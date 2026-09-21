// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {z} from 'zod';

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
export type SceneTimelineProposal = z.infer<typeof sceneTimelineProposalSchema>;
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
export interface SceneProposalResult {
  accepted: boolean; revision: number; diagnostics: readonly SceneDiagnostic[];
  segments?: readonly SceneSegmentAssessment[];
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
