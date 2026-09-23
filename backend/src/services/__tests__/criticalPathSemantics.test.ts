// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {
  __INTERNAL__,
  enrichSegmentsWithSemantics,
  segmentKeyOf as exportedSegmentKeyOf,
  type SegmentInput,
} from '../criticalPathSemantics';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';
import {EMPTY, queryResult, sqliteTraceProcessor} from '../../../tests/helpers/criticalPathTraceProcessorFixture';

const {buildSegmentValuesCte, segmentKeyOf} = __INTERNAL__;

interface PublishedSegment {
  idx: number;
  utid: number;
  tsStart: number;
  tsEnd: number;
}

/** The `(idx, utid, tid, upid, ts_start, ts_end)` tuples a loader put in its VALUES CTE. */
function publishedSegments(sql: string): PublishedSegment[] {
  return Array.from(
    sql.matchAll(/\((\d+), (\d+), (?:\d+|NULL), (?:\d+|NULL), (\d+), (\d+)\)/g),
    (m) => ({idx: Number(m[1]), utid: Number(m[2]), tsStart: Number(m[3]), tsEnd: Number(m[4])})
  );
}

const CPU_COLUMNS = [
  'segment_idx',
  'cpu',
  'competing_tid',
  'competing_utid',
  'competing_thread',
  'competing_process',
  'competing_state',
  'competing_dur_ns',
  'cpu_max_freq',
];

/**
 * Behaves like trace_processor for the CPU-competition query: it returns one
 * competitor per published window, tagged with whatever `idx` the SQL itself
 * declared for that window. That is the value distribute() resolves against
 * the full segment list, so a loader that renumbers a filtered subset from
 * zero is caught here rather than hidden by a hand-written segment_idx.
 */
function cpuEchoService(): {tp: TraceProcessorService; cpuSqls: string[]} {
  const cpuSqls: string[] = [];
  const query = jest
    .fn<TraceProcessorService['query']>()
    .mockImplementation(async (_traceId, sql) => {
      if (/target_cpu/.test(sql)) {
        cpuSqls.push(sql);
        const rows = publishedSegments(sql).map((seg) => [
          seg.idx,
          3,
          999,
          99,
          'other-thread',
          'other.process',
          'Running',
          400_000,
          1_800_000,
        ]);
        return queryResult(CPU_COLUMNS, rows);
      }
      return EMPTY;
    });
  return {tp: {query} as unknown as TraceProcessorService, cpuSqls};
}

const COMPETITOR = expect.objectContaining({
  cpu: 3,
  competingTid: 999,
  competingThread: 'other-thread',
  competingProcess: 'other.process',
});

describe('criticalPathSemantics segment index contract', () => {
  const sleeping: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 1_000, endTs: 2_000, state: 'S'};
  const runnable: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 2_000, endTs: 3_000, state: 'R'};
  const blocked: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 3_000, endTs: 4_000, state: 'D'};
  const preempted: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 4_000, endTs: 5_000, state: 'R+'};

  it('keeps full-list indices when a loader narrows to a subset', () => {
    const cte = buildSegmentValuesCte([sleeping, runnable], (segment) => segment.state === 'R');
    expect(cte).toBe('(1, 7, 7, 2, 2000, 3000)');
  });

  it('attaches CPU competition to the runnable segment, not the sleeping one before it', async () => {
    const {tp, cpuSqls} = cpuEchoService();
    const {segments: result, sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', [sleeping, runnable]);

    expect(cpuSqls).toHaveLength(1);
    expect(publishedSegments(cpuSqls[0])).toEqual([{idx: 1, utid: 7, tsStart: 2_000, tsEnd: 3_000}]);

    const runnableSem = result.get(segmentKeyOf(runnable));
    const sleepingSem = result.get(segmentKeyOf(sleeping));
    expect(runnableSem?.cpuCompetition).toEqual([COMPETITOR]);
    expect(sources.cpu).toBe('present');
    expect(sleepingSem?.cpuCompetition).toEqual([]);
  });

  it('keeps every runnable window on its own segment when runnable and waiting states interleave', async () => {
    const {tp, cpuSqls} = cpuEchoService();
    const segments = [sleeping, runnable, blocked, preempted];
    const {segments: result} = await enrichSegmentsWithSemantics(tp, 'trace-1', segments);

    expect(publishedSegments(cpuSqls[0]).map((seg) => seg.idx)).toEqual([1, 3]);
    expect(segments.map((segment) => result.get(segmentKeyOf(segment))?.cpuCompetition)).toEqual([
      [],
      [COMPETITOR],
      [],
      [COMPETITOR],
    ]);
  });

  it('skips the CPU query entirely when no segment is runnable', async () => {
    const {tp, cpuSqls} = cpuEchoService();
    const {sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', [sleeping, blocked]);

    expect(cpuSqls).toHaveLength(0);
    expect(sources.cpu).toBe('skipped');
  });
});

const MS = 1_000_000;

describe('criticalPathSemantics overlap and attribution', () => {
  it('attaches only rows overlapping the half-open window and clips their duration', async () => {
    // Thread 7: D [4,10) ends where segment A starts; D [12,26) straddles A's end;
    // D [40,45) starts where segment B ends.
    const {tp} = sqliteTraceProcessor(`
      INSERT INTO thread_state(utid, ts, dur, state, io_wait) VALUES
        (7, ${4 * MS}, ${6 * MS}, 'D', 1),
        (7, ${12 * MS}, ${14 * MS}, 'D', 1),
        (7, ${26 * MS}, ${4 * MS}, 'R', 0),
        (7, ${40 * MS}, ${5 * MS}, 'D', 1);
    `);
    const a: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'D'};
    const b: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 30 * MS, endTs: 40 * MS, state: 'D'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [a, b]);

    expect(segments.get(segmentKeyOf(a))?.ioSignals).toEqual([
      {source: 'io_wait_flag', blockedFunction: null, durMs: 8, eventDurMs: 14, ioWait: true},
    ]);
    expect(segments.get(segmentKeyOf(b))?.ioSignals).toEqual([]);
  });

  it('clips binder, monitor and GC events to the segment and keeps the whole event duration', async () => {
    // Sync call from thread 7 (client [5,15)) served by thread 8 (server [6,14)).
    const {tp} = sqliteTraceProcessor(`
      INSERT INTO android_binder_txns VALUES
        (42, 43, 'IDemo', 'doWork', 1, 1, 'com.demo', 'main', 'system_server', 'binder:8',
         7, 8, 1007, 1008, ${5 * MS}, ${10 * MS}, ${6 * MS}, ${8 * MS});
      INSERT INTO android_monitor_contention VALUES
        (5, ${18 * MS}, ${6 * MS}, 7, 9, 1007, 1009, 'main', 'worker', 'a()', 'b()', 1);
      INSERT INTO android_garbage_collection_events VALUES
        (2, ${8 * MS}, ${20 * MS}, 'young', 0, 1.5, 'HeapTaskDaemon', 'com.demo');
    `);
    const client: SegmentInput = {utid: 7, tid: 1007, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'S'};
    const server: SegmentInput = {utid: 8, tid: 1008, upid: 3, startTs: 0, endTs: 10 * MS, state: 'Running'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [client, server]);
    const clientSem = segments.get(segmentKeyOf(client));
    const serverSem = segments.get(segmentKeyOf(server));

    expect(clientSem?.binderTxns).toEqual([
      expect.objectContaining({binderTxnId: 42, side: 'client', durMs: 5, eventDurMs: 10}),
    ]);
    // The server segment's event is the server slice, not the longer client wait.
    expect(serverSem?.binderTxns).toEqual([
      expect.objectContaining({binderTxnId: 42, side: 'server', durMs: 4, eventDurMs: 8}),
    ]);
    expect(clientSem?.monitorContention).toEqual([expect.objectContaining({rowId: 5, durMs: 2, eventDurMs: 6})]);
    expect(clientSem?.gcEvents).toEqual([expect.objectContaining({gcType: 'young', durMs: 10, eventDurMs: 20})]);
    expect(serverSem?.gcEvents).toEqual([]);
  });

  it('finds the CPU a runnable segment ran on at its end and clips competitors to the window', async () => {
    // Thread 7 was Running on CPU 1 until the segment began and ran on CPU 3
    // from the instant it ended. Only CPU 3 is the CPU it waited for.
    const {tp} = sqliteTraceProcessor(`
      INSERT INTO process(upid, name) VALUES (4, 'other.process');
      INSERT INTO thread VALUES (9, 1009, 4, 'worker'), (10, 1010, 4, 'early'),
        (11, 1011, 4, 'late'), (12, 1012, 4, 'cpu1');
      INSERT INTO thread_state(utid, ts, dur, state, cpu) VALUES
        (7, ${5 * MS}, ${5 * MS}, 'Running', 1),
        (7, ${10 * MS}, ${10 * MS}, 'R', NULL),
        (7, ${20 * MS}, ${5 * MS}, 'Running', 3),
        (9, ${12 * MS}, ${13 * MS}, 'Running', 3),
        (10, ${5 * MS}, ${5 * MS}, 'Running', 3),
        (11, ${20 * MS}, ${2 * MS}, 'Running', 3),
        (12, ${10 * MS}, ${10 * MS}, 'Running', 1);
      INSERT INTO cpu_frequency_counters VALUES (3, 0, ${100 * MS}, 1800000);
    `);
    const runnable: SegmentInput = {utid: 7, tid: 1007, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'R'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [runnable]);

    expect(segments.get(segmentKeyOf(runnable))?.cpuCompetition).toEqual([
      {
        cpu: 3,
        competingTid: 1009,
        competingUtid: 9,
        competingThread: 'worker',
        competingProcess: 'other.process',
        competingState: 'Running',
        competingDurMs: 8,
        eventDurMs: 13,
        cpuMaxFreqKhz: 1_800_000,
      },
    ]);
  });

  it('copies the segment entity and window onto its semantics and exports segmentKeyOf', async () => {
    const {tp} = sqliteTraceProcessor('');
    const segment: SegmentInput = {utid: 7, tid: 1007, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'S'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [segment]);

    expect(exportedSegmentKeyOf(segment)).toBe(`7|${10 * MS}|${20 * MS}`);
    expect(segments.get(exportedSegmentKeyOf(segment))).toMatchObject({
      segmentKey: `7|${10 * MS}|${20 * MS}`,
      utid: 7,
      upid: 2,
      startTs: 10 * MS,
      endTs: 20 * MS,
    });
  });

  it('gives a repeated window its rows once', async () => {
    const {tp} = sqliteTraceProcessor(`
      INSERT INTO thread_state(utid, ts, dur, state, io_wait) VALUES (7, ${12 * MS}, ${4 * MS}, 'D', 1);
    `);
    const segment: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'D'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [segment, {...segment}]);

    expect(segments.size).toBe(1);
    expect(segments.get(segmentKeyOf(segment))?.ioSignals).toHaveLength(1);
  });
});

describe('criticalPathSemantics wake sources', () => {
  // Thread 7 (com.demo, pid 1007) sleeps; thread 9 in the same process wakes it.
  const THREADS = `
    INSERT INTO process(upid, pid, name) VALUES (2, 1007, 'com.demo');
    INSERT INTO thread VALUES (7, 1017, 2, 'pool-1-thread-1'), (8, 1018, 2, 'worker'), (9, 1019, 2, 'pool-2-thread-9');
  `;

  it('attaches only sleeps overlapping the half-open window, clips them and reads the waker off the successor row', async () => {
    // S [4,10) ends where the straddled segment starts; S [12,26) straddles its
    // end and is woken by thread 9 on the R row at 26; S [40,45) starts where
    // segment B ends.
    const {tp} = sqliteTraceProcessor(`${THREADS}
      INSERT INTO thread_state(utid, ts, dur, state, waker_utid, irq_context) VALUES
        (7, ${4 * MS}, ${6 * MS}, 'S', NULL, NULL),
        (7, ${10 * MS}, ${2 * MS}, 'R', 9, 0),
        (7, ${12 * MS}, ${14 * MS}, 'S', NULL, NULL),
        (7, ${26 * MS}, ${4 * MS}, 'R', 9, 0),
        (7, ${40 * MS}, ${5 * MS}, 'S', NULL, NULL),
        (7, ${45 * MS}, ${1 * MS}, 'R', 9, 0);
    `);
    const straddling: SegmentInput = {utid: 7, tid: 1017, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'S'};
    const b: SegmentInput = {...straddling, startTs: 30 * MS, endTs: 40 * MS};

    const {segments, sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', [straddling, b]);

    expect(sources.wakeSource).toBe('present');
    expect(segments.get(segmentKeyOf(straddling))?.wakeSources).toEqual([
      {
        state: 'S',
        durMs: 8,
        eventDurMs: 14,
        threadName: 'pool-1-thread-1',
        threadRole: 'worker',
        wakerThreadName: 'pool-2-thread-9',
        wakerProcessName: 'com.demo',
        wakerRole: 'worker',
        irqContext: false,
        wakeSource: 'same_process_thread',
        waitClass: 'worker_handoff',
      },
    ]);
    expect(segments.get(segmentKeyOf(b))?.wakeSources).toEqual([]);
  });

  it('numbers only sleeping segments against the full list, so a runnable segment ahead of them gets none', async () => {
    const {tp, sqls} = sqliteTraceProcessor(`${THREADS}
      INSERT INTO thread_state(utid, ts, dur, state, waker_utid, irq_context) VALUES
        (8, ${10 * MS}, ${10 * MS}, 'S', NULL, NULL),
        (8, ${20 * MS}, ${1 * MS}, 'R', 9, 1);
    `);
    const runnable: SegmentInput = {utid: 7, tid: 1017, upid: 2, startTs: 0, endTs: 10 * MS, state: 'R'};
    const sleeping: SegmentInput = {utid: 8, tid: 1018, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'S'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [runnable, sleeping]);

    const wakeSql = sqls.find((sql) => /FROM waits AS w/.test(sql));
    expect(wakeSql && publishedSegments(wakeSql)).toEqual([{idx: 1, utid: 8, tsStart: 10 * MS, tsEnd: 20 * MS}]);
    expect(segments.get(segmentKeyOf(runnable))?.wakeSources).toEqual([]);
    expect(segments.get(segmentKeyOf(sleeping))?.wakeSources).toEqual([
      expect.objectContaining({irqContext: true, wakeSource: 'irq_or_softirq', waitClass: 'timer_or_device_wake'}),
    ]);
  });

  it('skips the wake query when no segment is sleeping', async () => {
    const {tp, sqls} = sqliteTraceProcessor(THREADS);
    const runnable: SegmentInput = {utid: 7, tid: 1017, upid: 2, startTs: 0, endTs: 10 * MS, state: 'R'};

    const {sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', [runnable]);

    expect(sources.wakeSource).toBe('skipped');
    expect(sqls.some((sql) => /FROM waits AS w/.test(sql))).toBe(false);
  });
});

describe('criticalPathSemantics source status and warnings', () => {
  const segment: SegmentInput = {utid: 7, tid: 1007, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'S'};

  it('rethrows a cancelled query instead of reporting the source as failed', async () => {
    const cancelled = Object.assign(new Error('Trace processor query cancelled'), {name: 'AbortError'});
    const {tp} = sqliteTraceProcessor('', {rules: [
      {match: /android_binder_txns/, responder: () => { throw cancelled; }},
    ]});

    await expect(enrichSegmentsWithSemantics(tp, 'trace-1', [segment])).rejects.toBe(cancelled);
  });

  it('labels only an unknown module as stdlib_missing; other INCLUDE failures are query errors', async () => {
    const {tp} = sqliteTraceProcessor('', {
      includeErrors: {
        'android.binder': "INCLUDE: unknown module 'android.binder'",
        'android.monitor_contention': 'no such column: blocked_utid',
      },
    });

    const enrichment = await enrichSegmentsWithSemantics(tp, 'trace-1', [segment]);

    expect(enrichment.sources).toEqual({
      binder: 'stdlib_missing',
      monitor: 'sql_error',
      io: 'empty',
      gc: 'empty',
      cpu: 'skipped',
      wakeSource: 'empty',
    });
    expect(enrichment.warnings).toEqual([
      'INCLUDE android.binder failed',
      'schema mismatch: no such column: blocked_utid',
    ]);
  });

  it('returns sources and each warning once at analysis level', async () => {
    const {tp} = sqliteTraceProcessor('', {
      queryErrors: [
        [/FROM segs\s+JOIN thread_state/, 'interrupted'],
        [/JOIN android_garbage_collection_events/, 'interrupted'],
      ],
    });
    const other: SegmentInput = {...segment, utid: 8, startTs: 20 * MS, endTs: 30 * MS};

    const enrichment = await enrichSegmentsWithSemantics(tp, 'trace-1', [segment, other]);

    expect(enrichment.warnings).toEqual(['query failed: interrupted']);
    expect(enrichment.sources).toMatchObject({io: 'sql_error', gc: 'sql_error', binder: 'empty'});
  });

  it('surfaces a failure the service reports in result.error instead of throwing', async () => {
    // The production TraceProcessorService returns SQL failures as
    // `QueryResult.error` with no rows; they must not read as empty results.
    const failing = (error: string): QueryResult => ({columns: [], rows: [], durationMs: 1, error});
    const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async (_traceId, sql) => {
      if (/INCLUDE PERFETTO MODULE android\.binder;/.test(sql)) {
        return failing("INCLUDE: unknown module 'android.binder'");
      }
      if (/android_monitor_contention/.test(sql)) {
        return failing('no such table: android_monitor_contention');
      }
      return EMPTY;
    });
    const tp = {query} as unknown as TraceProcessorService;
    const segment: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 1_000, endTs: 2_000, state: 'S'};
    const {sources, warnings} = await enrichSegmentsWithSemantics(tp, 'trace-1', [segment]);

    expect(sources.binder).toBe('stdlib_missing');
    expect(sources.monitor).toBe('stdlib_missing');
    expect(warnings).toEqual(
      expect.arrayContaining([
        'INCLUDE android.binder failed',
        expect.stringMatching(/^stdlib table missing: no such table: android_monitor_contention/),
      ])
    );
  });

  it('returns skipped sources and no warnings for an empty segment list', async () => {
    const {tp, sqls} = sqliteTraceProcessor('');

    const enrichment = await enrichSegmentsWithSemantics(tp, 'trace-1', []);

    expect(sqls).toEqual([]);
    expect(enrichment.segments.size).toBe(0);
    expect(Object.values(enrichment.sources)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(enrichment.warnings).toEqual([]);
  });
});
