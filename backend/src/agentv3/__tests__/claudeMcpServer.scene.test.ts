// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createClaudeMcpServer} from '../claudeMcpServer';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {activateSceneRuntime, createSceneRunDispatchBinding, consumeSceneRuntimeSeal,
  sceneRunOwnerKey, type SceneRunDispatchBinding} from '../../agent/scene/sceneRuntimeBinding';
import {resolveRuntimeEvidenceStore} from '../../agentRuntime/runtimeEvidenceContext';
import {sceneRunState, type SceneRunContext} from '../../agent/scene/sceneRunContext';
import type {SceneTimelineSegment} from '../../agent/scene/sceneTimelineContract';
import type {SceneCoverageRegistrySnapshot} from '../../agent/scene/sceneCoveragePlan';

const bindings: SceneRunDispatchBinding[] = [];
const scope = {runId: 'run-scene-mcp', sessionId: 'session-scene-mcp', traceId: 'trace-scene-mcp', ownerKey: sceneRunOwnerKey({})};
function fixture(sceneCoverageRegistry?: SceneCoverageRegistrySnapshot) {
  const query = jest.fn(async () => ({columns: ['start_ns', 'end_ns'], rows: [['0', '1000']], durationMs: 0}));
  const traceProcessorService = {query} as unknown as TraceProcessorService;
  const skillExecutor = new SkillExecutor(traceProcessorService);
  const controller = new AbortController();
  const binding = createSceneRunDispatchBinding({scope, signal: controller.signal, assertCurrent() {}});
  bindings.push(binding);
  const options = binding.bindOptions({runId: scope.runId});
  const artifactStore = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('unexpected fallback');});
  let open = true;
  const server = (sceneRunContext?: SceneRunContext) => createClaudeMcpServer({
    ...scope, traceProcessorService, skillExecutor, artifactStore, sceneRunContext,
    canInvokeTool: () => open, androidInternalsPackStore: null,
  });
  const activate = () => activateSceneRuntime(options, {...scope, deadlineMs: Date.now() + 60000,
    artifactStore, traceProcessorService, sceneCoverageRegistry, signal: controller.signal, canInvokeTool: () => open});
  return {server, activate, binding, controller, query, close: () => {open = false;}};
}
function segment(id: string): SceneTimelineSegment {
  return {id, startNs: '0', endNs: '1000', object: {kind: 'trace', key: scope.traceId},
    userAction: 'Input unavailable', deviceState: 'Device state unavailable', appResponse: 'No inferred app response',
    evidenceRefs: [], boundaries: {start: {source: 'trace_bound'}, end: {source: 'trace_bound'}}, dependencies: [], supersedes: []};
}
afterEach(() => {bindings.splice(0).forEach(binding => binding.release()); jest.restoreAllMocks();});

describe('shared scene proposal capability', () => {
  it('does not expose the tool in an ordinary MCP server', () => {
    const f = fixture();
    expect(f.server().toolDefinitions.some(tool => tool.name === 'propose_scene_timeline')).toBe(false);
    expect(f.query).not.toHaveBeenCalled();
  });
  it('refuses forged and JSON-copied capabilities', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    expect(() => f.server({bindOptions: value => value})).toThrow('unissued_scene_runtime_capability');
    expect(() => f.server(JSON.parse(JSON.stringify(capability)))).toThrow('unissued_scene_runtime_capability');
  });
  it('registers the shared schema and returns bounded revision diagnostics while retaining full state privately', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const mcp = f.server(capability);
    const tool = mcp.toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    expect(mcp.allowedTools).toContain('mcp__smartperfetto__propose_scene_timeline');
    expect(tool.shared.inputSchema).toHaveProperty('baseRevision');
    expect(tool.evidenceEffect).toBe('read_existing');
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'p1',
      segments: Array.from({length: 50}, (_, index) => segment(`segment-${index}`)), unresolved: []}, {});
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({accepted: true, revision: 1,
      omittedChangedSegmentCount: 18, omittedDiagnosticCount: 26});
    expect(response.structuredContent?.changedSegmentIds).toHaveLength(32);
    expect(response.structuredContent?.diagnostics).toHaveLength(24);
    expect(response.structuredContent).not.toHaveProperty('segments');
    expect(response.structuredContent).not.toHaveProperty('evidence');
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(20000);
    const snapshot = consumeSceneRuntimeSeal(f.binding.seal()!, scope);
    expect(snapshot.segments).toHaveLength(50);
    expect(snapshot.segments.every(item => item.semanticStatus === 'unverified')).toBe(true);
  });
  it('preserves the committed revision when the model supplies proof fields', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'forged', segments: [segment('s')],
      verified: true, unresolved: []}, {});
    expect(response.structuredContent).toMatchObject({accepted: false, revision: 0,
      diagnostics: [{code: 'invalid_proposal'}]});
    expect(sceneRunState(capability).revision).toBe(0);
  });
  it('returns required query gaps without turning an accepted candidate into capture proof', async () => {
    const f = fixture({skills: [], fragments: new Map(), strategyRegistryFingerprint: 'fixture-strategy',
      profileRefs: [{id: 'scene_reconstruction', version: 1}]});
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'gaps', segments: [segment('s')]}, {});
    const coverage = response.structuredContent?.coverage as any;
    expect(coverage).toMatchObject({captureStatus: 'unknown', omittedTargetCount: 0});
    expect(coverage.targets).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'input_observations', capabilityStatus: 'unknown', scanStatus: 'unknown', unscannedWindowCount: 1,
    })]));
    expect(JSON.stringify(coverage)).not.toContain('receipts');
    expect(JSON.stringify(coverage)).not.toContain('ownerKey');
    expect(JSON.stringify(coverage)).not.toContain('definitionFingerprint');
  });
  it('rejects tool work after runtime acquisition closes and after product release', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    f.close();
    const result = await tool.shared.handler({baseRevision: 0, proposalId: 'late', segments: [segment('s')], unresolved: []}, {});
    expect(result.isError).toBe(true);
    expect(sceneRunState(capability).revision).toBe(0);
    f.binding.release();
    expect(() => f.server(capability)).toThrow('unissued_scene_runtime_capability');
  });
});
