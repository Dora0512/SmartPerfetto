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
  nsToMs,
  rowObject,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import {classifyWaker} from './criticalPathWakerChain';
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
  | 'skipped';

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
  isBlockedThreadMain: boolean | null;
}

export interface IoSignal {
  source: 'io_wait_flag' | 'blocked_function';
  blockedFunction: string | null;
  durMs: number;
  ioWait: boolean;
}

// Android's common kernel emits sched_blocked_reason only for
// TASK_UNINTERRUPTIBLE (android14-6.1 try_to_wake_up, android16-6.12
// __schedule), so thread_state.blocked_function is NULL on every S row and the
// I/O signals above can say nothing about an interruptible wait. Socket receive
// and epoll waits are S. What is left for them is the wake source, which
// Perfetto records on the first R/R+ row after the sleep.
//
// THREAD_ROLE_PATTERNS mirrors backend/skills/fragments/thread_role.sql rule for
// rule; threadRoleContract.test.ts parses the SQL and fails if the two drift.
// The `main` role is resolved from tid = pid (pid > 0) and is deliberately not
// a name pattern, and anything unmatched is `other`.
export const THREAD_ROLE_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  render: ['RenderThread*'],
  gc: ['HeapTaskDaemon*', 'FinalizerDaemon*', 'ReferenceQueueD*'],
  jit: ['Jit thread pool*', 'Profile Saver*'],
  binder: ['Binder:*', 'binder:*', 'HwBinder:*', 'hwbinder:*'],
  network: ['OkHttp*', 'Okio*', 'Cronet*', 'ChromiumNet*', 'NetworkThread*', '*Network*'],
  image: ['glide*', 'Glide*', 'Coil*', 'Fresco*', '*decode*', '*Decode*'],
  worker: [
    'pool-*',
    'AsyncTask*',
    'arch_disk_io*',
    'RxCached*',
    'DefaultDispatcher*',
    'Dispatchers.Default*',
    '*Dispatcher*',
    '*Executor*',
    '*Worker*',
  ],
  flutter_ui: ['1.ui'],
  flutter_raster: ['1.raster'],
  webview: ['CrRendererMain*'],
  system: ['Signal Catcher*'],
};

// Evaluation order must match the SQL CASE: `network` before `worker` keeps an
// OkHttp dispatcher out of the worker bucket, and `image` before `worker` keeps
// a Glide executor out of it. It is the declaration order of the object above
// rather than a second list, because a separate order array is a third rule set
// that can drift from both SQL and the patterns it orders — `threadRoleContract`
// would still see the SQL and the patterns agree while evaluation used another
// sequence entirely.

export type WaitClass =
  | 'network_receive_candidate'
  | 'timer_or_device_wake'
  | 'worker_handoff'
  | 'binder_reply'
  | 'system_service'
  | 'unknown';

export type WakeSource =
  | 'irq_or_softirq'
  | 'same_process_thread'
  | 'binder_thread'
  | 'system_process'
  | 'swapper'
  | 'unknown';

export interface WakeSourceSummary {
  state: string | null;
  durMs: number;
  threadName: string | null;
  threadRole: string;
  wakerThreadName: string | null;
  wakerProcessName: string | null;
  wakerRole: string;
  irqContext: boolean;
  wakeSource: WakeSource;
  waitClass: WaitClass;
}

// SQLite GLOB is case-sensitive and understands `*` and `?` only; the patterns
// above use `*`, and `.` is a literal there as it is here.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

const THREAD_ROLE_MATCHERS: ReadonlyArray<{role: string; matchers: RegExp[]}> = Object.entries(
  THREAD_ROLE_PATTERNS
).map(([role, patterns]) => ({role, matchers: patterns.map(globToRegExp)}));

export function classifyThreadRole(
  threadName: string | null,
  tid: number | null,
  processPid: number | null
): string {
  if (processPid !== null && processPid > 0 && tid !== null && tid === processPid) return 'main';
  if (threadName === null) return 'other';
  for (const {role, matchers} of THREAD_ROLE_MATCHERS) {
    if (matchers.some((matcher) => matcher.test(threadName))) return role;
  }
  return 'other';
}

// Conservative list, mirroring the fragment: a platform service, the compositor,
// the network daemon, or a vendor HAL.
function isSystemProcessName(name: string | null): boolean {
  if (!name) return false;
  return (
    name === 'system_server' ||
    name.endsWith('surfaceflinger') ||
    name.endsWith('netd') ||
    name.startsWith('vendor.') ||
    name.startsWith('android.hardware.') ||
    name.startsWith('/vendor/bin/')
  );
}

/**
 * Who ended the wait. Mirrors the `wake_source` CASE in
 * fragments/sleep_wake_source.sql; `threadRoleContract.test.ts` holds the two
 * equal bucket by bucket.
 *
 * The idle and null-waker tests are ordered the other way round from SQL, which
 * is safe only because a NULL `waker_utid` comes from a LEFT JOIN that also
 * leaves the waker's name and tid NULL: `classifyWaker` then answers `unknown`,
 * never `swapper`.
 */
function classifyWakeSource(input: {
  irqContext: boolean;
  wakerUtid: number | null;
  wakerTid: number | null;
  wakerThreadName: string | null;
  wakerRole: string;
  wakerUpid: number | null;
  sleeperUpid: number | null;
  wakerProcessName: string | null;
}): WakeSource {
  // classifyWaker already separates an IRQ/softirq wake from an idle-thread
  // wake; only the remaining `thread` case needs a process-level decision.
  const wakerKind = classifyWaker(input.wakerThreadName, input.wakerTid, input.irqContext);
  if (wakerKind === 'irq') return 'irq_or_softirq';
  if (wakerKind === 'swapper') return 'swapper';
  if (input.wakerUtid === null) return 'unknown';
  if (input.wakerRole === 'binder') return 'binder_thread';
  if (input.wakerUpid !== null && input.wakerUpid === input.sleeperUpid) return 'same_process_thread';
  if (isSystemProcessName(input.wakerProcessName)) return 'system_process';
  return 'unknown';
}

/**
 * What the wait plausibly was. Mirrors the `wait_class` CASE in the same
 * fragment, and is a CANDIDATE label: an IRQ-context wake is equally a NET_RX
 * softirq and a timer expiry, which is why only the sleeping thread's role
 * narrows it at all.
 */
function classifyWaitClass(input: {
  state: string | null;
  irqContext: boolean;
  threadRole: string;
  wakerUtid: number | null;
  wakerRole: string;
  wakerUpid: number | null;
  sleeperUpid: number | null;
  wakerProcessName: string | null;
}): WaitClass {
  const interruptible = input.state === 'S' || input.state === 'I';
  if (input.irqContext && input.threadRole === 'network' && interruptible) {
    return 'network_receive_candidate';
  }
  if (input.irqContext) return 'timer_or_device_wake';
  if (input.wakerUtid === null) return 'unknown';
  if (input.wakerRole === 'binder') return 'binder_reply';
  if (input.wakerUpid !== null && input.wakerUpid === input.sleeperUpid) return 'worker_handoff';
  if (isSystemProcessName(input.wakerProcessName)) return 'system_service';
  return 'unknown';
}

export interface GcEventSummary {
  gcType: string | null;
  isMarkCompact: boolean | null;
  reclaimedMb: number | null;
  durMs: number;
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
  cpuMaxFreqKhz: number | null;
}

export interface SegmentSemantics {
  segmentKey: string;
  binderTxns: BinderTxnSummary[];
  monitorContention: MonitorContentionSummary[];
  ioSignals: IoSignal[];
  gcEvents: GcEventSummary[];
  cpuCompetition: CpuCompetitionSummary[];
  wakeSources: WakeSourceSummary[];
  sources: {
    binder: SemanticSourceStatus;
    monitor: SemanticSourceStatus;
    io: SemanticSourceStatus;
    gc: SemanticSourceStatus;
    cpu: SemanticSourceStatus;
    wakeSource: SemanticSourceStatus;
  };
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

function classifyError(error: unknown): {status: SemanticSourceStatus; warning: string} {
  const message = error instanceof Error ? error.message : String(error);
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
    const result = await tp.query(traceId, sql);
    if (result.rows.length === 0) {
      return {status: 'empty', rows: []};
    }
    const rows = result.rows.map((row) => mapRow(rowObject(result.columns, row)));
    return {status: 'present', rows};
  } catch (error: unknown) {
    const {status, warning} = classifyError(error);
    return {status, rows: [], warning};
  }
}

async function includeModule(
  tp: TraceProcessorService,
  traceId: string,
  module: string
): Promise<{ok: boolean; warning?: string}> {
  try {
    await tp.query(traceId, `INCLUDE PERFETTO MODULE ${module};`);
    return {ok: true};
  } catch (error: unknown) {
    const {warning} = classifyError(error);
    return {ok: false, warning: warning ?? `INCLUDE ${module} failed`};
  }
}

function segmentKeyOf(segment: SegmentInput): string {
  return `${segment.utid}|${segment.startTs}|${segment.endTs}`;
}

function buildSegmentValuesCte(segments: SegmentInput[]): string {
  // VALUES (idx, utid, tid_or_null, upid_or_null, ts_start, ts_end)
  // All numeric — no string injection vector.
  return segments
    .map(
      (segment, idx) =>
        `(${idx}, ${segment.utid}, ${segment.tid ?? 'NULL'}, ${segment.upid ?? 'NULL'}, ${segment.startTs}, ${segment.endTs})`
    )
    .join(', ');
}

interface BinderRow {
  segmentIdx: number;
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
}

async function loadBinderTxns(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: BinderRow[]; status: SemanticSourceStatus; warning?: string}> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.binder);
  if (!include.ok) {
    return {rows: [], status: 'stdlib_missing', warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // NOTE: client_ts/dur OR server_ts/dur — either side overlapping the segment
  // window counts. binder_txn_id may be 0 for some events; we keep it for
  // dedup/cross-reference but do not treat 0 as missing.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      txn.binder_txn_id,
      txn.binder_reply_id,
      CASE
        WHEN txn.client_utid = segs.utid AND txn.server_utid = segs.utid THEN 'both'
        WHEN txn.client_utid = segs.utid THEN 'client'
        WHEN txn.server_utid = segs.utid THEN 'server'
        ELSE 'client'
      END AS side,
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
      MAX(
        COALESCE(txn.client_dur, 0),
        COALESCE(txn.server_dur, 0)
      ) AS dur_ns
    FROM segs
    JOIN android_binder_txns AS txn ON
      (
        (txn.client_utid = segs.utid
          AND txn.client_ts <= segs.ts_end
          AND txn.client_ts + COALESCE(txn.client_dur, 0) >= segs.ts_start)
        OR
        (txn.server_utid = segs.utid
          AND txn.server_ts <= segs.ts_end
          AND txn.server_ts + COALESCE(txn.server_dur, 0) >= segs.ts_start)
      )
    ORDER BY dur_ns DESC
    LIMIT ${Math.min(segments.length * 8, 200)};
  `;
  const attempt = await tryQuery<BinderRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    binderTxnId: toNullableNumber(row.binder_txn_id),
    binderReplyId: toNullableNumber(row.binder_reply_id),
    side: (toOptionalString(row.side) ?? 'client') as BinderRow['side'],
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
    durMs: nsToMs(toNumber(row.dur_ns)),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface MonitorRow {
  segmentIdx: number;
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
  isBlockedThreadMain: boolean | null;
}

async function loadMonitorContention(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: MonitorRow[]; status: SemanticSourceStatus; warning?: string}> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.monitor);
  if (!include.ok) {
    return {rows: [], status: 'stdlib_missing', warning: include.warning};
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
      mc.dur,
      mc.is_blocked_thread_main
    FROM segs
    JOIN android_monitor_contention AS mc
      ON mc.blocked_utid = segs.utid
     AND mc.ts <= segs.ts_end
     AND mc.ts + mc.dur >= segs.ts_start
    ORDER BY mc.dur DESC
    LIMIT ${Math.min(segments.length * 6, 120)};
  `;
  const attempt = await tryQuery<MonitorRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    rowId: toNumber(row.id),
    shortBlockedMethod: toOptionalString(row.short_blocked_method),
    shortBlockingMethod: toOptionalString(row.short_blocking_method),
    blockedThreadName: toOptionalString(row.blocked_thread_name),
    blockingThreadName: toOptionalString(row.blocking_thread_name),
    blockedTid: toNullableNumber(row.blocked_thread_tid),
    blockingTid: toNullableNumber(row.blocking_tid),
    blockedUtid: toNullableNumber(row.blocked_utid),
    blockingUtid: toNullableNumber(row.blocking_utid),
    durMs: nsToMs(toNumber(row.dur)),
    isBlockedThreadMain: toBool(row.is_blocked_thread_main),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface IoRow {
  segmentIdx: number;
  blockedFunction: string | null;
  ioWait: boolean;
  durMs: number;
}

async function loadIoSignals(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: IoRow[]; status: SemanticSourceStatus; warning?: string}> {
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
      ts.dur
    FROM segs
    JOIN thread_state AS ts
      ON ts.utid = segs.utid
     AND ts.ts <= segs.ts_end
     AND ts.ts + ts.dur >= segs.ts_start
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
    ORDER BY ts.dur DESC
    LIMIT ${Math.min(segments.length * 4, 80)};
  `;
  const attempt = await tryQuery<IoRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    blockedFunction: toOptionalString(row.blocked_function),
    ioWait: toBool(row.io_wait) === true,
    durMs: nsToMs(toNumber(row.dur)),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface WakeSourceRow {
  segmentIdx: number;
  state: string | null;
  durMs: number;
  irqContext: boolean;
  threadName: string | null;
  threadRole: string;
  sleeperUpid: number | null;
  wakerUtid: number | null;
  wakerThreadName: string | null;
  wakerProcessName: string | null;
  wakerRole: string;
  wakeSource: WakeSource;
  waitClass: WaitClass;
}

async function loadWakeSources(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: WakeSourceRow[]; status: SemanticSourceStatus; warning?: string}> {
  // Only sleeping segments have a wake source worth attributing; a Runnable or
  // Running segment was never waiting on anybody. The VALUES rows carry each
  // segment's index in the FULL list, because the caller distributes results by
  // that index — a filtered array's own positions would attribute a wait to the
  // wrong segment.
  const sleeping = segments
    .map((segment, idx) => ({segment, idx}))
    .filter(({segment}) => /^(?:S|I|D|DK)$/.test(segment.state ?? ''));
  if (sleeping.length === 0) {
    return {rows: [], status: 'skipped'};
  }
  const cte = sleeping
    .map(({segment, idx}) =>
      `(${idx}, ${segment.utid}, ${segment.tid ?? 'NULL'}, ${segment.upid ?? 'NULL'}, ${segment.startTs}, ${segment.endTs})`)
    .join(', ');
  // waker_utid and irq_context live on the first R/R+ row AFTER the sleep, so
  // each wait is re-linked to the row starting at its end timestamp. A single
  // wake can be split into R then R+, which MAX collapses back to one row.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte}),
    waits AS (
      SELECT
        segs.idx AS segment_idx,
        ts.id AS state_id,
        ts.utid AS sleeper_utid,
        ts.state AS state,
        ts.dur AS dur_ns,
        MAX(nxt.waker_utid) AS waker_utid,
        MAX(nxt.irq_context) AS irq_context
      FROM segs
      JOIN thread_state AS ts
        ON ts.utid = segs.utid
       AND ts.ts <= segs.ts_end
       AND ts.ts + ts.dur >= segs.ts_start
      LEFT JOIN thread_state AS nxt
        ON nxt.utid = ts.utid
       AND nxt.ts = ts.ts + ts.dur
       AND nxt.state IN ('R', 'R+')
       AND nxt.waker_utid IS NOT NULL
      WHERE ts.state IN ('S', 'I', 'D', 'DK')
        AND ts.dur > 0
      GROUP BY segs.idx, ts.id
    )
    SELECT
      w.segment_idx,
      w.state,
      w.dur_ns,
      w.irq_context,
      w.waker_utid,
      thr.name AS thread_name,
      thr.tid AS thread_tid,
      proc.pid AS process_pid,
      proc.upid AS sleeper_upid,
      wthr.name AS waker_thread_name,
      wthr.tid AS waker_tid,
      wproc.name AS waker_process_name,
      wproc.pid AS waker_process_pid,
      wproc.upid AS waker_upid
    FROM waits AS w
    LEFT JOIN thread AS thr ON thr.utid = w.sleeper_utid
    LEFT JOIN process AS proc ON proc.upid = thr.upid
    LEFT JOIN thread AS wthr ON wthr.utid = w.waker_utid
    LEFT JOIN process AS wproc ON wproc.upid = wthr.upid
    ORDER BY w.dur_ns DESC
    LIMIT ${Math.min(sleeping.length * 6, 120)};
  `;
  const attempt = await tryQuery<WakeSourceRow>(tp, traceId, sql, (row) => {
    const irqContext = toBool(row.irq_context) === true;
    const threadRole = classifyThreadRole(
      toOptionalString(row.thread_name),
      toNullableNumber(row.thread_tid),
      toNullableNumber(row.process_pid)
    );
    const wakerUtid = toNullableNumber(row.waker_utid);
    const wakerThreadName = toOptionalString(row.waker_thread_name);
    const wakerTid = toNullableNumber(row.waker_tid);
    const wakerProcessName = toOptionalString(row.waker_process_name);
    const wakerRole = wakerUtid === null
      ? 'unknown'
      : classifyThreadRole(wakerThreadName, wakerTid, toNullableNumber(row.waker_process_pid));
    const wakerUpid = toNullableNumber(row.waker_upid);
    const sleeperUpid = toNullableNumber(row.sleeper_upid);
    const state = toOptionalString(row.state);
    const wakeSource = classifyWakeSource({
      irqContext,
      wakerUtid,
      wakerTid,
      wakerThreadName,
      wakerRole,
      wakerUpid,
      sleeperUpid,
      wakerProcessName,
    });
    return {
      segmentIdx: toNumber(row.segment_idx),
      state,
      durMs: nsToMs(toNumber(row.dur_ns)),
      irqContext,
      threadName: toOptionalString(row.thread_name),
      threadRole,
      sleeperUpid,
      wakerUtid,
      wakerThreadName,
      wakerProcessName,
      wakerRole,
      wakeSource,
      waitClass: classifyWaitClass({
        state,
        irqContext,
        threadRole,
        wakerUtid,
        wakerRole,
        wakerUpid,
        sleeperUpid,
        wakerProcessName,
      }),
    };
  });
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface GcRow {
  segmentIdx: number;
  gcType: string | null;
  isMarkCompact: boolean | null;
  reclaimedMb: number | null;
  durMs: number;
  thread: string | null;
  process: string | null;
}

async function loadGcEvents(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: GcRow[]; status: SemanticSourceStatus; warning?: string}> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.gc);
  if (!include.ok) {
    return {rows: [], status: 'stdlib_missing', warning: include.warning};
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
      gc.gc_dur,
      gc.thread_name,
      gc.process_name
    FROM segs
    JOIN android_garbage_collection_events AS gc
      ON segs.upid IS NOT NULL
     AND gc.upid = segs.upid
     AND gc.gc_ts <= segs.ts_end
     AND gc.gc_ts + gc.gc_dur >= segs.ts_start
    ORDER BY gc.gc_dur DESC
    LIMIT ${Math.min(segments.length * 3, 60)};
  `;
  const attempt = await tryQuery<GcRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    gcType: toOptionalString(row.gc_type),
    isMarkCompact: toBool(row.is_mark_compact),
    reclaimedMb: toNullableNumber(row.reclaimed_mb),
    durMs: nsToMs(toNumber(row.gc_dur)),
    thread: toOptionalString(row.thread_name),
    process: toOptionalString(row.process_name),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface CpuRow {
  segmentIdx: number;
  cpu: number;
  competingTid: number | null;
  competingUtid: number | null;
  competingThread: string | null;
  competingProcess: string | null;
  competingState: string | null;
  competingDurMs: number;
  cpuMaxFreqKhz: number | null;
}

async function loadCpuCompetition(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: CpuRow[]; status: SemanticSourceStatus; warning?: string}> {
  // Only meaningful for R/R+ states (waiting for CPU). For S/D the segment
  // wasn't on a CPU, so same-CPU competition is undefined.
  const runnable = segments.filter((s) => /^R\+?$/.test(s.state ?? ''));
  if (runnable.length === 0) {
    return {rows: [], status: 'skipped'};
  }
  const cte = buildSegmentValuesCte(runnable);

  // Prefer freq module if available, but tolerate its absence.
  const includeFreq = await includeModule(tp, traceId, STDLIB_MODULES.frequency);

  // Two-step: 1) find the CPU the runnable thread eventually ran on (or was
  // queued on); 2) list other Running threads on that same CPU during the
  // overlap. We use thread_state.cpu of the matching segment row directly.
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
       AND ts.ts + ts.dur >= segs.ts_start
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
      ts.dur AS competing_dur_ns
      ${includeFreq.ok ? `,(SELECT MAX(freq) FROM cpu_frequency_counters f WHERE f.cpu = tc.cpu AND f.ts + f.dur >= tc.ts_start AND f.ts <= tc.ts_end) AS cpu_max_freq` : ',NULL AS cpu_max_freq'}
    FROM target_cpu AS tc
    JOIN thread_state AS ts
      ON ts.cpu = tc.cpu
     AND ts.state = 'Running'
     AND ts.ts <= tc.ts_end
     AND ts.ts + ts.dur >= tc.ts_start
    LEFT JOIN thread AS thr ON thr.utid = ts.utid
    LEFT JOIN process AS proc ON proc.upid = thr.upid
    WHERE ts.utid != (SELECT utid FROM segs WHERE idx = tc.segment_idx)
    ORDER BY ts.dur DESC
    LIMIT ${Math.min(runnable.length * 6, 120)};
  `;
  const attempt = await tryQuery<CpuRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    cpu: toNumber(row.cpu),
    competingTid: toNullableNumber(row.competing_tid),
    competingUtid: toNullableNumber(row.competing_utid),
    competingThread: toOptionalString(row.competing_thread),
    competingProcess: toOptionalString(row.competing_process),
    competingState: toOptionalString(row.competing_state),
    competingDurMs: nsToMs(toNumber(row.competing_dur_ns)),
    cpuMaxFreqKhz: toNullableNumber(row.cpu_max_freq),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

export async function enrichSegmentsWithSemantics(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<Map<string, SegmentSemantics>> {
  const result = new Map<string, SegmentSemantics>();

  if (segments.length === 0) return result;

  // Initialize empty buckets for every segment so callers always get a slot.
  for (const segment of segments) {
    const key = segmentKeyOf(segment);
    result.set(key, {
      segmentKey: key,
      binderTxns: [],
      monitorContention: [],
      ioSignals: [],
      gcEvents: [],
      cpuCompetition: [],
      wakeSources: [],
      sources: {
        binder: 'skipped',
        monitor: 'skipped',
        io: 'skipped',
        gc: 'skipped',
        cpu: 'skipped',
        wakeSource: 'skipped',
      },
      warnings: [],
    });
  }

  // Run all six queries concurrently — each is independent.
  const [binder, monitor, io, gc, cpu, wakeSource] = await Promise.all([
    loadBinderTxns(tp, traceId, segments),
    loadMonitorContention(tp, traceId, segments),
    loadIoSignals(tp, traceId, segments),
    loadGcEvents(tp, traceId, segments),
    loadCpuCompetition(tp, traceId, segments),
    loadWakeSources(tp, traceId, segments),
  ]);

  const distribute = <T extends {segmentIdx: number}>(
    rows: T[],
    pick: (sem: SegmentSemantics, row: T) => void
  ): void => {
    for (const row of rows) {
      const segment = segments[row.segmentIdx];
      if (!segment) continue;
      const sem = result.get(segmentKeyOf(segment));
      if (!sem) continue;
      pick(sem, row);
    }
  };

  distribute(binder.rows, (sem, row) =>
    sem.binderTxns.push({
      binderTxnId: row.binderTxnId,
      binderReplyId: row.binderReplyId,
      side: row.side,
      interfaceName: row.interfaceName,
      methodName: row.methodName,
      isSync: row.isSync,
      isMainThread: row.isMainThread,
      clientProcess: row.clientProcess,
      clientThread: row.clientThread,
      serverProcess: row.serverProcess,
      serverThread: row.serverThread,
      clientUtid: row.clientUtid,
      serverUtid: row.serverUtid,
      clientTid: row.clientTid,
      serverTid: row.serverTid,
      durMs: row.durMs,
    })
  );

  distribute(monitor.rows, (sem, row) =>
    sem.monitorContention.push({
      rowId: row.rowId,
      shortBlockedMethod: row.shortBlockedMethod,
      shortBlockingMethod: row.shortBlockingMethod,
      blockedThreadName: row.blockedThreadName,
      blockingThreadName: row.blockingThreadName,
      blockedTid: row.blockedTid,
      blockingTid: row.blockingTid,
      blockedUtid: row.blockedUtid,
      blockingUtid: row.blockingUtid,
      durMs: row.durMs,
      isBlockedThreadMain: row.isBlockedThreadMain,
    })
  );

  distribute(io.rows, (sem, row) =>
    sem.ioSignals.push({
      source: row.ioWait ? 'io_wait_flag' : 'blocked_function',
      blockedFunction: row.blockedFunction,
      durMs: row.durMs,
      ioWait: row.ioWait,
    })
  );

  distribute(gc.rows, (sem, row) =>
    sem.gcEvents.push({
      gcType: row.gcType,
      isMarkCompact: row.isMarkCompact,
      reclaimedMb: row.reclaimedMb,
      durMs: row.durMs,
      thread: row.thread,
      process: row.process,
    })
  );

  distribute(cpu.rows, (sem, row) =>
    sem.cpuCompetition.push({
      cpu: row.cpu,
      competingTid: row.competingTid,
      competingUtid: row.competingUtid,
      competingThread: row.competingThread,
      competingProcess: row.competingProcess,
      competingState: row.competingState,
      competingDurMs: row.competingDurMs,
      cpuMaxFreqKhz: row.cpuMaxFreqKhz,
    })
  );

  distribute(wakeSource.rows, (sem, row) =>
    sem.wakeSources.push({
      state: row.state,
      durMs: row.durMs,
      threadName: row.threadName,
      threadRole: row.threadRole,
      wakerThreadName: row.wakerThreadName,
      wakerProcessName: row.wakerProcessName,
      wakerRole: row.wakerRole,
      irqContext: row.irqContext,
      wakeSource: row.wakeSource,
      waitClass: row.waitClass,
    })
  );

  // Set per-source status + warnings on every segment, even if it received 0 rows.
  for (const sem of result.values()) {
    sem.sources = {
      binder: binder.status,
      monitor: monitor.status,
      io: io.status,
      gc: gc.status,
      cpu: cpu.status,
      wakeSource: wakeSource.status,
    };
    for (const w of [binder.warning, monitor.warning, io.warning, gc.warning, cpu.warning,
      wakeSource.warning]) {
      if (w) sem.warnings.push(w);
    }
  }

  return result;
}

// Exported for unit-test reach into otherwise-private helpers.
export const __INTERNAL__ = {
  classifyError,
  segmentKeyOf,
  buildSegmentValuesCte,
  classifyWaitClass,
  classifyWakeSource,
  isSystemProcessName,
};
