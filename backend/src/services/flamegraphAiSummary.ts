// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate, stripPromptComments} from '../agentv3/strategyLoader';
import {redactObjectForLLM} from '../utils/llmPrivacy';
import {AI_CAPABILITY_ENV_KEY, type AiCapabilityPolicyV1} from './aiCapabilityPolicy';
import type {FlamegraphAiFallbackReason, FlamegraphAiSummary, FlamegraphAnalysis} from './flamegraphTypes';
import {resolveOneShotModelRoute, runIsolatedClaudeOneShot} from './oneShotModelCall';
import type {ProviderScope} from './providerManager';

function pct(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

export function buildDeterministicFlamegraphSummary(analysis: FlamegraphAnalysis): string {
  if (!analysis.available || analysis.filteredSampleCount === 0) {
    return [
      '这份 trace 里没有可用于火焰图的 CPU 调用栈采样，暂时不能判断热点函数。',
      analysis.warnings.length > 0 ? `补充信息：${analysis.warnings.slice(0, 3).join('；')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const topSelf = analysis.topFunctions.slice(0, 5);
  const topCumulative = analysis.topCumulativeFunctions.slice(0, 5);
  const topCategory = analysis.categoryBreakdown.find((item) => item.selfCount > 0);
  const hotPath = analysis.hotPaths[0];
  const topThread = analysis.threadBreakdown[0];
  const lines = [
    `这次火焰图共命中 ${analysis.filteredSampleCount} 个 CPU 采样，需要分开看“自占热点”和“累计调用链热点”。`,
  ];

  if (topSelf.length > 0) {
    lines.push(
      `自占最高的函数是：${topSelf.map((item) => `${item.name}（${item.categoryLabel}，自占 ${item.selfCount}，约 ${pct(item.selfPercentage)}）`).join('、')}。这些更接近“CPU 真正烧在函数自己身上”的位置。`
    );
  }
  if (topCumulative.length > 0) {
    lines.push(
      `累计最高的调用链节点是：${topCumulative.map((item) => `${item.name}（累计 ${item.sampleCount}，约 ${pct(item.cumulativePercentage)}）`).join('、')}。这些更适合用来往下展开追最热路径。`
    );
  }
  if (topCategory) {
    lines.push(
      `按归类看，${topCategory.label} 的自占采样最突出，占 ${pct(topCategory.percentage)}，可以先判断这是业务代码、Framework、Native 还是系统侧开销。`
    );
  }
  if (hotPath) {
    lines.push(`最热路径大致是：${hotPath.compressedFrames.join(' -> ')}，占 ${pct(hotPath.percentage)}。`);
  }
  if (topThread) {
    lines.push(
      `线程维度上，${topThread.processName}/${topThread.threadName} 最突出，占 ${pct(topThread.percentage)}。`
    );
  }
  lines.push(
    '建议优先从最高自占函数判断“谁在直接耗 CPU”，再从最高累计节点和最热路径判断“是谁把这条热路径调起来的”。如果热点落在业务代码，重点查循环、锁、IO、序列化或重复计算；如果落在 Framework/Native/Kernel，就向上追业务入口。'
  );

  if (analysis.warnings.length > 0) {
    lines.push(`注意：${analysis.warnings.slice(0, 3).join('；')}`);
  }

  return lines.join('\n');
}

function compactAnalysisForLLM(analysis: FlamegraphAnalysis): unknown {
  return {
    available: analysis.available,
    sampleCount: analysis.sampleCount,
    filteredSampleCount: analysis.filteredSampleCount,
    source: analysis.source,
    analyzer: analysis.analyzer,
    topFunctions: analysis.topFunctions.slice(0, 15),
    topCumulativeFunctions: analysis.topCumulativeFunctions.slice(0, 15),
    categoryBreakdown: analysis.categoryBreakdown.slice(0, 8),
    hotPaths: analysis.hotPaths.slice(0, 8).map((path) => ({
      ...path,
      frames: path.frames.slice(-12),
      compressedFrames: path.compressedFrames,
    })),
    threadBreakdown: analysis.threadBreakdown.slice(0, 10),
    warnings: analysis.warnings.slice(0, 10),
  };
}

export interface FlamegraphAiSummaryOptions {
  /** Provider Manager scope of the caller; the call follows its active profile. */
  providerScope?: ProviderScope;
  /** Caller cancellation, e.g. the HTTP client disconnecting. */
  signal?: AbortSignal;
  /** Defaults to the process-wide `SMARTPERFETTO_AI_ENABLED` policy. */
  aiPolicy?: AiCapabilityPolicyV1;
  /** Whether the caller may start model work (`agent:run`); false never calls a model. */
  aiPermitted?: boolean;
}

// The flamegraph surface is Chinese-only (its static page and rule summary).
function fallbackWarning(reason: FlamegraphAiFallbackReason, detail = ''): string {
  switch (reason) {
    case 'ai_disabled':
      return `AI 已由 ${AI_CAPABILITY_ENV_KEY} 关闭，已返回规则兜底总结。`;
    case 'permission_denied':
      return '当前账号没有运行 AI 分析的权限（agent:run），已返回规则兜底总结。';
    case 'runtime_not_supported':
      return `当前 Provider 使用 ${detail} 运行时，火焰图 AI 总结只支持 Claude Agent SDK，已返回规则兜底总结。`;
    case 'runtime_unavailable':
      return '无法解析当前 AI Provider，已返回规则兜底总结。';
    case 'credentials_missing':
      return 'AI 模型未配置，已返回规则兜底总结。';
    case 'client_disconnected':
      return '客户端已断开，AI 总结已取消。';
    case 'timed_out':
      return 'AI 总结超时，已返回规则兜底总结。';
    case 'failed':
      // The provider's own error text stays in the server log.
      return 'AI 总结失败，已返回规则兜底总结。';
    case 'empty_response':
      return 'AI 没有返回有效内容，已返回规则兜底总结。';
  }
}

function buildPrompt(
  analysis: FlamegraphAnalysis,
  question: string | undefined,
): {prompt: string; redactionApplied: boolean} | undefined {
  const template = loadPromptTemplate('prompt-flamegraph-summary');
  if (!template) return undefined;
  const redacted = redactObjectForLLM(compactAnalysisForLLM(analysis));
  const prompt = renderTemplate(stripPromptComments(template), {
    questionBlock: question ? `\n\n用户问题：${question.slice(0, 500)}` : '',
    statsJson: JSON.stringify(redacted.value),
  });
  return {prompt, redactionApplied: redacted.stats.applied};
}

/**
 * Optional model narrative over the flamegraph statistics. Every path that
 * does not produce a model answer returns the rule summary with a
 * `fallbackReason` and a warning; this never throws for policy, permission,
 * provider or model failures.
 */
export async function summarizeFlamegraphWithAi(
  analysis: FlamegraphAnalysis,
  question?: string,
  options: FlamegraphAiSummaryOptions = {},
): Promise<FlamegraphAiSummary> {
  const fallback = buildDeterministicFlamegraphSummary(analysis);
  const degrade = (
    reason: FlamegraphAiFallbackReason,
    extra: Pick<FlamegraphAiSummary, 'model' | 'redactionApplied'> = {},
    detail = '',
  ): FlamegraphAiSummary => ({
    generated: false,
    ...extra,
    summary: fallback,
    warnings: [fallbackWarning(reason, detail)],
    fallbackReason: reason,
  });

  // Operator switch and caller permission first: no trace-derived text may
  // reach a model otherwise.
  const route = resolveOneShotModelRoute({
    feature: 'flamegraph_ai_summary',
    providerScope: options.providerScope,
    aiPolicy: options.aiPolicy,
    logLabel: 'FlamegraphAI',
  });
  if (route.kind === 'unavailable' && route.reason === 'ai_disabled') return degrade('ai_disabled');
  if (options.aiPermitted === false) return degrade('permission_denied');
  if (options.signal?.aborted) return degrade('client_disconnected');
  if (route.kind === 'unavailable') return degrade(route.reason);
  if (route.runtime !== 'claude-agent-sdk') return degrade('runtime_not_supported', {}, route.runtime);

  const built = buildPrompt(analysis, question);
  if (!built) return degrade('failed');
  const timeoutMs = Number.parseInt(process.env.FLAMEGRAPH_AI_TIMEOUT_MS || '60000', 10);
  const result = await runIsolatedClaudeOneShot({
    prompt: built.prompt,
    tier: 'main',
    timeoutMs,
    signal: options.signal,
    logLabel: 'FlamegraphAI',
    providerScope: options.providerScope,
  });
  const attempted = {...(result.model ? {model: result.model} : {}), redactionApplied: built.redactionApplied};
  if (!result.ok) return degrade(result.reason, attempted);
  return {generated: true, ...attempted, model: result.model, summary: result.text, warnings: []};
}
