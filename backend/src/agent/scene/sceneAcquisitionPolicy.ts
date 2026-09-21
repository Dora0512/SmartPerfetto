// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {loadPromptSegment, renderTemplate} from '../../agentv3/strategyLoader';
import type {RuntimeAcquisitionPolicy} from '../../agentv3/mcpToolRegistry';
import type {RuntimeToolResult} from '../../agentRuntime/runtimeToolSpec';
import {createRuntimeToolResult, readRuntimeToolReceipt, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {sceneRunState, type SceneRunContext, type SceneRunState} from './sceneRunContext';
import {recordSceneAcquisition, recordSceneToolSettled, recordSceneToolStarted, sceneAcquisitionRefusal,
  sceneAcquisitionReminder, sceneAcquisitionsSinceCommit, sceneClosingReserveMs, slowestRecentSceneRoundMs,
  type ScenePacingRefusal, type ScenePacingReminder} from './sceneProposalPacing';

const GUIDANCE_TEMPLATES: Readonly<Record<ScenePacingRefusal | ScenePacingReminder, string>> = {
  scene_first_revision_due: 'scene-pacing-first-revision-due',
  scene_acquisition_window_closed: 'scene-pacing-window-closed',
  scene_no_committed_revision: 'scene-pacing-no-revision',
  scene_deadline_near: 'scene-pacing-deadline-near',
};
const ACTION_REQUIRED: Readonly<Record<ScenePacingRefusal, string>> = {
  scene_first_revision_due: 'submit_first_scene_revision',
  scene_acquisition_window_closed: 'submit_scene_timeline_then_deliver',
};

function guidance(kind: ScenePacingRefusal | ScenePacingReminder, run: SceneRunState): string | undefined {
  const template = loadPromptSegment(GUIDANCE_TEMPLATES[kind]);
  if (!template) return undefined;
  const pacing = run.pacing;
  return renderTemplate(template, {revision: run.revision, acquisitions: pacing.completedAcquisitions,
    acquisitionsSinceCommit: sceneAcquisitionsSinceCommit(pacing), grace: pacing.policy.attemptGraceAcquisitions,
    reserveSeconds: Math.round(sceneClosingReserveMs(pacing) / 1000),
    roundSeconds: Math.round(slowestRecentSceneRoundMs(pacing) / 1000)});
}

/** Append one reminder to the first text block, the same channel other tools use for their notices. */
function withReminder(result: RuntimeToolResult, text: string): RuntimeToolResult {
  const content = Array.isArray(result.content) ? result.content : [];
  const index = content.findIndex(block => block.type === 'text');
  if (index < 0) return result;
  return {...result, content: content.map((block, position) => position === index && block.type === 'text'
    ? {...block, text: `${block.text}\n\n${text}`} : block)};
}

/**
 * Registry pacing for one issued scene run. Every decision reads the run's own
 * committed state; a revoked run throws, which the registry turns into an
 * acquisition-closed refusal.
 */
export function createSceneAcquisitionPolicy(context: SceneRunContext): RuntimeAcquisitionPolicy {
  return {
    observe(event) {
      const pacing = sceneRunState(context).pacing;
      if (event.phase === 'started') recordSceneToolStarted(pacing, Date.now());
      else recordSceneToolSettled(pacing, Date.now());
    },
    admit() {
      const run = sceneRunState(context);
      const kind = sceneAcquisitionRefusal(run.pacing, Date.now());
      if (!kind) return undefined;
      const text = guidance(kind, run);
      return createRuntimeToolResult({success: false, action_required: ACTION_REQUIRED[kind], unsupportedReason: kind,
        revision: run.revision, committedSegments: run.pacing.committedSegments, ...(text ? {guidance: text} : {})},
      {isError: true});
    },
    complete(_toolName, result) {
      const run = sceneRunState(context);
      // The receipt answers without decoding the whole result; only receipt-less results are decoded.
      const success = result.isError === true ? false : (readRuntimeToolReceipt(result) ?? readRuntimeToolResultFacts(result)).success;
      if (success === false) return result;
      recordSceneAcquisition(run.pacing);
      const kind = sceneAcquisitionReminder(run.pacing, Date.now());
      const text = kind ? guidance(kind, run) : undefined;
      return text ? withReminder(result, text) : result;
    },
  };
}
