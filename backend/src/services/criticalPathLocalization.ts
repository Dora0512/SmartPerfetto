// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Renders every display field of a critical-path analysis from the ids the
// engine recorded (see criticalPathText.ts). Rendering is idempotent — it
// never reads previously rendered text — so any analysis, raw or already
// projected, can be rendered into any output language.

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {CriticalPathAnalysis, CriticalPathSegment} from './criticalPathAnalyzer';
import {
  anomalyText,
  evidenceText,
  hintText,
  hypothesisText,
  moduleText,
  noteText,
  reasonText,
  recommendationText,
  stateText,
  warningText,
} from './criticalPathText';

function renderSegment(segment: CriticalPathSegment, language: OutputLanguage): CriticalPathSegment {
  return {
    ...segment,
    modules: segment.moduleIds.map((id) => moduleText(id, language)),
    reasons: segment.reasonItems.map((reason) => reasonText(reason, language)),
    ...(segment.children ? {children: segment.children.map((child) => renderSegment(child, language))} : {}),
  };
}

function summaryText(analysis: CriticalPathAnalysis, language: OutputLanguage): string {
  const {task} = analysis;
  const owner = (process: string | null | undefined, thread: string | null | undefined): string =>
    `${process ?? '-'} / ${thread ?? '-'}`;
  const listSeparator = localize(language, '、', ', ');
  const lines = [
    localize(
      language,
      `选中 task 位于 ${owner(task.processName, task.threadName)}，状态 ${stateText(task.state, language)}，持续 ${task.durationMs.toFixed(2)} ms。`,
      `Selected task: ${owner(task.processName, task.threadName)}, state ${stateText(task.state, language)}, duration ${task.durationMs.toFixed(2)} ms.`,
    ),
    localize(
      language,
      `critical path 外部链路累计 ${analysis.blockingMs.toFixed(2)} ms，占 ${analysis.externalBlockingPercentage.toFixed(2)}%。`,
      `External critical path: ${analysis.blockingMs.toFixed(2)} ms (${analysis.externalBlockingPercentage.toFixed(2)}%).`,
    ),
  ];
  const longest = analysis.longestSegment;
  if (longest) {
    const modules = longest.moduleIds.map((id) => moduleText(id, language)).join(listSeparator) ||
      moduleText('unclassified', language);
    lines.push(localize(
      language,
      `最长外部段是 ${owner(longest.processName, longest.threadName)}，持续 ${longest.durationMs.toFixed(2)} ms，关联 ${modules}。`,
      `Longest external segment: ${owner(longest.processName, longest.threadName)}, ${longest.durationMs.toFixed(2)} ms, modules ${modules}.`,
    ));
  }
  const topModules = analysis.moduleBreakdown
    .slice(0, 3)
    .map((item) => `${moduleText(item.moduleId, language)} ${item.durationMs.toFixed(2)} ms`)
    .join(listSeparator);
  if (topModules) lines.push(localize(language, `主要关联模块：${topModules}。`, `Primary modules: ${topModules}.`));
  const highest =
    analysis.anomalies.find((item) => item.severity === 'critical') ??
    analysis.anomalies.find((item) => item.severity === 'warning');
  if (highest) {
    const {title, detail} = anomalyText(highest.id, highest.params, language);
    lines.push(localize(language, `异常判断：${title}。${detail}`, `Finding: ${title}. ${detail}`));
  }
  const waker = analysis.directWaker;
  if (waker && (waker.threadName || waker.irqContext)) {
    const source = waker.irqContext ? 'Interrupt' : owner(waker.processName, waker.threadName);
    lines.push(localize(language, `直接唤醒来源：${source}。`, `Direct waker: ${source}.`));
  }
  return lines.join('\n');
}

/** Every display field rendered in `language` from the analysis' ids. */
export function renderCriticalPathAnalysis(
  analysis: CriticalPathAnalysis,
  language: OutputLanguage,
): CriticalPathAnalysis {
  const quantification = analysis.quantification;
  const rendered: CriticalPathAnalysis = {
    ...analysis,
    wakeupChain: analysis.wakeupChain.map((segment) => renderSegment(segment, language)),
    moduleBreakdown: analysis.moduleBreakdown.map((item) => ({...item, module: moduleText(item.moduleId, language)})),
    anomalies: analysis.anomalies.map((anomaly) => ({
      ...anomaly,
      ...anomalyText(anomaly.id, anomaly.params, language),
      evidence: anomaly.evidenceItems.map((item) => evidenceText(item, language)),
    })),
    recommendations: analysis.recommendationIds.map((id) => recommendationText(id, language)),
    warnings: analysis.warningCodes.map((warning) => warningText(warning, language)),
    ...(analysis.directWaker
      ? {directWaker: {...analysis.directWaker, hints: analysis.directWaker.hintCodes.map((code) => hintText(code, language))}}
      : {}),
    ...(quantification
      ? {
          quantification: {
            ...quantification,
            counterfactual: quantification.counterfactual
              ? {...quantification.counterfactual, note: noteText({code: quantification.counterfactual.noteCode}, language)}
              : null,
            hypotheses: quantification.hypotheses.map((hypothesis) => ({
              ...hypothesis,
              statement: hypothesisText(hypothesis.id, hypothesis.params, language),
              notes: hypothesis.noteCodes.map((note) => noteText(note, language)),
            })),
          },
        }
      : {}),
  };
  return {...rendered, summary: summaryText(rendered, language)};
}

/** The analysis as a reader in `language` sees it; the historical name of the renderer. */
export function projectCriticalPathAnalysis(
  analysis: CriticalPathAnalysis,
  outputLanguage: OutputLanguage,
): CriticalPathAnalysis {
  return renderCriticalPathAnalysis(analysis, outputLanguage);
}
