// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {evidenceCaptureHash, freezeEvidenceValue} from '../../services/evidence/evidenceCapture';
import {isIssuedInvestigationEvidenceSnapshot} from '../../services/evidence/investigationEvidenceLedger';
import {assertSceneRunActive, sceneRunState, type SceneRunContext} from './sceneRunContext';
import type {SceneScanCoverageSnapshot, SceneScanCoverageAssessment} from './sceneTimelineContract';

/** Server-only acquisition from retained execution witnesses; must share proposal mutation admission. */
export function captureSceneScanCoverage(handle: SceneRunContext): void {
  const state = sceneRunState(handle);
  assertSceneRunActive(state);
  if (!state.busy) throw new Error('scene_scan_requires_mutation');
  const addIssue = (code: string) => {
    if (!state.scanDiagnostics.some(item => item.code === code) && state.scanDiagnostics.length < state.limits.maxDiagnostics) {
      state.scanDiagnostics.push({code});
    }
  };
  let snapshot;
  try {snapshot = state.options.createEvidenceReadView().investigationEvidence?.();}
  catch {addIssue('scene_scan_read_failed'); return;}
  if (!snapshot) return;
  if (!isIssuedInvestigationEvidenceSnapshot(snapshot) || snapshot.ownerKey !== state.options.ownerKey ||
      snapshot.currentRunId !== state.options.runId) {addIssue('scene_scan_scope_or_witness_mismatch'); return;}
  snapshot.scanIssues?.forEach(addIssue);
  const pending = new Map<string, NonNullable<typeof snapshot.scans>[number]>();
  let addedBytes = 0; let addedReceipts = 0;
  for (const scan of snapshot.scans || []) {
    if (scan.originRunId !== state.options.runId || scan.traceId !== state.options.traceId || scan.traceSide !== 'current' ||
        BigInt(scan.window.start) < BigInt(state.options.traceBounds.startNs) ||
        BigInt(scan.window.end) > BigInt(state.options.traceBounds.endNs)) {addIssue('scene_scan_scope_or_window_mismatch'); continue;}
    const previous = pending.get(scan.recordId) || state.scanReceipts.get(scan.recordId);
    if (previous && evidenceCaptureHash(previous) === evidenceCaptureHash(scan)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(scan), 'utf8');
    if (state.consumed.scanReceipts + addedReceipts >= state.limits.maxScanReceipts ||
        state.consumed.scanBytes + addedBytes + bytes > state.limits.maxScanReceiptBytes ||
        state.consumed.bytes + addedBytes + bytes > state.limits.maxRunBytes) {addIssue('scene_scan_receipt_budget_exhausted'); break;}
    addedReceipts++; addedBytes += bytes;
    pending.set(scan.recordId, scan);
  }
  assertSceneRunActive(state);
  state.consumed.scanReceipts += addedReceipts; state.consumed.scanBytes += addedBytes; state.consumed.bytes += addedBytes;
  pending.forEach((scan, id) => state.scanReceipts.set(id, scan));
}

type Window = {startNs: string; endNs: string};
function unionWindows(input: readonly Window[]): Window[] {
  const windows: Window[] = [];
  for (const window of [...input].sort((a, b) => BigInt(a.startNs) < BigInt(b.startNs) ? -1 : BigInt(a.startNs) > BigInt(b.startNs) ? 1 : 0)) {
    const last = windows[windows.length - 1];
    if (last && BigInt(window.startNs) <= BigInt(last.endNs)) {
      if (BigInt(window.endNs) > BigInt(last.endNs)) last.endNs = window.endNs;
    } else windows.push({...window});
  }
  return windows;
}
function uncovered(request: Window, scanned: readonly Window[]): Window[] {
  // A point query needs a real receipt covering that point, never the vacuous union of no scans.
  if (request.startNs === request.endNs) return scanned.some(item =>
    BigInt(item.startNs) <= BigInt(request.startNs) && BigInt(item.endNs) >= BigInt(request.endNs)) ? [] : [{...request}];
  const gaps: Window[] = [];
  let cursor = BigInt(request.startNs);
  const end = BigInt(request.endNs);
  for (const item of scanned) {
    const start = BigInt(item.startNs), stop = BigInt(item.endNs);
    if (stop <= cursor || start >= end) continue;
    if (start > cursor) gaps.push({startNs: String(cursor), endNs: String(start)});
    if (stop > cursor) cursor = stop;
  }
  if (cursor < end) gaps.push({startNs: String(cursor), endNs: String(end)});
  return gaps;
}
const scanKey = (item: {domain: string; source: string; skillId: string; stepId: string; resultStepId: string; definitionFingerprint: string}) =>
  JSON.stringify([item.domain, item.source, item.skillId, item.stepId, item.resultStepId, item.definitionFingerprint]);

/** Pure bounded projection of frozen receipts. Does not issue or restore authority. */
export function assessSceneScanCoverage(snapshot?: SceneScanCoverageSnapshot): SceneScanCoverageAssessment {
  if (!snapshot) return {status: 'unknown', captureStatus: 'unknown', reason: 'scan_coverage_not_registered', sources: []};
  type Receipt = SceneScanCoverageSnapshot['receipts'][number];
  const groups = new Map<string, {receipt: Receipt; attempts: Receipt[]; complete: Receipt[]; windows: Window[]}>();
  let processed = 0;
  const globalIssues = new Set(snapshot.diagnostics.map(item => item.code));
  for (const receipt of snapshot.receipts) {
    if (++processed > snapshot.maxUnionWindows) {globalIssues.add('scene_scan_union_budget_exhausted'); break;}
    // Preserve the old source grouping when validating policy-free history.
    const key = snapshot.plan ? scanKey(receipt) : JSON.stringify([
      receipt.domain, receipt.source, receipt.skillId, receipt.resultStepId, receipt.definitionFingerprint]);
    let group = groups.get(key);
    if (!group) {group = {receipt, attempts: [], complete: [], windows: []}; groups.set(key, group);}
    group.attempts.push(receipt);
    if (receipt.scanStatus === 'complete' && receipt.issues.length === 0) {
      group.complete.push(receipt); group.windows.push({startNs: receipt.window.start, endNs: receipt.window.end});
    }
  }
  for (const group of groups.values()) group.windows = unionWindows(group.windows);
  const outstandingIssues = (group: NonNullable<ReturnType<typeof groups.get>>) => {
    const issues = new Set(globalIssues);
    for (const receipt of group.attempts) {
      if (!snapshot.plan || uncovered({startNs: receipt.window.start, endNs: receipt.window.end}, group.windows).length)
        receipt.issues.forEach(issue => issues.add(issue));
    }
    return issues;
  };
  const sources = [...groups.values()].map(group => {
    const receipt = group.receipt;
    const issues = outstandingIssues(group);
    if (uncovered(snapshot.requestedWindow, group.windows).length) issues.add('scene_scan_window_gap');
    return {domain: receipt.domain, source: receipt.source, skillId: receipt.skillId, summaryStepId: receipt.stepId,
      resultStepId: receipt.resultStepId, definitionFingerprint: receipt.definitionFingerprint,
      scanStatus: issues.size ? 'partial' as const : 'complete' as const, windows: group.windows, issues: [...issues].sort()};
  });
  const plan = snapshot.plan;
  if (!plan?.targets.length) return freezeEvidenceValue({status: globalIssues.has('scene_coverage_plan_unavailable') || !sources.length ? 'unknown' : 'partial',
    captureStatus: 'unknown', reason: globalIssues.has('scene_coverage_plan_unavailable') ? 'scene_coverage_plan_unavailable' :
      sources.length ? 'capture_completeness_unproven' : 'scan_coverage_not_registered', sources});
  const targets: NonNullable<SceneScanCoverageAssessment['targets']>[number][] = plan.targets.map(target => {
    const group = target.producer && groups.get(scanKey({domain: target.domain, source: target.source,
      ...target.producer, stepId: target.producer.summaryStepId}));
    const windows = group?.windows ?? [];
    const gaps = uncovered(snapshot.requestedWindow, windows);
    const issues = group ? outstandingIssues(group) : new Set(globalIssues);
    if (target.bindingIssue) issues.add(target.bindingIssue);
    if (!group?.complete.length) issues.add('scene_scan_capability_unknown');
    if (gaps.length) issues.add('scene_scan_window_gap');
    const complete = !gaps.length && !issues.size;
    const observed = group?.complete.some(receipt => receipt.totalRows !== undefined && BigInt(receipt.totalRows) > 0n);
    return {id: target.id, domain: target.domain, source: target.source,
      capabilityStatus: group?.complete.length ? 'queryable' : 'unknown',
      observationStatus: observed ? 'observed' : complete ? 'unobserved' : 'unknown',
      scanStatus: complete ? 'complete' : windows.length ? 'partial' : 'unknown', scannedWindows: windows,
      unscannedWindows: gaps, captureUnknownWindows: [{...snapshot.requestedWindow}], issues: [...issues].sort(),
      historicalIssues: [...new Set(group?.attempts.flatMap(receipt => receipt.issues) ?? [])].sort()};
  });
  const complete = targets.every(target => target.scanStatus === 'complete');
  return freezeEvidenceValue({status: complete ? 'complete' : 'partial', captureStatus: 'unknown',
    reason: complete ? 'required_query_scans_complete_capture_unknown' : 'required_query_scans_incomplete',
    planFingerprint: plan.fingerprint, targets, sources});
}
