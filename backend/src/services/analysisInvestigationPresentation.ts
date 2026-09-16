// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {AnalysisDeliveryAssurance, AnalysisAssuranceStatus} from '../types/analysisDelivery';

/** Presentation only: missing historical fields never become successful checks. */
export function investigationStatusLines(
  assurance: Pick<AnalysisDeliveryAssurance, 'investigation' | 'investigationEvidence'> | undefined,
  language: OutputLanguage,
): string[] {
  const label = (status: AnalysisAssuranceStatus | undefined): string => {
    switch (status) {
      case 'passed': return localize(language, '已核验', 'Checked');
      case 'not_applicable': return localize(language, '本轮不适用', 'Not applicable to this turn');
      case 'coverage_incomplete': return localize(language, '仍有必需维度缺失', 'Required dimensions remain incomplete');
      case 'unavailable': return localize(language, '核验不可用', 'Assessment unavailable');
      case 'failed': return localize(language, '未通过核验', 'Assessment failed');
      default: return localize(language, '尚未核验', 'Not checked');
    }
  };
  return [
    `${localize(language, '系统调查覆盖', 'System investigation coverage')}: ${label(assurance?.investigation)}`,
    `${localize(language, '系统证据覆盖', 'System evidence coverage')}: ${label(assurance?.investigationEvidence)}`,
  ];
}

export interface ClaimVerificationStatusSummary {
  status?: string;
  totalClaimCount?: number;
  checkedClaimCount?: number;
  verifiedClaimCount?: number;
  unsupportedClaimCount?: number;
  notCheckedReason?: string;
  notCheckedDetail?: string;
}

/**
 * One line that separates "claims contradict the evidence" from "claims were
 * not verified". Both used to reach the terminal only as the session marker,
 * and a delivered answer with zero verified claims printed the same green tick
 * as a fully verified one.
 */
export function claimVerificationStatusLine(
  summary: ClaimVerificationStatusSummary | undefined,
  language: OutputLanguage,
): string | undefined {
  if (!summary?.status) return undefined;
  const total = summary.totalClaimCount ?? 0;
  const verified = summary.verifiedClaimCount ?? 0;
  const unsupported = summary.unsupportedClaimCount ?? 0;
  const prefix = localize(language, '断言核验', 'Claim verification');
  const explanation = claimVerificationNotCheckedExplanation(summary, language);
  const detail = explanation ? localize(language, `（${explanation}）`, ` (${explanation})`) : '';
  if (summary.status === 'failed') {
    return `${prefix}: ${localize(language, `未通过，${unsupported} 条断言与证据不符（已核验 ${verified}/${total}）`,
      `failed — ${unsupported} claim(s) contradict the evidence (verified ${verified}/${total})`)}`;
  }
  if (summary.status === 'passed') {
    return `${prefix}: ${localize(language, `已核验 ${verified}/${total}`, `verified ${verified}/${total}`)}`;
  }
  if (total === 0) return `${prefix}: ${localize(language, '无结构化断言', 'no structured claims')}${detail}`;
  return `${prefix}: ${verified > 0
    ? localize(language, `部分核验 ${verified}/${total}`, `partially verified ${verified}/${total}`)
    : localize(language, `未核验 0/${total}`, `not verified 0/${total}`)}${detail}`;
}

/**
 * Why claims were not checked, with the closed-vocabulary detail codes when
 * present. Shared by the CLI status line and the HTML report so both name the
 * same cause.
 */
export function claimVerificationNotCheckedExplanation(
  verification: {notCheckedReason?: string; notCheckedDetail?: string} | undefined,
  language: OutputLanguage,
): string | undefined {
  const notCheckedReason = verification?.notCheckedReason;
  if (!notCheckedReason) return undefined;
  const reason = (() => {
    switch (notCheckedReason) {
      case 'invalid_declarations': return localize(language, '结论声明格式无效，断言未进入核验', 'the conclusion declaration was invalid, so no claim was admitted');
      case 'timeout': return localize(language, '语义复核超出时间预算', 'semantic review ran out of time');
      case 'provider_error': return localize(language, '语义复核调用失败', 'the semantic review call failed');
      case 'invalid_snapshot': return localize(language, '核验输入不完整', 'the verification input was incomplete');
      case 'complete_proposition_review_unavailable': return localize(language, '完整命题复核不可用', 'complete proposition review was unavailable');
      default: return notCheckedReason;
    }
  })();
  return verification.notCheckedDetail
    ? localize(language, `${reason}：${verification.notCheckedDetail}`, `${reason}: ${verification.notCheckedDetail}`)
    : reason;
}

/** Display counts come from the claim results themselves, never from a stored count. */
export function summarizeClaimVerification(verification: {
  status: string; unsupportedClaimCount?: number; notCheckedReason?: string; notCheckedDetail?: string;
  claimResults?: readonly {status: string}[]; issues?: readonly unknown[];
} | undefined): (ClaimVerificationStatusSummary & {issueCount: number}) | undefined {
  if (!verification) return undefined;
  const claims = verification.claimResults ?? [];
  return {
    status: verification.status,
    totalClaimCount: claims.length,
    checkedClaimCount: claims.filter(claim => claim.status !== 'not_checked').length,
    verifiedClaimCount: claims.filter(claim => claim.status === 'verified').length,
    unsupportedClaimCount: claims.filter(claim => claim.status === 'unsupported').length,
    ...(verification.notCheckedReason ? {notCheckedReason: verification.notCheckedReason} : {}),
    ...(verification.notCheckedDetail ? {notCheckedDetail: verification.notCheckedDetail} : {}),
    issueCount: verification.issues?.length ?? 0,
  };
}

export type DeliveryVerdict = 'completed' | 'unverified' | 'partial' | 'failed';

/**
 * One classification of a finished turn for terminal markers.
 *
 * The Web panel (analysisCompletedResultStatus) shows `partial` for everything
 * that is not a clean completion: an unfinished run, a failed quality gate,
 * incomplete delivery assurance, or an ineligible declaration. The CLI splits
 * that set in two so its marker says which one happened — `partial` for an
 * unfinished run or claims that contradict the evidence, `unverified` for a
 * delivered answer whose checks did not complete. Round 60 printed the same
 * `!` for both, and a green tick for answers with zero verified claims.
 */
export function deriveDeliveryVerdict(result: {
  success?: boolean;
  partial?: boolean;
  deliveryAssurance?: Partial<Pick<AnalysisDeliveryAssurance, 'completion' | 'claims' | 'source' | 'identity' | 'report'>>;
  conclusionContract?: {bindingEligibility?: string} | null;
  claimSupport?: readonly {bindingEligibility?: string}[];
}): DeliveryVerdict {
  if (result.success === false) return 'failed';
  if (result.partial) return 'partial';
  const assurance = result.deliveryAssurance;
  const incomplete = Boolean(assurance && (['completion', 'claims', 'source', 'identity', 'report'] as const)
    .some(key => assurance[key] === 'failed' || assurance[key] === 'coverage_incomplete'));
  const ineligible = result.conclusionContract?.bindingEligibility === 'ineligible' ||
    Boolean(result.claimSupport?.some(claim => claim.bindingEligibility === 'ineligible'));
  return incomplete || ineligible ? 'unverified' : 'completed';
}
