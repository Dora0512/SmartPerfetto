// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import Database from 'better-sqlite3';
import {__INTERNAL__, quantifyCriticalPath, type QuantifyTaskInput} from '../criticalPathQuantify';
import {segmentKeyOf, type SegmentSemantics} from '../criticalPathSemantics';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';

const {buildCounterfactual, buildHypotheses} = __INTERNAL__;

const MS = 1_000_000;
const EMPTY: QueryResult = {columns: [], rows: [], durationMs: 1};

// The task is thread 1 of process 7; the evidence below comes from other
// threads on its chain, as it does after the root thread is removed.
const TASK: QuantifyTaskInput = {upid: 7, startTs: 0, endTs: 200 * MS, durMs: 200};
const WINDOW = {startTs: 100 * MS, endTs: 110 * MS};

function semantics(
  entity: {utid: number; upid: number | null},
  signals: Partial<Pick<SegmentSemantics, 'binderTxns' | 'monitorContention' | 'ioSignals' | 'gcEvents' | 'cpuCompetition'>>
): SegmentSemantics {
  const segment = {...entity, ...WINDOW};
  return {
    segmentKey: segmentKeyOf(segment),
    ...segment,
    binderTxns: [],
    monitorContention: [],
    ioSignals: [],
    gcEvents: [],
    cpuCompetition: [],
    wakeSources: [],
    ...signals,
  };
}

const BINDER = semantics({utid: 40, upid: 8}, {
  binderTxns: [{
    binderTxnId: 42, binderReplyId: 43, side: 'client', interfaceName: 'IDemo', methodName: 'doWork',
    isSync: true, isMainThread: false, clientProcess: 'com.demo', clientThread: 'worker',
    serverProcess: 'system_server', serverThread: 'binder:55', clientUtid: 40, serverUtid: 55,
    clientTid: 1040, serverTid: 1055, durMs: 6, eventDurMs: 30,
  }],
});
const MONITOR = semantics({utid: 41, upid: 8}, {
  monitorContention: [{
    rowId: 5, side: 'blocked', shortBlockedMethod: 'a()', shortBlockingMethod: 'b()', blockedThreadName: 'worker',
    blockingThreadName: 'other', blockedTid: 1041, blockingTid: 1060, blockedUtid: 41, blockingUtid: 60,
    durMs: 3, eventDurMs: 12, isBlockedThreadMain: false,
  }],
});
const IO = semantics({utid: 42, upid: 8}, {
  ioSignals: [{source: 'io_wait_flag', blockedFunction: null, durMs: 6, eventDurMs: 9, ioWait: true}],
});
const GC = semantics({utid: 43, upid: 9}, {
  gcEvents: [{
    gcType: 'full', isMarkCompact: true, reclaimedMb: 4, durMs: 5, eventDurMs: 40,
    thread: 'HeapTaskDaemon', process: 'com.other',
  }],
});
const CPU = semantics({utid: 44, upid: 8}, {
  cpuCompetition: [{
    cpu: 3, competingTid: 1077, competingUtid: 77, competingThread: 'hog', competingProcess: 'com.hog',
    competingState: 'Running', competingDurMs: 7, eventDurMs: 25, cpuMaxFreqKhz: 1_800_000,
  }],
});

describe('criticalPathQuantify counterfactual', () => {
  it('reports the best-case remaining duration and the maximum saving', () => {
    const estimate = buildCounterfactual({...TASK, durMs: 30}, [
      {segmentKey: 'a', durMs: 5},
      {segmentKey: 'b', durMs: 22},
    ]);

    expect(estimate).toMatchObject({
      longestSegmentKey: 'b',
      longestSegmentDurMs: 22,
      bestCaseDurationMs: 8,
      maxSavingMs: 22,
      upperBoundMs: 8,
    });
    expect(estimate?.note).toMatch(/^BEST CASE ONLY/);
    expect(estimate?.note).toContain('at most maxSavingMs');
  });

  it('floors the best case at zero and has no estimate without a positive segment', () => {
    expect(buildCounterfactual({...TASK, durMs: 10}, [{segmentKey: 'a', durMs: 12}])).toMatchObject({
      bestCaseDurationMs: 0,
      upperBoundMs: 0,
      maxSavingMs: 12,
    });
    expect(buildCounterfactual(TASK, [])).toBeNull();
    expect(buildCounterfactual(TASK, [{segmentKey: 'a', durMs: 0}])).toBeNull();
  });
});

describe('criticalPathQuantify hypotheses', () => {
  it('binds the IO hypothesis to the producing segment thread and window', () => {
    const [hypothesis] = buildHypotheses([IO]);

    expect(hypothesis.id).toBe('h-io-wait');
    expect(hypothesis.verificationSql).toBe(
      `SELECT ts, dur, state, blocked_function, io_wait FROM thread_state WHERE utid = 42 AND state IN ('D', 'DK') ` +
        `AND ts < ${110 * MS} AND ts + dur > ${100 * MS} ORDER BY dur DESC LIMIT 10;`
    );
    expect(hypothesis.statement).toContain('utid=42');
    expect(hypothesis.statement).not.toContain('utid=1 ');
  });

  it('binds the GC hypothesis to the producing segment process and window', () => {
    const [hypothesis] = buildHypotheses([GC]);

    expect(hypothesis.id).toBe('h-gc-stall');
    expect(hypothesis.verificationSql).toContain(`WHERE upid = 9 AND gc_ts < ${110 * MS} AND gc_ts + gc_dur > ${100 * MS} `);
    expect(hypothesis.statement).toContain('upid=9');
  });

  it('checks CPU competitor priority on sched, over the producing segment window', () => {
    const [hypothesis] = buildHypotheses([CPU]);

    expect(hypothesis.id).toBe('h-cpu-competition');
    expect(hypothesis.verificationSql).toBe(
      `SELECT ts, dur, priority FROM sched WHERE utid = 77 AND ts < ${110 * MS} AND ts + dur > ${100 * MS} ` +
        'ORDER BY dur DESC LIMIT 10;'
    );

    // Runs as written against a sched table and keeps only slices inside the window.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sched(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, cpu INTEGER, utid INTEGER, priority INTEGER);
      INSERT INTO sched(ts, dur, cpu, utid, priority) VALUES
        (${95 * MS}, ${5 * MS}, 3, 77, 100),
        (${105 * MS}, ${15 * MS}, 3, 77, 110),
        (${110 * MS}, ${5 * MS}, 3, 77, 120),
        (${105 * MS}, ${2 * MS}, 3, 78, 130);
    `);
    expect(db.prepare(hypothesis.verificationSql).all()).toEqual([{ts: 105 * MS, dur: 15 * MS, priority: 110}]);
  });

  it('checks the binder server process for GC over the producing segment window', () => {
    const [hypothesis] = buildHypotheses([BINDER]);

    expect(hypothesis.id).toBe('h-binder-server-gc');
    expect(hypothesis.verificationSql).toContain('WHERE upid IN (SELECT upid FROM thread WHERE utid = 55) ');
    expect(hypothesis.verificationSql).toContain(`AND gc_ts < ${110 * MS} AND gc_ts + gc_dur > ${100 * MS} `);
  });

  it('quotes the clipped and the whole-event duration in every statement', () => {
    const cases: Array<[SegmentSemantics, string, number, number]> = [
      [BINDER, 'h-binder-server-gc', 6, 30],
      [MONITOR, 'h-monitor-blocking', 3, 12],
      [IO, 'h-io-wait', 6, 9],
      [GC, 'h-gc-stall', 5, 40],
      [CPU, 'h-cpu-competition', 7, 25],
    ];
    for (const [sem, id, clippedMs, eventMs] of cases) {
      const [hypothesis] = buildHypotheses([sem]);
      expect(hypothesis.id).toBe(id);
      expect(hypothesis.statement).toContain(`${clippedMs} ms`);
      expect(hypothesis.statement).toContain(`lasts ${eventMs} ms`);
      expect(hypothesis.statement).toContain('clipped to the segment');
      expect(hypothesis.statement).toContain(`[${100 * MS}, ${110 * MS})`);
    }
  });

  it('names the owner and its waiter when the contention was attached from the owner side', () => {
    const owner = semantics({utid: 60, upid: 8}, {
      monitorContention: [{...MONITOR.monitorContention[0], side: 'owner'}],
    });

    const [hypothesis] = buildHypotheses([owner]);

    expect(hypothesis.id).toBe('h-monitor-blocking');
    expect(hypothesis.statement).toContain('utid=60 holds the Java monitor (contention row id=5) that utid=41 waits on');
    expect(hypothesis.verificationSql).toContain('WHERE id = 5;');
  });

  it('thresholds on the time clipped to the segment, not the whole event', () => {
    const shortIo = semantics({utid: 42, upid: 8}, {
      ioSignals: [{source: 'io_wait_flag', blockedFunction: null, durMs: 3, eventDurMs: 50, ioWait: true}],
    });
    const shortGc = semantics({utid: 43, upid: 9}, {
      gcEvents: [{...GC.gcEvents[0], durMs: 3, eventDurMs: 100}],
    });

    expect(buildHypotheses([shortIo, shortGc])).toEqual([]);
  });
});

describe('quantifyCriticalPath', () => {
  it('keeps its signature and derives hypotheses from the semantics it is given', async () => {
    const sqls: string[] = [];
    const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async (_traceId, sql) => {
      sqls.push(sql);
      return EMPTY;
    });
    const tp = {query} as unknown as TraceProcessorService;

    const result = await quantifyCriticalPath(
      tp,
      'trace-1',
      TASK,
      [{segmentKey: IO.segmentKey, durMs: 10}],
      [IO, CPU]
    );

    expect(result.counterfactual).toMatchObject({bestCaseDurationMs: 190, maxSavingMs: 10});
    expect(result.hypotheses.map((hypothesis) => hypothesis.id)).toEqual(['h-io-wait', 'h-cpu-competition']);
    const frameSql = sqls.find((sql) => /expected_frame_timeline_slice/.test(sql)) ?? '';
    expect(frameSql).toContain(`exp.ts < ${TASK.endTs}`);
    expect(frameSql).toContain(`exp.ts + exp.dur > ${TASK.startTs}`);
  });
});
