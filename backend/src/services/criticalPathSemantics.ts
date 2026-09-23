// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 3 of critical-task analysis: enrich raw thread_state segments with
// structured semantic events from Perfetto stdlib tables (NOT regex on slice
// names — see commit history rationale).
//
// Schema confirmed via backend/test-output/stdlib-schema-probe.json against
// 6 real test traces on perfetto v54:
//   ✅ android_binder_txns   (client_*/server_*, binder_txn_id, is_sync, method_name)
//   ✅ android_monitor_contention (blocked_utid/blocking_utid, ts/dur, short_*_method)
//   ❌ android_io / android_io_long_tasks — DO NOT EXIST in v54
//      → fallback uses thread_state.io_wait + blocked_function text
//   ✅ android_garbage_collection_events (gc_ts / gc_dur / reclaimed_mb — NOT ts/dur/reclaimed_bytes)
//   ❌ cpu_utilization_per_thread — DOES NOT EXIST in v54
//      → R/R+ CPU competition: query same-CPU thread_state directly + cpu_frequency_counters

import {
  queryRows,
  assertQuerySucceeded,
  nsToMs,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';

export interface SegmentInput {
  utid: number;
  tid: number | null;
  upid: number | null;
  startTs: number;
  endTs: number;
  state?: string | null;
}

export type SemanticSourceStatus =
  | 'present'
  | 'empty'
  | 'stdlib_missing'
  | 'sql_error'
  | 'skipped'
  | 'not_checked';

export type SemanticSourceName = 'binder' | 'monitor' | 'io' | 'gc' | 'cpu';
export type SemanticSources = Record<SemanticSourceName, SemanticSourceStatus>;

// Every duration below is attributable time: the event's overlap with the
// segment window it is attached to. `eventDurMs` is the whole event.
export interface BinderTxnSummary {
  binderTxnId: number | null;
  binderReplyId: number | null;
  side: 'client' | 'server' | 'both';
  interfaceName: string | null;
  methodName: string | null;
  isSync: boolean | null;
  isMainThread: boolean | null;
  clientProcess: string | null;
  clientThread: string | null;
  serverProcess: string | null;
  serverThread: string | null;
  clientUtid: number | null;
  serverUtid: number | null;
  clientTid: number | null;
  serverTid: number | null;
  durMs: number;
  eventDurMs: number;
}

export interface MonitorContentionSummary {
  rowId: number;
  shortBlockedMethod: string | null;
  shortBlockingMethod: string | null;
  blockedThreadName: string | null;
  blockingThreadName: string | null;
  blockedTid: number | null;
  blockingTid: number | null;
  blockedUtid: number | null;
  blockingUtid: number | null;
  durMs: number;
  eventDurMs: number;
  isBlockedThreadMain: boolean | null;
}

export interface IoSignal {
  source: 'io_wait_flag' | 'blocked_function';
  blockedFunction: string | null;
  durMs: number;
  eventDurMs: number;
  ioWait: boolean;
}

export interface GcEventSummary {
  gcType: string | null;
  isMarkCompact: boolean | null;
  reclaimedMb: number | null;
  durMs: number;
  eventDurMs: number;
  thread: string | null;
  process: string | null;
}

export interface CpuCompetitionSummary {
  cpu: number;
  competingTid: number | null;
  competingUtid: number | null;
  competingThread: string | null;
  competingProcess: string | null;
  competingState: string | null; // R / Running / R+
  competingDurMs: number;
  eventDurMs: number;
  cpuMaxFreqKhz: number | null;
}

export interface SegmentSemantics {
  segmentKey: string;
  // The segment the evidence below was attached to (entity + window).
  utid: number;
  upid: number | null;
  startTs: number;
  endTs: number;
  binderTxns: BinderTxnSummary[];
  monitorContention: MonitorContentionSummary[];
  ioSignals: IoSignal[];
  gcEvents: GcEventSummary[];
  cpuCompetition: CpuCompetitionSummary[];
  sources: SemanticSources;
  warnings: string[];
}

export interface EnrichSegmentsOptions {
  /** The tid/upid lookup failed, so segment upids are unknown and GC evidence is not checked. */
  threadLookupFailed?: boolean;
}

export interface SemanticEnrichment {
  segments: Map<string, SegmentSemantics>;
  sources: SemanticSources;
  /** Each loader warning once. */
  warnings: string[];
}

interface QueryAttempt<T> {
  status: SemanticSourceStatus;
  rows: T[];
  warning?: string;
}

const STDLIB_MODULES = {
  binder: 'android.binder',
  monitor: 'android.monitor_contention',
  gc: 'android.garbage_collection',
  frequency: 'linux.cpu.frequency',
} as const;

function classifyError(error: unknown, module?: string): {status: SemanticSourceStatus; warning: string} {
  const message = error instanceof Error ? error.message : String(error);
  // Only an unknown module means the stdlib lacks it; any other INCLUDE
  // failure (a table or column the module needs) is classified like a query.
  if (module !== undefined && /unknown module/i.test(message)) {
    return {status: 'stdlib_missing', warning: `INCLUDE ${module} failed`};
  }
  // Perfetto trace_processor returns "no such table: X" / "no such column: Y"
  if (/no such table/i.test(message)) {
    return {status: 'stdlib_missing', warning: `stdlib table missing: ${message.split('\n')[0]}`};
  }
  if (/no such column|no such function/i.test(message)) {
    return {status: 'sql_error', warning: `schema mismatch: ${message.split('\n')[0]}`};
  }
  return {status: 'sql_error', warning: `query failed: ${message.split('\n')[0]}`};
}

async function tryQuery<T>(
  tp: TraceProcessorService,
  traceId: string,
  sql: string,
  mapRow: (row: QueryRow) => T
): Promise<QueryAttempt<T>> {
  try {
    const rows = await queryRows(tp, traceId, sql);
    if (rows.length === 0) {
      return {status: 'empty', rows: []};
    }
    return {status: 'present', rows: rows.map(mapRow)};
  } catch (error: unknown) {
    const {status, warning} = classifyError(error);
    return {status, rows: [], warning};
  }
}

type IncludeResult = {ok: true} | {ok: false; status: SemanticSourceStatus; warning: string};

async function includeModule(
  tp: TraceProcessorService,
  traceId: string,
  module: string
): Promise<IncludeResult> {
  try {
    assertQuerySucceeded(await tp.query(traceId, `INCLUDE PERFETTO MODULE ${module};`));
    return {ok: true};
  } catch (error: unknown) {
    return {ok: false, ...classifyError(error, module)};
  }
}

export function segmentKeyOf(segment: {utid: number; startTs: number; endTs: number}): string {
  return `${segment.utid}|${segment.startTs}|${segment.endTs}`;
}

// `idx` is each segment's position in the FULL list handed to
// enrichSegmentsWithSemantics: distribute() resolves the `segment_idx` a query
// returns against that same list. A loader that only wants a subset passes
// `keep`, so rows are dropped after numbering. Never filter the list first —
// the subset would be renumbered from zero and its rows would land on whichever
// segment sits at that position in the full list.
function buildSegmentValuesCte(
  segments: SegmentInput[],
  keep: (segment: SegmentInput) => boolean = () => true
): string {
  // VALUES (idx, utid, tid_or_null, upid_or_null, ts_start, ts_end)
  // All numeric — no string injection vector.
  return segments
    .flatMap((segment, idx) =>
      keep(segment)
        ? [`(${idx}, ${segment.utid}, ${segment.tid ?? 'NULL'}, ${segment.upid ?? 'NULL'}, ${segment.startTs}, ${segment.endTs})`]
        : []
    )
    .join(', ');
}

/** A loader row: the summary plus the `segment_idx` the query attached it to. */
interface Attributed<T> {
  segmentIdx: number;
  summary: T;
}

type LoaderResult<T> = QueryAttempt<Attributed<T>>;

// Loaders attach an event to a segment on the half-open overlap
// `ev_start < seg_end AND ev_end > seg_start` (an event that ends exactly where
// the segment starts belongs to the previous segment) and report `dur_ns` as
// `MIN(ev_end, seg_end) - MAX(ev_start, seg_start)`. A thread_state row still
// open at trace end has dur -1, so the clipped value is floored at 0.
function clippedMs(value: unknown): number {
  return nsToMs(Math.max(0, toNumber(value)));
}

async function loadBinderTxns(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<LoaderResult<BinderTxnSummary>> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.binder);
  if (!include.ok) {
    return {rows: [], status: include.status, warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // Either side on the segment's thread counts. The event is that side's slice;
  // the client wins when both match because a sync client slice encloses its
  // server slice. binder_txn_id may be 0 for some events; we keep it for
  // dedup/cross-reference but do not treat 0 as missing.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte}),
    hits AS (
      SELECT
        segs.idx AS segment_idx,
        segs.ts_start,
        segs.ts_end,
        txn.binder_txn_id,
        txn.binder_reply_id,
        txn.interface,
        txn.method_name,
        txn.is_sync,
        txn.is_main_thread,
        txn.client_process,
        txn.client_thread,
        txn.server_process,
        txn.server_thread,
        txn.client_utid,
        txn.server_utid,
        txn.client_tid,
        txn.server_tid,
        txn.client_ts,
        COALESCE(txn.client_dur, 0) AS client_dur,
        txn.server_ts,
        COALESCE(txn.server_dur, 0) AS server_dur,
        COALESCE(
          txn.client_utid = segs.utid
            AND txn.client_ts < segs.ts_end
            AND txn.client_ts + COALESCE(txn.client_dur, 0) > segs.ts_start,
          0
        ) AS client_hit,
        COALESCE(
          txn.server_utid = segs.utid
            AND txn.server_ts < segs.ts_end
            AND txn.server_ts + COALESCE(txn.server_dur, 0) > segs.ts_start,
          0
        ) AS server_hit
      FROM segs
      JOIN android_binder_txns AS txn
        ON txn.client_utid = segs.utid OR txn.server_utid = segs.utid
    ),
    events AS (
      SELECT
        *,
        CASE WHEN client_hit THEN client_ts ELSE server_ts END AS ev_ts,
        CASE WHEN client_hit THEN client_dur ELSE server_dur END AS ev_dur
      FROM hits
      WHERE client_hit OR server_hit
    )
    SELECT
      segment_idx,
      binder_txn_id,
      binder_reply_id,
      CASE
        WHEN client_hit AND server_hit THEN 'both'
        WHEN client_hit THEN 'client'
        ELSE 'server'
      END AS side,
      interface,
      method_name,
      is_sync,
      is_main_thread,
      client_process,
      client_thread,
      server_process,
      server_thread,
      client_utid,
      server_utid,
      client_tid,
      server_tid,
      MIN(ev_ts + ev_dur, ts_end) - MAX(ev_ts, ts_start) AS dur_ns,
      ev_dur AS event_dur_ns
    FROM events
    ORDER BY dur_ns DESC
    LIMIT ${Math.min(segments.length * 8, 200)};
  `;
  return tryQuery(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    summary: {
      binderTxnId: toNullableNumber(row.binder_txn_id),
      binderReplyId: toNullableNumber(row.binder_reply_id),
      side: (toOptionalString(row.side) ?? 'client') as BinderTxnSummary['side'],
      interfaceName: toOptionalString(row.interface),
      methodName: toOptionalString(row.method_name),
      isSync: toBool(row.is_sync),
      isMainThread: toBool(row.is_main_thread),
      clientProcess: toOptionalString(row.client_process),
      clientThread: toOptionalString(row.client_thread),
      serverProcess: toOptionalString(row.server_process),
      serverThread: toOptionalString(row.server_thread),
      clientUtid: toNullableNumber(row.client_utid),
      serverUtid: toNullableNumber(row.server_utid),
      clientTid: toNullableNumber(row.client_tid),
      serverTid: toNullableNumber(row.server_tid),
      durMs: clippedMs(row.dur_ns),
      eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
    },
  }));
}

async function loadMonitorContention(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<LoaderResult<MonitorContentionSummary>> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.monitor);
  if (!include.ok) {
    return {rows: [], status: include.status, warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // android_monitor_contention.blocked_utid is the thread that's stuck waiting
  // for the lock. We match against the segment's utid.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      mc.id,
      mc.short_blocked_method,
      mc.short_blocking_method,
      mc.blocked_thread_name,
      mc.blocking_thread_name,
      mc.blocked_thread_tid,
      mc.blocking_tid,
      mc.blocked_utid,
      mc.blocking_utid,
      MIN(mc.ts + mc.dur, segs.ts_end) - MAX(mc.ts, segs.ts_start) AS dur_ns,
      mc.dur AS event_dur_ns,
      mc.is_blocked_thread_main
    FROM segs
    JOIN android_monitor_contention AS mc
      ON mc.blocked_utid = segs.utid
     AND mc.ts < segs.ts_end
     AND mc.ts + mc.dur > segs.ts_start
    ORDER BY dur_ns DESC
    LIMIT ${Math.min(segments.length * 6, 120)};
  `;
  return tryQuery(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    summary: {
      rowId: toNumber(row.id),
      shortBlockedMethod: toOptionalString(row.short_blocked_method),
      shortBlockingMethod: toOptionalString(row.short_blocking_method),
      blockedThreadName: toOptionalString(row.blocked_thread_name),
      blockingThreadName: toOptionalString(row.blocking_thread_name),
      blockedTid: toNullableNumber(row.blocked_thread_tid),
      blockingTid: toNullableNumber(row.blocking_tid),
      blockedUtid: toNullableNumber(row.blocked_utid),
      blockingUtid: toNullableNumber(row.blocking_utid),
      durMs: clippedMs(row.dur_ns),
      eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
      isBlockedThreadMain: toBool(row.is_blocked_thread_main),
    },
  }));
}

async function loadIoSignals(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<LoaderResult<IoSignal>> {
  // No stdlib io table in v54 — use thread_state.io_wait + kernel wchan
  // single-frame blocked_function patterns (page cache / block layer / fs /
  // mmc / ufs) as fallback. blocked_function is not a full call stack.
  const cte = buildSegmentValuesCte(segments);
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      ts.blocked_function,
      ts.io_wait,
      MIN(ts.ts + ts.dur, segs.ts_end) - MAX(ts.ts, segs.ts_start) AS dur_ns,
      ts.dur AS event_dur_ns
    FROM segs
    JOIN thread_state AS ts
      ON ts.utid = segs.utid
     AND ts.ts < segs.ts_end
     AND ts.ts + ts.dur > segs.ts_start
    WHERE ts.state IN ('D', 'DK')
      AND (
        ts.io_wait = 1
        OR ts.blocked_function LIKE '%io_schedule%'
        OR ts.blocked_function LIKE '%wait_on_buffer%'
        OR ts.blocked_function LIKE '%wait_on_page%'
        OR ts.blocked_function LIKE '%folio_wait%'
        OR ts.blocked_function LIKE '%submit_bio%'
        OR ts.blocked_function LIKE '%filemap_read%'
        OR ts.blocked_function LIKE '%filemap_fault%'
        OR ts.blocked_function LIKE '%do_page_fault%'
        OR ts.blocked_function LIKE '%ext4_%'
        OR ts.blocked_function LIKE '%f2fs_%'
        OR ts.blocked_function LIKE '%erofs_%'
        OR ts.blocked_function LIKE '%dm_%'
        OR ts.blocked_function LIKE '%mmc_%'
        OR ts.blocked_function LIKE '%ufshcd_%'
        OR ts.blocked_function LIKE '%blk_%'
        OR ts.blocked_function LIKE '%blk_mq_%'
      )
    ORDER BY dur_ns DESC
    LIMIT ${Math.min(segments.length * 4, 80)};
  `;
  return tryQuery(tp, traceId, sql, (row) => {
    const ioWait = toBool(row.io_wait) === true;
    return {
      segmentIdx: toNumber(row.segment_idx),
      summary: {
        source: ioWait ? 'io_wait_flag' : 'blocked_function',
        blockedFunction: toOptionalString(row.blocked_function),
        durMs: clippedMs(row.dur_ns),
        eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
        ioWait,
      },
    };
  });
}

async function loadGcEvents(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[],
  threadLookupFailed: boolean
): Promise<LoaderResult<GcEventSummary>> {
  // Segment upids come from the tid/upid lookup. Without it an empty result
  // would read as "no GC", so report that the source was not checked.
  if (threadLookupFailed) {
    return {rows: [], status: 'not_checked'};
  }
  const include = await includeModule(tp, traceId, STDLIB_MODULES.gc);
  if (!include.ok) {
    return {rows: [], status: include.status, warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // gc.upid OR gc.utid overlap. GC blocks the whole process, so a non-task
  // thread's GC can stall the segment indirectly. We match on upid.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      gc.gc_type,
      gc.is_mark_compact,
      gc.reclaimed_mb,
      MIN(gc.gc_ts + gc.gc_dur, segs.ts_end) - MAX(gc.gc_ts, segs.ts_start) AS dur_ns,
      gc.gc_dur AS event_dur_ns,
      gc.thread_name,
      gc.process_name
    FROM segs
    JOIN android_garbage_collection_events AS gc
      ON segs.upid IS NOT NULL
     AND gc.upid = segs.upid
     AND gc.gc_ts < segs.ts_end
     AND gc.gc_ts + gc.gc_dur > segs.ts_start
    ORDER BY dur_ns DESC
    LIMIT ${Math.min(segments.length * 3, 60)};
  `;
  return tryQuery(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    summary: {
      gcType: toOptionalString(row.gc_type),
      isMarkCompact: toBool(row.is_mark_compact),
      reclaimedMb: toNullableNumber(row.reclaimed_mb),
      durMs: clippedMs(row.dur_ns),
      eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
      thread: toOptionalString(row.thread_name),
      process: toOptionalString(row.process_name),
    },
  }));
}

async function loadCpuCompetition(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<LoaderResult<CpuCompetitionSummary>> {
  // Only meaningful for R/R+ states (waiting for CPU). For S/D the segment
  // wasn't on a CPU, so same-CPU competition is undefined.
  const isRunnable = (segment: SegmentInput): boolean => /^R\+?$/.test(segment.state ?? '');
  const runnableCount = segments.filter(isRunnable).length;
  if (runnableCount === 0) {
    return {rows: [], status: 'skipped'};
  }
  const cte = buildSegmentValuesCte(segments, isRunnable);

  // Prefer freq module if available, but tolerate its absence.
  const includeFreq = await includeModule(tp, traceId, STDLIB_MODULES.frequency);

  // Two-step: 1) find the CPU the runnable thread eventually ran on (or was
  // queued on); 2) list other Running threads on that same CPU during the
  // overlap. We use thread_state.cpu of the matching segment row directly.
  // target_cpu is the one end-inclusive match (`ts.ts <= segs.ts_end`): the
  // row starting exactly at segment end is the CPU it eventually ran on.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte}),
    target_cpu AS (
      SELECT segs.idx AS segment_idx,
             ts.cpu,
             segs.ts_start,
             segs.ts_end
      FROM segs
      JOIN thread_state AS ts
        ON ts.utid = segs.utid
       AND ts.ts <= segs.ts_end
       AND ts.ts + ts.dur > segs.ts_start
      WHERE ts.cpu IS NOT NULL
      GROUP BY segs.idx, ts.cpu
    )
    SELECT
      tc.segment_idx,
      tc.cpu,
      thr.tid AS competing_tid,
      ts.utid AS competing_utid,
      thr.name AS competing_thread,
      proc.name AS competing_process,
      ts.state AS competing_state,
      MIN(ts.ts + ts.dur, tc.ts_end) - MAX(ts.ts, tc.ts_start) AS competing_dur_ns,
      ts.dur AS event_dur_ns
      ${includeFreq.ok ? `,(SELECT MAX(freq) FROM cpu_frequency_counters f WHERE f.cpu = tc.cpu AND f.ts < tc.ts_end AND f.ts + f.dur > tc.ts_start) AS cpu_max_freq` : ',NULL AS cpu_max_freq'}
    FROM target_cpu AS tc
    JOIN thread_state AS ts
      ON ts.cpu = tc.cpu
     AND ts.state = 'Running'
     AND ts.ts < tc.ts_end
     AND ts.ts + ts.dur > tc.ts_start
    LEFT JOIN thread AS thr ON thr.utid = ts.utid
    LEFT JOIN process AS proc ON proc.upid = thr.upid
    WHERE ts.utid != (SELECT utid FROM segs WHERE idx = tc.segment_idx)
    ORDER BY competing_dur_ns DESC
    LIMIT ${Math.min(runnableCount * 6, 120)};
  `;
  return tryQuery(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    summary: {
      cpu: toNumber(row.cpu),
      competingTid: toNullableNumber(row.competing_tid),
      competingUtid: toNullableNumber(row.competing_utid),
      competingThread: toOptionalString(row.competing_thread),
      competingProcess: toOptionalString(row.competing_process),
      competingState: toOptionalString(row.competing_state),
      competingDurMs: clippedMs(row.competing_dur_ns),
      eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
      cpuMaxFreqKhz: toNullableNumber(row.cpu_max_freq),
    },
  }));
}

function emptySemantics(segment: SegmentInput, key: string): SegmentSemantics {
  return {
    segmentKey: key,
    utid: segment.utid,
    upid: segment.upid,
    startTs: segment.startTs,
    endTs: segment.endTs,
    binderTxns: [],
    monitorContention: [],
    ioSignals: [],
    gcEvents: [],
    cpuCompetition: [],
    sources: {binder: 'skipped', monitor: 'skipped', io: 'skipped', gc: 'skipped', cpu: 'skipped'},
    warnings: [],
  };
}

export async function enrichSegmentsWithSemantics(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[],
  options: EnrichSegmentsOptions = {}
): Promise<SemanticEnrichment> {
  const result = new Map<string, SegmentSemantics>();

  // Copies of one window would only fetch the same rows twice, so every loader
  // and distribute() share the index space of the unique windows.
  const unique = segments.filter((segment) => {
    const key = segmentKeyOf(segment);
    if (result.has(key)) return false;
    result.set(key, emptySemantics(segment, key));
    return true;
  });

  if (unique.length === 0) {
    return {
      segments: result,
      sources: {binder: 'skipped', monitor: 'skipped', io: 'skipped', gc: 'skipped', cpu: 'skipped'},
      warnings: [],
    };
  }

  // Run all five queries concurrently — each is independent.
  const [binder, monitor, io, gc, cpu] = await Promise.all([
    loadBinderTxns(tp, traceId, unique),
    loadMonitorContention(tp, traceId, unique),
    loadIoSignals(tp, traceId, unique),
    loadGcEvents(tp, traceId, unique, options.threadLookupFailed === true),
    loadCpuCompetition(tp, traceId, unique),
  ]);

  const sources: SemanticSources = {
    binder: binder.status,
    monitor: monitor.status,
    io: io.status,
    gc: gc.status,
    cpu: cpu.status,
  };
  const warnings = Array.from(
    new Set(
      [binder.warning, monitor.warning, io.warning, gc.warning, cpu.warning].filter(
        (warning): warning is string => Boolean(warning)
      )
    )
  );

  // Per-segment sources/warnings repeat the analysis-level values for
  // callers that read them from a segment.
  for (const sem of result.values()) {
    sem.sources = {...sources};
    sem.warnings = [...warnings];
  }

  const distribute = <T>(rows: Attributed<T>[], list: (sem: SegmentSemantics) => T[]): void => {
    for (const {segmentIdx, summary} of rows) {
      const segment = unique[segmentIdx];
      const sem = segment && result.get(segmentKeyOf(segment));
      if (sem) list(sem).push(summary);
    }
  };

  distribute(binder.rows, (sem) => sem.binderTxns);
  distribute(monitor.rows, (sem) => sem.monitorContention);
  distribute(io.rows, (sem) => sem.ioSignals);
  distribute(gc.rows, (sem) => sem.gcEvents);
  distribute(cpu.rows, (sem) => sem.cpuCompetition);

  return {segments: result, sources, warnings};
}

// Exported for unit-test reach into otherwise-private helpers.
export const __INTERNAL__ = {
  classifyError,
  segmentKeyOf,
  buildSegmentValuesCte,
};
