// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash} from 'crypto';
import {z} from 'zod';
import {DEFAULT_SCENE_RUN_LIMITS as limits, sceneCellValueMatches, sceneTimelineSegmentSchema,
  type SceneTimelineAssessment} from '../../agent/scene/sceneTimelineContract';
import {evidenceCaptureHash} from '../evidence/evidenceCapture';
import {assessSceneScanCoverage} from '../../agent/scene/sceneScanCoverage';

// Historical shape validation only: no runtime-context, witness or publication issuer imports.
const id = z.string().min(1).max(256);
const message = z.string().min(1).max(4096);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const int64 = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const window = z.object({startNs: int64, endNs: int64}).strict()
  .refine(value => BigInt(value.startNs) <= BigInt(value.endNs));
const scanWindow = z.object({start: int64, end: int64}).strict()
  .refine(value => BigInt(value.start) <= BigInt(value.end));
const diagnostic = z.object({code: id, segmentId: id.optional(), referenceIndex: count.optional(), detail: message.optional()}).strict();
const finiteCheck = z.object({predicate: z.enum(['time.start_cell_equals_boundary', 'time.end_cell_equals_boundary',
  'identity.cited_object_observed', 'story.semantic']), status: z.enum(['passed', 'contradicted', 'unknown']), reason: message.optional()}).strict()
  .refine(value => value.predicate !== 'story.semantic' || value.status === 'unknown');
const field = z.object({
  origin: z.object({kind: z.enum(['skill_literal', 'native_producer']), definitionFingerprint: id,
    skillId: id.optional(), stepId: id.optional(), selectedSqlHash: id.optional()}).strict(),
  unit: id.optional(), timeRole: z.enum(['start', 'end', 'duration']).optional(), clock: z.literal('trace_monotonic').optional(),
  identityRole: z.enum(['upid', 'utid', 'cpu', 'ucpu', 'machine_id']).optional(), metricId: id.optional(),
  aggregation: id.optional(), populationKey: id.optional(),
}).strict();
const scalar = z.union([z.string().max(limits.maxRunBytes), z.number().finite(), z.boolean(), z.null()]);
const evidence = z.object({captureId: id, originalRowIndex: count, referenceIndex: count, fingerprint: id,
  source: z.object({originRunId: id, artifactId: id.optional(), evidenceRefId: id.optional(), sourceToolCallId: id.optional(),
    skillId: id.optional(), stepId: id.optional(), queryHash: id.optional()}).strict(),
  row: z.record(z.string().min(1).max(256), scalar).refine(value => Object.keys(value).length <= 16_384),
  fields: z.record(z.string().min(1).max(256), field).refine(value => Object.keys(value).length <= 16_384),
}).strict();
const segmentAssessment = z.object({segment: sceneTimelineSegmentSchema,
  contentFingerprint: id, dependencyFingerprint: id, issuedRevision: count.min(1), referencesResolved: z.boolean(),
  semanticStatus: z.literal('unverified'), checks: z.array(finiteCheck).max(4),
  evidence: z.array(evidence).max(limits.maxRequestReferences),
  diagnostics: z.array(diagnostic).max(limits.maxRequestReferences + 8),
}).strict();
const scanReceipt = z.object({recordId: id, captureId: id, resultCaptureId: id.optional(), originRunId: id,
  traceId: id, traceSide: z.literal('current'), skillId: id, stepId: id, resultStepId: id,
  sourceToolCallId: id, definitionFingerprint: id, selectedSqlHash: id, resultSqlHash: id.optional(),
  domain: id, source: id, window: scanWindow, totalRows: int64.optional(), returnedRows: int64.optional(),
  scanStatus: z.enum(['complete', 'partial']), captureStatus: z.literal('unknown'), issues: z.array(id).max(limits.maxDiagnostics),
}).strict().refine(value => value.scanStatus !== 'complete' || (Boolean(value.resultCaptureId && value.resultSqlHash) &&
  value.totalRows !== undefined && value.totalRows === value.returnedRows && value.issues.length === 0));
const coverageSource = z.object({domain: id, source: id, skillId: id, summaryStepId: id.optional(), resultStepId: id, definitionFingerprint: id,
  scanStatus: z.enum(['complete', 'partial']), windows: z.array(window).max(limits.maxScanUnionWindows),
  issues: z.array(id).max(limits.maxDiagnostics * 2 + 2),
}).strict();
const coveragePlan = z.object({fingerprint: id, profileId: id, profileVersion: count.min(1), policyFingerprint: id,
  registryFingerprint: id, strategyRegistryFingerprint: id, targets: z.array(z.object({id, domain: id, source: id,
    producer: z.object({skillId: id, summaryStepId: id, resultStepId: id, definitionFingerprint: id}).strict().optional(),
    requestedProducer: z.object({skillId: id, summaryStepId: id, resultStepId: id}).strict().optional(),
    bindingIssue: id.optional(),
  }).strict().refine(value => Boolean(value.producer) !== Boolean(value.bindingIssue) &&
    (!value.requestedProducer || !value.producer))).min(1).max(limits.maxRequiredTargets),
}).strict().refine(value => {
  const {fingerprint, ...body} = value;
  return fingerprint === evidenceCaptureHash(body) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= limits.maxCoveragePlanBytes &&
    new Set(value.targets.map(target => target.id)).size === value.targets.length &&
    new Set(value.targets.map(target => {
      const producer = target.producer ?? target.requestedProducer;
      return JSON.stringify([target.domain, target.source, producer ? [producer.skillId, producer.summaryStepId, producer.resultStepId] : null]);
    })).size === value.targets.length;
});
const coverageTarget = z.object({id, domain: id, source: id, capabilityStatus: z.enum(['unknown', 'queryable']),
  observationStatus: z.enum(['unknown', 'observed', 'unobserved']), scanStatus: z.enum(['unknown', 'partial', 'complete']),
  scannedWindows: z.array(window).max(limits.maxScanUnionWindows), unscannedWindows: z.array(window).max(limits.maxScanUnionWindows + 1),
  captureUnknownWindows: z.array(window).length(1), issues: z.array(id).max(limits.maxDiagnostics * 2 + 4),
  historicalIssues: z.array(id).max(limits.maxDiagnostics * 2 + 4),
}).strict();
const historicalAssessment = z.object({schemaVersion: z.literal('scene_timeline@1'), runId: id, sessionId: id, traceId: id,
  ownerKey: z.string().min(1).max(4096).optional(), revision: count.max(limits.maxRevisions),
  segments: z.array(segmentAssessment).max(limits.maxSegments), unresolved: z.array(message).max(1024),
  diagnostics: z.array(diagnostic).max(limits.maxDiagnostics * 2 + 2), status: z.literal('partial'),
  coverage: z.object({status: z.enum(['unknown', 'partial', 'complete']), captureStatus: z.literal('unknown'), reason: message,
    planFingerprint: id.optional(), targets: z.array(coverageTarget).min(1).max(limits.maxRequiredTargets).optional(),
    sources: z.array(coverageSource).max(limits.maxScanReceipts)}).strict(),
  scanCoverage: z.object({revision: count.max(limits.maxRevisions), requestedWindow: window,
    receipts: z.array(scanReceipt).max(limits.maxScanReceipts), diagnostics: z.array(diagnostic).max(limits.maxDiagnostics),
    maxUnionWindows: count.min(1).max(limits.maxScanUnionWindows), plan: coveragePlan.optional()}).strict().optional(),
}).strict();

export interface HistoricalSceneAssessmentScope {
  traceId: string; ownerPartition: string; requestedRange: {startNs: string; endNs: string}; maxBytes: number;
}
/** Reject malformed history without normalizing defaults, trimming IDs, or changing any stored fingerprint. */
export function isSceneTimelineHistoricalAssessment(value: unknown, scope: HistoricalSceneAssessmentScope): value is SceneTimelineAssessment {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > scope.maxBytes) return false;
    const original: unknown = JSON.parse(serialized);
    const parsed = historicalAssessment.safeParse(value);
    if (!parsed.success || evidenceCaptureHash(JSON.parse(JSON.stringify(parsed.data))) !== evidenceCaptureHash(original)) return false;
    const item = parsed.data;
    if (item.traceId !== scope.traceId || !window.safeParse(scope.requestedRange).success ||
        (item.ownerKey !== undefined && createHash('sha256').update(item.ownerKey).digest('hex') !== scope.ownerPartition)) return false;
    const inside = (start: string, end: string) => int64.safeParse(start).success && int64.safeParse(end).success &&
      BigInt(start) <= BigInt(end) && BigInt(start) >= BigInt(scope.requestedRange.startNs) && BigInt(end) <= BigInt(scope.requestedRange.endNs);
    const ids = new Set(item.segments.map(entry => entry.segment.id));
    if (ids.size !== item.segments.length) return false;
    let references = 0, edges = 0;
    for (const entry of item.segments) {
      const {segment} = entry;
      references += segment.evidenceRefs.length; edges += segment.dependencies.length + segment.supersedes.length;
      if (!inside(segment.startNs, segment.endNs) || entry.issuedRevision > item.revision ||
          (segment.object.machineId !== undefined && !int64.safeParse(segment.object.machineId).success) ||
          new Set(entry.checks.map(check => check.predicate)).size !== entry.checks.length ||
          new Set(entry.evidence.map(row => row.referenceIndex)).size !== entry.evidence.length ||
          new Set(segment.dependencies).size !== segment.dependencies.length ||
          new Set(segment.supersedes).size !== segment.supersedes.length || segment.supersedes.includes(segment.id) ||
          segment.evidenceRefs.some(reference => !Number.isSafeInteger(reference.rowIndex)) ||
          segment.dependencies.some(parent => parent === segment.id || !ids.has(parent))) return false;
      for (const edge of [segment.boundaries.start, segment.boundaries.end]) {
        if (edge.evidenceIndex !== undefined && !Number.isSafeInteger(edge.evidenceIndex)) return false;
        if (edge.source === 'evidence' && (edge.evidenceIndex === undefined || edge.evidenceIndex >= segment.evidenceRefs.length || !edge.column)) return false;
      }
      for (const excerpt of entry.evidence) {
        const reference = segment.evidenceRefs[excerpt.referenceIndex];
        if (!reference || excerpt.source.originRunId !== item.runId || excerpt.originalRowIndex !== reference.rowIndex ||
            (['artifactId', 'sourceToolCallId'] as const).some(key =>
              reference[key] !== undefined && excerpt.source[key] !== reference[key]) ||
            (reference.evidenceRefId !== undefined && ![excerpt.source.evidenceRefId, excerpt.source.artifactId,
              ...(excerpt.source.artifactId ? [`data:${excerpt.source.artifactId}`, `ev_${excerpt.source.artifactId}`] : [])].includes(reference.evidenceRefId)) ||
            (reference.column !== undefined && reference.value !== undefined &&
              !sceneCellValueMatches(excerpt.row[reference.column], reference.value))) return false;
      }
      if (entry.referencesResolved && (!segment.evidenceRefs.length || entry.evidence.length !== segment.evidenceRefs.length)) return false;
      if (entry.diagnostics.some(issue => issue.segmentId !== undefined && issue.segmentId !== segment.id ||
          issue.referenceIndex !== undefined && issue.referenceIndex >= segment.evidenceRefs.length)) return false;
    }
    if (references > limits.maxRunReferences || edges > limits.maxDependencyEdges) return false;
    const children = new Map<string, string[]>(), remaining = new Map<string, number>();
    for (const {segment} of item.segments) {
      remaining.set(segment.id, segment.dependencies.length);
      for (const parent of segment.dependencies) {
        const descendants = children.get(parent) || []; descendants.push(segment.id); children.set(parent, descendants);
      }
    }
    const ready = [...remaining].filter(([, degree]) => degree === 0).map(([id]) => id);
    for (let index = 0; index < ready.length; index++) for (const child of children.get(ready[index]) || []) {
      const degree = remaining.get(child)! - 1; remaining.set(child, degree); if (degree === 0) ready.push(child);
    }
    if (ready.length !== item.segments.length) return false;
    const scan = item.scanCoverage;
    if (scan) {
      if (scan.revision !== item.revision || scan.requestedWindow.startNs !== scope.requestedRange.startNs ||
          scan.requestedWindow.endNs !== scope.requestedRange.endNs ||
          Buffer.byteLength(JSON.stringify(scan.receipts), 'utf8') > limits.maxScanReceiptBytes ||
          new Set(scan.receipts.map(receipt => receipt.recordId)).size !== scan.receipts.length ||
          scan.receipts.some(receipt => receipt.traceId !== item.traceId || receipt.originRunId !== item.runId ||
            !inside(receipt.window.start, receipt.window.end))) return false;
    }
    if ((item.coverage.targets || item.coverage.planFingerprint || item.coverage.status === 'complete') && !scan?.plan) return false;
    const sourceKeys = new Set<string>();
    let windows = 0;
    for (const source of item.coverage.sources) {
      const key = JSON.stringify([source.domain, source.source, source.skillId, source.summaryStepId, source.resultStepId, source.definitionFingerprint]);
      if (sourceKeys.has(key) || !scan || source.windows.some(range => !inside(range.startNs, range.endNs))) return false;
      sourceKeys.add(key); windows += source.windows.length;
      if (!scan.receipts.some(receipt => JSON.stringify([receipt.domain, receipt.source, receipt.skillId,
        source.summaryStepId === undefined ? undefined : receipt.stepId, receipt.resultStepId, receipt.definitionFingerprint]) === key)) return false;
      if (source.scanStatus === 'complete' && (source.issues.length !== 0 || source.windows.length !== 1 ||
          source.windows[0].startNs !== scope.requestedRange.startNs || source.windows[0].endNs !== scope.requestedRange.endNs)) return false;
    }
    // The existing assessor is a pure DTO projection. Compare only; never replace history or issue authority.
    const derived = assessSceneScanCoverage(scan);
    // Legacy archives keep their original schema, without backfilling today's required policy.
    const comparable = !scan?.plan && item.coverage.sources.every(source => source.summaryStepId === undefined)
      ? {...derived, sources: derived.sources.map(({summaryStepId: _summary, ...source}) => source)} : derived;
    return windows <= limits.maxScanUnionWindows && (!scan ||
      evidenceCaptureHash(comparable) === evidenceCaptureHash(item.coverage));
  } catch {return false;}
}
