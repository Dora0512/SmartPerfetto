// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CriticalPathAnalysis} from '../criticalPathAnalyzer';
import {buildDeterministicCriticalPathSummary} from '../criticalPathAiSummary';
import {projectCriticalPathAnalysis, renderCriticalPathAnalysis} from '../criticalPathLocalization';

function fixture(): CriticalPathAnalysis {
  return renderCriticalPathAnalysis({
    available: true,
    task: {
      threadStateId: 1,
      utid: 10,
      startTs: 1_000,
      dur: 50_000_000,
      durationMs: 50,
      processName: 'com.example',
      threadName: 'main',
      state: 'S',
    },
    totalMs: 50,
    blockingMs: 40,
    selfMs: 10,
    externalBlockingPercentage: 80,
    wakeupChain: [],
    moduleBreakdown: [
      {
        moduleId: 'io_filesystem',
        module: '',
        durationMs: 40,
        percentage: 80,
        segmentCount: 1,
        examples: [],
      },
    ],
    anomalies: [
      {
        id: 'io_candidate',
        severity: 'warning',
        title: '',
        detail: '',
        evidenceItems: [{kind: 'text', text: 'io_wait=true'}],
        evidence: [],
      },
    ],
    summary: '',
    recommendationIds: ['inspect_io'],
    recommendations: [],
    warningCodes: [],
    warnings: [],
    rawRows: 1,
    truncated: false,
  }, 'zh-CN');
}

describe('criticalPathAiSummary localization', () => {
  it('builds English presentation without mutating the raw analysis', () => {
    const analysis = fixture();
    const before = structuredClone(analysis);

    const summary = buildDeterministicCriticalPathSummary(analysis, 'en');

    expect(summary).toContain('External critical path: 40.00 ms (80.00%).');
    expect(summary).toContain('I/O / File system 40.00 ms');
    expect(summary).toContain(
      'The wait chain contains an I/O or page-cache candidate',
    );
    expect(analysis).toEqual(before);
  });

  it('renders the counterfactual as a best case with a bounded saving in both languages', () => {
    const analysis: CriticalPathAnalysis = {
      ...fixture(),
      quantification: {
        counterfactual: {
          longestSegmentKey: '10|1000|40001000',
          longestSegmentDurMs: 40,
          bestCaseDurationMs: 10,
          maxSavingMs: 40,
          longestSegmentDurNs: 40_000_000,
          bestCaseDurationNs: 10_000_000,
          maxSavingNs: 40_000_000,
          upperBoundMs: 10,
          noteCode: 'best_case_only',
          note: '',
        },
        frameImpacts: [],
        hypotheses: [],
        warnings: [],
      },
    };

    const en = buildDeterministicCriticalPathSummary(analysis, 'en');
    expect(en).toContain('best-case task duration of 10.00 ms, a saving of at most 40.00 ms');
    expect(en).not.toMatch(/upper bound/i);
    const zh = buildDeterministicCriticalPathSummary(analysis, 'zh-CN');
    expect(zh).toContain('任务时长最好可降至 10.00 ms，即至多节省 40.00 ms');
    expect(zh).not.toContain('上界');
  });

  it('explains a window with no waiting time in English, also when handed an already projected analysis', () => {
    const analysis: CriticalPathAnalysis = {
      ...fixture(),
      available: false,
      unavailableReason: 'no_waiting_time',
      blockingMs: 0,
      externalBlockingPercentage: 0,
      moduleBreakdown: [],
      anomalies: [{
        id: 'no_waiting_time',
        severity: 'info',
        title: '',
        detail: '',
        evidenceItems: [],
        evidence: [],
      }],
    };

    const summary = buildDeterministicCriticalPathSummary(analysis, 'en');
    expect(summary).toContain('Rule findings: The selection contains no waiting time.');
    expect(summary).not.toMatch(/\p{Script=Han}/u);
    // The MCP tool projects first; the projection is idempotent for English.
    expect(buildDeterministicCriticalPathSummary(projectCriticalPathAnalysis(analysis, 'en'), 'en')).toBe(summary);
  });
});
