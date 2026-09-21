// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {z} from 'zod';
import {loadStrategyYaml} from '../../agentv3/strategyLoader';
import type {SkillDefinition} from '../../services/skillEngine/types';
import {fingerprintSkillDefinition} from '../../services/selfEvolution/skillFingerprint';
import {immutableCanonicalSnapshot} from '../../services/selfEvolution/canonicalJson';
import {evidenceCaptureHash, freezeEvidenceValue} from '../../services/evidence/evidenceCapture';
import {assertSceneRunActive, sceneRunState, type SceneRunContext} from './sceneRunContext';
import {DEFAULT_SCENE_RUN_LIMITS, type SceneCoveragePlan} from './sceneTimelineContract';
import type {ReadonlyStrategyRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';

const id = z.string().min(1).max(256);
const producer = z.object({skillId: id, summaryStepId: id, resultStepId: id}).strict();
export const sceneCoveragePolicySchema = z.object({profileId: id, profileVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requiredTargets: z.array(z.object({id, domain: id, source: id, producer: producer.optional()}).strict())
    .min(1).max(DEFAULT_SCENE_RUN_LIMITS.maxRequiredTargets),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>(), bindings = new Set<string>();
  for (const target of value.requiredTargets) {
    const key = JSON.stringify([target.domain, target.source, target.producer ?? null]);
    if (ids.has(target.id) || bindings.has(key)) ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate required target'});
    ids.add(target.id); bindings.add(key);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > DEFAULT_SCENE_RUN_LIMITS.maxCoveragePlanBytes)
    ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Coverage policy exceeds budget'});
});
/** Same concrete definitions/fragments registered with this run's executor, not a fresh registry lookup. */
export interface SceneCoverageRegistrySnapshot {
  skills: readonly SkillDefinition[]; fragments: ReadonlyMap<string, string>;
  registryFingerprint?: string; strategyRegistryFingerprint: string;
  profileRefs: readonly {id: string; version: number}[];
}
export function snapshotSceneCoverageRegistry(registry: {getAllSkills(): SkillDefinition[]; getFragmentCache(): Map<string, string>; registryFingerprint?: string},
  strategies: Pick<ReadonlyStrategyRegistrySnapshot, 'registryFingerprint' | 'getStrategy'>, sceneId: string): SceneCoverageRegistrySnapshot {
  return {skills: immutableCanonicalSnapshot(registry.getAllSkills()),
    fragments: new Map(registry.getFragmentCache()), registryFingerprint: registry.registryFingerprint,
    strategyRegistryFingerprint: strategies.registryFingerprint,
    profileRefs: freezeEvidenceValue((strategies.getStrategy(sceneId)?.investigationContract?.profileRefs ?? []).map(ref => ({...ref})))};
}
/** Pure definition binding. Its output has no execution authority; only the private context retains it. */
export function buildSceneCoveragePlan(input: unknown, registry: SceneCoverageRegistrySnapshot): SceneCoveragePlan {
  const policy = sceneCoveragePolicySchema.parse(input);
  if (!registry.profileRefs.some(ref => ref.id === policy.profileId && ref.version === policy.profileVersion))
    throw new Error('scene_coverage_profile_mismatch');
  const byName = new Map(registry.skills.map(skill => [skill.name, skill]));
  if (byName.size !== registry.skills.length) throw new Error('scene_coverage_duplicate_skill');
  const targets = policy.requiredTargets.map(target => {
    if (!target.producer) return {id: target.id, domain: target.domain, source: target.source,
      bindingIssue: 'scene_coverage_producer_unconfigured'};
    const skill = byName.get(target.producer.skillId);
    const summary = skill?.steps?.find(step => step.id === target.producer!.summaryStepId);
    const result = skill?.steps?.find(step => step.id === target.producer!.resultStepId);
    const scan = summary?.type === 'atomic' ? summary.investigation_evidence?.scan : undefined;
    if (!skill || !scan || result?.type !== 'atomic' || !result.investigation_evidence || scan.domain !== target.domain ||
        scan.resultStepId !== target.producer.resultStepId || (!scan.sourceColumn && target.source !== 'all')) {
      const {producer: _unbound, ...identity} = target;
      return {...identity, requestedProducer: target.producer, bindingIssue: 'scene_coverage_producer_unavailable'};
    }
    return {...target, producer: {...target.producer, definitionFingerprint: fingerprintSkillDefinition(skill, registry.fragments)}};
  });
  const body = {profileId: policy.profileId, profileVersion: policy.profileVersion,
    policyFingerprint: evidenceCaptureHash(policy),
    registryFingerprint: registry.registryFingerprint ?? evidenceCaptureHash({skills: registry.skills, fragments: [...registry.fragments].sort(([a], [b]) => a.localeCompare(b))}),
    strategyRegistryFingerprint: registry.strategyRegistryFingerprint, targets};
  return freezeEvidenceValue({...body, fingerprint: evidenceCaptureHash(body)});
}
/** Server-only, once before tools open. Models never provide a policy, plan or capability manifest. */
export function initializeSceneCoveragePlan(handle: SceneRunContext, registry?: SceneCoverageRegistrySnapshot): void {
  const state = sceneRunState(handle);
  assertSceneRunActive(state);
  if (state.coveragePlanInitialized || state.revision !== 0 || state.busy) throw new Error('scene_coverage_already_initialized');
  state.coveragePlanInitialized = true;
  try {
    if (!registry) throw new Error('scene_coverage_registry_missing');
    const policy = loadStrategyYaml('scene-coverage-policy', value => sceneCoveragePolicySchema.parse(value));
    if (!policy) throw new Error('scene_coverage_policy_missing');
    const plan = buildSceneCoveragePlan(policy, registry);
    const bytes = Buffer.byteLength(JSON.stringify(plan), 'utf8');
    if (plan.targets.length > state.limits.maxRequiredTargets || bytes > state.limits.maxCoveragePlanBytes ||
        state.consumed.bytes + bytes > state.limits.maxRunBytes) throw new Error('scene_coverage_plan_budget_exhausted');
    assertSceneRunActive(state);
    state.coveragePlan = plan; state.consumed.bytes += bytes;
  } catch {
    assertSceneRunActive(state);
    state.scanDiagnostics.push({code: 'scene_coverage_plan_unavailable'});
  }
}
