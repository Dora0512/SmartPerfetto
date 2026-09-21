// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/** Owner-safe serialized scene timeline. Raw audit rows and live receipts never cross this boundary. */
export interface SceneReportReference {
  schemaVersion: 'scene_report_ref@1';
  reportId: string;
  traceId: string;
  sessionId: string;
  runId: string;
  revision: number;
  expiresAt: number;
  manifestSha256: string;
}

export interface SceneTimelineView {
  schemaVersion: 'scene_timeline@1';
  runId: string;
  sessionId: string;
  traceId: string;
  revision: number;
  status: 'partial';
  segments: readonly SceneSegmentView[];
  unresolved: readonly string[];
  diagnostics: readonly SceneTimelineDiagnostic[];
  coverage: {
    /** Query scan coverage only; never capture completeness or story correctness. */
    status: 'unknown' | 'partial' | 'complete';
    captureStatus: 'unknown';
    reason: string;
    planFingerprint?: string;
    targets?: readonly SceneCoverageTargetView[];
    sources: readonly {
      domain: string;
      source: string;
      skillId: string;
      summaryStepId?: string;
      resultStepId: string;
      definitionFingerprint: string;
      scanStatus: 'complete' | 'partial';
      windows: readonly {startNs: string; endNs: string}[];
      issues: readonly string[];
    }[];
  };
}

export interface SceneCoverageTargetView {
  id: string; domain: string; source: string;
  capabilityStatus: 'unknown' | 'queryable';
  observationStatus: 'unknown' | 'observed' | 'unobserved';
  scanStatus: 'unknown' | 'partial' | 'complete';
  scannedWindows: readonly {startNs: string; endNs: string}[];
  unscannedWindows: readonly {startNs: string; endNs: string}[];
  captureUnknownWindows: readonly {startNs: string; endNs: string}[];
  issues: readonly string[];
  historicalIssues: readonly string[];
}

export interface SceneTimelineDiagnostic {
  code: string;
  segmentId?: string;
  referenceIndex?: number;
  detail?: string;
}

export interface SceneTimelineEvidenceReference {
  evidenceRefId?: string;
  artifactId?: string;
  sourceToolCallId?: string;
  rowIndex: number;
  column?: string;
  value?: string | number | boolean | null;
}

export interface SceneTimelineBoundary {
  source: 'evidence' | 'trace_bound' | 'inferred' | 'open';
  evidenceIndex?: number;
  column?: string;
}

export interface SceneSegmentView {
  segment: {
    id: string;
    startNs: string;
    endNs: string;
    object: {kind: string; key: string; machineId?: string};
    userAction: string;
    deviceState: string;
    appResponse: string;
    evidenceRefs: readonly SceneTimelineEvidenceReference[];
    boundaries: {start: SceneTimelineBoundary; end: SceneTimelineBoundary};
    dependencies: readonly string[];
    supersedes: readonly string[];
  };
  contentFingerprint: string;
  dependencyFingerprint: string;
  issuedRevision: number;
  referencesResolved: boolean;
  semanticStatus: 'unverified';
  checks: readonly {predicate: string; status: 'passed' | 'contradicted' | 'unknown'; reason?: string}[];
  diagnostics: readonly SceneTimelineDiagnostic[];
}
