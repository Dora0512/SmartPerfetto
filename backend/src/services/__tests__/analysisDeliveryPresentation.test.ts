// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  claimVerificationStatusLine,
  deriveDeliveryVerdict,
  summarizeClaimVerification,
} from '../analysisInvestigationPresentation';
import {analysisConfidenceIsGrounded} from '../../agentv3/analysisTermination';

describe('delivery verdict', () => {
  // Every input the Web panel's analysisCompletedResultStatus reports as partial
  // must be `partial` or `unverified` here, never `completed`.
  it.each([
    [{success: false}, 'failed'],
    [{success: true, partial: true}, 'partial'],
    [{success: true, deliveryAssurance: {claims: 'coverage_incomplete'}}, 'unverified'],
    [{success: true, deliveryAssurance: {report: 'failed'}}, 'unverified'],
    [{success: true, conclusionContract: {bindingEligibility: 'ineligible'}}, 'unverified'],
    [{success: true, claimSupport: [{bindingEligibility: 'eligible'}, {bindingEligibility: 'ineligible'}]}, 'unverified'],
    [{success: true, deliveryAssurance: {completion: 'passed', claims: 'passed', source: 'not_applicable',
      identity: 'not_applicable', report: 'not_checked'}}, 'completed'],
    [{success: true}, 'completed'],
  ] as const)('classifies %j as %s', (input, expected) => {
    expect(deriveDeliveryVerdict(input as never)).toBe(expected);
  });

  it('keeps a failed quality gate partial even when assurance is also incomplete', () => {
    expect(deriveDeliveryVerdict({success: true, partial: true, deliveryAssurance: {claims: 'failed'}})).toBe('partial');
  });
});

describe('claim verification status line', () => {
  const summary = (status: string, statuses: string[], extra: Record<string, unknown> = {}) =>
    summarizeClaimVerification({status, claimResults: statuses.map(item => ({status: item})), issues: [], ...extra});

  it('derives counts from claim results rather than stored counters', () => {
    expect(summarizeClaimVerification({status: 'failed', checkedClaimCount: 99, unsupportedClaimCount: 99,
      claimResults: [{status: 'verified'}, {status: 'unsupported'}, {status: 'not_checked'}], issues: [{}, {}]} as never))
      .toEqual({status: 'failed', totalClaimCount: 3, checkedClaimCount: 2, verifiedClaimCount: 1,
        unsupportedClaimCount: 1, issueCount: 2});
  });

  it('reports failure without treating every unsupported reference as a contradiction', () => {
    expect(claimVerificationStatusLine(summary('failed', ['partial', 'unsupported']), 'zh-CN'))
      .toBe('断言核验: 未通过，1 条断言未通过核验（已核验 0/2）');
    expect(claimVerificationStatusLine(summary('failed', ['partial', 'unsupported']), 'en'))
      .toBe('Claim verification: failed — 1 claim(s) failed verification (verified 0/2)');
  });

  it('names an invalid declaration as unverified, not contradicted', () => {
    expect(claimVerificationStatusLine(summary('partial', ['not_checked', 'not_checked'],
      {notCheckedReason: 'invalid_declarations'}), 'en'))
      .toBe('Claim verification: not verified 0/2 (the conclusion declaration was invalid, so no claim was admitted)');
  });

  it('reports partial and complete verification and an empty claim set', () => {
    expect(claimVerificationStatusLine(summary('partial', ['verified', 'partial'], {notCheckedReason: 'timeout'}), 'en'))
      .toBe('Claim verification: partially verified 1/2 (semantic review ran out of time)');
    expect(claimVerificationStatusLine(summary('passed', ['verified', 'verified']), 'en')).toBe('Claim verification: verified 2/2');
    expect(claimVerificationStatusLine(summary('not_checked', []), 'en')).toBe('Claim verification: no structured claims');
    expect(claimVerificationStatusLine(undefined, 'en')).toBeUndefined();
  });

  it('appends closed-vocabulary triage detail after the reason', () => {
    expect(claimVerificationStatusLine(summary('partial', ['not_checked', 'not_checked'],
      {notCheckedReason: 'invalid_declarations', notCheckedDetail: 'invalid_json,duplicate_marker'}), 'zh-CN'))
      .toBe('断言核验: 未核验 0/2（结论声明格式无效，断言未进入核验：invalid_json,duplicate_marker）');
    expect(claimVerificationStatusLine(summary('partial', ['not_checked'],
      {notCheckedReason: 'provider_error', notCheckedDetail: 'http_429;attempts_2'}), 'en'))
      .toBe('Claim verification: not verified 0/1 (the semantic review call failed: http_429;attempts_2)');
    expect(claimVerificationStatusLine(summary('partial', ['not_checked'], {notCheckedReason: 'timeout'}), 'en'))
      .toBe('Claim verification: not verified 0/1 (semantic review ran out of time)');
  });
});

describe('grounded confidence', () => {
  it('treats the no-findings baseline as ungrounded', () => {
    expect(analysisConfidenceIsGrounded({findings: []})).toBe(false);
    expect(analysisConfidenceIsGrounded({})).toBe(false);
    expect(analysisConfidenceIsGrounded({findings: [{}]})).toBe(true);
  });
});
