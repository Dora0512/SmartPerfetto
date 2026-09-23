// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 5 of critical-task analysis: counterfactual best-case estimation,
// frame timeline impact join, and falsifiable hypothesis generation.
//
// Codex P2-1: this is NOT a "projected truth". Removing the longest external
// segment saves at most its duration, and a previously shorter path may become
// critical, so the remaining duration is a best case, never a prediction.
// Amdahl-style bookkeeping only.

import {queryRows, assertQuerySucceeded, nsToMs, toNullableNumber, toNumber, toOptionalString} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';
import type {SegmentSemantics} from './criticalPathSemantics';

export interface QuantifyTaskInput {
  upid: number | null;
  startTs: number;
  endTs: number;
  durMs: number;
}

export interface QuantifySegmentInput {
  segmentKey: string;
  durMs: number;
}

export interface CounterfactualEstimate {
  longestSegmentKey: string | null;
  longestSegmentDurMs: number;
  /** Task duration left if the longest external segment took no time (task − longest). */
  bestCaseDurationMs: number;
  /** The most removing that segment can save (= longestSegmentDurMs). */
  maxSavingMs: number;
  /** @deprecated read bestCaseDurationMs */
  upperBoundMs: number;
  note: string;
}

export interface FrameImpact {
  frameId: number | null;
  expectedDeadlineDurMs: number;
  jankType: string | null;
  presentType: string | null;
  layerName: string | null;
  appUpid: number | null;
  overlapMs: number;
}

export type HypothesisStrength = 'strong' | 'weak' | 'speculative';

export interface CriticalPathHypothesis {
  id: string;
  statement: string;
  strength: HypothesisStrength;
  /**
   * SQL that, when run on the same trace, will return rows iff the hypothesis
   * holds. Codex P1-8: only numeric IDs are interpolated; never string
   * literals from segment metadata.
   */
  verificationSql: string;
  notes: string[];
}

export interface CriticalPathQuantification {
  counterfactual: CounterfactualEstimate | null;
  frameImpacts: FrameImpact[];
  hypotheses: CriticalPathHypothesis[];
  warnings: string[];
}

function buildCounterfactual(
  task: QuantifyTaskInput,
  segments: QuantifySegmentInput[]
): CounterfactualEstimate | null {
  if (segments.length === 0) return null;
  // Stable order: dur DESC, then segmentKey ASC — guarantees deterministic
  // "longest segment" pick across equal-duration ties.
  const longest = [...segments].sort(
    (a, b) => b.durMs - a.durMs || a.segmentKey.localeCompare(b.segmentKey)
  )[0];
  if (!longest || longest.durMs <= 0) return null;
  const bestCaseDurationMs = Math.max(0, Math.round((task.durMs - longest.durMs) * 100) / 100);
  return {
    longestSegmentKey: longest.segmentKey,
    longestSegmentDurMs: longest.durMs,
    bestCaseDurationMs,
    maxSavingMs: longest.durMs,
    upperBoundMs: bestCaseDurationMs,
    note:
      'BEST CASE ONLY — bestCaseDurationMs is the task duration left if the longest external segment took no time; ' +
      'the saving is at most maxSavingMs, and a previously shorter path may become critical, so the task may shrink by less.',
  };
}

async function loadFrameImpacts(
  tp: TraceProcessorService,
  traceId: string,
  task: QuantifyTaskInput
): Promise<{impacts: FrameImpact[]; warning?: string}> {
  // expected_frame_timeline_slice gives `ts + dur` as the deadline window
  // (end-of-expected-frame). actual_frame_timeline_slice carries jank_type
  // and present_type for that frame. Join via display_frame_token.
  try {
    assertQuerySucceeded(await tp.query(traceId, 'INCLUDE PERFETTO MODULE android.frames.timeline;'));
  } catch (error: unknown) {
    return {
      impacts: [],
      warning: `frames.timeline include failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }

  const upidFilter = task.upid !== null ? `AND exp.upid = ${task.upid}` : '';
  const sql = `
    SELECT
      exp.display_frame_token AS frame_id,
      exp.dur AS expected_dur,
      act.jank_type,
      act.present_type,
      exp.layer_name,
      exp.upid,
      MIN(exp.ts + exp.dur, ${task.endTs}) - MAX(exp.ts, ${task.startTs}) AS overlap_ns
    FROM expected_frame_timeline_slice AS exp
    LEFT JOIN actual_frame_timeline_slice AS act
      ON act.display_frame_token = exp.display_frame_token
     AND act.upid = exp.upid
    WHERE exp.ts < ${task.endTs}
      AND exp.ts + exp.dur > ${task.startTs}
      ${upidFilter}
    ORDER BY overlap_ns DESC
    LIMIT 4
  `;

  try {
    const rows = await queryRows(tp, traceId, sql);
    const impacts: FrameImpact[] = rows.map((obj) => {
      const overlapNs = toNumber(obj.overlap_ns);
      return {
        frameId: toNullableNumber(obj.frame_id),
        expectedDeadlineDurMs: nsToMs(toNumber(obj.expected_dur)),
        jankType: toOptionalString(obj.jank_type),
        presentType: toOptionalString(obj.present_type),
        layerName: toOptionalString(obj.layer_name),
        appUpid: toNullableNumber(obj.upid),
        overlapMs: nsToMs(Math.max(0, overlapNs)),
      };
    });
    return {impacts: impacts.filter((impact) => impact.overlapMs > 0)};
  } catch (error: unknown) {
    return {
      impacts: [],
      warning: `frame timeline query failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}

/** A signal together with the segment (entity + window) that produced it. */
interface Attributed<T> {
  sem: SegmentSemantics;
  item: T;
}

function rankBy<T>(
  semantics: SegmentSemantics[],
  pick: (sem: SegmentSemantics) => T[],
  durMs: (item: T) => number
): Array<Attributed<T>> {
  return semantics
    .flatMap((sem) => pick(sem).map((item) => ({sem, item})))
    .sort((a, b) => durMs(b.item) - durMs(a.item));
}

/**
 * Generate up to 3 falsifiable hypotheses ranked by evidence strength.
 *
 * Each hypothesis names the entity and window of the segment whose evidence
 * produced it; that segment is usually another thread on the chain, not the
 * task. Durations and thresholds use time clipped to that segment; the whole
 * event is quoted as `eventDurMs`.
 *
 * SQL rule (Codex P1-8): all interpolated values must be numeric — utid/upid,
 * `binder.serverUtid`, `monitor.rowId` and segment timestamps. NEVER
 * interpolate user-controlled strings (process name, method name, etc.) into
 * verification SQL — they appear in the natural-language statement only.
 */
function buildHypotheses(semantics: SegmentSemantics[]): CriticalPathHypothesis[] {
  const hypotheses: CriticalPathHypothesis[] = [];
  const window = (sem: SegmentSemantics): string => `[${sem.startTs}, ${sem.endTs})`;

  // H1: Sync binder client is blocked while server is GC'ing. Only fires when
  // this segment is on the CLIENT side AND the call is sync — server-side
  // segments reflect work-in-server, not wait-from-client (efficiency review
  // P1-5 / quality review #13).
  const longBinder = rankBy(semantics, (sem) => sem.binderTxns, (txn) => txn.durMs).find(
    ({item: txn}) =>
      txn.durMs >= 4 && txn.side === 'client' && txn.isSync === true && txn.serverUtid !== null && txn.binderTxnId !== null
  );
  if (longBinder) {
    const {sem, item: txn} = longBinder;
    hypotheses.push({
      id: 'h-binder-server-gc',
      statement:
        `Sync binder client wait (txn id=${txn.binderTxnId}) covers ${txn.durMs} ms of the critical-path segment ` +
        `of utid=${sem.utid} ${window(sem)} (clipped to the segment; the whole transaction lasts ${txn.eventDurMs} ms) ` +
        `and is the dominant reason; verify that the server process was running GC during this segment.`,
      strength: 'strong',
      verificationSql:
        `INCLUDE PERFETTO MODULE android.garbage_collection;\n` +
        `SELECT gc_type, gc_dur, reclaimed_mb FROM android_garbage_collection_events ` +
        `WHERE upid IN (SELECT upid FROM thread WHERE utid = ${txn.serverUtid}) ` +
        `AND gc_ts < ${sem.endTs} AND gc_ts + gc_dur > ${sem.startTs} ` +
        `ORDER BY gc_dur DESC LIMIT 5;`,
      notes: ['sync binder call on client side'],
    });
  }

  // H2: Java monitor lock contention is the proximate cause.
  const longMonitor = rankBy(semantics, (sem) => sem.monitorContention, (mc) => mc.durMs).find(
    ({item: mc}) => mc.durMs >= 2
  );
  if (longMonitor) {
    const {sem, item: mc} = longMonitor;
    hypotheses.push({
      id: 'h-monitor-blocking',
      statement:
        `A Java monitor contention (row id=${mc.rowId}) blocks utid=${sem.utid} for ${mc.durMs} ms of its ` +
        `critical-path segment ${window(sem)} (clipped to the segment; the whole contention lasts ${mc.eventDurMs} ms); ` +
        `verify the blocking thread's call chain via android_monitor_contention_chain.`,
      strength: mc.isBlockedThreadMain ? 'strong' : 'weak',
      verificationSql:
        `INCLUDE PERFETTO MODULE android.monitor_contention;\n` +
        `SELECT parent_id, child_id, short_blocking_method, short_blocked_method, dur ` +
        `FROM android_monitor_contention_chain WHERE id = ${mc.rowId};`,
      notes: mc.isBlockedThreadMain ? ['main thread blocked'] : ['non-main thread'],
    });
  }

  // H3: io_wait or IO/page-cache blocked_function candidate on the segment's thread.
  const longIo = rankBy(semantics, (sem) => sem.ioSignals, (io) => io.durMs).find(({item: io}) => io.durMs >= 4);
  if (longIo) {
    const {sem, item: io} = longIo;
    hypotheses.push({
      id: 'h-io-wait',
      statement:
        `Thread utid=${sem.utid} spends ${io.durMs} ms of its critical-path segment ${window(sem)} in an io_wait ` +
        `or IO/page-cache blocked_function candidate (clipped to the segment; the whole D/DK slice lasts ` +
        `${io.eventDurMs} ms); blocked_function is a single-frame kernel wchan, so verify with D/DK slices plus ` +
        `file/page-fault/block-I/O evidence.`,
      strength: io.ioWait ? 'strong' : 'speculative',
      verificationSql:
        `SELECT ts, dur, state, blocked_function, io_wait FROM thread_state ` +
        `WHERE utid = ${sem.utid} AND state IN ('D', 'DK') ` +
        `AND ts < ${sem.endTs} AND ts + dur > ${sem.startTs} ` +
        `ORDER BY dur DESC LIMIT 10;`,
      notes: io.ioWait ? ['io_wait flag confirmed'] : ['inferred from blocked_function pattern'],
    });
  }

  // H4: GC-induced stall in the segment's process.
  const longGc = rankBy(semantics, (sem) => sem.gcEvents, (gc) => gc.durMs).find(
    ({sem, item: gc}) => gc.durMs >= 4 && sem.upid !== null
  );
  if (longGc) {
    const {sem, item: gc} = longGc;
    hypotheses.push({
      id: 'h-gc-stall',
      statement:
        `A GC event in process upid=${sem.upid} overlaps the critical-path segment of utid=${sem.utid} ` +
        `${window(sem)} for ${gc.durMs} ms (clipped to the segment; the whole GC lasts ${gc.eventDurMs} ms); ` +
        `verify all GC events touching the segment.`,
      strength: gc.isMarkCompact ? 'strong' : 'weak',
      verificationSql:
        `INCLUDE PERFETTO MODULE android.garbage_collection;\n` +
        `SELECT gc_type, is_mark_compact, gc_dur, reclaimed_mb FROM android_garbage_collection_events ` +
        `WHERE upid = ${sem.upid} ` +
        `AND gc_ts < ${sem.endTs} AND gc_ts + gc_dur > ${sem.startTs} ` +
        `ORDER BY gc_dur DESC LIMIT 5;`,
      notes: gc.isMarkCompact ? ['mark-compact (heap-blocking)'] : ['non-mark-compact'],
    });
  }

  // H5: CPU competition for runnable segments. `priority` lives on `sched`,
  // not on `thread_state`.
  const longCpu = rankBy(semantics, (sem) => sem.cpuCompetition, (cpu) => cpu.competingDurMs).find(
    ({item: cpu}) => cpu.competingDurMs >= 2 && cpu.competingUtid !== null
  );
  if (longCpu) {
    const {sem, item: cpu} = longCpu;
    hypotheses.push({
      id: 'h-cpu-competition',
      statement:
        `While utid=${sem.utid} was runnable in its critical-path segment ${window(sem)}, a competing thread ` +
        `(utid=${cpu.competingUtid}) ran on CPU ${cpu.cpu} for ${cpu.competingDurMs} ms (clipped to the segment; ` +
        `the whole Running slice lasts ${cpu.eventDurMs} ms); verify priority and preemption.`,
      strength: 'weak',
      verificationSql:
        `SELECT ts, dur, priority FROM sched ` +
        `WHERE utid = ${cpu.competingUtid} ` +
        `AND ts < ${sem.endTs} AND ts + dur > ${sem.startTs} ` +
        `ORDER BY dur DESC LIMIT 10;`,
      notes: cpu.cpuMaxFreqKhz !== null ? [`CPU max freq during segment: ${cpu.cpuMaxFreqKhz} kHz`] : [],
    });
  }

  // Cap to 3 strongest.
  return hypotheses
    .sort((a, b) => {
      const order: Record<HypothesisStrength, number> = {strong: 0, weak: 1, speculative: 2};
      return order[a.strength] - order[b.strength];
    })
    .slice(0, 3);
}

export async function quantifyCriticalPath(
  tp: TraceProcessorService,
  traceId: string,
  task: QuantifyTaskInput,
  segments: QuantifySegmentInput[],
  semantics: SegmentSemantics[]
): Promise<CriticalPathQuantification> {
  const counterfactual = buildCounterfactual(task, segments);
  const frameResult = await loadFrameImpacts(tp, traceId, task);
  const hypotheses = buildHypotheses(semantics);

  const warnings: string[] = [];
  if (frameResult.warning) warnings.push(frameResult.warning);

  return {
    counterfactual,
    frameImpacts: frameResult.impacts,
    hypotheses,
    warnings,
  };
}

export const __INTERNAL__ = {
  buildCounterfactual,
  buildHypotheses,
};
