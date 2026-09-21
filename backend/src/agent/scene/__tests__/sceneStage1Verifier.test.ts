// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({query: jest.fn()}));

import {parseVerifierJson, runSceneStage1Verifier} from '../sceneStage1Verifier';
import {projectSceneVerification} from '../scenePresentation';
import type {DisplayedScene} from '../types';

function scene(overrides: Partial<DisplayedScene> = {}): DisplayedScene {
  return {id: 'action-1', sceneType: 'tap', sourceStepId: 'user_gestures',
    startTs: '100', endTs: '200', durationMs: 0.0001, label: 'tap',
    processName: 'com.app', metadata: {}, severity: 'unknown',
    confidenceScore: 0.9, analysisState: 'not_planned', ...overrides};
}

describe('Stage1 structural verification boundaries', () => {
  it.each([
    {startTs: '200', endTs: '100'},
    {startTs: 'not-a-time', endTs: '100'},
    {startTs: '-1', endTs: '100'},
  ])('rejects invalid timing %j even when confidence is high', async timing => {
    const result = await runSceneStage1Verifier({scenes: [scene(timing)], traceDurationSec: 1});
    expect(result.status).toBe('needs_review');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({type: 'invalid_timing'})]));
  });

  it('checks exact trace bounds without rounding nanoseconds through Number', async () => {
    const result = await runSceneStage1Verifier({
      scenes: [scene({startTs: '9007199254740993', endTs: '9007199254740995'})],
      traceDurationSec: 0.000000002,
      traceBounds: {startTs: '9007199254740992', endTs: '9007199254740994'},
    });
    expect(result.issues.some(issue => issue.type === 'outside_trace_bounds')).toBe(true);
  });

  it('detects the real regression shape: idle fully contains an observed gesture', async () => {
    const result = await runSceneStage1Verifier({scenes: [
      scene({startTs: '506731587003811', endTs: '506733321151727', sceneType: 'scroll'}),
      scene({id: 'gap-1', sourceStepId: 'idle_periods', sceneType: 'idle', sceneRole: 'context',
        startTs: '506731587003811', endTs: '506734505356883'}),
    ], traceDurationSec: 8});
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'idle_overlaps_activity', sceneId: 'gap-1',
    })]));
    expect(result.status).toBe('needs_review');
  });

  it('rejects duplicate scene ids and dangling parent links', async () => {
    const result = await runSceneStage1Verifier({scenes: [scene(), scene({parentSceneId: 'missing'})], traceDurationSec: 1});
    expect(result.issues.map(issue => issue.type)).toEqual(expect.arrayContaining(['duplicate_scene_id', 'missing_parent_scene']));
  });

  it('does not present a structural pass as raw evidence or coverage verification', async () => {
    const result = await runSceneStage1Verifier({scenes: [scene()], traceDurationSec: 1});
    expect(result).toMatchObject({status: 'passed', scope: 'structure', evidenceStatus: 'not_checked'});
    expect(result.summary).toContain('结构检查');
    expect(projectSceneVerification(result, 'en')?.summary).toContain('not checked');
  });

  it('propagates extraction truncation and missing action semantics', async () => {
    const result = await runSceneStage1Verifier({scenes: [scene()], traceDurationSec: 1,
      inputCoverage: {source_status: 'partial', observed_event_count: 55, missing_action_count: 55, output_truncated: 1}});
    expect(result.issues.map(issue => issue.type)).toEqual(expect.arrayContaining(['input_semantics_missing', 'input_output_truncated']));
    expect(result.status).toBe('needs_review');
  });
});

describe('legacy optional model response parsing', () => {
  it.each(['not json', '{}', '{"status":"failed"}', '{"status":"passed","summary":"ok","verified":true}'])
    ('fails closed on unsupported or malformed output: %s', raw => {
      expect(parseVerifierJson(raw).status).toBe('failed');
    });
  it('accepts the exact documented response without promoting other statuses', () => {
    expect(parseVerifierJson('{"status":"needs_review","summary":"Conflicting identities"}'))
      .toEqual({status: 'needs_review', summary: 'Conflicting identities'});
    expect(parseVerifierJson('```json\n{"status":"passed","summary":"Structure is consistent"}\n```').status).toBe('passed');
  });
});
