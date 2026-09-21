// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createSceneRunDispatchBinding, activateSceneRuntime, sceneRunOwnerKey} from '../../agent/scene/sceneRuntimeBinding';
import {proposeSceneTimeline} from '../../agent/scene/sceneTimelineProposal';
import {consumeSceneTimelinePublication} from '../../agent/scene/sceneTimelinePublication';
import {resolveRuntimeEvidenceStore} from '../../agentRuntime/runtimeEvidenceContext';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';

const scope = {runId: 'scene-final-run', sessionId: 'scene-final-session', traceId: 'scene-final-trace',
  ownerKey: sceneRunOwnerKey({})};
const body = (): AnalysisResult => ({sessionId: scope.sessionId, success: false, conclusion: '',
  findings: [], hypotheses: [], confidence: 0, rounds: 1, totalDurationMs: 100,
  partial: true, terminationReason: 'execution_error'});
const owner = () => ({runId: scope.runId, signal: new AbortController().signal,
  isCurrent: () => true, assertAuthorized: () => {}});

describe('scene product finalization', () => {
  it('retains the last proposal independently of a failed provider body and consumes the seal once', async () => {
    const signal = new AbortController().signal;
    const binding = createSceneRunDispatchBinding({scope, signal, assertCurrent: () => {}});
    try {
      const options = binding.bindOptions({runId: scope.runId});
      const artifactStore = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('unexpected fallback');});
      const context = await activateSceneRuntime(options, {...scope, artifactStore, deadlineMs: Date.now() + 60_000,
        traceProcessorService: {query: jest.fn().mockResolvedValue({columns: ['start_ns', 'end_ns'], rows: [['0', '100']]})}});
      await proposeSceneTimeline(context!, {baseRevision: 0, proposalId: 'one', segments: [{id: 'unknown',
        startNs: '0', endNs: '100', object: {kind: 'device', key: 'unknown'}, userAction: 'Unknown',
        deviceState: 'Unknown', appResponse: 'Unknown', evidenceRefs: [],
        boundaries: {start: {source: 'trace_bound'}, end: {source: 'trace_bound'}}}]});
      const seal = binding.seal()!;
      const scene = {seal, scope, outputLanguage: 'en' as const};
      const finalized = await finalizeAnalysisResult({result: body(), owner: owner(), query: 'Reconstruct', scene});
      expect(finalized.result).toMatchObject({success: false, partial: true, sceneTimeline: {
        runId: scope.runId, revision: 1, status: 'partial', segments: [{semanticStatus: 'unverified'}]}});
      const publication = consumeSceneTimelinePublication(finalized.scenePublication!, scope);
      expect(publication.assessment).toEqual(finalized.result.sceneTimeline);
      expect(publication.summary).toBe(finalized.result.conclusion);
      expect(() => consumeSceneTimelinePublication(finalized.scenePublication!, scope)).toThrow('unissued_scene_publication');
      await expect(finalizeAnalysisResult({result: body(), owner: owner(), query: 'Reconstruct', scene}))
        .rejects.toThrow();
    } finally {binding.release();}
  });
  it('drops model or historical timeline JSON without an issued product seal', async () => {
    const result = {...body(), sceneTimeline: {schemaVersion: 'scene_timeline@1', revision: 900,
      segments: [{verified: true}]}} as unknown as AnalysisResult;
    const finalized = await finalizeAnalysisResult({result, owner: owner(), query: 'Reconstruct'});
    expect(finalized.result.sceneTimeline).toBeUndefined();
    expect(finalized.scenePublication).toBeUndefined();
  });
});
