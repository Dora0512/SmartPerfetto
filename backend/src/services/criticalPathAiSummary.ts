// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate, stripPromptComments} from '../agentv3/strategyLoader';
import {
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {redactObjectForLLM} from '../utils/llmPrivacy';
import {AI_CAPABILITY_ENV_KEY, type AiCapabilityPolicyV1} from './aiCapabilityPolicy';
import type {CriticalPathAnalysis} from './criticalPathAnalyzer';
import {projectCriticalPathAnalysis} from './criticalPathLocalization';
import {buildDeterministicCriticalPathSummary} from './criticalPathSummary';
import {
  resolveOneShotModelRoute,
  runIsolatedClaudeOneShot,
  type OneShotFallbackReason,
} from './oneShotModelCall';
import type {ProviderScope} from './providerManager';

// Re-exported so the critical-path route keeps its historical import site while
// the pure summary itself no longer drags the Claude Agent SDK in with it.
export {buildDeterministicCriticalPathSummary};

/** Why the deterministic rule summary was returned instead of a model answer. */
export type CriticalPathAiFallbackReason = OneShotFallbackReason;

export interface CriticalPathAiSummary {
  generated: boolean;
  model?: string;
  summary: string;
  warnings: string[];
  redactionApplied?: boolean;
  /** Set whenever `generated` is false; `warnings` carries the localized explanation. */
  fallbackReason?: CriticalPathAiFallbackReason;
}

export interface CriticalPathAiSummaryOptions {
  /**
   * Provider Manager scope of the caller. The summary follows that scope's
   * active profile exactly like an Agent run, instead of raw process env.
   */
  providerScope?: ProviderScope;
  /** Caller cancellation, e.g. the HTTP client disconnecting. */
  signal?: AbortSignal;
  /** Defaults to the process-wide `SMARTPERFETTO_AI_ENABLED` policy. */
  aiPolicy?: AiCapabilityPolicyV1;
  /**
   * Whether the caller may start model work (`agent:run`). Reading a trace is
   * not enough to spend the workspace's provider; false returns the rule
   * summary without any model call.
   */
  aiPermitted?: boolean;
}

type CriticalPathCounterfactual = NonNullable<
  NonNullable<CriticalPathAnalysis['quantification']>['counterfactual']
>;

interface CounterfactualView {
  longestSegmentDurMs: number;
  /** Best-case task duration once the longest external segment is removed. */
  bestCaseDurationMs: number;
  /** The saving that removal can buy at most (a shorter path may take over). */
  maxSavingMs: number;
}

// The pick keeps the deprecated `upperBoundMs` alias and the note out of the
// prompt: the model sees the best-case fields only.
function readCounterfactual(counterfactual: CriticalPathCounterfactual): CounterfactualView {
  const {longestSegmentDurMs, bestCaseDurationMs, maxSavingMs} = counterfactual;
  return {longestSegmentDurMs, bestCaseDurationMs, maxSavingMs};
}

// LLM input hard caps (Codex P1-6) — protect cost and avoid drowning the model
// in segment-level detail.
const HARD_CAPS = {
  segments: 16,
  childSegments: 4,
  binderTxnsPerSeg: 4,
  monitorPerSeg: 4,
  ioPerSeg: 4,
  gcPerSeg: 4,
  cpuPerSeg: 4,
  hypotheses: 3,
  warnings: 8,
  stringMaxLen: 200,
} as const;

function clampString<T>(value: T, max: number = HARD_CAPS.stringMaxLen): T {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return (value.slice(0, max - 1) + '…') as unknown as T;
}

// Codex P0-5: extend redaction beyond the generic API-key/path patterns to
// cover Android-specific PII surfaces — package names, binder methods,
// io paths, monitor methods, layer names.
function redactCriticalPathFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactCriticalPathFields(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      // Hypothesis text is built by the product from numeric-only
      // interpolation, and the prompt asks the model to reuse the SQL
      // verbatim; clamping it would cut the SQL mid-predicate.
      if (lk === 'statement' || lk === 'verificationsql' || lk === 'notes') {
        out[k] = v;
        continue;
      }
      // Hash-style obfuscation for sensitive identifiers (keep grouping but
      // not the literal value).
      if (
        lk === 'package_name' ||
        lk === 'packagename' ||
        lk === 'app_package' ||
        lk === 'method_name' ||
        lk === 'methodname' ||
        lk === 'short_blocking_method' ||
        lk === 'short_blocked_method' ||
        lk === 'blocking_method' ||
        lk === 'blocked_method' ||
        lk === 'interface' ||
        lk === 'interfacename' ||
        lk === 'aidl_name' ||
        lk === 'layer_name' ||
        lk === 'layername' ||
        lk === 'io_path' ||
        lk === 'iopath' ||
        lk === 'path' ||
        // The compact payload's own keys (binder and monitor methods).
        lk === 'method' ||
        lk === 'blockedmethod'
      ) {
        if (typeof v === 'string' && v.length > 0) {
          out[k] = `<${lk}_${Buffer.from(v).toString('base64').slice(0, 8)}>`;
          continue;
        }
      }
      out[k] = clampString(redactCriticalPathFields(v));
    }
    return out;
  }
  if (typeof value === 'string') {
    return clampString(value);
  }
  return value;
}

interface TrimmedSegment {
  startOffsetMs: number;
  durationMs: number;
  threadName: string | null | undefined;
  processName: string | null | undefined;
  state: string | null | undefined;
  blockedFunction: string | null | undefined;
  cpu: number | null | undefined;
  ioWait: boolean | null | undefined;
  modules: string[];
  reasons: string[];
  semantics?: unknown;
  children?: TrimmedSegment[];
}

function compactAnalysisForLLM(analysis: CriticalPathAnalysis): unknown {
  const trimSegment = (segment: CriticalPathAnalysis['wakeupChain'][number]): TrimmedSegment => ({
    startOffsetMs: segment.startOffsetMs,
    durationMs: segment.durationMs,
    threadName: segment.threadName,
    processName: segment.processName,
    state: segment.state,
    blockedFunction: segment.blockedFunction,
    cpu: segment.cpu,
    ioWait: segment.ioWait,
    modules: segment.modules,
    reasons: segment.reasons.slice(0, 6),
    semantics: segment.semantics
      ? {
          binderTxns: segment.semantics.binderTxns.slice(0, HARD_CAPS.binderTxnsPerSeg).map((txn) => ({
            side: txn.side,
            isSync: txn.isSync,
            isMainThread: txn.isMainThread,
            method: txn.methodName,
            interface: txn.interfaceName,
            durMs: txn.durMs,
          })),
          monitorContention: segment.semantics.monitorContention.slice(0, HARD_CAPS.monitorPerSeg).map((mc) => ({
            method: mc.shortBlockingMethod,
            blockedMethod: mc.shortBlockedMethod,
            blockedThread: mc.blockedThreadName,
            blockingThread: mc.blockingThreadName,
            durMs: mc.durMs,
            isBlockedThreadMain: mc.isBlockedThreadMain,
          })),
          ioSignals: segment.semantics.ioSignals.slice(0, HARD_CAPS.ioPerSeg).map((io) => ({
            source: io.source,
            blockedFunction: io.blockedFunction,
            durMs: io.durMs,
          })),
          gcEvents: segment.semantics.gcEvents.slice(0, HARD_CAPS.gcPerSeg).map((gc) => ({
            type: gc.gcType,
            isMarkCompact: gc.isMarkCompact,
            reclaimedMb: gc.reclaimedMb,
            durMs: gc.durMs,
          })),
          cpuCompetition: segment.semantics.cpuCompetition.slice(0, HARD_CAPS.cpuPerSeg).map((cpu) => ({
            cpu: cpu.cpu,
            competingThread: cpu.competingThread,
            competingState: cpu.competingState,
            competingDurMs: cpu.competingDurMs,
            cpuMaxFreqKhz: cpu.cpuMaxFreqKhz,
          })),
        }
      : undefined,
    children: segment.children
      ? segment.children.slice(0, HARD_CAPS.childSegments).map((child) => trimSegment(child))
      : undefined,
  });

  return {
    available: analysis.available,
    task: analysis.task,
    totalMs: analysis.totalMs,
    blockingMs: analysis.blockingMs,
    selfMs: analysis.selfMs,
    externalBlockingPercentage: analysis.externalBlockingPercentage,
    wakeupChain: analysis.wakeupChain.slice(0, HARD_CAPS.segments).map((segment) => trimSegment(segment)),
    moduleBreakdown: analysis.moduleBreakdown.slice(0, 8),
    ruleAnomalies: analysis.anomalies.slice(0, 8),
    ruleRecommendations: analysis.recommendations.slice(0, 6),
    warnings: analysis.warnings.slice(0, HARD_CAPS.warnings),
    rawRows: analysis.rawRows,
    truncated: analysis.truncated,
    slices: analysis.slices?.slice(0, 6),
    directWaker: analysis.directWaker,
    quantification: analysis.quantification
      ? {
          counterfactual: analysis.quantification.counterfactual
            ? readCounterfactual(analysis.quantification.counterfactual)
            : null,
          frameImpacts: analysis.quantification.frameImpacts.slice(0, 4),
          hypotheses: analysis.quantification.hypotheses.slice(0, HARD_CAPS.hypotheses),
        }
      : undefined,
    semanticSources: analysis.semanticSources,
  };
}

/** Localized explanation for each deterministic-summary fallback. */
function fallbackWarning(
  reason: CriticalPathAiFallbackReason,
  outputLanguage: OutputLanguage,
  detail = '',
): string {
  switch (reason) {
    case 'ai_disabled':
      return localize(
        outputLanguage,
        `AI 已由 ${AI_CAPABILITY_ENV_KEY} 关闭，已返回规则兜底总结。`,
        `AI is disabled by ${AI_CAPABILITY_ENV_KEY}; a deterministic rule summary was returned.`,
      );
    case 'runtime_not_supported':
      return localize(
        outputLanguage,
        `当前 Provider 使用 ${detail} 运行时，关键路径 AI 总结只支持 Claude Agent SDK，已返回规则兜底总结。`,
        `The active provider uses the ${detail} runtime; the critical-path AI summary supports only the Claude Agent SDK, so a deterministic rule summary was returned.`,
      );
    case 'runtime_unavailable':
      return localize(
        outputLanguage,
        '无法解析当前 AI Provider，已返回规则兜底总结。',
        'The active AI provider could not be resolved; a deterministic rule summary was returned.',
      );
    case 'credentials_missing':
      return localize(
        outputLanguage,
        'AI 模型未配置，已返回规则兜底总结。',
        'No AI model is configured; a deterministic rule summary was returned.',
      );
    case 'client_disconnected':
      return localize(
        outputLanguage,
        '客户端已断开，AI 诊断已取消。',
        'The client disconnected, so the AI diagnosis was cancelled.',
      );
    case 'timed_out':
      return localize(
        outputLanguage,
        'AI 诊断超时，已返回规则兜底总结。',
        'AI diagnosis timed out; a deterministic rule summary was returned.',
      );
    case 'failed':
      // The provider's own error text stays in the server log.
      return localize(
        outputLanguage,
        'AI 诊断失败，已返回规则兜底总结。',
        'AI diagnosis failed; a deterministic rule summary was returned.',
      );
    case 'permission_denied':
      return localize(
        outputLanguage,
        '当前账号没有运行 AI 分析的权限（agent:run），已返回规则兜底总结。',
        'This account may not run AI analysis (agent:run); a deterministic rule summary was returned.',
      );
    case 'empty_response':
      return localize(
        outputLanguage,
        'AI 没有返回有效内容，已返回规则兜底总结。',
        'The AI returned no valid content; a deterministic rule summary was returned.',
      );
  }
}

function buildStructuredPrompt(
  analysis: CriticalPathAnalysis,
  question: string | undefined,
  outputLanguage: OutputLanguage,
): {prompt: string; redactionApplied: boolean} | undefined {
  const template = loadPromptTemplate(
    outputLanguage === 'en' ? 'prompt-critical-path-summary-en' : 'prompt-critical-path-summary-zh',
  );
  if (!template) return undefined;
  // The model reads the facts in the language it answers in.
  const compact = compactAnalysisForLLM(projectCriticalPathAnalysis(analysis, outputLanguage));
  const redacted = redactObjectForLLM(redactCriticalPathFields(compact));
  const prompt = renderTemplate(stripPromptComments(template), {
    factsJson: JSON.stringify(redacted.value).slice(0, 32_000),
    questionBlock: question
      ? localize(
          outputLanguage,
          `\n\n用户额外问题：${clampString(question, 500)}`,
          `\n\nAdditional user question: ${clampString(question, 500)}`,
        )
      : '',
  });
  return {prompt, redactionApplied: redacted.stats.applied};
}

/**
 * Optional model narrative over the deterministic analysis. Every path that
 * does not produce a model answer returns the deterministic summary with a
 * `fallbackReason` and a localized warning; this function never throws for
 * policy, permission, provider, or model failures.
 */
export async function summarizeCriticalPathWithAi(
  analysis: CriticalPathAnalysis,
  question?: string,
  outputLanguage: OutputLanguage = 'zh-CN',
  options: CriticalPathAiSummaryOptions = {},
): Promise<CriticalPathAiSummary> {
  const fallback = buildDeterministicCriticalPathSummary(analysis, outputLanguage);
  const degrade = (
    reason: CriticalPathAiFallbackReason,
    extra: Pick<CriticalPathAiSummary, 'model' | 'redactionApplied'> = {},
    detail = '',
  ): CriticalPathAiSummary => ({
    generated: false,
    ...extra,
    summary: fallback,
    warnings: [fallbackWarning(reason, outputLanguage, detail)],
    fallbackReason: reason,
  });

  // The operator switch and the caller's permission are checked before any
  // provider or credential lookup: no trace-derived text may reach a model
  // otherwise.
  const route = resolveOneShotModelRoute({
    feature: 'critical_path_ai_summary',
    providerScope: options.providerScope,
    aiPolicy: options.aiPolicy,
    logLabel: 'CriticalPathAI',
  });
  if (route.kind === 'unavailable' && route.reason === 'ai_disabled') return degrade('ai_disabled');
  if (options.aiPermitted === false) return degrade('permission_denied');
  if (options.signal?.aborted) return degrade('client_disconnected');
  if (route.kind === 'unavailable') return degrade(route.reason);
  if (route.runtime !== 'claude-agent-sdk') return degrade('runtime_not_supported', {}, route.runtime);

  const built = buildStructuredPrompt(analysis, question, outputLanguage);
  if (!built) return degrade('failed');
  const timeoutMs = Number.parseInt(process.env.CRITICAL_PATH_AI_TIMEOUT_MS || '60000', 10);
  const result = await runIsolatedClaudeOneShot({
    prompt: built.prompt,
    tier: 'main',
    timeoutMs,
    signal: options.signal,
    logLabel: 'CriticalPathAI',
    providerScope: options.providerScope,
  });
  const attempted = {...(result.model ? {model: result.model} : {}), redactionApplied: built.redactionApplied};
  if (!result.ok) return degrade(result.reason, attempted);
  return {generated: true, ...attempted, model: result.model, summary: result.text, warnings: []};
}
