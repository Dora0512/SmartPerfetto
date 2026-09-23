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
import {EMPTY, sqliteTraceProcessor} from '../../../tests/helpers/criticalPathTraceProcessorFixture';

const {segmentWindowsCte, segmentKeyOf} = __INTERNAL__;

const MS_UNIT = 1_000_000;

describe('criticalPathSemantics segment index contract', () => {
  const sleeping: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 1 * MS_UNIT, endTs: 2 * MS_UNIT, state: 'S'};
  const runnable: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 2 * MS_UNIT, endTs: 3 * MS_UNIT, state: 'R'};
  const blocked: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 3 * MS_UNIT, endTs: 4 * MS_UNIT, state: 'D'};
  const preempted: SegmentInput = {utid: 7, tid: 7, upid: 2, startTs: 4 * MS_UNIT, endTs: 5 * MS_UNIT, state: 'R+'};

  it('numbers every segment in list order and passes the state as numeric flags only', () => {
    expect(segmentWindowsCte([sleeping, {...runnable, waiterUtid: 1}])).toBe(
      'segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping, runnable, waiter_utid) AS (VALUES ' +
        `(0, 7, 7, 2, ${1 * MS_UNIT}, ${2 * MS_UNIT}, 1, 0, NULL), (1, 7, 7, 2, ${2 * MS_UNIT}, ${3 * MS_UNIT}, 0, 1, 1))`
    );
  });

  it('keeps every runnable window on its own segment when runnable and waiting states interleave', async () => {
    // Thread 7 is queued on CPU 3 in both runnable windows; thread 9 runs there throughout.
    const {tp} = sqliteTraceProcessor(`
      INSERT INTO process(upid, name) VALUES (4, 'other.process');
      INSERT INTO thread VALUES (9, 999, 4, 'other-thread');
      INSERT INTO thread_state(utid, ts, dur, state, cpu) VALUES
        (7, ${2 * MS_UNIT}, ${1 * MS_UNIT}, 'R', 3),
        (7, ${4 * MS_UNIT}, ${1 * MS_UNIT}, 'R+', 3);
      INSERT INTO sched(ts, dur, cpu, utid) VALUES (0, ${10 * MS_UNIT}, 3, 9);
    `);
    const segments = [sleeping, runnable, blocked, preempted];

    const {segments: result, sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', segments);

    const competitor = expect.objectContaining({cpu: 3, competingTid: 999, competingThread: 'other-thread',
      competingProcess: 'other.process', competingDurMs: 1});
    expect(segments.map((segment) => result.get(segmentKeyOf(segment))?.cpuCompetition)).toEqual([
      [], [competitor], [], [competitor],
    ]);
    expect(sources.cpu).toBe('present');
  });

  it('skips the CPU query entirely when no segment is runnable', async () => {
    const {tp, sqls} = sqliteTraceProcessor('');

    const {sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', [sleeping, blocked]);

    expect(sqls.some((sql) => /segment_cpu_competition/.test(sql))).toBe(false);
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
      -- sched mirrors the Running rows, plus the idle task, which is never a competitor.
      INSERT INTO sched(ts, dur, cpu, utid) VALUES
        (${5 * MS}, ${5 * MS}, 1, 7), (${20 * MS}, ${5 * MS}, 3, 7),
        (${12 * MS}, ${13 * MS}, 3, 9), (${5 * MS}, ${5 * MS}, 3, 10),
        (${20 * MS}, ${2 * MS}, 3, 11), (${10 * MS}, ${10 * MS}, 1, 12),
        (${10 * MS}, ${2 * MS}, 3, 0);
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

    expect(sqls.some((sql) => /segment_wake_sources/.test(sql))).toBe(true);
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
    expect(sqls.some((sql) => /segment_wake_sources/.test(sql))).toBe(false);
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
        [/segment_io_signals/, 'interrupted'],
        [/segment_gc_events/, 'interrupted'],
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

describe('criticalPathSemantics monitor contention sides', () => {
  // Thread 7 (the task) waits on a monitor held by thread 8; thread 9 waits on the same owner.
  const SETUP = `
    INSERT INTO android_monitor_contention VALUES
      (5, ${10 * MS}, ${10 * MS}, 7, 8, 1007, 1008, 'main', 'owner', 'a()', 'b()', 1),
      (6, ${12 * MS}, ${6 * MS}, 9, 8, 1009, 1008, 'other', 'owner', 'c()', 'b()', 0);
  `;
  const ownerSegment: SegmentInput = {
    utid: 8, tid: 1008, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'Running', waiterUtid: 7,
  };

  it('attaches the contention to the lock owner segment whose waiter it explains', async () => {
    const {tp} = sqliteTraceProcessor(SETUP);

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [ownerSegment]);

    expect(segments.get(segmentKeyOf(ownerSegment))?.monitorContention).toEqual([
      expect.objectContaining({rowId: 5, side: 'owner', blockedUtid: 7, blockingUtid: 8, durMs: 10}),
    ]);
  });

  it('never attaches another thread blocked on the same owner, nor any owner row without a waiter', async () => {
    const {tp} = sqliteTraceProcessor(SETUP);
    const unrelatedWaiter: SegmentInput = {...ownerSegment, waiterUtid: 3};
    const noWaiter: SegmentInput = {...ownerSegment, startTs: 10 * MS + 1, waiterUtid: null};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [unrelatedWaiter, noWaiter]);

    expect(segments.get(segmentKeyOf(unrelatedWaiter))?.monitorContention).toEqual([]);
    expect(segments.get(segmentKeyOf(noWaiter))?.monitorContention).toEqual([]);
  });

  it('still attaches the blocked side to the waiting thread itself', async () => {
    const {tp} = sqliteTraceProcessor(SETUP);
    const blocked: SegmentInput = {utid: 9, tid: 1009, upid: 2, startTs: 10 * MS, endTs: 20 * MS, state: 'S'};

    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [blocked]);

    expect(segments.get(segmentKeyOf(blocked))?.monitorContention).toEqual([
      expect.objectContaining({rowId: 6, side: 'blocked', durMs: 6}),
    ]);
  });
});

describe('criticalPathSemantics I/O blocked_function families', () => {
  const segment: SegmentInput = {utid: 7, tid: 1007, upid: 2, startTs: 0, endTs: 100 * MS, state: 'D'};
  const ioFunctions = async (names: string[]): Promise<Array<string | null>> => {
    const rows = names.map((name, index) => `(7, ${index * 10 * MS}, ${5 * MS}, 'D', 0, '${name}')`).join(', ');
    const {tp} = sqliteTraceProcessor(
      `INSERT INTO thread_state(utid, ts, dur, state, io_wait, blocked_function) VALUES ${rows};`
    );
    const {segments} = await enrichSegmentsWithSemantics(tp, 'trace-1', [segment]);
    return (segments.get(segmentKeyOf(segment))?.ioSignals ?? []).map((io) => io.blockedFunction);
  };

  it('matches the I/O families, including buffer and file-system wchans', async () => {
    // At most four rows per segment are kept, so check four names at a time.
    for (const names of [
      ['__wait_on_buffer', 'ext4_file_read_iter', 'f2fs_write_begin', 'folio_wait_bit_common'],
      ['io_schedule', 'blk_mq_get_tag', 'filemap_fault', 'do_page_fault'],
    ]) {
      expect((await ioFunctions(names)).sort()).toEqual([...names].sort());
    }
  });

  it('does not read `_` as a wildcard: a GPU fence wait is not I/O', async () => {
    expect(await ioFunctions(['dma_fence_wait_timeout', 'blkdev_notify', 'mmcdriver_poll'])).toEqual([]);
  });
});

describe('criticalPathSemantics row bounds', () => {
  it('keeps the longest rows of every segment, so one busy segment cannot starve the others', async () => {
    // Segment A has 10 long D/io_wait rows, segment B one short one.
    const aRows = Array.from({length: 10}, (_, index) => `(7, ${index * 2 * MS}, ${2 * MS}, 'D', 1)`).join(', ');
    const {tp} = sqliteTraceProcessor(`
      INSERT INTO thread_state(utid, ts, dur, state, io_wait) VALUES ${aRows}, (8, ${50 * MS}, ${1 * MS / 10}, 'D', 1);
    `);
    const a: SegmentInput = {utid: 7, tid: 1007, upid: 2, startTs: 0, endTs: 20 * MS, state: 'D'};
    const b: SegmentInput = {utid: 8, tid: 1008, upid: 2, startTs: 50 * MS, endTs: 60 * MS, state: 'D'};

    const {segments, warnings} = await enrichSegmentsWithSemantics(tp, 'trace-1', [a, b]);

    expect(segments.get(segmentKeyOf(a))?.ioSignals).toHaveLength(4);
    expect(segments.get(segmentKeyOf(b))?.ioSignals).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

describe('criticalPathSemantics loader ceiling', () => {
  it('keeps the longest rows and warns when a loader reaches its row ceiling', async () => {
    // 1001 D segments with four io_wait rows each: 4004 rows, over the 4000 ceiling.
    const segments: SegmentInput[] = Array.from({length: 1001}, (_, index) => ({
      utid: 7, tid: 1007, upid: 2, startTs: index * 10 * MS, endTs: (index * 10 + 8) * MS, state: 'D',
    }));
    const rows = segments.flatMap((segment, index) => Array.from({length: 4}, (_, row) =>
      `(7, ${segment.startTs + row * 2 * MS}, ${(row === 0 && index === 0 ? 1.9 : 2) * MS}, 'D', 1)`)).join(', ');
    const {tp} = sqliteTraceProcessor(`INSERT INTO thread_state(utid, ts, dur, state, io_wait) VALUES ${rows};`);

    const {segments: result, warnings, sources} = await enrichSegmentsWithSemantics(tp, 'trace-1', segments);

    expect(sources.io).toBe('present');
    expect([...result.values()].reduce((sum, sem) => sum + sem.ioSignals.length, 0)).toBe(4000);
    expect(warnings).toContain('io evidence reached the 4000-row limit; the shortest segments may lack it');
  });
});
