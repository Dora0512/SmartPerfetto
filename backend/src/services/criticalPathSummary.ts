// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Deterministic, provider-free rendering of a critical-path analysis.
//
// This lives apart from `criticalPathAiSummary.ts` on purpose: that module
// imports the Claude Agent SDK at module scope for `summarizeCriticalPathWithAi`,
// so anything importing it pays for an SDK load and an implicit provider
// dependency. The MCP `analyze_wait_chain` tool needs only this rule summary and
// must never reach a provider, so the pure function lives here and the old
// module re-exports it for its existing route consumer.

import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {CriticalPathAnalysis} from './criticalPathAnalyzer';
// One English table, not two. This module used to carry its own copy covering
// five of the fourteen modules and twelve of the fifteen findings, so every
// label added afterwards — the wake-source module and finding among them —
// reached the localized analysis and fell through here as Chinese.
import {englishAnomalyTitle, englishModuleName} from './criticalPathLocalization';

export function buildDeterministicCriticalPathSummary(
  analysis: CriticalPathAnalysis,
  outputLanguage: OutputLanguage = 'zh-CN',
): string {
  if (outputLanguage === 'en') {
    const lines = [
      'Critical-path analysis for the selected task.',
      '',
      'Evidence source: Perfetto sched.thread_executing_span_with_slice / _critical_path_stack.',
      `Selected task: ${analysis.task.processName ?? '-'} / ${analysis.task.threadName ?? '-'}, ${analysis.totalMs.toFixed(2)} ms.`,
      `External critical path: ${analysis.blockingMs.toFixed(2)} ms (${analysis.externalBlockingPercentage.toFixed(2)}%).`,
    ];

    if (analysis.moduleBreakdown.length > 0) {
      lines.push(
        `Primary modules: ${analysis.moduleBreakdown
          .slice(0, 4)
          .map((item) =>
            `${englishModuleName(item.module)} ` +
            `${item.durationMs.toFixed(2)} ms`)
          .join(', ')}.`,
      );
    }
    if (analysis.directWaker?.kind && analysis.directWaker.kind !== 'unknown') {
      lines.push(
        `Direct waker: ${analysis.directWaker.kind}${
          analysis.directWaker.threadName
            ? ` (${analysis.directWaker.threadName})`
            : ''
        }${analysis.directWaker.irqContext ? ', IRQ context' : ''}.`,
      );
    }
    if (analysis.quantification?.counterfactual) {
      lines.push(
        `Counterfactual upper bound: removing the longest external segment ` +
        `(${analysis.quantification.counterfactual.longestSegmentDurMs.toFixed(2)} ms) ` +
        `gives a task-duration upper bound of ` +
        `${analysis.quantification.counterfactual.upperBoundMs.toFixed(2)} ms. ` +
        'This is an upper bound, not a guaranteed prediction.',
      );
    }
    if (analysis.anomalies.length > 0) {
      lines.push(
        `Rule findings: ${analysis.anomalies
          .slice(0, 3)
          .map((item) => englishAnomalyTitle(item.title))
          .join('; ')}.`,
      );
    }
    return lines.filter(line => line !== undefined).join('\n');
  }

  const lines = [
    analysis.summary,
    '',
    '事实来源：Perfetto sched.thread_executing_span_with_slice / _critical_path_stack。',
    `选中 task：${analysis.task.processName ?? '-'} / ${analysis.task.threadName ?? '-'}，${analysis.totalMs.toFixed(2)} ms。`,
    `外部 critical path：${analysis.blockingMs.toFixed(2)} ms，占 ${analysis.externalBlockingPercentage.toFixed(2)}%。`,
  ];

  if (analysis.moduleBreakdown.length > 0) {
    lines.push(
      `主要模块：${analysis.moduleBreakdown
        .slice(0, 4)
        .map((item) => `${item.module} ${item.durationMs.toFixed(2)} ms`)
        .join('、')}。`
    );
  }
  if (analysis.directWaker?.kind && analysis.directWaker.kind !== 'unknown') {
    lines.push(
      `直接唤醒来源：${analysis.directWaker.kind}${
        analysis.directWaker.threadName ? ` (${analysis.directWaker.threadName})` : ''
      }${analysis.directWaker.irqContext ? '，IRQ 上下文' : ''}。`
    );
  }
  if (analysis.quantification?.counterfactual) {
    lines.push(
      `反事实上界：消除最长外部段（${analysis.quantification.counterfactual.longestSegmentDurMs.toFixed(2)} ms）后任务时长上界 ${analysis.quantification.counterfactual.upperBoundMs.toFixed(2)} ms（仅上界估算，可能因次长段成为新瓶颈而无法达到）。`
    );
  }
  if (analysis.anomalies.length > 0) {
    lines.push(`规则判断：${analysis.anomalies.slice(0, 3).map((item) => item.title).join('；')}。`);
  }
  if (analysis.recommendations.length > 0) {
    lines.push(`建议：${analysis.recommendations.slice(0, 2).join('；')}`);
  }

  return lines.filter((line) => line !== undefined).join('\n');
}
