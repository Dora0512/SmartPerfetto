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
import {projectCriticalPathAnalysis} from './criticalPathLocalization';

export function buildDeterministicCriticalPathSummary(
  analysis: CriticalPathAnalysis,
  outputLanguage: OutputLanguage = 'zh-CN',
): string {
  const counterfactual = analysis.quantification?.counterfactual;
  if (outputLanguage === 'en') {
    // The localization projection owns every English label; read the module
    // and anomaly names from it instead of keeping a second map. It is
    // idempotent, so an analysis the caller already projected is safe here.
    const view = projectCriticalPathAnalysis(analysis, 'en');
    const lines = [
      'Critical-path analysis for the selected task.',
      '',
      'Evidence source: Perfetto sched.thread_executing_span_with_slice / _critical_path_stack.',
      `Selected task: ${analysis.task.processName ?? '-'} / ${analysis.task.threadName ?? '-'}, ${analysis.totalMs.toFixed(2)} ms.`,
      `External critical path: ${analysis.blockingMs.toFixed(2)} ms (${analysis.externalBlockingPercentage.toFixed(2)}%).`,
    ];

    if (view.moduleBreakdown.length > 0) {
      lines.push(
        `Primary modules: ${view.moduleBreakdown
          .slice(0, 4)
          .map((item) => `${item.module} ${item.durationMs.toFixed(2)} ms`)
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
    if (counterfactual) {
      lines.push(
        `Counterfactual best case: removing the longest external segment ` +
        `(${counterfactual.longestSegmentDurMs.toFixed(2)} ms) leaves a best-case task duration of ` +
        `${counterfactual.bestCaseDurationMs.toFixed(2)} ms, a saving of at most ` +
        `${counterfactual.maxSavingMs.toFixed(2)} ms. ` +
        'Another wait may become the bottleneck, so the real saving can be smaller.',
      );
    }
    if (view.anomalies.length > 0) {
      lines.push(`Rule findings: ${view.anomalies.slice(0, 3).map((item) => item.title).join('; ')}.`);
    }
    return lines.join('\n');
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
  if (counterfactual) {
    lines.push(
      `反事实最好情况：消除最长外部段（${counterfactual.longestSegmentDurMs.toFixed(2)} ms）后，` +
      `任务时长最好可降至 ${counterfactual.bestCaseDurationMs.toFixed(2)} ms，即至多节省 ` +
      `${counterfactual.maxSavingMs.toFixed(2)} ms；其他等待可能成为新瓶颈，实际节省可能更少。`
    );
  }
  if (analysis.anomalies.length > 0) {
    lines.push(`规则判断：${analysis.anomalies.slice(0, 3).map((item) => item.title).join('；')}。`);
  }
  if (analysis.recommendations.length > 0) {
    lines.push(`建议：${analysis.recommendations.slice(0, 2).join('；')}`);
  }

  return lines.join('\n');
}
