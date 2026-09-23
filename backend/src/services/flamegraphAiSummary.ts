// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate, stripPromptComments} from '../agentv3/strategyLoader';
import {redactObjectForLLM} from '../utils/llmPrivacy';
import type {AiCapabilityPolicyV1} from './aiCapabilityPolicy';
import type {FlamegraphAiSummary, FlamegraphAnalysis} from './flamegraphTypes';
import {runOneShotSummary} from './oneShotModelCall';
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
 * provider or model failures. The flamegraph surface (its static page and rule
 * summary) is Chinese only.
 */
export async function summarizeFlamegraphWithAi(
  analysis: FlamegraphAnalysis,
  question?: string,
  options: FlamegraphAiSummaryOptions = {},
): Promise<FlamegraphAiSummary> {
  return runOneShotSummary({
    feature: 'flamegraph_ai_summary',
    label: {zh: '火焰图 AI 总结', en: 'flamegraph AI summary'},
    logLabel: 'FlamegraphAI',
    outputLanguage: 'zh-CN',
    ruleSummary: () => buildDeterministicFlamegraphSummary(analysis),
    buildPrompt: () => buildPrompt(analysis, question),
    timeoutMs: Number.parseInt(process.env.FLAMEGRAPH_AI_TIMEOUT_MS || '60000', 10),
    aiPolicy: options.aiPolicy,
    aiPermitted: options.aiPermitted,
    signal: options.signal,
    providerScope: options.providerScope,
  });
}
