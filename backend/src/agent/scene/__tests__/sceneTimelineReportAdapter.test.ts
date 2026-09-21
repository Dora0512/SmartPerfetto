// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SceneEvidenceArchive} from '../../../services/sceneReport/sceneEvidenceArchive';
import {SceneReportMemoryCache} from '../../../services/sceneReport/sceneReportMemoryCache';
import type {SceneReportStore} from '../../../services/sceneReport/sceneReportStore';
import {SceneStoryService, projectSceneReport, type SceneStorySession} from '../sceneStoryService';
import {issueSceneTimelinePublication, type SceneTimelinePublication} from '../sceneTimelinePublication';
import {sceneRunOwnerKey} from '../sceneRuntimeBinding';
import type {SceneScope, SceneSegmentAssessment, SceneTimelineAssessment} from '../sceneTimelineContract';
import type {SceneTimelineReportMetadata} from '../sceneTimelineReportAdapter';
import type {SceneTimelineReport} from '../types';

let directory: string;
beforeEach(async () => {directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-report-adapter-'));});
afterEach(async () => {jest.restoreAllMocks(); await fs.rm(directory, {recursive: true, force: true});});
const owner = {tenantId: 'tenant-report', workspaceId: 'workspace-report', userId: 'user-report'};
const scope: SceneScope = {runId: 'run-report', sessionId: 'session-report', traceId: 'trace-report', ownerKey: sceneRunOwnerKey(owner)};
const start = 9007199254740993000n;

function segment(index: number): SceneSegmentAssessment {
  const startNs = String(start + BigInt(index) * 1000n);
  return {
    segment: {id: `segment-${index}`, startNs, endNs: String(BigInt(startNs) + 1n),
      object: {kind: 'upid', key: '42'}, userAction: `touch movement ${index}`,
      deviceState: 'screen on; posture unknown', appResponse: `window response ${index}`,
      evidenceRefs: [{artifactId: `artifact-${index}`, rowIndex: index}],
      boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: 'ts'}, end: {source: 'inferred'}},
      dependencies: index ? [`segment-${index - 1}`] : [], supersedes: []},
    contentFingerprint: `content-${index}`, dependencyFingerprint: `dependency-${index}`, issuedRevision: 4,
    referencesResolved: true, semanticStatus: 'unverified',
    checks: [{predicate: 'time.start_cell_equals_boundary', status: 'passed'},
      {predicate: 'story.semantic', status: 'unknown', reason: 'unsupported_semantic_predicate'}],
    evidence: [{captureId: `capture-${index}`, originalRowIndex: index, referenceIndex: 0, fingerprint: `row-${index}`,
      source: {originRunId: scope.runId, artifactId: `artifact-${index}`},
      row: {ts: startNs, auditOnly: `raw-audit-row-${index}`}, fields: {}}],
    diagnostics: [],
  };
}
function assessment(count = 2): SceneTimelineAssessment {
  return {schemaVersion: 'scene_timeline@1', ...scope, revision: 4,
    segments: Array.from({length: count}, (_, index) => segment(index)),
    unresolved: ['exact presentation boundary remains unknown'], diagnostics: [], status: 'partial',
    coverage: {status: 'unknown', captureStatus: 'unknown', reason: 'capture_completeness_unproven', sources: []}};
}
function fixture(count = 2, summary = 'The user moved a finger while the display remained on.') {
  const value = assessment(count);
  const meta: SceneTimelineReportMetadata = {owner, traceContentHash: 'a'.repeat(64),
    requestedRange: {startNs: String(start), endNs: String(start + BigInt(count + 1) * 1000n)},
    schemaVersion: 'scene_report@3', ruleVersion: 'scene_finite@1', producerFingerprint: 'producer-fingerprint',
    traceProcessorFingerprint: 'processor-fingerprint'};
  const publication = issueSceneTimelinePublication({scope, assessment: value, summary,
    outputLanguage: 'en', totalDurationMs: 123, registryFingerprint: 'registry-fingerprint',
    providerId: 'selected-provider', runtimeKind: 'openai-agents-sdk'});
  const archive = new SceneEvidenceArchive(directory);
  const events = jest.fn();
  const session: SceneStorySession = {sessionId: scope.sessionId, status: 'running', createdAt: 10, lastActivityAt: 11};
  const reportStore = {save: jest.fn<SceneReportStore['save']>(async () => {}),
    loadById: jest.fn<SceneReportStore['loadById']>(async () => null),
    loadByHash: jest.fn<SceneReportStore['loadByHash']>(async () => null),
    delete: jest.fn<SceneReportStore['delete']>(async () => false),
    cleanupExpired: jest.fn<SceneReportStore['cleanupExpired']>(async () => 0)};
  const service = new SceneStoryService({broadcast: events, getSession: () => session, reportStore,
    memoryCache: new SceneReportMemoryCache(4), computeHash: async () => meta.traceContentHash,
    probeDuration: async () => 0, evidenceArchive: archive});
  const assertCurrent = jest.fn(() => {});
  const input = {publication, scope, meta, assertCurrent};
  return {service, archive, input, events, session, reportStore, value};
}

describe('finalized scene report adapter', () => {
  it('archives one canonical revision and returns only the browser projection without publishing a terminal event', async () => {
    const f = fixture();
    const result = await f.service.acceptFinalizedTimeline(f.input);
    const stored = await f.archive.load(scope.ownerKey, result.report.reportId);
    expect(stored).not.toBeNull();
    const canonical = stored!.report as SceneTimelineReport;
    expect(canonical.sceneTimeline).toEqual(f.value);
    expect(stored!.assessment).toEqual(f.value);
    expect(canonical.expiresAt).toBeNull();
    expect(result.report.expiresAt).toBe(result.archiveRef.expiresAt);
    expect(result.report.generatedBy).toMatchObject({pipelineVersion: 'v3', runtime: 'agent-runtime',
      runtimeKind: 'openai-agents-sdk', providerId: 'selected-provider', registryFingerprint: 'registry-fingerprint'});
    expect(result.report.displayedScenes.map(scene => scene.id)).toEqual(f.value.segments.map(value => value.segment.id));
    const first = result.report.displayedScenes[0];
    expect(first).toMatchObject({sceneType: 'scene_observation', severity: 'unknown', analysisEligible: false,
      startTs: String(start), endTs: String(start + 1n), durationMs: 0.000001});
    expect(first.metadata).toMatchObject({revision: 4, userAction: 'touch movement 0',
      deviceState: 'screen on; posture unknown', appResponse: 'window response 0', semanticStatus: 'unverified'});
    expect(JSON.stringify(result.report)).not.toContain('raw-audit-row');
    expect(result.report.sceneTimeline.segments[0]).not.toHaveProperty('evidence');
    expect(f.events).not.toHaveBeenCalled();
    expect(f.session).toEqual({sessionId: scope.sessionId, status: 'running', createdAt: 10, lastActivityAt: 11});
    expect(f.reportStore.save).not.toHaveBeenCalled();
    expect(f.reportStore.loadById).not.toHaveBeenCalled();
  });

  it('preserves original summary and operation meaning when only UI labels change language', async () => {
    const f = fixture();
    const {report} = await f.service.acceptFinalizedTimeline(f.input);
    const chineseUi = projectSceneReport(report, 'zh-CN');
    expect(chineseUi.outputLanguage).toBe('en');
    expect(chineseUi.summary).toBe(report.summary);
    expect(chineseUi.summaries).toEqual({en: report.summary});
    expect(chineseUi.displayedScenes[0].label).toContain('场景观测');
    expect(chineseUi.displayedScenes[0].metadata.userAction).toBe('touch movement 0');
    expect(chineseUi.sceneTimeline).toEqual(report.sceneTimeline);
    expect(JSON.stringify(chineseUi)).not.toContain('raw-audit-row');
  });

  it('derives fresh and historical views from the same full revision, retaining a tail beyond 500 segments', async () => {
    const f = fixture(601);
    const fresh = await f.service.acceptFinalizedTimeline(f.input);
    const loaded = await f.service.getFinalizedReport(scope.ownerKey, fresh.report.reportId);
    expect(loaded?.displayedScenes).toHaveLength(601);
    expect(loaded?.sceneTimeline.segments).toHaveLength(601);
    expect(loaded?.displayedScenes[600]?.id).toBe('segment-600');
    expect(loaded?.displayedScenes[600]?.endTs).toBe(String(start + 600_001n));
    expect(loaded?.displayedScenes).toEqual(fresh.report.displayedScenes);
    expect(loaded?.sceneTimeline).toEqual(fresh.report.sceneTimeline);
    expect(loaded?.summary).toBe(fresh.report.summary);
    expect(loaded?.expiresAt).toBe(fresh.archiveRef.expiresAt);
    expect(JSON.stringify(loaded)).not.toContain('raw-audit-row');
    await expect(f.service.acceptFinalizedTimeline({...f.input,
      publication: loaded as unknown as SceneTimelinePublication})).rejects.toThrow('unissued_scene_publication');
  });

  it('rejects forged/replayed publication tokens before any extra archive write', async () => {
    const f = fixture();
    const save = jest.spyOn(f.archive, 'save');
    await expect(f.service.acceptFinalizedTimeline({...f.input, publication: {} as SceneTimelinePublication}))
      .rejects.toThrow('unissued_scene_publication');
    expect(save).not.toHaveBeenCalled();
    await f.service.acceptFinalizedTimeline(f.input);
    await expect(f.service.acceptFinalizedTimeline(f.input)).rejects.toThrow('unissued_scene_publication');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each(['ownerKey', 'runId', 'traceId', 'sessionId'] as const)('rejects a publication under another %s', async field => {
    const f = fixture();
    const save = jest.spyOn(f.archive, 'save');
    await expect(f.service.acceptFinalizedTimeline({...f.input, scope: {...scope, [field]: 'other'}}))
      .rejects.toThrow('unissued_scene_publication');
    expect(save).not.toHaveBeenCalled();
    const result = await f.service.acceptFinalizedTimeline(f.input);
    expect(result.report.sceneTimeline.revision).toBe(4);
  });

  it('does not return an archive reference, mutate sessions or publish terminal events after archive failure', async () => {
    const f = fixture();
    const save = jest.spyOn(f.archive, 'save').mockRejectedValue(new Error('disk full'));
    await expect(f.service.acceptFinalizedTimeline(f.input)).rejects.toThrow('disk full');
    const attemptedId = save.mock.calls[0][0].reportId;
    expect(await f.service.getFinalizedReport(scope.ownerKey, attemptedId)).toBeNull();
    expect(f.session.status).toBe('running');
    expect(f.events).not.toHaveBeenCalled();
    expect(f.reportStore.save).not.toHaveBeenCalled();
    await expect(f.service.acceptFinalizedTimeline(f.input)).rejects.toThrow('unissued_scene_publication');
  });

  it('keeps owner-scoped archive misses authoritative with no v2 or memory fallback', async () => {
    const f = fixture();
    const {report} = await f.service.acceptFinalizedTimeline(f.input);
    f.reportStore.loadById.mockResolvedValue(report);
    expect(await f.service.getFinalizedReport('other-owner', report.reportId)).toBeNull();
    jest.spyOn(f.archive, 'load').mockResolvedValue(null);
    expect(await f.service.getFinalizedReport(scope.ownerKey, report.reportId)).toBeNull();
    expect(f.reportStore.loadById).not.toHaveBeenCalled();
    expect(f.events).not.toHaveBeenCalled();
  });

  it('rejects a report/assessment revision mismatch in an otherwise readable historical container', async () => {
    const f = fixture();
    const {report} = await f.service.acceptFinalizedTimeline(f.input);
    const stored = (await f.archive.load(scope.ownerKey, report.reportId))!;
    jest.spyOn(f.archive, 'load').mockResolvedValue({...stored,
      assessment: {...stored.assessment, revision: stored.assessment.revision + 1}});
    expect(await f.service.getFinalizedReport(scope.ownerKey, report.reportId)).toBeNull();
  });

  it('stops before archive writes when ownership is no longer current', async () => {
    const f = fixture();
    const save = jest.spyOn(f.archive, 'save');
    f.input.assertCurrent.mockImplementation(() => {throw new Error('run cancelled');});
    await expect(f.service.acceptFinalizedTimeline(f.input)).rejects.toThrow('run cancelled');
    expect(save).not.toHaveBeenCalled();
    expect(f.events).not.toHaveBeenCalled();
  });
});
