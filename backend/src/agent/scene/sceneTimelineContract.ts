// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {z} from 'zod';
import {exactNumbersEqual} from '../../utils/exactDecimal';

const id = z.string().trim().min(1).max(256);
export const sceneNanosecondsSchema = z.string().regex(/^(0|[1-9]\d*)$/).max(40);
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
export const sceneEvidenceReferenceSchema = z.object({
  evidenceRefId: id.optional(), artifactId: id.optional(), sourceToolCallId: id.optional(),
  rowIndex: z.number().int().nonnegative(), column: id.optional(), value: scalar.optional(),
}).strict().refine(value => Boolean(value.evidenceRefId || value.artifactId || value.sourceToolCallId),
  'An execution evidence identifier is required');
const boundary = z.object({source: z.enum(['evidence', 'trace_bound', 'inferred', 'open']),
  evidenceIndex: z.number().int().nonnegative().optional(), column: id.optional()}).strict();
export const sceneTimelineSegmentSchema = z.object({
  id,
  startNs: sceneNanosecondsSchema,
  endNs: sceneNanosecondsSchema,
  object: z.object({kind: id, key: id, machineId: sceneNanosecondsSchema.optional()}).strict(),
  userAction: z.string().min(1).max(4096),
  deviceState: z.string().min(1).max(4096),
  appResponse: z.string().min(1).max(4096),
  evidenceRefs: z.array(sceneEvidenceReferenceSchema).max(4096),
  boundaries: z.object({start: boundary, end: boundary}).strict(),
  dependencies: z.array(id).max(4096).default([]),
  supersedes: z.array(id).max(4096).default([]),
}).strict();
/** Delta manifest. Unmentioned members retain their content, never model-supplied receipts. */
export const sceneTimelineProposalSchema = z.object({
  baseRevision: z.number().int().nonnegative(), proposalId: id,
  segments: z.array(sceneTimelineSegmentSchema).max(4096),
  removeSegmentIds: z.array(id).max(4096).default([]),
  unresolved: z.array(z.string().min(1).max(4096)).max(1024).default([]),
}).strict();
/**
 * The proposal tool's published input. MCP hosts validate a call against it
 * before the handler runs, so it keeps the structure and required fields for
 * the model but lets representational noise through: optional fields accept
 * null, identifiers accept blanks, and nested objects keep unknown keys. The
 * strict contract above then decides per change group with repairable
 * diagnostics. (A host may still drop unknown top-level keys; they never reach
 * the stored revision either way.)
 */
const toolId = z.string().max(256);
const toolNs = z.string().max(40);
const toolText = z.string().max(4096);
const toolReference = z.object({evidenceRefId: toolId.nullable().optional(), artifactId: toolId.nullable().optional(),
  sourceToolCallId: toolId.nullable().optional(), rowIndex: z.number().nullable(), column: toolId.nullable().optional(),
  value: scalar.optional()}).passthrough();
const toolBoundary = z.object({source: z.enum(['evidence', 'trace_bound', 'inferred', 'open']),
  evidenceIndex: z.number().nullable().optional(), column: toolId.nullable().optional()}).passthrough();
export const sceneTimelineSegmentToolSchema = z.object({
  id: toolId, startNs: toolNs, endNs: toolNs,
  object: z.object({kind: toolId, key: toolId, machineId: toolNs.nullable().optional()}).passthrough(),
  userAction: toolText, deviceState: toolText, appResponse: toolText,
  evidenceRefs: z.array(toolReference).max(4096),
  boundaries: z.object({start: toolBoundary, end: toolBoundary}).passthrough(),
  dependencies: z.array(toolId).max(4096).nullable().optional(),
  supersedes: z.array(toolId).max(4096).nullable().optional(),
}).passthrough();
export const sceneTimelineProposalToolShape = {
  baseRevision: z.number(), proposalId: toolId,
  segments: z.array(sceneTimelineSegmentToolSchema).max(4096),
  removeSegmentIds: z.array(toolId).max(4096).nullable().optional(),
  unresolved: z.array(toolText).max(1024).nullable().optional(),
};

/** Envelope parsed first; each segment is validated on its own so one bad member cannot hide the rest. */
export const sceneTimelineProposalEnvelopeSchema = sceneTimelineProposalSchema.extend({segments: z.array(z.unknown()).max(4096)});
export type SceneTimelineProposal = z.infer<typeof sceneTimelineProposalSchema>;
/**
 * A quoted cell must denote the captured value. A numeric cell may be quoted as
 * an exactly equal decimal string, which is how nanosecond fields travel in the
 * same payload; this is the claim verifier's exact-number rule, so unsafe
 * integers, booleans and other coercions never match. Live proposals and
 * archived assessments use this one rule.
 */
export function sceneCellValueMatches(captured: unknown, claimed: unknown): boolean {
  if (captured === claimed) return true;
  const mixed = (typeof captured === 'number' && typeof claimed === 'string') ||
    (typeof captured === 'string' && typeof claimed === 'number');
  return mixed && exactNumbersEqual(captured, claimed);
}
export type SceneTimelineSegment = z.infer<typeof sceneTimelineSegmentSchema>;
export interface SceneScope {runId: string; sessionId: string; traceId: string; ownerKey: string}
export interface SceneDiagnostic {code: string; segmentId?: string; referenceIndex?: number; detail?: string}
export interface SceneFiniteCheck {predicate: string; status: 'passed' | 'contradicted' | 'unknown'; reason?: string}
export interface SceneEvidenceExcerpt {
  captureId: string; originalRowIndex: number; referenceIndex: number; fingerprint: string;
  source: {originRunId: string; artifactId?: string; evidenceRefId?: string; sourceToolCallId?: string;
    skillId?: string; stepId?: string; queryHash?: string};
  row: Readonly<Record<string, string | number | boolean | null>>;
  fields: import('../../services/evidence/evidenceCapture').CapturedEvidenceTable['fields'];
}
export interface SceneSegmentAssessment {
  segment: SceneTimelineSegment;
  contentFingerprint: string;
  dependencyFingerprint: string;
  issuedRevision: number;
  referencesResolved: boolean;
  /** Finite checks never certify the free-form story. */
  semanticStatus: 'unverified';
  checks: readonly SceneFiniteCheck[];
  evidence: readonly SceneEvidenceExcerpt[];
  diagnostics: readonly SceneDiagnostic[];
}
export interface SceneTimelineSnapshot {
  schemaVersion: 'scene_timeline@1'; runId: string; sessionId: string; traceId: string;
  revision: number; segments: readonly SceneSegmentAssessment[];
  unresolved: readonly string[]; diagnostics: readonly SceneDiagnostic[];
  scanCoverage?: SceneScanCoverageSnapshot;
}
export interface SceneTimelineAssessment extends SceneTimelineSnapshot {
  status: 'partial';
  coverage: SceneScanCoverageAssessment;
}
export interface SceneScanCoverageSnapshot {
  revision: number; requestedWindow: {startNs: string; endNs: string};
  receipts: readonly import('../../services/evidence/investigationEvidenceLedger').InvestigationScanRecord[];
  diagnostics: readonly SceneDiagnostic[]; maxUnionWindows: number;
  plan?: SceneCoveragePlan;
}
export interface SceneCoveragePlan {
  fingerprint: string; profileId: string; profileVersion: number; policyFingerprint: string; registryFingerprint: string;
  strategyRegistryFingerprint: string;
  targets: readonly {id: string; domain: string; source: string;
    producer?: {skillId: string; summaryStepId: string; resultStepId: string; definitionFingerprint: string};
    requestedProducer?: {skillId: string; summaryStepId: string; resultStepId: string};
    bindingIssue?: string}[];
}
export type SceneScanCoverageAssessment = import('../../types/sceneTimeline').SceneTimelineView['coverage'];
/**
 * An atomic change group that did not commit. Its members keep their committed
 * versions and lineage; none of its supersedes or removals were applied.
 */
export interface SceneRejectedGroup {
  segmentIds: readonly string[];
  segmentIndices: readonly number[];
  removedSegmentIds: readonly string[];
  diagnostics: readonly SceneDiagnostic[];
}
export interface SceneProposalResult {
  accepted: boolean; revision: number; diagnostics: readonly SceneDiagnostic[];
  segments?: readonly SceneSegmentAssessment[];
  /** Removals this commit applied. */
  removedSegmentIds?: readonly string[];
  rejectedGroups?: readonly SceneRejectedGroup[];
}
export interface SceneRunLimits {
  maxSegments: number; maxRunCandidates: number; maxDiagnostics: number; maxRevisions: number; maxReceipts: number; maxDependencyEdges: number;
  maxProposalBytes: number; maxRunBytes: number; maxRunReferences: number; maxRequestReferences: number;
  maxReferencesPerRead: number; maxScanReceipts: number; maxScanReceiptBytes: number; maxScanUnionWindows: number;
  maxRequiredTargets: number; maxCoveragePlanBytes: number;
}
/** Resource bounds only; scenario semantics belong in Skills/Strategies. */
export const DEFAULT_SCENE_RUN_LIMITS: Readonly<SceneRunLimits> = Object.freeze({
  maxSegments: 2000, maxRunCandidates: 8000, maxDiagnostics: 128, maxRevisions: 64, maxReceipts: 8000, maxDependencyEdges: 16000,
  maxProposalBytes: 1_048_576, maxRunBytes: 16_777_216, maxRunReferences: 32768,
  maxRequestReferences: 4096, maxReferencesPerRead: 128, maxScanReceipts: 2048,
  maxScanReceiptBytes: 2_097_152, maxScanUnionWindows: 2048,
  maxRequiredTargets: 64, maxCoveragePlanBytes: 65_536,
});
