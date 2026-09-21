// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {uuidv4} from '../../utils/uuid';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import type {ResourceOwnerFields} from '../../services/resourceOwnership';
import type {SceneArchiveCacheIdentity, SceneEvidenceArchive, SceneEvidenceArchiveRef} from '../../services/sceneReport/sceneEvidenceArchive';
import {evidenceCaptureHash} from '../../services/evidence/evidenceCapture';
import {sceneNanosecondsSchema, type SceneScope, type SceneTimelineAssessment} from './sceneTimelineContract';
import {consumeSceneTimelinePublication, type SceneTimelinePublication, type ScenePublicationData} from './sceneTimelinePublication';
import {projectSceneTimelineForClient, type SceneTimelineView} from './sceneTimelineProjection';
import {projectDisplayedScene} from './scenePresentation';
import {sceneRunOwnerKey} from './sceneRuntimeBinding';
import type {DisplayedScene, SceneReport, SceneTimelineReport, SceneTimelineReportView} from './types';

export const SCENE_TIMELINE_REPORT_PREFIX = 'scene-v3-';
export type SceneTimelineArchive = Pick<SceneEvidenceArchive, 'save' | 'load'>;
export interface SceneTimelineReportMetadata extends Omit<SceneArchiveCacheIdentity, 'outputLanguage'> {
  /** Trusted route/session metadata. The archive owner key remains the read boundary. */
  owner?: ResourceOwnerFields;
  traceMeta?: Omit<SceneReport['traceMeta'], 'durationSec'>;
}
export interface AcceptFinalizedTimelineInput {
  publication: SceneTimelinePublication;
  scope: SceneScope;
  meta: SceneTimelineReportMetadata;
  assertCurrent(): void | Promise<void>;
}
export interface FinalizedTimelineReport {
  report: SceneTimelineReportView;
  archiveRef: SceneEvidenceArchiveRef;
}

function durationNs(start: string, end: string): bigint {
  sceneNanosecondsSchema.parse(start);
  sceneNanosecondsSchema.parse(end);
  const delta = BigInt(end) - BigInt(start);
  if (delta < 0n) throw new Error('scene_report_invalid_interval');
  return delta;
}
function durationInUnit(delta: bigint, divisor: bigint): number {
  // Subtract exact timestamps before converting the convenience display duration.
  return Number(delta / divisor) + Number(delta % divisor) / Number(divisor);
}

/** Derive every row from the canonical revision; free-form story text never selects a detector category. */
export function displayedScenesFromTimeline(
  timeline: SceneTimelineAssessment | SceneTimelineView,
  language: OutputLanguage,
): DisplayedScene[] {
  return timeline.segments.map(value => {
    const segment = value.segment;
    const scene: DisplayedScene = {
      id: segment.id, sceneType: 'scene_observation', sourceStepId: 'scene_timeline',
      startTs: segment.startNs, endTs: segment.endNs,
      durationMs: durationInUnit(durationNs(segment.startNs, segment.endNs), 1_000_000n),
      label: '', severity: 'unknown', sceneRole: 'context', analysisEligible: false, analysisState: 'not_planned',
      metadata: {
        revision: timeline.revision, runId: timeline.runId,
        object: segment.object, userAction: segment.userAction, deviceState: segment.deviceState,
        appResponse: segment.appResponse, boundaries: segment.boundaries,
        dependencies: segment.dependencies, supersedes: segment.supersedes,
        evidenceReferences: segment.evidenceRefs, checks: value.checks,
        semanticStatus: value.semanticStatus, referencesResolved: value.referencesResolved,
        diagnostics: value.diagnostics,
      },
    };
    return projectDisplayedScene(scene, language);
  });
}

/** Pure, idempotent browser projection. Narrative language and meaning stay bound to the saved run. */
export function projectSceneTimelineReport(
  report: SceneTimelineReport | SceneTimelineReportView,
  language: OutputLanguage,
  expiresAt = report.expiresAt,
): SceneTimelineReportView {
  const timeline = projectSceneTimelineForClient(report.sceneTimeline);
  return {...report, expiresAt, sceneTimeline: timeline,
    displayedScenes: displayedScenesFromTimeline(timeline, language),
    // These v2 containers never carry an alternative timeline or raw audit rows in v3.
    cachedDataEnvelopes: [], jobs: [],
  };
}

function buildCanonicalReport(data: Readonly<ScenePublicationData>, meta: SceneTimelineReportMetadata): SceneTimelineReport {
  const range = meta.requestedRange;
  const requestedDuration = durationNs(range.startNs, range.endNs);
  if (meta.owner && sceneRunOwnerKey(meta.owner) !== data.scope.ownerKey) throw new Error('scene_report_owner_mismatch');
  if (data.assessment.scanCoverage && (data.assessment.scanCoverage.requestedWindow.startNs !== range.startNs ||
    data.assessment.scanCoverage.requestedWindow.endNs !== range.endNs)) throw new Error('scene_report_range_mismatch');
  for (const {segment} of data.assessment.segments) {
    durationNs(segment.startNs, segment.endNs);
    if (BigInt(segment.startNs) < BigInt(range.startNs) || BigInt(segment.endNs) > BigInt(range.endNs)) {
      throw new Error('scene_report_segment_outside_requested_range');
    }
  }
  return {
    reportId: `${SCENE_TIMELINE_REPORT_PREFIX}${uuidv4()}`,
    tenantId: meta.owner?.tenantId, workspaceId: meta.owner?.workspaceId, userId: meta.owner?.userId,
    traceHash: meta.traceContentHash, traceId: data.scope.traceId,
    traceOrigin: meta.traceContentHash === null ? 'external_rpc' : 'file',
    cachePolicy: 'evidence_archive', expiresAt: null, createdAt: Date.now(), phase: 'analyzed',
    traceMeta: {...meta.traceMeta, durationSec: durationInUnit(requestedDuration, 1_000_000_000n)},
    sessionId: data.scope.sessionId, runId: data.scope.runId,
    sceneTimeline: data.assessment,
    displayedScenes: displayedScenesFromTimeline(data.assessment, data.outputLanguage),
    cachedDataEnvelopes: [], jobs: [], summary: data.summary, outputLanguage: data.outputLanguage,
    summaries: {[data.outputLanguage]: data.summary}, insights: [],
    partialReport: data.assessment.status === 'partial', totalDurationMs: data.totalDurationMs,
    generatedBy: {runtime: 'agent-runtime', runtimeKind: data.runtimeKind, pipelineVersion: 'v3',
      providerId: data.providerId, registryFingerprint: data.registryFingerprint},
  };
}

/** Consume product publication once and atomically archive the report plus its full owner-safe assessment. */
export async function acceptFinalizedSceneTimeline(
  archive: SceneTimelineArchive,
  input: AcceptFinalizedTimelineInput,
): Promise<FinalizedTimelineReport> {
  await input.assertCurrent();
  const data = consumeSceneTimelinePublication(input.publication, input.scope);
  const report = buildCanonicalReport(data, input.meta);
  const {owner: _owner, traceMeta: _traceMeta, ...identity} = input.meta;
  const archiveRef = await archive.save({ownerKey: data.scope.ownerKey, traceId: data.scope.traceId,
    reportId: report.reportId, report, assessment: data.assessment,
    cacheIdentity: {...identity, requestedRange: {...identity.requestedRange}, outputLanguage: data.outputLanguage},
    providerProvenance: {providerId: data.providerId, runtime: data.runtimeKind},
  }, input.assertCurrent);
  await input.assertCurrent();
  return {report: projectSceneTimelineReport(report, data.outputLanguage, archiveRef.expiresAt), archiveRef};
}

function canonicalReport(value: unknown, assessment: SceneTimelineAssessment, reportId: string, traceId: string):
  value is SceneTimelineReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Partial<SceneTimelineReport>;
  return report.reportId === reportId && report.traceId === traceId &&
    report.sessionId === assessment.sessionId && report.runId === assessment.runId &&
    report.generatedBy?.pipelineVersion === 'v3' && report.generatedBy.runtime === 'agent-runtime' &&
    report.cachePolicy === 'evidence_archive' && typeof report.summary === 'string' &&
    (report.outputLanguage === 'en' || report.outputLanguage === 'zh-CN') &&
    Number.isFinite(report.totalDurationMs) && report.totalDurationMs! >= 0 &&
    Boolean(report.traceMeta) && Array.isArray(report.insights) &&
    evidenceCaptureHash(report.sceneTimeline) === evidenceCaptureHash(assessment);
}

/** Owner-partitioned history only. An archive miss/integrity failure never falls back to v2 or memory. */
export async function loadFinalizedSceneReport(
  archive: SceneTimelineArchive,
  ownerKey: string,
  reportId: string,
): Promise<SceneTimelineReportView | null> {
  if (!reportId.startsWith(SCENE_TIMELINE_REPORT_PREFIX)) return null;
  const stored = await archive.load(ownerKey, reportId);
  if (!stored || stored.manifest.reportId !== reportId || stored.assessment.traceId !== stored.manifest.traceId ||
    !canonicalReport(stored.report, stored.assessment, reportId, stored.manifest.traceId)) return null;
  const report = stored.report;
  if (report.outputLanguage !== stored.manifest.cacheIdentity.outputLanguage ||
    report.traceHash !== stored.manifest.cacheIdentity.traceContentHash) return null;
  try {return projectSceneTimelineReport({...report, sceneTimeline: stored.assessment}, report.outputLanguage, stored.manifest.expiresAt);}
  catch {return null;}
}
