// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {evidenceCaptureHash, freezeEvidenceValue, getCapturedAnchorFacts} from '../../services/evidence/evidenceCapture';
import {bindReadResolutionToAnchor, isIssuedEvidenceReadResolution, type EvidenceReadResolution,
  type EvidenceReadRequest} from '../../services/evidence/evidenceReadView';
import {assertSceneRunActive, mutateSceneRun, type SceneRunContext, type SceneRunState} from './sceneRunContext';
import {sceneTimelineProposalSchema, type SceneTimelineSegment, type SceneProposalResult, type SceneDiagnostic,
  type SceneSegmentAssessment, type SceneFiniteCheck, type SceneEvidenceExcerpt} from './sceneTimelineContract';

import {captureSceneScanCoverage} from './sceneScanCoverage';

export const SCENE_FINITE_RULE_VERSION = 'scene_finite@1';
const SAFE_REFERENCE_FAILURE_REASONS = new Set([
  'multiple_evidence_records', 'identifier_conflict', 'evidence_not_retained', 'execution_witness_mismatch',
  'trace_capture_mismatch', 'trace_outside_read_scope', 'execution_witness_unavailable', 'execution_unavailable',
  'duplicate_evidence_columns', 'invalid_metadata_locator', 'invalid_row_index', 'invalid_row_selector',
  'row_selector_not_unique', 'row_selector_not_found', 'row_index_selector_conflict', 'row_locator_required',
  'row_index_out_of_range', 'required_column_missing', 'unsupported_raw_cell',
]);
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sameObject = (a: SceneTimelineSegment, b: SceneTimelineSegment) => a.object.kind === b.object.kind && a.object.key === b.object.key && a.object.machineId === b.object.machineId;
const contentHash = (segment: SceneTimelineSegment) => evidenceCaptureHash({rule: SCENE_FINITE_RULE_VERSION, segment});
function failure(state: SceneRunState, diagnostics: SceneDiagnostic[]): SceneProposalResult {
  // Keep actionable terminal diagnostics bounded; failed requests are not retained as candidates.
  state.diagnostics = diagnostics.slice(0, state.limits.maxDiagnostics);
  return freezeEvidenceValue({accepted: false, revision: state.revision, diagnostics});
}
function exactNanoseconds(value: unknown, unit: string | undefined): bigint | undefined {
  const scale = unit === 'ns' ? 1n : unit === 'us' ? 1000n : unit === 'ms' ? 1_000_000n : unit === 's' ? 1_000_000_000n : undefined;
  if (scale === undefined || (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isSafeInteger(value))) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || match[2].length + (match[3]?.length || 0) > 80) return undefined;
  const denominator = 10n ** BigInt(match[3]?.length || 0);
  const scaled = BigInt(`${match[1]}${match[2]}${match[3] || ''}`) * scale;
  return scaled % denominator === 0n ? scaled / denominator : undefined;
}
function checkBoundary(segment: SceneTimelineSegment, edge: 'start' | 'end', reads: readonly EvidenceReadResolution[],
  state: SceneRunState): SceneFiniteCheck {
  const boundary = segment.boundaries[edge];
  const wanted = edge === 'start' ? segment.startNs : segment.endNs;
  const predicate = `time.${edge}_cell_equals_boundary`;
  if (boundary.source === 'trace_bound') return {predicate, status:
    wanted === state.options.traceBounds[edge === 'start' ? 'startNs' : 'endNs'] ? 'passed' : 'contradicted'};
  if (boundary.source !== 'evidence' || boundary.evidenceIndex === undefined || !boundary.column) {
    return {predicate, status: 'unknown', reason: 'boundary_not_observed'};
  }
  const read = reads[boundary.evidenceIndex];
  if (!read || read.status !== 'resolved' || !read.row) return {predicate, status: 'unknown', reason: 'boundary_evidence_unavailable'};
  const field = read.record.fields[boundary.column];
  if (!field || !['skill_literal', 'native_producer'].includes(field.origin.kind) ||
      !field.origin.definitionFingerprint?.trim() || field.clock !== 'trace_monotonic' ||
      !['start', 'end'].includes(field.timeRole || '')) return {predicate, status: 'unknown', reason: 'producer_time_semantics_unavailable'};
  const observed = exactNanoseconds(read.row[boundary.column], field.unit);
  return observed === undefined ? {predicate, status: 'unknown', reason: 'inexact_or_unsupported_time_unit'} :
    {predicate, status: observed === BigInt(wanted) ? 'passed' : 'contradicted'};
}
function exactIdentity(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 40 ? value : undefined;
}
function checkObject(segment: SceneTimelineSegment, reads: readonly EvidenceReadResolution[], state: SceneRunState): SceneFiniteCheck {
  const matches: boolean[] = [];
  for (const read of reads) {
    if (read.status !== 'resolved' || !read.row) continue;
    const declared = Object.entries(read.record.fields).filter(([, field]) =>
      ['skill_literal', 'native_producer'].includes(field.origin.kind) && field.origin.definitionFingerprint?.trim());
    const machines = declared.filter(([, field]) => field.identityRole === 'machine_id')
      .map(([column]) => exactIdentity(read.row![column])).filter(value => value !== undefined);
    // A machine-local CPU identifier is not trace-global. Explicit machine claims also need evidence.
    if ((segment.object.kind === 'cpu' && segment.object.machineId === undefined) ||
        (segment.object.machineId !== undefined && !machines.includes(segment.object.machineId))) continue;
    for (const [column, field] of declared) {
      const value = exactIdentity(read.row[column]);
      if (field.identityRole === segment.object.kind && value !== undefined) matches.push(value === segment.object.key);
    }
    const anchor = {context: {traceId: state.options.traceId, traceSide: 'current'}};
    bindReadResolutionToAnchor(anchor, read);
    const row = getCapturedAnchorFacts(anchor)?.nativeRow;
    if (row?.relation === segment.object.kind && exactIdentity(row.id) !== undefined) matches.push(String(row.id) === segment.object.key);
  }
  return {predicate: 'identity.cited_object_observed', status: matches.length ?
    matches.some(Boolean) ? 'passed' : 'contradicted' : 'unknown',
    ...(!matches.length ? {reason: 'producer_identity_semantics_unavailable'} : {})};
}
/** Active run tool handler. Mutations are atomic across async evidence reads. */
export async function proposeSceneTimeline(handle: SceneRunContext, input: unknown): Promise<SceneProposalResult> {
  return mutateSceneRun(handle, async state => {
    let inputBytes: number;
    try {inputBytes = byteSize(input);} catch {return failure(state, [{code: 'invalid_proposal_json'}]);}
    if (inputBytes > state.limits.maxProposalBytes || state.consumed.bytes + inputBytes > state.limits.maxRunBytes) {
      return failure(state, [{code: 'scene_byte_budget_exhausted'}]);
    }
    const parsed = sceneTimelineProposalSchema.safeParse(input);
    if (!parsed.success) return failure(state, [{code: 'invalid_proposal', detail: parsed.error.issues
      .slice(0, 12).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}]);
    const proposal = parsed.data;
    const fingerprint = evidenceCaptureHash(proposal);
    const replay = state.proposals.get(proposal.proposalId);
    if (replay) return replay.fingerprint === fingerprint ? replay.result : failure(state, [{code: 'proposal_id_content_conflict'}]);
    if (proposal.baseRevision !== state.revision) return failure(state, [{code: 'stale_base_revision'}]);
    if (state.revision >= state.limits.maxRevisions) return failure(state, [{code: 'scene_revision_budget_exhausted'}]);
    if (state.consumed.candidates + proposal.segments.length > state.limits.maxRunCandidates) {
      return failure(state, [{code: 'scene_cumulative_candidate_budget_exhausted'}]);
    }
    state.consumed.candidates += proposal.segments.length;
    state.consumed.bytes += inputBytes;
    const segments = new Map([...state.segments].map(([id, value]) => [id, value.segment]));
    const diagnostics: SceneDiagnostic[] = [];
    const incomingIds = new Set(proposal.segments.map(segment => segment.id));
    if (incomingIds.size !== proposal.segments.length) diagnostics.push({code: 'duplicate_segment_id'});
    const removed = new Set(proposal.removeSegmentIds);
    for (const id of removed) {
      if (!segments.has(id) || incomingIds.has(id)) diagnostics.push({code: 'invalid_segment_removal', segmentId: id});
      segments.delete(id);
    }
    const superseded = new Set<string>();
    for (const segment of proposal.segments) {
      if (BigInt(segment.startNs) > BigInt(segment.endNs) || BigInt(segment.startNs) < BigInt(state.options.traceBounds.startNs) ||
          BigInt(segment.endNs) > BigInt(state.options.traceBounds.endNs)) diagnostics.push({code: 'segment_outside_trace', segmentId: segment.id});
      for (const parent of segment.supersedes) {
        const priorLineage = state.segments.get(segment.id)?.segment.supersedes || [];
        const historical = priorLineage.includes(parent) ? [...state.proposals.values()]
          .flatMap(entry => entry.result.segments || []).find(entry => entry.segment.id === parent)?.segment : undefined;
        const old = state.segments.get(parent)?.segment || historical;
        if (!old || parent === segment.id || incomingIds.has(parent) || !sameObject(old, segment) ||
            BigInt(segment.startNs) > BigInt(old.endNs) || BigInt(segment.endNs) < BigInt(old.startNs)) {
          diagnostics.push({code: 'invalid_supersedes', segmentId: segment.id, detail: parent});
        }
        superseded.add(parent);
      }
      for (const edge of [segment.boundaries.start, segment.boundaries.end]) {
        if (edge.source === 'evidence' && (edge.evidenceIndex === undefined || !edge.column || edge.evidenceIndex >= segment.evidenceRefs.length)) {
          diagnostics.push({code: 'invalid_boundary_reference', segmentId: segment.id});
        }
      }
      segments.set(segment.id, segment);
    }
    superseded.forEach(id => segments.delete(id));
    if (segments.size > state.limits.maxSegments) diagnostics.push({code: 'scene_candidate_budget_exhausted'});
    const hashes = new Map<string, string>();
    const visiting = new Set<string>();
    const dependencyFingerprint = (id: string): string => {
      if (hashes.has(id)) return hashes.get(id)!;
      if (visiting.has(id)) {diagnostics.push({code: 'dependency_cycle', segmentId: id}); return '';}
      const segment = segments.get(id);
      if (!segment) {diagnostics.push({code: 'dependency_missing', segmentId: id}); return '';}
      visiting.add(id);
      const fingerprint = evidenceCaptureHash({content: contentHash(segment), dependencies:
        [...new Set(segment.dependencies)].sort().map(parent => [parent, dependencyFingerprint(parent)])});
      visiting.delete(id); hashes.set(id, fingerprint); return fingerprint;
    };
    for (const id of segments.keys()) dependencyFingerprint(id);
    const edges = proposal.segments.reduce((total, segment) => total + segment.dependencies.length + segment.supersedes.length, 0);
    if (state.consumed.dependencyEdges + edges > state.limits.maxDependencyEdges) diagnostics.push({code: 'scene_dependency_budget_exhausted'});
    if (diagnostics.length) return failure(state, diagnostics);
    state.consumed.dependencyEdges += edges;
    const reusable = (segment: SceneTimelineSegment): boolean => {
      const previous = state.segments.get(segment.id);
      return Boolean(previous?.referencesResolved && previous.dependencyFingerprint === hashes.get(segment.id));
    };
    const changed = [...segments.values()].filter(segment => !reusable(segment));
    const referenceCount = changed.reduce((total, segment) => total + segment.evidenceRefs.length, 0);
    if (referenceCount > state.limits.maxRequestReferences || state.consumed.references + referenceCount > state.limits.maxRunReferences) {
      return failure(state, [{code: 'scene_reference_budget_exhausted'}]);
    }
    if (state.consumed.receipts + changed.length > state.limits.maxReceipts) return failure(state, [{code: 'scene_receipt_budget_exhausted'}]);
    const next = new Map<string, SceneSegmentAssessment>();
    for (const segment of segments.values()) {
      const previous = state.segments.get(segment.id);
      if (previous && reusable(segment)) next.set(segment.id, previous);
    }
    const requests: (EvidenceReadRequest & {segmentId: string; referenceIndex: number})[] = changed.flatMap(segment => segment.evidenceRefs.map((reference, index) => ({
      key: `${segment.id}:${index}`, segmentId: segment.id, referenceIndex: index, reference, requiredColumns: [...new Set([
        ...(reference.column ? [reference.column] : []), ...[segment.boundaries.start, segment.boundaries.end]
          .filter(edge => edge.evidenceIndex === index && edge.column).map(edge => edge.column!),
      ])],
    })));
    const reads = new Map<string, EvidenceReadResolution>();
    // Each chunk takes a fresh bounded view, admitting newly captured evidence without increasing ordinary finalization limits.
    for (let start = 0; start < requests.length; start += state.limits.maxReferencesPerRead) {
      assertSceneRunActive(state);
      const chunk = requests.slice(start, start + state.limits.maxReferencesPerRead);
      state.consumed.references += chunk.length;
      let resolutions: readonly EvidenceReadResolution[];
      try {resolutions = await state.options.createEvidenceReadView().resolveReferences(chunk, state.options.signal);}
      catch {assertSceneRunActive(state); return failure(state, [{code: 'scene_evidence_read_failed', detail: 'Reacquire evidence during the active analysis run.'}]);}
      assertSceneRunActive(state);
      for (const request of chunk) {
        // Only caller-provided coordinates are returned; never echo a captured value or foreign scope.
        const location = {segmentId: request.segmentId, referenceIndex: request.referenceIndex,
          ...(request.reference.column ? {detail: `column: ${request.reference.column}`} : {})};
        const matches = resolutions.filter(read => read.key === request.key);
        if (matches.length !== 1) return failure(state, [{code: 'invalid_evidence_resolution', ...location}]);
        const read = matches[0];
        if (read.status === 'resolved') {
          if (!isIssuedEvidenceReadResolution(read) || read.record.originRunId !== state.options.runId ||
              read.record.meta.traceId !== state.options.traceId || read.record.meta.traceSide !== 'current' || !read.row ||
              read.originalRowIndex === undefined) return failure(state, [{code: 'evidence_scope_or_witness_mismatch', ...location}]);
          if (request.reference.column && request.reference.value !== undefined &&
              read.row[request.reference.column] !== request.reference.value) return failure(state, [{code: 'evidence_value_mismatch', ...location}]);
        } else if (read.status !== 'incomplete') {
          const reason = SAFE_REFERENCE_FAILURE_REASONS.has(read.reason) ? read.reason : 'reference_unavailable';
          return failure(state, [{code: 'evidence_reference_rejected', ...location,
            detail: `${reason}; requiredColumns: ${JSON.stringify(request.requiredColumns)}; reacquire current-run evidence and resubmit.`}]);
        }
        reads.set(request.key, read);
      }
    }
    let receiptBytes = 0;
    for (const segment of changed) {
      const resolved = segment.evidenceRefs.map((_, index) => reads.get(`${segment.id}:${index}`)!);
      const evidence: SceneEvidenceExcerpt[] = resolved.flatMap((read, referenceIndex) => read.status === 'resolved' ? [{
        captureId: read.record.captureId, originalRowIndex: read.originalRowIndex!, referenceIndex,
        fingerprint: evidenceCaptureHash({record: read.record, row: read.row, rowIndex: read.originalRowIndex}),
        source: {originRunId: read.record.originRunId!, artifactId: read.record.meta.artifactId,
          evidenceRefId: read.record.meta.evidenceRefId, sourceToolCallId: read.record.meta.sourceToolCallId,
          skillId: read.record.meta.skillId, stepId: read.record.meta.stepId, queryHash: read.record.meta.queryHash},
        row: read.row!, fields: read.record.fields,
      }] : []);
      const checks = [checkBoundary(segment, 'start', resolved, state), checkBoundary(segment, 'end', resolved, state),
        checkObject(segment, resolved, state), {predicate: 'story.semantic', status: 'unknown' as const, reason: 'unsupported_semantic_predicate'}];
      const localDiagnostics: SceneDiagnostic[] = resolved.flatMap((read, referenceIndex) => read.status !== 'resolved'
        ? [{code: 'evidence_read_incomplete', segmentId: segment.id, referenceIndex, detail: read.reason}] : []);
      if (!resolved.length) localDiagnostics.push({code: 'no_segment_evidence', segmentId: segment.id});
      checks.filter(check => check.status === 'contradicted').forEach(check => localDiagnostics.push({code: 'finite_check_contradicted',
        segmentId: segment.id, detail: check.predicate}));
      const assessment: SceneSegmentAssessment = freezeEvidenceValue({segment, contentFingerprint: contentHash(segment),
        dependencyFingerprint: hashes.get(segment.id)!, issuedRevision: state.revision + 1,
        referencesResolved: resolved.length > 0 && resolved.every(read => read.status === 'resolved'), semanticStatus: 'unverified',
        checks, evidence, diagnostics: localDiagnostics});
      receiptBytes += byteSize(assessment);
      next.set(segment.id, assessment);
    }
    if (state.consumed.bytes + receiptBytes > state.limits.maxRunBytes) return failure(state, [{code: 'scene_byte_budget_exhausted'}]);
    assertSceneRunActive(state);
    state.consumed.bytes += receiptBytes;
    captureSceneScanCoverage(handle);
    assertSceneRunActive(state);
    state.consumed.receipts += changed.length;
    state.segments = next; state.revision += 1; state.unresolved = freezeEvidenceValue(proposal.unresolved);
    state.diagnostics = [];
    const result = freezeEvidenceValue({accepted: true, revision: state.revision, diagnostics: [...next.values()].flatMap(item => item.diagnostics),
      segments: [...next.values()]});
    state.proposals.set(proposal.proposalId, {fingerprint, result});
    return result;
  });
}
