// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {analyzeCriticalPath} from '../criticalPathAnalyzer';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return {columns, rows, durationMs: 1};
}

const EMPTY = queryResult([], []);

interface SqlRule {
  match: RegExp;
  responder: (sql: string) => QueryResult;
}

function patternMockedService(rules: SqlRule[]): TraceProcessorService {
  const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async (_traceId, sql) => {
    for (const rule of rules) {
      if (rule.match.test(sql)) {
        return rule.responder(sql);
      }
    }
    // INCLUDE PERFETTO MODULE always succeeds with an empty result by default.
    if (/^\s*INCLUDE\s+PERFETTO\s+MODULE/i.test(sql)) {
      return EMPTY;
    }
    // Schema lookups for tid/upid via thread table.
    if (/SELECT tid, upid FROM thread/i.test(sql)) {
      return EMPTY;
    }
    return EMPTY;
  });
  return {query} as unknown as TraceProcessorService;
}

describe('critical path analyzer', () => {
  const taskColumns = [
    'thread_state_id',
    'ts',
    'dur',
    'utid',
    'state',
    'blocked_function',
    'io_wait',
    'cpu',
    'waker_id',
    'irq_context',
    'tid',
    'thread_upid',
    'thread_name',
    'process_name',
    'waker_utid',
    'waker_state',
    'waker_thread_name',
    'waker_process_name',
  ];

  const stackColumns = [
    'id',
    'ts',
    'dur',
    'utid',
    'stack_depth',
    'name',
    'table_name',
    'root_utid',
    'thread_name',
    'process_name',
  ];

  const wakerColumns = [
    'target_id',
    'target_ts',
    'waker_id',
    'target_irq_context',
    'waker_id_resolved',
    'waker_utid',
    'waker_state',
    'waker_cpu',
    'waker_irq_context',
    'waker_tid',
    'waker_thread_name',
    'waker_process_name',
  ];

  it('summarizes wakeup chain and surfaces stdlib-derived modules when L3 reports binder/monitor signals', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [
              101,
              1_000_000_000,
              20_000_000,
              1,
              'S',
              null,
              0,
              null,
              55,
              0,
              1001,
              7,
              'main',
              'com.demo',
              2,
              'D',
              'binder:system',
              'system_server',
            ],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 1_000_000_000, 12_000_000, 2, 8, 'blocking thread_state: D', 'thread_state', 1, 'binder:system', 'system_server'],
            [1, 1_000_000_000, 12_000_000, 2, 9, 'blocking process_name: system_server', 'thread_state', 1, 'binder:system', 'system_server'],
            [1, 1_000_000_000, 12_000_000, 2, 10, 'blocking thread_name: binder:system', 'thread_state', 1, 'binder:system', 'system_server'],
            [3, 1_012_000_000, 5_000_000, 3, 8, 'blocking thread_state: R+', 'thread_state', 1, 'RenderThread', 'com.demo'],
            [3, 1_012_000_000, 5_000_000, 3, 10, 'blocking thread_name: RenderThread', 'thread_state', 1, 'RenderThread', 'com.demo'],
          ]),
      },
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread_state AS waker/i,
        responder: () =>
          queryResult(wakerColumns, [
            [101, 1_000_000_000, 55, 0, 55, 2, 'D', 0, 0, 3001, 'binder:system', 'system_server'],
          ]),
      },
      {
        match: /FROM segs\s+JOIN android_binder_txns/i,
        responder: () =>
          queryResult(
            [
              'segment_idx',
              'binder_txn_id',
              'binder_reply_id',
              'side',
              'interface',
              'method_name',
              'is_sync',
              'is_main_thread',
              'client_process',
              'client_thread',
              'server_process',
              'server_thread',
              'client_utid',
              'server_utid',
              'client_tid',
              'server_tid',
              'dur_ns',
            ],
            [
              [
                0,
                42,
                7,
                'client',
                'IBinder',
                'doSomething',
                1,
                1,
                'com.demo',
                'main',
                'system_server',
                'binder:system',
                1,
                2,
                1001,
                3001,
                12_000_000,
              ],
            ]
          ),
      },
      // monitor + io + gc + cpu + frames all empty
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 101});

    expect(analysis.available).toBe(true);
    expect(analysis.task.threadName).toBe('main');
    expect(analysis.task.processName).toBe('com.demo');
    expect(analysis.task.upid).toBe(7);
    expect(analysis.wakeupChain).toHaveLength(2);
    // The first segment should now carry stdlib-derived 'Binder / IPC' module
    // — proof that L3 enrichment overrode the regex fallback.
    expect(analysis.wakeupChain[0].modules).toContain('Binder / IPC');
    expect(analysis.wakeupChain[0].semantics?.binderTxns).toHaveLength(1);
    expect(analysis.directWaker).not.toBeNull();
    expect(analysis.directWaker?.kind).toBe('thread');
    expect(analysis.quantification).toBeDefined();
    expect(analysis.semanticSources?.binder).toBe('present');
    // Hypothesis SQL must contain only numeric IDs, never raw method names
    // — verify by ensuring no apostrophes (which would indicate a string literal).
    for (const hypothesis of analysis.quantification?.hypotheses ?? []) {
      expect(hypothesis.verificationSql.includes("'")).toBe(false);
    }
  });

  it('short-circuits to a "Running 状态：无等待链可分析" finding when the task is Running', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target/i,
        responder: () =>
          queryResult(taskColumns, [
            [102, 2_000_000_000, 4_000_000, 1, 'Running', null, 0, 3, null, null, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 102});

    expect(analysis.available).toBe(false);
    expect(analysis.wakeupChain).toEqual([]);
    expect(analysis.anomalies[0].title).toBe('Running 状态：无等待链可分析');
    expect(analysis.recommendations[0]).toContain('callstack');
  });

  it('returns no critical path chain when stack query yields zero rows for a non-Running task', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [103, 3_000_000_000, 6_000_000, 1, 'S', null, 0, null, null, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () => queryResult(stackColumns, []),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 103});

    expect(analysis.available).toBe(false);
    expect(analysis.anomalies[0].title).toBe('没有取到 critical path 等待链');
  });

  it('annotates IRQ-context waker as kind="irq" with no upstream chain', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [104, 4_000_000_000, 10_000_000, 1, 'S', null, 0, null, 7, 1, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 4_000_000_000, 5_000_000, 2, 8, 'blocking thread_state: R', 'thread_state', 1, 'kworker/0', 'kworker'],
          ]),
      },
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread_state AS waker/i,
        responder: () =>
          queryResult(wakerColumns, [
            // target_irq_context=1, waker resolved as kworker but irq_context flag wins
            [104, 4_000_000_000, 7, 1, 7, 2, 'R', 0, 0, 0, 'kworker/0', null],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 104});

    expect(analysis.directWaker).not.toBeNull();
    expect(analysis.directWaker?.irqContext).toBe(true);
    expect(analysis.directWaker?.kind).toBe('irq');
  });

  it('range mode (utid+startTs+dur) splits a multi-state selection into per-slice findings', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread\s+LEFT JOIN process USING\(upid\)\s+WHERE thread\.utid =/i,
        responder: () =>
          queryResult(['utid', 'tid', 'thread_upid', 'thread_name', 'process_name'], [[1, 1001, 7, 'main', 'com.demo']]),
      },
      {
        match: /FROM thread_state\s+WHERE utid =/i,
        responder: () =>
          queryResult(['id', 'ts', 'dur', 'state', 'blocked_function', 'io_wait', 'cpu'], [
            [201, 5_000_000_000, 8_000_000, 'S', null, 0, null],
            [202, 5_008_000_000, 6_000_000, 'D', 'io_schedule', 1, null],
            [203, 5_014_000_000, 2_000_000, 'Running', null, 0, 4],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 5_000_000_000, 7_000_000, 2, 8, 'blocking thread_state: D', 'thread_state', 1, 'binder:system', 'system_server'],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {
      utid: 1,
      startTs: 5_000_000_000,
      dur: 16_000_000,
    });

    expect(analysis.slices).toBeDefined();
    expect(analysis.slices?.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['sleeping', 'uninterruptible', 'running'])
    );
    // Dominant state should pick the longest slice (sleeping, 8ms).
    expect(analysis.task.state).toBe('S');
  });

  it('exposes semanticSources status when stdlib include succeeds but table is empty', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [105, 6_000_000_000, 18_000_000, 1, 'S', null, 0, null, 99, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 6_000_000_000, 12_000_000, 2, 8, 'blocking thread_state: S', 'thread_state', 1, 'other', 'svc'],
          ]),
      },
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread_state AS waker/i,
        responder: () => queryResult(wakerColumns, []),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 105});

    expect(analysis.semanticSources).toBeDefined();
    // All semantic sources came back empty (no rules matched) — must not be 'present'.
    for (const status of Object.values(analysis.semanticSources ?? {})) {
      expect(['empty', 'skipped', 'stdlib_missing', 'sql_error']).toContain(status);
    }
  });

  it('counterfactual upper bound is task.dur - longest external segment, never below zero', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [106, 7_000_000_000, 30_000_000, 1, 'S', null, 0, null, null, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 7_000_000_000, 22_000_000, 2, 8, 'blocking thread_state: S', 'thread_state', 1, 'svc', 'svc_proc'],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 106});

    expect(analysis.quantification?.counterfactual?.longestSegmentDurMs).toBeCloseTo(22, 1);
    expect(analysis.quantification?.counterfactual?.upperBoundMs).toBeCloseTo(8, 1);
    expect(analysis.quantification?.counterfactual?.note).toMatch(/UPPER BOUND/);
  });
  // Android emits sched_blocked_reason only for D state, so every S-state wait
  // on the critical path arrives with blocked_function NULL. The wake-source
  // layer is the only kernel signal those waits have, and it is decided in
  // TypeScript here and in SQL in fragments/sleep_wake_source.sql.
  describe('wake-source attribution of S-state waits', () => {
    const wakeColumns = [
      'segment_idx',
      'state',
      'dur_ns',
      'irq_context',
      'waker_utid',
      'thread_name',
      'thread_tid',
      'process_pid',
      'sleeper_upid',
      'waker_thread_name',
      'waker_tid',
      'waker_process_name',
      'waker_process_pid',
      'waker_upid',
    ];

    /**
     * Three sleeping segments on one chain: a short hand-off, a long IRQ-woken
     * receive candidate, and a longer hand-off. Recursion is off so the flat
     * segment list is exactly these three and `segment_idx` stays stable.
     */
    function wakeChainService(wakeRows: unknown[][]): TraceProcessorService {
      return patternMockedService([
        {
          match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
          responder: () =>
            queryResult(taskColumns, [
              [301, 7_000_000_000, 50_000_000, 1, 'S', null, 0, null, null, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
            ]),
        },
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            queryResult(stackColumns, [
              [1, 7_000_000_000, 4_000_000, 5, 8, 'blocking thread_state: S', 'thread_state', 1, 'pool-1-thread-1', 'com.demo'],
              [2, 7_005_000_000, 30_000_000, 6, 8, 'blocking thread_state: S', 'thread_state', 1, 'OkHttp Dispatch', 'com.demo'],
              [3, 7_036_000_000, 12_000_000, 7, 8, 'blocking thread_state: S', 'thread_state', 1, 'pool-1-thread-2', 'com.demo'],
            ]),
        },
        {
          match: /FROM waits AS w/i,
          responder: () => queryResult(wakeColumns, wakeRows),
        },
      ]);
    }

    // idx 0: same-process worker woke it — a hand-off, 4 ms.
    const shortHandoff = [0, 'S', 4_000_000, 0, 60, 'pool-1-thread-1', 5100, 1001, 7, 'pool-2-thread-9', 5900, 'com.demo', 1001, 7];
    // idx 1: IRQ context on a network-role thread in S — a receive candidate.
    const networkWait = [1, 'S', 30_000_000, 1, 99, 'OkHttp Dispatch', 5200, 1001, 7, 'kworker/u16:3', 300, null, null, null];
    // idx 2: the same hand-off shape, three times longer.
    const longHandoff = [2, 'S', 12_000_000, 0, 61, 'pool-1-thread-2', 5300, 1001, 7, 'pool-2-thread-9', 5900, 'com.demo', 1001, 7];

    it('labels an IRQ-woken S wait on a network thread as a receive candidate', async () => {
      const analysis = await analyzeCriticalPath(wakeChainService([networkWait]), 'trace-1', {
        threadStateId: 301,
        recursionEnabled: false,
      });

      expect(analysis.semanticSources?.wakeSource).toBe('present');
      const segment = analysis.wakeupChain.find(entry => entry.threadName === 'OkHttp Dispatch');
      expect(segment?.wakeSourceClass).toBe('network_receive_candidate');
      expect(segment?.modules).toContain('网络收包等待候选');
      // The wake source itself stays IRQ; only the sleeper's role narrows it.
      expect(segment?.semantics?.wakeSources[0]).toMatchObject({
        wakeSource: 'irq_or_softirq', threadRole: 'network', irqContext: true,
      });
      const anomaly = analysis.anomalies.find(entry => entry.title === '等待链涉及网络收包等待候选');
      expect(anomaly?.severity).toBe('info');
      expect(anomaly?.evidence).toEqual(['com.demo / OkHttp Dispatch', '30.00 ms']);
      // A candidate, never a cause: the detail has to say so.
      expect(anomaly?.detail).toContain('定时器到期');
    });

    it('labels a same-process non-binder waker as a worker hand-off', async () => {
      const analysis = await analyzeCriticalPath(wakeChainService([shortHandoff]), 'trace-1', {
        threadStateId: 301,
        recursionEnabled: false,
      });

      const segment = analysis.wakeupChain.find(entry => entry.threadName === 'pool-1-thread-1');
      expect(segment?.wakeSourceClass).toBe('worker_handoff');
      expect(segment?.modules).toContain('worker 交接等待');
      expect(segment?.semantics?.wakeSources[0]).toMatchObject({
        wakeSource: 'same_process_thread', wakerRole: 'worker', irqContext: false,
      });
      expect(analysis.anomalies.some(entry => entry.title === '等待链涉及网络收包等待候选')).toBe(false);
    });

    // Reporting the first segment of either class meant a 4 ms hand-off ahead of
    // a 30 ms receive candidate hid the segment worth opening, and whichever
    // class lost the race went unmentioned.
    it('reports both wait classes, each naming its own longest segment', async () => {
      const analysis = await analyzeCriticalPath(
        wakeChainService([shortHandoff, networkWait, longHandoff]),
        'trace-1',
        {threadStateId: 301, recursionEnabled: false},
      );

      expect(analysis.wakeupChain.map(entry => entry.wakeSourceClass)).toEqual([
        'worker_handoff', 'network_receive_candidate', 'worker_handoff',
      ]);
      const wakeAnomalies = analysis.anomalies.filter(entry =>
        entry.title === '等待链涉及网络收包等待候选' || entry.title === '等待链涉及 worker 交接等待');
      expect(wakeAnomalies.map(entry => ({title: entry.title, evidence: entry.evidence}))).toEqual([
        {title: '等待链涉及网络收包等待候选', evidence: ['com.demo / OkHttp Dispatch', '30.00 ms']},
        {title: '等待链涉及 worker 交接等待', evidence: ['com.demo / pool-1-thread-2', '12.00 ms']},
      ]);
    });
  });
});
