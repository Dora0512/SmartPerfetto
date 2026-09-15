// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {RuntimeToolInvocationEvent} from '../../agentRuntime/runtimeToolObserver';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../finalSemanticLimits';
import type {EvidenceReadRecord, EvidenceReadViewOptions} from './evidenceReadView';
import {capturedEvidenceTable, evidenceCaptureHash, freezeEvidenceValue,
  type CapturedFieldSemantics, type EvidenceScalar, type EvidenceTableWitness} from './evidenceCapture';

/** Producer-owned raw-column mappings. Neither display labels nor SQL aliases imply semantics. */
export interface InvestigationEvidenceDeclaration {
  window: {start: string; end: string};
  identity?: {upid?: string; utid?: string; cpu?: string; ucpu?: string; machine_id?: string};
  context?: {window_id?: string; role?: string};
  metrics: Array<{domain: string; metric_id: string; value: string; unit?: string;
    status: string; coverage?: string; denominator?: string; aggregation?: string}>;
}
interface ProducerBinding {
  declaration: InvestigationEvidenceDeclaration;
  definitionFingerprint: string;
  selectedSqlHash: string;
  skillId: string;
  stepId: string;
  traceId: string;
}
export interface InvestigationEvidenceRecord {
  readonly recordId: string;
  readonly captureId: string;
  readonly rowIndex: number;
  readonly evidenceRefId?: string;
  readonly artifactId?: string;
  readonly sourceToolCallId?: string;
  readonly skillId: string;
  readonly stepId: string;
  readonly definitionFingerprint: string;
  readonly selectedSqlHash: string;
  readonly traceId: string;
  readonly traceSide: 'current' | 'reference';
  readonly originRunId?: string;
  readonly origin: 'current_run' | 'reused' | 'unknown';
  readonly domain: string;
  readonly metricId: string;
  readonly status: 'observed' | 'partial' | 'unavailable' | 'unknown';
  readonly window: {readonly start: number | string; readonly end: number | string};
  readonly upid?: number;
  readonly utid?: number;
  readonly cpu?: number | null;
  readonly ucpu?: number | null;
  readonly machineId?: number | null;
  readonly windowId?: number | string | null;
  readonly role?: string | null;
  readonly aggregation?: string;
  readonly value: EvidenceScalar;
  readonly unit?: string;
  readonly coverage?: number | string;
  readonly denominator?: number | string;
}
export interface InvestigationEvidenceSnapshot {
  readonly schemaVersion: 'investigation_evidence@1';
  readonly ownerKey: string;
  readonly currentRunId?: string;
  readonly fingerprint: string;
  readonly records: readonly InvestigationEvidenceRecord[];
  readonly issues: readonly string[];
  readonly incompleteCaptureIds?: readonly string[];
  readonly complete: boolean;
}
const bindings = new WeakMap<EvidenceTableWitness, ProducerBinding>();
const issuedSnapshots = new WeakSet<object>();
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const exactNs = (value: unknown): value is number | string =>
  (nonnegative(value) && Number.isSafeInteger(value)) ||
  (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20);

export function isInvestigationEvidenceDeclaration(value: unknown): value is InvestigationEvidenceDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const declaration = value as InvestigationEvidenceDeclaration;
  return Boolean(declaration.window && nonempty(declaration.window.start) && nonempty(declaration.window.end) &&
    (!declaration.identity || Object.entries(declaration.identity).every(([key, column]) =>
      ['upid', 'utid', 'cpu', 'ucpu', 'machine_id'].includes(key) && nonempty(column))) &&
    (!declaration.context || Object.entries(declaration.context).every(([key, column]) =>
      ['window_id', 'role'].includes(key) && nonempty(column))) &&
    Array.isArray(declaration.metrics) && declaration.metrics.length > 0 && declaration.metrics.every(metric =>
      metric && nonempty(metric.domain) && nonempty(metric.metric_id) && nonempty(metric.value) && nonempty(metric.status) &&
      [metric.unit, metric.coverage, metric.denominator, metric.aggregation].every(field => field === undefined || nonempty(field)) &&
      (metric.coverage === undefined) === (metric.denominator === undefined)));
}

/** Validate nested Skill declarations before admitting a definition into the executor. */
export function validateInvestigationEvidenceDeclarations(definition: object): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'investigation_evidence' && !isInvestigationEvidenceDeclaration(child)) {
        throw new Error('Invalid investigation_evidence producer declaration');
      }
      if (key === 'investigation_evidence') investigationCaptureFields(child as InvestigationEvidenceDeclaration,
        {kind: 'skill_literal', definitionFingerprint: 'declaration_validation'});
      visit(child);
    }
  };
  visit(definition);
}

export function investigationCaptureFields(declaration: InvestigationEvidenceDeclaration | undefined,
  origin: CapturedFieldSemantics['origin']): Record<string, CapturedFieldSemantics> {
  if (!declaration) return {};
  const fields: Record<string, CapturedFieldSemantics> = Object.create(null);
  const merge = (column: string, next: CapturedFieldSemantics): void => {
    const previous = fields[column];
    for (const key of ['unit', 'timeRole', 'clock', 'metricId', 'aggregation', 'populationKey'] as const) {
      if (previous?.[key] !== undefined && next[key] !== undefined && previous[key] !== next[key]) {
        throw new Error(`Invalid investigation_evidence conflicting field semantics: ${column}.${key}`);
      }
    }
    fields[column] = {...previous, ...next};
  };
  merge(declaration.window.start, {origin, unit: 'ns', timeRole: 'start', clock: 'trace_monotonic'});
  merge(declaration.window.end, {origin, unit: 'ns', timeRole: 'end', clock: 'trace_monotonic'});
  for (const metric of declaration.metrics) {
    merge(metric.value, {origin, metricId: metric.metric_id, ...(metric.unit ? {unit: metric.unit} : {}),
      ...(metric.aggregation ? {aggregation: metric.aggregation} : {})});
    for (const column of [metric.coverage, metric.denominator]) {
      if (column) merge(column, {origin, unit: 'ns', timeRole: 'duration'});
    }
  }
  return fields;
}

/** Called only with the original successful SQL response witness by SkillExecutor. */
export function attachInvestigationEvidence(witness: EvidenceTableWitness, binding: ProducerBinding): void {
  if (!capturedEvidenceTable(witness) || bindings.has(witness) || !isInvestigationEvidenceDeclaration(binding.declaration) ||
      ![binding.definitionFingerprint, binding.selectedSqlHash, binding.skillId, binding.stepId, binding.traceId].every(nonempty)) return;
  try {
    investigationCaptureFields(binding.declaration, {kind: 'skill_literal', definitionFingerprint: binding.definitionFingerprint});
  } catch { return; }
  bindings.set(witness, freezeEvidenceValue(structuredClone(binding)));
}

export type InvestigationToolObservation = {toolCallId: string; phase: 'started' | 'completed' | 'failed'; failed: boolean; originRunId?: string};
export function captureInvestigationToolObservation(event: RuntimeToolInvocationEvent): InvestigationToolObservation {
  return Object.freeze({toolCallId: event.toolCallId, phase: event.phase,
    failed: event.phase === 'failed' || (event.phase === 'completed' && event.result.isError === true)});
}

export function investigationEvidenceFingerprint(snapshot: Omit<InvestigationEvidenceSnapshot, 'fingerprint'>): string {
  const {schemaVersion, ownerKey, currentRunId, records, issues, complete, incompleteCaptureIds} = snapshot;
  return evidenceCaptureHash({schemaVersion, ownerKey, currentRunId, records, issues, complete,
    ...(incompleteCaptureIds ? {incompleteCaptureIds} : {})});
}
export function isIssuedInvestigationEvidenceSnapshot(value: unknown): value is InvestigationEvidenceSnapshot {
  return Boolean(value && typeof value === 'object' && issuedSnapshots.has(value));
}

export type CompactInvestigationEvidenceRecord = Pick<InvestigationEvidenceRecord,
  'recordId' | 'captureId' | 'domain' | 'metricId' | 'status' | 'origin' | 'originRunId' |
  'traceId' | 'traceSide' | 'window' | 'upid' | 'utid' | 'cpu' | 'ucpu' | 'machineId' |
  'windowId' | 'role' | 'aggregation' | 'value' | 'unit' | 'coverage' | 'denominator'>;
export interface CompactInvestigationEvidenceSnapshot {
  readonly schemaVersion: 'compact_investigation_evidence@1';
  /** Fingerprint of the complete retained ledger, not this provider projection. */
  readonly fingerprint: string;
  readonly byteBudget: number;
  readonly records: readonly CompactInvestigationEvidenceRecord[];
  readonly omittedRecordCount: number;
  readonly issues: readonly string[];
  readonly incompleteCaptureIds?: readonly string[];
  readonly complete: boolean;
}

/** Bounded provider projection. Cohorts are kept whole and never selected by success or value. */
function compactInvestigationEvidenceWithin(snapshot: InvestigationEvidenceSnapshot,
  maxBytes: number, ceilingBytes: number): CompactInvestigationEvidenceSnapshot | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ceilingBytes) return undefined;
  const groups = new Map<string, CompactInvestigationEvidenceRecord[]>();
  for (const record of snapshot.records) {
    const {recordId, captureId, domain, metricId, status, origin, originRunId, traceId, traceSide,
      window, upid, utid, cpu, ucpu, machineId, windowId, role, aggregation, value, unit, coverage, denominator} = record;
    const key = JSON.stringify([captureId, metricId, traceId, traceSide, String(window.start), String(window.end), windowId]);
    const group = groups.get(key) || [];
    group.push({recordId, captureId, domain, metricId, status, origin, originRunId, traceId, traceSide,
      window, upid, utid, cpu, ucpu, machineId, windowId, role, aggregation, value, unit, coverage, denominator});
    groups.set(key, group);
  }
  const envelope = (records: CompactInvestigationEvidenceRecord[]): CompactInvestigationEvidenceSnapshot => {
    const omittedRecordCount = snapshot.records.length - records.length;
    return {schemaVersion: 'compact_investigation_evidence@1', fingerprint: snapshot.fingerprint, byteBudget: maxBytes,
      records, omittedRecordCount, issues: [...new Set([...snapshot.issues,
        ...(omittedRecordCount ? ['investigation_provider_view_omitted_records'] : [])])].sort(),
      ...(snapshot.incompleteCaptureIds ? {incompleteCaptureIds: [...snapshot.incompleteCaptureIds]} : {}),
      complete: snapshot.complete && omittedRecordCount === 0};
  };
  const fits = (view: CompactInvestigationEvidenceSnapshot) => Buffer.byteLength(JSON.stringify(view), 'utf8') <= maxBytes;
  let view = envelope([]);
  if (!fits(view)) return undefined;
  for (const group of groups.values()) {
    const candidate = envelope([...view.records, ...group]);
    if (!fits(candidate)) break;
    view = candidate;
  }
  return freezeEvidenceValue(view);
}

/** Preserve the existing general provider-view contract and its 64 KiB ceiling. */
export function compactInvestigationEvidence(snapshot: InvestigationEvidenceSnapshot,
  maxBytes = 64 * 1024): CompactInvestigationEvidenceSnapshot | undefined {
  return compactInvestigationEvidenceWithin(snapshot, maxBytes, 64 * 1024);
}

/** Semantic review may use the shared total-input ceiling; final prompt sizing remains authoritative. */
export function compactInvestigationEvidenceForSemantic(snapshot: InvestigationEvidenceSnapshot,
  maxBytes: number): CompactInvestigationEvidenceSnapshot | undefined {
  return compactInvestigationEvidenceWithin(snapshot, maxBytes, FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
}

/** The caller supplies retained private witnesses, never serialized artifact payloads. */
export function buildInvestigationEvidenceSnapshot(captures: readonly EvidenceReadRecord[], options: EvidenceReadViewOptions,
  observations: readonly InvestigationToolObservation[] = []): InvestigationEvidenceSnapshot {
  const records: InvestigationEvidenceRecord[] = [];
  const issues = new Set<string>();
  const incompleteCaptureIds = new Set<string>();
  const allowed = new Set(options.allowedTraces.map(trace => `${trace.traceSide}:${trace.traceId}`));
  const toolStates = new Map(observations.map(observation => [`${observation.originRunId || ''}:${observation.toolCallId}`, observation]));
  for (const observation of toolStates.values()) {
    if ((!options.currentRunId || observation.originRunId === options.currentRunId) &&
        (observation.phase === 'started' || observation.failed)) issues.add('tool_observation_incomplete');
  }
  for (const {record, witness} of captures) {
    const binding = bindings.get(witness);
    if (!binding) continue; // Arbitrary SQL does not acquire producer authority by choosing familiar aliases.
    const incomplete = (issue: string) => {issues.add(issue); incompleteCaptureIds.add(witness.captureId);};
    const table = capturedEvidenceTable(witness);
    const meta = record.meta;
    if (!table || table.unavailableReason || record.captureId !== witness.captureId ||
        binding.traceId !== meta.traceId || !allowed.has(`${meta.traceSide}:${meta.traceId}`) ||
        !['current', 'reference'].includes(meta.traceSide || '')) {
      incomplete('capture_scope_or_witness_unavailable'); continue;
    }
    if (meta.executionStatus === 'unavailable' || meta.executionStatus === 'optional_error') {
      incomplete('capture_execution_unavailable'); continue;
    }
    const observation = meta.sourceToolCallId ? toolStates.get(`${record.originRunId || ''}:${meta.sourceToolCallId}`) : undefined;
    const toolChecked = observation?.phase === 'completed' && !observation.failed;
    if (!toolChecked) incomplete('capture_tool_observation_missing');
    if (new Set(table.columns).size !== table.columns.length) {incomplete('capture_columns_ambiguous'); continue;}
    if (!table.rows.length) {incomplete('capture_empty'); continue;}
    const {declaration} = binding;
    const originRunId = record.originRunId;
    const origin = originRunId && options.currentRunId
      ? originRunId === options.currentRunId ? 'current_run' : 'reused' : 'unknown';
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
      if (records.length >= 4096) {incomplete('ledger_record_budget_exhausted'); break;}
      const read = (column: string | undefined) => column ? table.rows[rowIndex][table.columns.indexOf(column)] : undefined;
      const start = read(declaration.window.start), end = read(declaration.window.end);
      const upid = read(declaration.identity?.upid), utid = read(declaration.identity?.utid);
      const cpu = read(declaration.identity?.cpu), ucpu = read(declaration.identity?.ucpu), machineId = read(declaration.identity?.machine_id);
      const windowId = read(declaration.context?.window_id), role = read(declaration.context?.role);
      if (!exactNs(start) || !exactNs(end) || BigInt(end) <= BigInt(start) ||
          Object.entries(declaration.identity || {}).some(([key, column]) => {
            const value = read(column);
            return !(value === null && ['cpu', 'ucpu', 'machine_id'].includes(key)) &&
              (!Number.isSafeInteger(value) || Number(value) < 0);
          }) ||
          (declaration.context?.window_id && !(windowId === null || typeof windowId === 'string' ||
            (typeof windowId === 'number' && Number.isSafeInteger(windowId)))) ||
          (declaration.context?.role && !(role === null || typeof role === 'string'))) {
        incomplete('capture_window_or_identity_invalid'); continue;
      }
      for (const [metricIndex, metric] of declaration.metrics.entries()) {
        if (records.length >= 4096) {incomplete('ledger_record_budget_exhausted'); break;}
        const value = read(metric.value), rawStatus = read(metric.status);
        const coverage = read(metric.coverage), denominator = read(metric.denominator);
        const validCoverage = !metric.coverage || (exactNs(coverage) && exactNs(denominator) &&
          BigInt(denominator) > 0n && BigInt(coverage) <= BigInt(denominator));
        let status: InvestigationEvidenceRecord['status'] = rawStatus === 'observed' ? 'observed' : rawStatus === 'partial' ? 'partial' :
          ['unavailable', 'unsupported', 'not_recorded'].includes(String(rawStatus)) ? 'unavailable' : 'unknown';
        if (!toolChecked || value === undefined || !validCoverage) status = 'unknown';
        if (status === 'observed' && value === null) status = 'unavailable';
        if (status === 'observed' && metric.coverage && exactNs(coverage) && exactNs(denominator) &&
            BigInt(coverage) < BigInt(denominator)) status = 'partial';
        if (status === 'unknown') issues.add('capture_metric_unknown');
        records.push({recordId: `${witness.captureId}:${rowIndex}:${metricIndex}`, captureId: witness.captureId, rowIndex,
          evidenceRefId: meta.evidenceRefId, artifactId: meta.artifactId, sourceToolCallId: meta.sourceToolCallId,
          skillId: binding.skillId, stepId: binding.stepId, definitionFingerprint: binding.definitionFingerprint,
          selectedSqlHash: binding.selectedSqlHash, traceId: binding.traceId, traceSide: meta.traceSide as 'current' | 'reference',
          ...(originRunId ? {originRunId} : {}), origin, domain: metric.domain, metricId: metric.metric_id, status,
          window: {start, end}, ...(typeof upid === 'number' ? {upid} : {}), ...(typeof utid === 'number' ? {utid} : {}),
          ...(cpu === null || typeof cpu === 'number' ? {cpu} : {}), ...(ucpu === null || typeof ucpu === 'number' ? {ucpu} : {}),
          ...(machineId === null || typeof machineId === 'number' ? {machineId} : {}),
          ...(windowId === null || typeof windowId === 'number' || typeof windowId === 'string' ? {windowId} : {}),
          ...(role === null || typeof role === 'string' ? {role} : {}), ...(metric.aggregation ? {aggregation: metric.aggregation} : {}),
          value: value ?? null, ...(metric.unit ? {unit: metric.unit} : {}),
          ...(exactNs(coverage) ? {coverage} : {}), ...(exactNs(denominator) ? {denominator} : {})});
      }
    }
  }
  const body = {schemaVersion: 'investigation_evidence@1' as const, ownerKey: options.ownerKey,
    ...(options.currentRunId ? {currentRunId: options.currentRunId} : {}), records, issues: [...issues].sort(),
    incompleteCaptureIds: [...incompleteCaptureIds].sort(), complete: issues.size === 0};
  const snapshot = freezeEvidenceValue({...body, fingerprint: investigationEvidenceFingerprint(body)});
  issuedSnapshots.add(snapshot);
  return snapshot;
}
