// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createSceneRunDispatchBinding, consumeSceneRuntimeSeal, sceneRunOwnerKey} from '../../src/agent/scene/sceneRuntimeBinding';
import {resolveRuntimeEvidenceStore} from '../../src/agentRuntime/runtimeEvidenceContext';
import {captureEvidenceTable} from '../../src/services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../src/services/traceProcessorConnectionModel';
import type {TraceProcessorService} from '../../src/services/traceProcessorService';
import type {SceneTimelineProposal} from '../../src/agent/scene/sceneTimelineContract';

/** Shared deterministic fixture; provider transports remain each runtime's existing harness. */
export function createSceneRuntimeMatrixFixture(runtime: string) {
  const controller = new AbortController();
  const scope = {runId: `${runtime}-scene-run`, sessionId: `${runtime}-scene-session`, traceId: `${runtime}-scene-trace`,
    ownerKey: sceneRunOwnerKey({})};
  const binding = createSceneRunDispatchBinding({scope, signal: controller.signal, assertCurrent() {}});
  const options = binding.bindOptions({runId: scope.runId, providerId: null});
  const boundsQueries: string[] = [];
  const traceProcessorService = {
    async query(traceId: string, sql: string) {
      if (sql === 'SELECT CAST(start_ts AS TEXT) AS start_ns, CAST(end_ts AS TEXT) AS end_ns FROM trace_bounds') {
        boundsQueries.push(traceId);
        return {columns: ['start_ns', 'end_ns'], rows: [['9007199254740992', '9007199254741992']], durationMs: 0};
      }
      return {columns: [], rows: [], durationMs: 0};
    },
    getTrace: () => ({id: scope.traceId, filename: 'scene.pftrace', size: 1, uploadTime: new Date(),
      status: 'ready', traceOs: 'android', traceFormat: 'perfetto_protobuf'}),
  } as unknown as TraceProcessorService;
  let submitted: SceneTimelineProposal | undefined;
  const proposal = () => {
    if (submitted) return submitted;
    const store = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('scene_fixture_missing_runtime_store');});
    const data = {columns: ['start_ns', 'end_ns', 'upid'], rows: [['9007199254740992', '9007199254740993', '7']]};
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'scene-matrix@1', skillId: 'scene_fixture', stepId: 'facts'};
    const artifactId = store.store({skillId: 'scene_fixture', stepId: 'facts', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: scope.traceId, traceSide: 'current'})});
    store.registerEvidenceCapture(artifactId, captureEvidenceTable(data, {
      start_ns: {origin, timeRole: 'start', clock: 'trace_monotonic', unit: 'ns'},
      end_ns: {origin, timeRole: 'end', clock: 'trace_monotonic', unit: 'ns'}, upid: {origin, identityRole: 'upid'},
    }), {evidenceRefId: `${scope.runId}:scene-evidence`, originRunId: 'ignored-model-origin'});
    return submitted = {baseRevision: 0, proposalId: 'current-scene-proposal', unresolved: [], removeSegmentIds: [], segments: [{
      id: 'scene-segment', startNs: '9007199254740992', endNs: '9007199254740993', object: {kind: 'upid', key: '7'},
      userAction: 'User action unknown', deviceState: 'Device state unknown', appResponse: 'Observed interval',
      evidenceRefs: [{artifactId, rowIndex: 0}], dependencies: [], supersedes: [],
      boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: 'start_ns'},
        end: {source: 'evidence', evidenceIndex: 0, column: 'end_ns'}},
    }]};
  };
  return {scope, options, controller, binding, boundsQueries, traceProcessorService, proposal,
    seal: () => {const seal = binding.seal(); if (!seal) throw new Error('scene_runtime_not_activated');
      const snapshot = consumeSceneRuntimeSeal(seal, scope);
      const plan = snapshot.scanCoverage?.plan;
      if (!plan || plan.profileId !== 'scene_reconstruction' || !plan.targets.length ||
          !plan.registryFingerprint || !plan.strategyRegistryFingerprint || !plan.fingerprint) {
        throw new Error('scene_runtime_coverage_plan_not_bound');
      }
      return snapshot;}};
}
