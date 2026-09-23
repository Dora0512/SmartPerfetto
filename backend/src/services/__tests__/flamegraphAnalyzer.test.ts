// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { buildDeterministicFlamegraphSummary } from '../flamegraphAiSummary';
import { buildFlamegraphFromPerfettoSummaryRows, getFlamegraphAvailability } from '../flamegraphAnalyzer';
import { createTraceProcessorQueryCancelledError } from '../traceProcessorCancellation';
import type { QueryResult, TraceProcessorService } from '../traceProcessorService';

describe('flamegraph analyzer', () => {
  const rows = [
    {
      id: 1,
      parentId: null,
      name: 'android.os.Looper.loopOnce',
      mappingName: 'framework.jar',
      selfCount: 0,
      cumulativeCount: 10,
    },
    {
      id: 2,
      parentId: 1,
      name: 'com.demo.ListScreen.render',
      mappingName: 'base.apk',
      selfCount: 0,
      cumulativeCount: 10,
    },
    {
      id: 3,
      parentId: 2,
      name: 'com.demo.ImageDecoder.decode',
      mappingName: 'base.apk',
      selfCount: 7,
      cumulativeCount: 7,
    },
    {
      id: 4,
      parentId: 2,
      name: 'libhwui.so!DrawFrame',
      mappingName: 'libhwui.so',
      selfCount: 3,
      cumulativeCount: 3,
    },
  ];

  it('renders Perfetto summary tree rows and ranks leaf hotspots', () => {
    const analysis = buildFlamegraphFromPerfettoSummaryRows(rows, {
      sampleCount: 10,
      sourceTable: 'linux_perf_samples_summary_tree',
    });

    expect(analysis.available).toBe(true);
    expect(analysis.filteredSampleCount).toBe(10);
    expect(analysis.root.children[0].name).toBe('android.os.Looper.loopOnce');
    expect(analysis.root.children[0].value).toBe(10);
    expect(analysis.topFunctions[0]).toMatchObject({
      name: 'com.demo.ImageDecoder.decode',
      selfCount: 7,
      category: 'app',
      categoryLabel: '业务代码',
    });
    expect(analysis.topFunctions[0].selfPercentage).toBe(70);
    expect(analysis.topCumulativeFunctions[0]).toMatchObject({
      name: 'android.os.Looper.loopOnce',
      sampleCount: 10,
      category: 'android-framework',
    });
    expect(analysis.hotPaths[0].frames).toEqual([
      'android.os.Looper.loopOnce',
      'com.demo.ListScreen.render',
      'com.demo.ImageDecoder.decode',
    ]);
    expect(analysis.hotPaths[0].compressedFrames).toEqual(analysis.hotPaths[0].frames);
    expect(analysis.categoryBreakdown[0]).toMatchObject({
      category: 'app',
      label: '业务代码',
      selfCount: 7,
    });
    expect(analysis.analyzer?.engine).toBe('typescript-fallback');
    expect(analysis.source?.sampleTable).toBe('linux_perf_samples_summary_tree');
  });

  it('produces a useful Chinese deterministic summary when AI is unavailable', () => {
    const analysis = buildFlamegraphFromPerfettoSummaryRows(rows, {
      sampleCount: 10,
      sourceTable: 'linux_perf_samples_summary_tree',
    });
    const summary = buildDeterministicFlamegraphSummary(analysis);

    expect(summary).toContain('这次火焰图共命中 10 个 CPU 采样');
    expect(summary).toContain('自占最高的函数');
    expect(summary).toContain('累计最高的调用链节点');
    expect(summary).toContain('com.demo.ImageDecoder.decode');
    expect(summary).toContain('建议优先从最高自占函数判断');
  });

  it('returns an empty analysis when Perfetto has no CPU profile summary tree', () => {
    const analysis = buildFlamegraphFromPerfettoSummaryRows([], {
      sourceTable: 'linux_perf_samples_summary_tree',
    });

    expect(analysis.available).toBe(false);
    expect(analysis.filteredSampleCount).toBe(0);
    expect(analysis.warnings.join('\n')).toContain('summary tree');
  });
});

describe('flamegraph source lookup reads processor errors', () => {
  type Answer = Partial<QueryResult> | Error;

  /** A processor whose statements answer from `respond`; errors come back as data, like the real service. */
  function fakeProcessor(respond: (sql: string) => Answer) {
    const statements: string[] = [];
    const service = {
      query: jest.fn(async (_traceId: string, sql: string) => {
        statements.push(sql.trim());
        const answer = respond(sql);
        if (answer instanceof Error) throw answer;
        return { columns: [], rows: [], durationMs: 0, ...answer } as QueryResult;
      }),
    } as unknown as TraceProcessorService;
    return { service, statements };
  }

  const stats = { columns: ['node_count', 'sample_count', 'root_sample_count'], rows: [[4, 10, 10]] };

  it('reports a source whose module or table is missing as unavailable, not as a source without samples', async () => {
    const { service } = fakeProcessor((sql) => {
      if (sql.includes('INCLUDE PERFETTO MODULE appleos')) return { error: 'Unknown module name provided - appleos.instruments.samples' };
      if (sql.includes('INCLUDE')) return {};
      return { error: 'no such table: linux_perf_samples_summary_tree' };
    });

    const availability = await getFlamegraphAvailability(service, 'trace-1');

    expect(availability.available).toBe(false);
    expect(availability.availableSources).toEqual([]);
    expect(availability.warnings).toEqual([]);
    expect(availability.missing.length).toBeGreaterThan(0);
  });

  it('retries a failed statement once and then fails instead of reading it as empty', async () => {
    const { service, statements } = fakeProcessor((sql) =>
      sql.includes('INCLUDE') ? {} : { error: 'trace processor RPC reset' });

    await expect(getFlamegraphAvailability(service, 'trace-1')).rejects.toThrow('trace processor RPC reset');
    expect(statements.filter((sql) => sql.includes('COUNT(*)'))).toHaveLength(2);
  });

  it('recovers when the retry succeeds', async () => {
    let failures = 1;
    const { service } = fakeProcessor((sql) => {
      if (sql.includes('INCLUDE')) return {};
      if (sql.includes('appleos')) return { error: 'no such table: appleos_instruments_samples_summary_tree' };
      if (failures-- > 0) return { error: 'transient' };
      return stats;
    });

    const availability = await getFlamegraphAvailability(service, 'trace-1');

    expect(availability).toMatchObject({ available: true, sampleSource: 'linux_perf_samples_summary_tree' });
  });

  it('does not retry a cancelled statement', async () => {
    const { service, statements } = fakeProcessor(() => createTraceProcessorQueryCancelledError('client gone'));

    await expect(getFlamegraphAvailability(service, 'trace-1')).rejects.toMatchObject({
      code: 'TRACE_PROCESSOR_QUERY_CANCELLED',
    });
    expect(statements).toHaveLength(1);
  });
});
