// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';
import {parseClaimSemanticsDeclaration, type ConclusionContract, type ConclusionBindingEligibility} from '../agent/core/conclusionContract';
import type {RuntimeFinalizationContext} from '../agentRuntime/analysisFinalizationContext';
import type {AnalysisRunSelection} from '../agentRuntime/analysisRunSpec';
import {loadPromptTemplate} from '../agentv3/strategyLoader';
import {
  analysisDeliveryFingerprint,
  type AnalysisCandidateIdentity,
  type AnalysisCaseRetrievalState,
  type AnalysisReportRequirement,
  type AnalysisReportRequirementAssessment,
  type PinnedAnalysisReportRequirements,
} from '../types/analysisDelivery';
import type {SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {isPlainJsonObject} from '../utils/isPlainJsonObject';
import {resolveAnalysisInvestigationRequirements} from '../agentRuntime/analysisInvestigationRequirements';
import type {ResolvedAnalysisInvestigationRequirements} from '../types/analysisInvestigation';
import type {InvestigationContentAssessment} from '../types/analysisInvestigationAssessment';
import {compactInvestigationEvidenceForSemantic,
  type CompactInvestigationEvidenceSnapshot} from './evidence/investigationEvidenceLedger';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT, FINAL_SEMANTIC_OUTPUT_BYTE_LIMIT} from './finalSemanticLimits';
import {expandSemanticSourceSnapshot} from './evidence/semanticSourceSnapshot';
export {FINAL_SEMANTIC_INPUT_BYTE_LIMIT, FINAL_SEMANTIC_OUTPUT_BYTE_LIMIT} from './finalSemanticLimits';

export const FINAL_SEMANTIC_RULE_VERSION = 'final_semantics@2';
const SEMANTIC_LOCATION_CATALOG_ENTRY_LIMIT = 512;
const SEMANTIC_LOCATION_CATALOG_BYTE_LIMIT = 64 * 1024;

export interface FinalSemanticSnapshot {
  /** Parent-owned privacy projection must preserve the entire review target. */
  inputCoverage: 'complete' | 'incomplete';
  inputProjectionIssue?: 'structure_limit' | 'content_projection' | 'semantic_input_limit';
  /** Issued parser aggregate; never copied from model-supplied JSON metadata. */
  declarationBindingEligibility: ConclusionBindingEligibility;
  query: string;
  body: string;
  conclusionContract?: ConclusionContract;
  /** Includes raw invalid declarations; already safe to send to this provider. */
  protocolDiagnostics?: unknown;
  /** Detached prepared projection only; serialized metadata is never proof. */
  evidenceSnapshot: unknown;
  sourceUse?: SourceUseDecisionV1;
  capabilitySnapshot?: unknown;
  reportRequirements?: PinnedAnalysisReportRequirements;
  caseRetrieval?: AnalysisCaseRetrievalState;
  investigationRequirements?: ResolvedAnalysisInvestigationRequirements;
  investigationEvidence?: CompactInvestigationEvidenceSnapshot;
  /** Canonical run selection scope. Lookup/range input only; never evidence. */
  selectionScope?: AnalysisRunSelection;
  /** Provider transport alias only; expands to the exact issued contract source copies. */
  semanticSourceAlias?: {readonly schemaVersion: 'final_semantic_source_alias@1'};
}

export interface FinalSemanticAssessmentInput {
  context: RuntimeFinalizationContext;
  /** Parent verifies the issued canonicalization receipt before calling. */
  canonicalCandidate: AnalysisCandidateIdentity;
  snapshot: FinalSemanticSnapshot;
  signal: AbortSignal;
  /** May only narrow the service's limits. Does not restart the run deadline. */
  limits?: {inputBytes?: number; outputBytes?: number};
}

export interface SemanticContentLocation {readonly start: number; readonly end: number}
interface SemanticLocationCatalog {
  readonly payload: {
    readonly schemaVersion: 'final_semantic_location_catalog@1';
    readonly entries: ReadonlyArray<{readonly spanId: string; readonly text: string}>;
  };
  readonly locations: Readonly<Record<string, SemanticContentLocation>>;
}
const ISSUE_CODES = [
  'kind_mismatch', 'predicate_mismatch', 'polarity_mismatch', 'discourse_mismatch',
  'modality_mismatch', 'quantifier_mismatch', 'scope_mismatch', 'numeric_mismatch',
  'declaration_not_expressed', 'unclear_semantics',
] as const;
export type SemanticIssueCode = typeof ISSUE_CODES[number];
export interface SemanticClaimAssessment {
  readonly claimId: string;
  readonly consistency: 'consistent' | 'inconsistent' | 'unknown';
  readonly contentLocations: readonly SemanticContentLocation[];
  readonly issues: ReadonlyArray<{
    readonly code: SemanticIssueCode;
    readonly contentLocations: readonly SemanticContentLocation[];
  }>;
}

export interface FinalSemanticAssessment {
  readonly schemaVersion: 'final_semantic_assessment@1';
  readonly ruleVersion: typeof FINAL_SEMANTIC_RULE_VERSION;
  readonly binding?: {
    readonly snapshotFingerprint: string;
    readonly canonicalCandidate: AnalysisCandidateIdentity;
  };
  readonly promptFingerprint?: string;
  /** checked describes review coverage, never evidence correctness. */
  readonly status: 'checked' | 'coverage_incomplete' | 'unavailable' | 'not_checked';
  readonly reason?: 'invalid_snapshot' | 'snapshot_changed' | 'input_projection_incomplete' | 'input_projection_limit' |
    'input_limit' | 'output_limit' | 'invalid_response' | 'missing_template' |
    'missing_transport' | 'timeout' | 'provider_error' | 'incomplete_output' |
    'invalid_configuration' | 'tool_use' | 'invalid_declarations';
  /** Private parser receipt only; contains no provider text, claim IDs or field values. */
  readonly responseDiagnostic?: FinalSemanticResponseDiagnostic;
  /** Private capacity receipt only; contains byte counts and a closed failure stage. */
  readonly inputDiagnostic?: FinalSemanticInputDiagnostic;
  readonly consistency: 'consistent' | 'inconsistent' | 'unknown';
  readonly coverage: {
    readonly body: 'complete' | 'incomplete';
    readonly claims: 'complete' | 'incomplete';
    readonly report: 'complete' | 'incomplete' | 'not_applicable';
  };
  readonly claims: readonly SemanticClaimAssessment[];
  readonly omissions: ReadonlyArray<{readonly code: 'undeclared_claim'; readonly contentLocations: readonly SemanticContentLocation[]}>;
  readonly requirements: readonly AnalysisReportRequirementAssessment[];
  /** Independent coverage; an old response never certifies this new dimension. */
  readonly investigation?: {
    readonly status: 'not_checked' | 'checked' | 'coverage_incomplete';
    readonly requirements: readonly InvestigationContentAssessment[];
  };
}

export interface FinalSemanticResponseDiagnostic {
  readonly stage: 'json' | 'envelope' | 'body_coverage' | 'claim' | 'claim_set' | 'omission' |
    'report_requirement' | 'report_requirement_set' | 'investigation' | 'investigation_set';
  readonly code: 'invalid_json' | 'invalid_shape' | 'invalid_location' | 'invalid_reference' |
    'invalid_constraint' | 'set_mismatch';
  /** One-based response item position; never an untrusted identifier. */
  readonly ordinal?: number;
  readonly expectedCount?: number;
  readonly actualCount?: number;
}

export interface FinalSemanticInputDiagnostic {
  readonly stage: 'investigation_envelope' | 'prompt_assembly';
  readonly code: 'no_valid_envelope' | 'byte_limit_exceeded';
  readonly limitBytes: number;
  readonly actualBytes?: number;
}

interface CapturedSnapshot {
  ruleVersion: typeof FINAL_SEMANTIC_RULE_VERSION;
  canonicalCandidate: AnalysisCandidateIdentity;
  snapshot: FinalSemanticSnapshot;
  runId: string;
  intent: RuntimeFinalizationContext['turnIntent'];
  traceIdentity: RuntimeFinalizationContext['traceIdentity'];
  runSelection?: AnalysisRunSelection;
  registryFingerprint: string;
}
interface AssessmentSlot {
  fingerprint?: string;
  promise: Promise<FinalSemanticAssessment>;
}
const slots = new WeakMap<RuntimeFinalizationContext, AssessmentSlot>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** Canonical JSON snapshot without invoking accessors or silently dropping data. */
function freezeJson<T>(input: T): T {
  const ancestors = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('invalid_snapshot');
    if (!Array.isArray(value) && !isPlainJsonObject(value)) throw new Error('invalid_snapshot');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
      throw new Error('invalid_snapshot');
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(descriptors).some(key => key !== 'length' &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) throw new Error('invalid_snapshot');
        const copy = Array.from({length: value.length}, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable) throw new Error('invalid_snapshot');
          return visit(descriptor.value);
        });
        return Object.freeze(copy);
      }
      // A null prototype preserves even a literal __proto__ key in raw JSON.
      const copy: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) throw new Error('invalid_snapshot');
        if (descriptor.value !== undefined) copy[key] = visit(descriptor.value);
      }
      return Object.freeze(copy);
    } finally { ancestors.delete(value); }
  };
  return visit(input) as T;
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function emptyAssessment(
  status: FinalSemanticAssessment['status'], reason: FinalSemanticAssessment['reason'],
  binding?: FinalSemanticAssessment['binding'], responseDiagnostic?: FinalSemanticResponseDiagnostic,
  inputDiagnostic?: FinalSemanticInputDiagnostic,
): FinalSemanticAssessment {
  return freezeJson({schemaVersion: 'final_semantic_assessment@1', ruleVersion: FINAL_SEMANTIC_RULE_VERSION,
    ...(binding ? {binding} : {}), ...(responseDiagnostic ? {responseDiagnostic} : {}),
    ...(inputDiagnostic ? {inputDiagnostic} : {}), status, reason, consistency: 'unknown',
    coverage: {body: 'incomplete', claims: 'incomplete', report: 'incomplete'},
    claims: [], omissions: [], requirements: []});
}

class SemanticResponseParseFailure extends Error {
  constructor(readonly diagnostic: FinalSemanticResponseDiagnostic) {
    super(`${diagnostic.stage}:${diagnostic.code}`);
  }
}

function invalidResponse(
  stage: FinalSemanticResponseDiagnostic['stage'], code: FinalSemanticResponseDiagnostic['code'],
  details: Pick<FinalSemanticResponseDiagnostic, 'ordinal' | 'expectedCount' | 'actualCount'> = {},
): never {
  throw new SemanticResponseParseFailure({stage, code, ...details});
}

function sameValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(freezeJson(left)) === JSON.stringify(freezeJson(right));
}
function requirementProjection(requirement: AnalysisReportRequirement): AnalysisReportRequirement {
  const {id, label, description, required, condition} = requirement;
  return {id, label, ...(description !== undefined ? {description} : {}), required,
    ...(condition !== undefined ? {condition} : {})};
}

function validSourceLedger(raw: unknown): boolean {
  if (raw === undefined) return true;
  if (!record(raw) || !keys(raw, ['schemaVersion', 'codeAwareMode', 'selectedCodebaseIds', 'status',
    'attemptedTools', 'queriedCodebaseIds', 'usedCodebaseIds', 'references'],
  ['reasonCode', 'coverageComplete', 'incompleteReasons']) || !Array.isArray(raw.references)) return false;
  if (raw.schemaVersion !== 'source_use_decision@1' || !member(raw.codeAwareMode, ['metadata_only', 'provider_send'])) return false;
  if (!member(raw.status, ['pending', 'not_needed', 'disallowed', 'no_queryable_anchor', 'attempted', 'located',
    'corroborated', 'ambiguous_candidates', 'not_found_complete', 'search_incomplete', 'unverified']) ||
    (raw.reasonCode !== undefined && typeof raw.reasonCode !== 'string') ||
    (raw.coverageComplete !== undefined && typeof raw.coverageComplete !== 'boolean')) return false;
  for (const key of ['selectedCodebaseIds', 'attemptedTools', 'queriedCodebaseIds', 'usedCodebaseIds', 'incompleteReasons']) {
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(item => typeof item === 'string'))) return false;
  }
  return raw.references.every(reference => {
    if (!record(reference) || !keys(reference, ['id', 'codebaseId', 'filePath', 'lookupKind'],
      ['chunkId', 'referenceId', 'lineRange', 'symbol', 'buildId', 'commitHash', 'sourceGeneration']) ||
      !['id', 'codebaseId', 'filePath'].every(key => nonempty(reference[key])) ||
      !member(reference.lookupKind, ['metadata', 'body', 'indexed', 'graph']) ||
      ['chunkId', 'referenceId', 'symbol', 'buildId', 'commitHash', 'sourceGeneration'].some(key =>
        reference[key] !== undefined && typeof reference[key] !== 'string')) return false;
    const lines = reference.lineRange;
    return lines === undefined || (record(lines) && keys(lines, ['start', 'end']) &&
      Number.isSafeInteger(lines.start) && Number.isSafeInteger(lines.end) &&
      Number(lines.start) > 0 && Number(lines.end) >= Number(lines.start));
  });
}

function inputIsBound(captured: CapturedSnapshot, context: RuntimeFinalizationContext): boolean {
  const {canonicalCandidate: candidate, intent} = captured;
  const snapshot = captured.snapshot.semanticSourceAlias
    ? expandSemanticSourceSnapshot(captured.snapshot) as FinalSemanticSnapshot | undefined : captured.snapshot;
  if (!snapshot) return false;
  if (context.deliveryContext.entry === 'historical_restore' ||
    ![candidate.candidateRef, candidate.runId, candidate.attemptId].every(nonempty) ||
    candidate.runId !== captured.runId || candidate.conclusionFingerprint !== analysisDeliveryFingerprint(snapshot.body) ||
    !member(snapshot.inputCoverage, ['complete', 'incomplete']) ||
    !member(snapshot.declarationBindingEligibility, ['eligible', 'ineligible', 'legacy_unchecked']) ||
    typeof snapshot.query !== 'string' ||
    !nonempty(snapshot.body) || !hasOwn(snapshot, 'evidenceSnapshot') ||
    intent.registryFingerprint !== captured.registryFingerprint || !validSourceLedger(snapshot.sourceUse) ||
    (snapshot.selectionScope === undefined || captured.runSelection === undefined
      ? snapshot.selectionScope !== captured.runSelection
      : !sameValues(snapshot.selectionScope, captured.runSelection))) return false;
  const selection = captured.runSelection;
  if (selection?.present && selection.sideResolution.status === 'resolved' &&
    selection.sideResolution.traceId !== captured.traceIdentity.currentTraceId) return false;
  if (snapshot.conclusionContract !== undefined && (!record(snapshot.conclusionContract) ||
    snapshot.conclusionContract.schemaVersion !== 'conclusion_contract_v1')) return false;
  const pin = snapshot.reportRequirements;
  if (intent.status === 'resolved' && intent.deliverable === 'report') {
    const strategy = context.strategyRegistry.getStrategy(intent.sceneId);
    if (!pin || !strategy || pin.sceneId !== intent.sceneId || pin.registryFingerprint !== captured.registryFingerprint ||
      !sameValues(pin.requirements, (strategy.finalReportContract?.requiredSections ?? []).map(requirementProjection))) return false;
  } else if (pin && (pin.sceneId !== intent.sceneId || pin.registryFingerprint !== captured.registryFingerprint)) return false;
  if (pin && (!Array.isArray(pin.requirements) || pin.requirements.some(requirement => !nonempty(requirement.id)) ||
    new Set(pin.requirements.map(requirement => requirement.id)).size !== pin.requirements.length)) return false;
  const investigation = resolveAnalysisInvestigationRequirements({intent, strategyRegistry: context.strategyRegistry});
  if ((snapshot.investigationRequirements || investigation.status === 'resolved') &&
    !sameValues(snapshot.investigationRequirements, investigation)) return false;
  if (snapshot.investigationEvidence && (!context.investigationEvidence ||
    !sameValues(snapshot.investigationEvidence, compactInvestigationEvidenceForSemantic(context.investigationEvidence,
      snapshot.investigationEvidence.byteBudget)))) return false;
  return true;
}

function utf16Boundary(body: string, offset: number): boolean {
  if (offset === 0 || offset === body.length) return true;
  const previous = body.charCodeAt(offset - 1);
  const next = body.charCodeAt(offset);
  return !(previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF);
}
function exactQuoteLocation(item: Record<string, unknown>, body: string): SemanticContentLocation | undefined {
  if (!keys(item, ['text'], ['occurrence']) || !nonempty(item.text) ||
    (hasOwn(item, 'occurrence') && (!Number.isSafeInteger(item.occurrence) || Number(item.occurrence) <= 0))) return undefined;
  const occurrence = item.occurrence as number | undefined;
  let start = -1;
  let count = 0;
  let selected = -1;
  // Advance one UTF-16 code unit so overlapping exact matches also count.
  while ((start = body.indexOf(item.text, start + 1)) !== -1) {
    count += 1;
    if (occurrence === undefined && count > 1) return undefined;
    if (occurrence === undefined || count === occurrence) selected = start;
    if (count === occurrence) break;
  }
  return selected < 0 ? undefined : {start: selected, end: selected + item.text.length};
}

function buildSemanticLocationCatalog(body: string): SemanticLocationCatalog | undefined {
  const bodyDigest = createHash('sha256').update(body).digest('hex');
  const entries: Array<{spanId: string; text: string}> = [];
  const locations: Record<string, SemanticContentLocation> = Object.create(null);
  let start = 0;
  let ordinal = 1;
  while (start < body.length) {
    let end = start;
    while (end < body.length && body[end] !== '\r' && body[end] !== '\n') end += 1;
    const text = body.slice(start, end);
    if (text.trim()) {
      if (entries.length >= SEMANTIC_LOCATION_CATALOG_ENTRY_LIMIT) return undefined;
      const spanDigest = createHash('sha256').update(text).digest('hex');
      const spanId = `line-${ordinal}-${bodyDigest}-${spanDigest}`;
      if (hasOwn(locations, spanId)) return undefined;
      entries.push({spanId, text});
      locations[spanId] = Object.freeze({start, end});
    }
    if (end === body.length) break;
    start = end + (body[end] === '\r' && body[end + 1] === '\n' ? 2 : 1);
    ordinal += 1;
  }
  if (!entries.length) return undefined;
  const payload = freezeJson({schemaVersion: 'final_semantic_location_catalog@1' as const, entries});
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > SEMANTIC_LOCATION_CATALOG_BYTE_LIMIT) return undefined;
  return Object.freeze({payload, locations: Object.freeze(locations)});
}

function semanticLocation(
  item: Record<string, unknown>, body: string,
  format: 'offsets' | 'offsets_with_text' | 'exact_quote' | 'catalog_or_exact_quote',
  catalog?: SemanticLocationCatalog,
): SemanticContentLocation | undefined {
  if (format === 'catalog_or_exact_quote' && keys(item, ['spanId']) && nonempty(item.spanId)) {
    return catalog?.locations[item.spanId];
  }
  if (format === 'exact_quote' || format === 'catalog_or_exact_quote') return exactQuoteLocation(item, body);
  if (!keys(item, format === 'offsets_with_text' ? ['start', 'end', 'text'] : ['start', 'end']) ||
    !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) return undefined;
  return {start: item.start as number, end: item.end as number};
}

function parseLocations(
  raw: unknown, body: string,
  format: 'offsets' | 'offsets_with_text' | 'exact_quote' | 'catalog_or_exact_quote',
  catalog?: SemanticLocationCatalog,
):
  SemanticContentLocation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const locations: SemanticContentLocation[] = [];
  for (const item of raw) {
    if (!record(item)) return undefined;
    const location = semanticLocation(item, body, format, catalog);
    if (!location) return undefined;
    const {start, end} = location;
    if (start < 0 || end <= start || end > body.length || !utf16Boundary(body, start) || !utf16Boundary(body, end) ||
      (format === 'offsets_with_text' && item.text !== body.slice(start, end)) || seen.has(`${start}:${end}`)) return undefined;
    seen.add(`${start}:${end}`);
    locations.push({start, end});
  }
  return locations;
}
function wholeBodyCovered(locations: readonly SemanticContentLocation[], length: number): boolean {
  let cursor = 0;
  for (const location of locations) {
    if (location.start !== cursor) return false;
    cursor = location.end;
  }
  return cursor === length;
}
type FinalSemanticPromptContext = Pick<CapturedSnapshot, 'snapshot' | 'intent' | 'traceIdentity' | 'registryFingerprint'>;

function fixedApplicability(requirement: AnalysisReportRequirement, captured: FinalSemanticPromptContext):
  AnalysisReportRequirementAssessment['applicability'] | undefined {
  if (requirement.condition?.kind === 'unresolved') return 'unknown';
  if (requirement.condition?.kind === 'strong_case_retrieval') {
    const cases = captured.snapshot.caseRetrieval;
    return cases?.status !== 'checked' ? 'unknown' :
      cases.recommendations.some(item => nonempty(item.caseId) && item.matchStrength === 'strong') ? 'applicable' : 'not_applicable';
  }
  return captured.intent.scope === 'scene_wide' && !requirement.condition ? 'applicable' : undefined;
}

/** Single prompt assembly path shared by exact budgeting and dispatch. */
export function buildFinalSemanticPrompt(captured: FinalSemanticPromptContext):
  {prompt: string; promptFingerprint: string; locationCatalog?: SemanticLocationCatalog} | undefined {
  const template = (loadPromptTemplate('prompt-final-semantic-assessment') ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!template) return undefined;
  const promptFingerprint = createHash('sha256').update(template).digest('hex');
  // Canonicalize here so the budget caller and the later captured dispatch build
  // the byte-identical request even when their input objects used different key order.
  const normalized: FinalSemanticPromptContext = freezeJson(captured);
  const locationCatalog = buildSemanticLocationCatalog(normalized.snapshot.body);
  const {reason: _reason, ...intentData} = normalized.intent;
  const prompt = `${template}\n\n${JSON.stringify({
    request: 'final_semantic_request@1', bodyUtf16Length: normalized.snapshot.body.length,
    ...normalized.snapshot, intent: intentData, traceIdentity: normalized.traceIdentity,
    registryFingerprint: normalized.registryFingerprint,
    // Always overwrite the reserved transport field after the snapshot spread.
    // JSON.stringify omits undefined, so a failed/oversized derived catalog also
    // removes any untrusted same-name snapshot property.
    contentLocationCatalog: locationCatalog?.payload,
    fixedRequirementApplicability: normalized.snapshot.reportRequirements?.requirements.map(requirement => ({
      requirementId: requirement.id, applicability: fixedApplicability(requirement, normalized) ?? 'semantic_decision',
    })),
  })}`;
  return {prompt, promptFingerprint, ...(locationCatalog ? {locationCatalog} : {})};
}

function semanticResponseJsonText(raw: string): string {
  const text = raw.trim();
  const completeFence = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(text);
  if (completeFence) return completeFence[1];
  const orphanClosingFence = /(?:\r\n|\n)```$/.exec(text);
  if (!orphanClosingFence) return text;
  const payload = text.slice(0, orphanClosingFence.index);
  return payload.includes('```') ? text : payload;
}

function parseResponseStrict(
  raw: string, captured: CapturedSnapshot, binding: NonNullable<FinalSemanticAssessment['binding']>,
  locationCatalog?: SemanticLocationCatalog,
):
  FinalSemanticAssessment {
  let value: unknown;
  try { value = JSON.parse(semanticResponseJsonText(raw)); } catch { return invalidResponse('json', 'invalid_json'); }
  if (!record(value) || !keys(value, ['schemaVersion', 'bodyCoverage', 'claims', 'omissions', 'requirements',
    ...(member(value.schemaVersion, ['final_semantic_response@3', 'final_semantic_response@4']) ? ['investigation'] : [])]) ||
    !member(value.schemaVersion, ['final_semantic_response@1', 'final_semantic_response@2', 'final_semantic_response@3',
      'final_semantic_response@4']) || !record(value.bodyCoverage) ||
    !keys(value.bodyCoverage, ['status', 'reviewedSpans']) || !member(value.bodyCoverage.status, ['complete', 'incomplete']) ||
    !Array.isArray(value.claims) || !Array.isArray(value.omissions) || !Array.isArray(value.requirements)) {
    return invalidResponse('envelope', 'invalid_shape');
  }
  const {body, conclusionContract: contract} = captured.snapshot;
  const locationFormat = value.schemaVersion === 'final_semantic_response@1' ? 'offsets_with_text' :
    value.schemaVersion === 'final_semantic_response@4' ? 'catalog_or_exact_quote' : 'exact_quote';
  const reviewedSpans = parseLocations(value.bodyCoverage.reviewedSpans, body, 'offsets');
  if (!reviewedSpans || reviewedSpans.some((item, index) => index > 0 && item.start < reviewedSpans[index - 1].end) ||
    (value.bodyCoverage.status === 'complete' && !wholeBodyCovered(reviewedSpans, body.length))) {
    return invalidResponse('body_coverage', 'invalid_location');
  }
  const declarations = new Map((contract?.claims ?? []).map(claim => [claim.id!, claim]));
  const claims: SemanticClaimAssessment[] = [];
  const seenClaims = new Set<string>();
  for (const [index, item] of value.claims.entries()) {
    if (!record(item) || !keys(item, ['claimId', 'consistency', 'contentLocations', 'issues']) ||
      !nonempty(item.claimId) || !declarations.has(item.claimId) || seenClaims.has(item.claimId) ||
      !member(item.consistency, ['consistent', 'inconsistent', 'unknown']) || !Array.isArray(item.issues)) {
      return invalidResponse('claim', 'invalid_reference', {ordinal: index + 1});
    }
    const locations = parseLocations(item.contentLocations, body, locationFormat, locationCatalog);
    if (!locations) return invalidResponse('claim', 'invalid_location', {ordinal: index + 1});
    const issues: Array<{code: SemanticIssueCode; contentLocations: SemanticContentLocation[]}> = [];
    for (const issue of item.issues) {
      if (!record(issue) || !keys(issue, ['code', 'contentLocations']) || !member(issue.code, ISSUE_CODES)) {
        return invalidResponse('claim', 'invalid_shape', {ordinal: index + 1});
      }
      const issueLocations = parseLocations(issue.contentLocations, body, locationFormat, locationCatalog);
      if (!issueLocations || (issue.code !== 'declaration_not_expressed' && issue.code !== 'unclear_semantics' && !issueLocations.length)) {
        return invalidResponse('claim', 'invalid_location', {ordinal: index + 1});
      }
      issues.push({code: issue.code, contentLocations: issueLocations});
    }
    if ((item.consistency === 'consistent' && (!locations.length || issues.length)) ||
      (item.consistency === 'inconsistent' && !issues.length)) {
      return invalidResponse('claim', 'invalid_constraint', {ordinal: index + 1});
    }
    const declaration = declarations.get(item.claimId)!;
    const hasTypedSemantics = Boolean(captured.snapshot.declarationBindingEligibility === 'eligible' && member(declaration.kind, [
      'numeric', 'categorical', 'time_range', 'identity', 'causal', 'comparison', 'inference', 'recommendation',
    ]) && declaration.semantics &&
      parseClaimSemanticsDeclaration(declaration.semantics).semantics &&
      !hasOwn(declaration, 'rawSemantics') && !declaration.semanticsParseIssues?.length);
    const consistency = item.consistency === 'consistent' && !hasTypedSemantics ? 'unknown' : item.consistency;
    if (consistency === 'unknown' && item.consistency === 'consistent') {
      issues.push({code: 'unclear_semantics', contentLocations: []});
    }
    seenClaims.add(item.claimId);
    claims.push({claimId: item.claimId, consistency, contentLocations: locations, issues});
  }
  if (seenClaims.size !== declarations.size) return invalidResponse('claim_set', 'set_mismatch', {
    expectedCount: declarations.size, actualCount: seenClaims.size,
  });
  const omissions: Array<{code: 'undeclared_claim'; contentLocations: SemanticContentLocation[]}> = [];
  for (const [index, item] of value.omissions.entries()) {
    if (!record(item) || !keys(item, ['code', 'contentLocations']) || item.code !== 'undeclared_claim') {
      return invalidResponse('omission', 'invalid_shape', {ordinal: index + 1});
    }
    const locations = parseLocations(item.contentLocations, body, locationFormat, locationCatalog);
    if (!locations?.length) return invalidResponse('omission', 'invalid_location', {ordinal: index + 1});
    omissions.push({code: 'undeclared_claim', contentLocations: locations});
  }
  const reportRequested = captured.intent.status === 'resolved' && captured.intent.deliverable === 'report';
  const pinnedRequirements = reportRequested ? captured.snapshot.reportRequirements!.requirements : [];
  const requirementMap = new Map(pinnedRequirements.map(requirement => [requirement.id, requirement]));
  const seenRequirements = new Set<string>();
  const requirements: AnalysisReportRequirementAssessment[] = [];
  for (const [index, item] of value.requirements.entries()) {
    if (!record(item) || !keys(item, ['requirementId', 'applicability', 'coverage', 'contentLocations', 'claimIds']) ||
      !nonempty(item.requirementId) || !requirementMap.has(item.requirementId) || seenRequirements.has(item.requirementId) ||
      !member(item.applicability, ['applicable', 'not_applicable', 'unknown']) || !member(item.coverage, ['covered', 'missing', 'unknown']) ||
      !Array.isArray(item.claimIds) || item.claimIds.some(id => typeof id !== 'string' || !declarations.has(id)) ||
      new Set(item.claimIds).size !== item.claimIds.length) {
      return invalidResponse('report_requirement', 'invalid_reference', {ordinal: index + 1});
    }
    const locations = parseLocations(item.contentLocations, body, locationFormat, locationCatalog);
    const fixed = fixedApplicability(requirementMap.get(item.requirementId)!, captured);
    if (!locations || (fixed !== undefined && item.applicability !== fixed) ||
      (item.applicability !== 'applicable' && item.coverage !== 'unknown') ||
      (item.coverage === 'covered' && !locations.length && !item.claimIds.length)) {
      return invalidResponse('report_requirement', locations ? 'invalid_constraint' : 'invalid_location', {ordinal: index + 1});
    }
    seenRequirements.add(item.requirementId);
    requirements.push({requirementId: item.requirementId, applicability: item.applicability,
      coverage: item.coverage, contentLocations: locations, claimIds: item.claimIds as string[]});
  }
  if (seenRequirements.size !== requirementMap.size) return invalidResponse('report_requirement_set', 'set_mismatch', {
    expectedCount: requirementMap.size, actualCount: seenRequirements.size,
  });
  const investigation = parseInvestigationResponse(value, captured, locationFormat, locationCatalog);
  const declarationCoverage = (captured.snapshot.declarationBindingEligibility === 'eligible' || declarations.size === 0) &&
    !hasOwn(contract ?? {}, 'rawClaims') && !contract?.parseIssues?.length &&
    contract?.bindingEligibility !== 'ineligible' && claims.every(claim => claim.consistency !== 'unknown');
  const coverage: FinalSemanticAssessment['coverage'] = {
    body: value.bodyCoverage.status,
    claims: declarationCoverage ? 'complete' : 'incomplete',
    report: !reportRequested ? 'not_applicable' : requirements.some(requirement =>
      requirementMap.get(requirement.requirementId)?.required !== false &&
      (requirement.applicability === 'unknown' || (requirement.applicability === 'applicable' && requirement.coverage === 'unknown')))
      ? 'incomplete' : 'complete',
  };
  const incomplete = Object.values(coverage).includes('incomplete');
  return freezeJson({schemaVersion: 'final_semantic_assessment@1', ruleVersion: FINAL_SEMANTIC_RULE_VERSION,
    binding, status: incomplete ? 'coverage_incomplete' : 'checked',
    consistency: omissions.length || claims.some(claim => claim.consistency === 'inconsistent') ? 'inconsistent' :
      incomplete ? 'unknown' : 'consistent', coverage, claims, omissions, requirements, investigation});
}

function parseResponse(
  raw: string, captured: CapturedSnapshot, binding: NonNullable<FinalSemanticAssessment['binding']>,
  locationCatalog?: SemanticLocationCatalog,
):
  {assessment?: FinalSemanticAssessment; diagnostic?: FinalSemanticResponseDiagnostic} {
  try { return {assessment: parseResponseStrict(raw, captured, binding, locationCatalog)}; }
  catch (error) {
    if (error instanceof SemanticResponseParseFailure) return {diagnostic: error.diagnostic};
    throw error;
  }
}

function parseInvestigationResponse(
  value: Record<string, unknown>, captured: CapturedSnapshot,
  locationFormat: 'offsets_with_text' | 'exact_quote' | 'catalog_or_exact_quote',
  locationCatalog?: SemanticLocationCatalog,
):
  NonNullable<FinalSemanticAssessment['investigation']> {
  if (!member(value.schemaVersion, ['final_semantic_response@3', 'final_semantic_response@4'])) {
    return {status: 'not_checked', requirements: []};
  }
  if (!Array.isArray(value.investigation)) return invalidResponse('investigation', 'invalid_shape');
  const pin = captured.snapshot.investigationRequirements;
  const required = pin?.status === 'resolved' ? pin.requirements : [];
  const definitions = new Map(required.map(item => [item.id, item]));
  const records = new Set(captured.snapshot.investigationEvidence?.records.map(item => item.recordId) ?? []);
  const seen = new Set<string>();
  const rows: InvestigationContentAssessment[] = [];
  for (const [index, item] of value.investigation.entries()) {
    if (!record(item) || !keys(item, ['requirementId', 'applicability', 'coverage', 'contentLocations',
      'evidenceRecordIds', 'scopeMatch', 'evidenceStatus']) || !nonempty(item.requirementId) ||
      !definitions.has(item.requirementId) || seen.has(item.requirementId) ||
      !member(item.applicability, ['applicable', 'not_applicable', 'unknown']) ||
      !member(item.coverage, ['covered', 'missing', 'unknown']) ||
      !member(item.scopeMatch, ['matched', 'mismatched', 'unknown']) ||
      !member(item.evidenceStatus, ['observed', 'insufficient', 'not_checked', 'failed', 'not_applicable', 'unknown']) ||
      !Array.isArray(item.evidenceRecordIds) || item.evidenceRecordIds.some(id => !nonempty(id) || !records.has(id)) ||
      new Set(item.evidenceRecordIds).size !== item.evidenceRecordIds.length) {
      return invalidResponse('investigation', 'invalid_reference', {ordinal: index + 1});
    }
    const locations = parseLocations(item.contentLocations, captured.snapshot.body, locationFormat, locationCatalog);
    const definition = definitions.get(item.requirementId)!;
    if (!locations || (!definition.condition && captured.intent.scope === 'scene_wide' && item.applicability !== 'applicable') ||
      (item.applicability !== 'applicable' && item.coverage !== 'unknown') ||
      ((item.coverage === 'covered' || item.applicability === 'not_applicable') && !locations.length) ||
      (item.evidenceStatus === 'observed' && (!item.evidenceRecordIds.length || item.scopeMatch !== 'matched'))) {
      return invalidResponse('investigation', locations ? 'invalid_constraint' : 'invalid_location', {ordinal: index + 1});
    }
    seen.add(item.requirementId);
    rows.push({requirementId: item.requirementId, applicability: item.applicability, coverage: item.coverage,
      contentLocations: locations, evidenceRecordIds: item.evidenceRecordIds as string[],
      scopeMatch: item.scopeMatch, evidenceStatus: item.evidenceStatus});
  }
  if (seen.size !== definitions.size) return invalidResponse('investigation_set', 'set_mismatch', {
    expectedCount: definitions.size, actualCount: seen.size,
  });
  return {status: pin?.status !== 'resolved' ? 'not_checked' : rows.some(item =>
    definitions.get(item.requirementId)?.required !== false && (item.applicability === 'unknown' ||
      item.applicability === 'applicable' && item.coverage === 'unknown')) ? 'coverage_incomplete' : 'checked', requirements: rows};
}

/** One semantic request per captured runtime context; this service never reads evidence. */
export function assessFinalSemantics(input: FinalSemanticAssessmentInput): Promise<FinalSemanticAssessment> {
  const {context, signal} = input;
  signal.throwIfAborted();
  let captured: CapturedSnapshot;
  let snapshotFingerprint: string;
  let limits: FinalSemanticAssessmentInput['limits'];
  try {
    // Read no provider configuration, private evidence handle, or unprojected ledger.
    captured = freezeJson({ruleVersion: FINAL_SEMANTIC_RULE_VERSION, canonicalCandidate: input.canonicalCandidate,
      snapshot: input.snapshot, runId: context.runId, intent: context.turnIntent,
      traceIdentity: context.traceIdentity, runSelection: context.getSelection(signal),
      registryFingerprint: context.strategyRegistry.registryFingerprint});
    limits = freezeJson(input.limits ?? {});
    snapshotFingerprint = fingerprint(captured);
  } catch {
    const existing = slots.get(context);
    if (existing) return existing.fingerprint === undefined ? existing.promise :
      Promise.resolve(emptyAssessment('not_checked', 'snapshot_changed'));
    const promise = Promise.resolve(emptyAssessment('not_checked', 'invalid_snapshot'));
    slots.set(context, {promise});
    return promise;
  }
  const binding = {snapshotFingerprint, canonicalCandidate: captured.canonicalCandidate};
  const previous = slots.get(context);
  if (previous) return previous.fingerprint === snapshotFingerprint ? previous.promise :
    Promise.resolve(emptyAssessment('not_checked', 'snapshot_changed', binding));
  // Reserve before any async work, including every failure path.
  const promise = Promise.resolve().then(async (): Promise<FinalSemanticAssessment> => {
    signal.throwIfAborted();
    const fail = (status: FinalSemanticAssessment['status'], reason: FinalSemanticAssessment['reason']) =>
      emptyAssessment(status, reason, binding);
    if (captured.snapshot.inputCoverage === 'incomplete') return captured.snapshot.inputProjectionIssue === 'semantic_input_limit'
      ? emptyAssessment('coverage_incomplete', 'input_limit', binding, undefined,
        {stage: 'investigation_envelope', code: 'no_valid_envelope', limitBytes: FINAL_SEMANTIC_INPUT_BYTE_LIMIT})
      : fail('coverage_incomplete', captured.snapshot.inputProjectionIssue === 'structure_limit'
        ? 'input_projection_limit' : 'input_projection_incomplete');
    if (captured.snapshot.declarationBindingEligibility === 'ineligible') return fail('not_checked', 'invalid_declarations');
    try { if (!inputIsBound(captured, context)) return fail('not_checked', 'invalid_snapshot'); }
    catch { return fail('not_checked', 'invalid_snapshot'); }
    const declarations = captured.snapshot.conclusionContract?.claims ?? [];
    if (!Array.isArray(declarations) || declarations.some(claim => !record(claim) || !nonempty(claim.id) || !nonempty(claim.text)) ||
      new Set(declarations.map(claim => claim.id)).size !== declarations.length) return fail('not_checked', 'invalid_declarations');
    const inputBytes = limits?.inputBytes ?? FINAL_SEMANTIC_INPUT_BYTE_LIMIT;
    const outputBytes = limits?.outputBytes ?? FINAL_SEMANTIC_OUTPUT_BYTE_LIMIT;
    if (!record(limits) || !keys(limits, [], ['inputBytes', 'outputBytes']) ||
      !Number.isSafeInteger(inputBytes) || inputBytes <= 0 || inputBytes > FINAL_SEMANTIC_INPUT_BYTE_LIMIT ||
      !Number.isSafeInteger(outputBytes) || outputBytes <= 0 || outputBytes > FINAL_SEMANTIC_OUTPUT_BYTE_LIMIT) {
      return fail('not_checked', 'invalid_configuration');
    }
    let assembled: ReturnType<typeof buildFinalSemanticPrompt>;
    try { assembled = buildFinalSemanticPrompt(captured); }
    catch { return fail('unavailable', 'missing_template'); }
    if (!assembled) return fail('unavailable', 'missing_template');
    const {prompt, promptFingerprint, locationCatalog} = assembled;
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > inputBytes) return emptyAssessment('coverage_incomplete', 'input_limit', binding, undefined,
      {stage: 'prompt_assembly', code: 'byte_limit_exceeded', limitBytes: inputBytes, actualBytes: promptBytes});
    if (!context.hasSemanticTransport) return fail('unavailable', 'missing_transport');
    const deadlineMs = context.deadlineMs;
    if (!Number.isFinite(deadlineMs)) return fail('not_checked', 'invalid_configuration');
    if (Date.now() >= deadlineMs) return fail('unavailable', 'timeout');
    try {
      const response = await context.dispatchText({prompt, systemPrompt: '', signal,
        deadlineMs, outputByteLimit: outputBytes});
      signal.throwIfAborted();
      if (Date.now() >= deadlineMs) return fail('unavailable', 'timeout');
      if (response.status !== 'ok') {
        if (response.status !== 'unavailable' || !member(response.reason, [
          'output_limit', 'incomplete_output', 'timeout', 'provider_error', 'invalid_configuration', 'invalid_response', 'tool_use',
        ])) return fail('unavailable', 'invalid_response');
        return fail(response.reason === 'output_limit' || response.reason === 'incomplete_output' ? 'coverage_incomplete' : 'unavailable', response.reason);
      }
      if (Buffer.byteLength(response.text, 'utf8') > outputBytes) return fail('coverage_incomplete', 'output_limit');
      const parsed = parseResponse(response.text, captured, binding, locationCatalog);
      return parsed.assessment ? freezeJson({...parsed.assessment, promptFingerprint}) :
        emptyAssessment('unavailable', 'invalid_response', binding, parsed.diagnostic);
    } catch {
      signal.throwIfAborted();
      return fail('unavailable', Date.now() >= deadlineMs ? 'timeout' : 'provider_error');
    }
  });
  slots.set(context, {fingerprint: snapshotFingerprint, promise});
  return promise;
}
