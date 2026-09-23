// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 2 of critical-task analysis: resolve the *direct* waker of the
// selected task slice and annotate IRQ/swapper termination semantics.
//
// Codex P1-1: this module deliberately does NOT recurse on waker_id. Recursing
// "who woke the thread that woke me?" does not yield a wait chain — it yields
// a notification chain that quickly devolves into IRQ handlers and softirqd.
// The actual wait chain (what each upstream thread was itself blocked on) is
// answered by L4's recursive _critical_path_stack call. This module is a
// single-hop annotator.

import {
  assertQuerySucceeded,
  rowObject,
  toBool,
  toNullableNumber,
  toOptionalString,
} from '../utils/traceProcessorRowUtils';
import {errorLine, hintText} from './criticalPathText';
import {rethrowIfTraceProcessorQueryCancelled} from './traceProcessorCancellation';
import type {TraceProcessorService} from './traceProcessorService';
import type {
  CriticalPathHintCode,
  CriticalPathWarning,
  WakerHop,
  WakerKind,
} from '../types/criticalPathContract';

export interface WakerChainResult {
  hop: WakerHop | null;
  warnings: CriticalPathWarning[];
}

export function classifyWaker(
  threadName: string | null,
  tid: number | null,
  irqContext: boolean
): WakerKind {
  if (irqContext) return 'irq';
  // Kernel idle threads: tid=0, or a `swapper`-prefixed comm. L2 resolves one
  // waker in TypeScript, so this is the one rule kept on both sides: the prefix
  // matches fragments/sleep_wake_source.sql (`thread_name GLOB 'swapper*'`), which
  // labels the chain's wake sources, so the direct waker and the chain agree.
  if (tid === 0) return 'swapper';
  if (threadName && /^swapper/.test(threadName)) return 'swapper';
  if (threadName) return 'thread';
  return 'unknown';
}

export interface ResolveWakerOptions {
  threadStateId: number;
  signal?: AbortSignal;
}

function withHints(hintCodes: CriticalPathHintCode[]): Pick<WakerHop, 'hintCodes' | 'hints'> {
  return {hintCodes, hints: hintCodes.map((code) => hintText(code, 'zh-CN'))};
}

/**
 * Resolve the direct waker for a given thread_state row id. Returns a single
 * hop (NOT a recursive chain) annotated with IRQ/swapper context.
 *
 * Perfetto records `waker_utid`, `waker_id` and `irq_context` on the first
 * R/R+ row after a sleep, never on the S/D row itself nor on the Running row
 * that follows. The wakeup row is therefore found by position:
 *  - a waiting row: its successor at `ts + dur` (same join and MAX collapse
 *    as blocking_chain_analysis.skill.yaml);
 *  - a Running row: the R/R+ row that ends where it starts. A predecessor
 *    without a waker is a preemption, not a wakeup, and reports no waker;
 *  - an R/R+ row: itself.
 *
 * Failure modes (each returns hop=null with a warning):
 *  - thread_state row missing
 *  - wakeup row carries no waker_utid (no recorded waker)
 *  - SQL error
 * Cancellation is rethrown, never reported as a failed lookup.
 */
export async function resolveDirectWaker(
  tp: TraceProcessorService,
  traceId: string,
  options: ResolveWakerOptions
): Promise<WakerChainResult> {
  const {threadStateId, signal} = options;
  if (!Number.isInteger(threadStateId) || threadStateId < 0) {
    return {hop: null, warnings: [{code: 'invalid_thread_state_id'}]};
  }

  const sql = `
    WITH target AS (
      SELECT id, ts, dur, utid, state, waker_utid, waker_id, irq_context
      FROM thread_state
      WHERE id = ${Math.trunc(threadStateId)}
    ),
    wake AS (
      SELECT
        target.id AS target_id,
        target.ts AS target_ts,
        CASE WHEN target.state IN ('R', 'R+') THEN target.waker_utid ELSE MAX(adj.waker_utid) END AS waker_utid,
        CASE WHEN target.state IN ('R', 'R+') THEN target.waker_id ELSE MAX(adj.waker_id) END AS waker_id,
        CASE WHEN target.state IN ('R', 'R+') THEN target.irq_context ELSE MAX(adj.irq_context) END AS irq_context
      FROM target
      LEFT JOIN thread_state AS adj
        ON target.state NOT IN ('R', 'R+')
       AND adj.utid = target.utid
       AND adj.state IN ('R', 'R+')
       AND adj.waker_utid IS NOT NULL
       AND (
         (target.state = 'Running' AND adj.ts + adj.dur = target.ts)
         OR (target.state != 'Running' AND adj.ts = target.ts + target.dur)
       )
      GROUP BY target.id
    )
    SELECT
      wake.target_id,
      wake.target_ts,
      wake.waker_utid,
      wake.waker_id,
      wake.irq_context,
      waker.state AS waker_state,
      waker.cpu AS waker_cpu,
      thread.tid AS waker_tid,
      thread.name AS waker_thread_name,
      process.name AS waker_process_name
    FROM wake
    LEFT JOIN thread_state AS waker ON waker.id = wake.waker_id
    LEFT JOIN thread ON thread.utid = wake.waker_utid
    LEFT JOIN process ON process.upid = thread.upid
    LIMIT 1
  `;

  let result;
  try {
    result = assertQuerySucceeded(await tp.query(traceId, sql, {signal}));
  } catch (error: unknown) {
    rethrowIfTraceProcessorQueryCancelled(error);
    return {hop: null, warnings: [{code: 'waker_query_failed', params: {message: errorLine(error)}}]};
  }

  if (result.rows.length === 0) {
    return {hop: null, warnings: [{code: 'thread_state_not_found', params: {id: threadStateId}}]};
  }

  const row = rowObject(result.columns, result.rows[0]);
  const wakerUtid = toNullableNumber(row.waker_utid);
  // IRQ context is a property of the wakeup event, so it is read from the
  // wakeup row only — never from the waker's own thread_state row.
  const irqContext = toBool(row.irq_context) === true;

  // No waker recorded — common when thread_state was scheduled by self-yield
  // or when the wakeup wasn't captured.
  if (wakerUtid === null) {
    if (irqContext) {
      return {
        hop: {
          threadStateId: null,
          utid: null,
          tid: null,
          threadName: null,
          processName: null,
          state: null,
          cpu: null,
          irqContext: true,
          kind: 'irq',
          ...withHints(['irq_wakeup']),
        },
        warnings: [],
      };
    }
    return {hop: null, warnings: [{code: 'no_recorded_waker'}]};
  }

  const wakerThreadName = toOptionalString(row.waker_thread_name);
  const wakerTid = toNullableNumber(row.waker_tid);
  const kind = classifyWaker(wakerThreadName, wakerTid, irqContext);

  const hintCodes: CriticalPathHintCode[] = [];
  if (irqContext) hintCodes.push('irq_wakeup');
  if (kind === 'swapper') hintCodes.push('swapper_wakeup');

  return {
    hop: {
      threadStateId: toNullableNumber(row.waker_id),
      utid: wakerUtid,
      tid: wakerTid,
      threadName: wakerThreadName,
      processName: toOptionalString(row.waker_process_name),
      state: toOptionalString(row.waker_state),
      cpu: toNullableNumber(row.waker_cpu),
      irqContext,
      kind,
      ...withHints(hintCodes),
    },
    warnings: [],
  };
}
