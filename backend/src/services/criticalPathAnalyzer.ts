// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 1 + Layer 4 orchestrator for critical-task analysis.
//
// Layered design:
//   L1 — state-aware dispatch (S/D/R/Running) + multi-thread_state-slice splitting
//   L2 — direct waker annotation                          (criticalPathWakerChain.ts)
//   L3 — semantic enrichment via Perfetto stdlib table joins (criticalPathSemantics.ts)
//   L4 — recursive _critical_path_stack on long external segments (this file, depth=2)
//   L5 — counterfactual best case + frame impact + hypotheses    (criticalPathQuantify.ts)
//
// Schema is backward-compatible: all old CriticalPathAnalysis top-level fields
// are preserved, with new fields ADDED. Old consumers will keep working.

import {
  enrichSegmentsWithSemantics,
  segmentKeyOf,
  type SegmentInput as SemanticSegmentInput,
  type SegmentSemantics,
  type SemanticSourceStatus,
} from './criticalPathSemantics';
import {resolveDirectWaker, type WakerChainResult, type WakerHop} from './criticalPathWakerChain';
import {
  quantifyCriticalPath,
  type CriticalPathQuantification,
  type QuantifySegmentInput,
} from './criticalPathQuantify';
import {
  nsToMs,
  assertQuerySucceeded,
  queryRows,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';

export interface CriticalPathAnalyzeOptions {
  threadStateId?: number | string;
  utid?: number | string;
  startTs?: number | string;
  dur?: number | string;
  endTs?: number | string;
  maxSegments?: number;
  recursionDepth?: number;
  recursionEnabled?: boolean;
  segmentBudget?: number;
}

export type CriticalPathInputErrorCode =
  | 'invalid_thread_state_id'
  | 'thread_state_not_found'
  | 'missing_selector'
  | 'non_positive_duration'
  | 'invalid_integer';

/** A caller-input failure; callers map `code` to a 4xx response. */
export class CriticalPathInputError extends Error {
  readonly code: CriticalPathInputErrorCode;

  constructor(code: CriticalPathInputErrorCode, message: string) {
    super(message);
    this.name = 'CriticalPathInputError';
    this.code = code;
  }
}

// === Backward-compatible types (do NOT remove fields) ===

export interface CriticalPathTaskInfo {
  threadStateId?: number;
  utid: number;
  tid?: number | null;
  upid?: number | null;
  startTs: number;
  dur: number;
  durationMs: number;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  threadName?: string | null;
  processName?: string | null;
  waker?: {
    threadStateId?: number | null;
    utid?: number | null;
    threadName?: string | null;
    processName?: string | null;
    state?: string | null;
    interruptContext?: boolean | null;
  };
}

export interface CriticalPathSegment {
  startTs: number;
  dur: number;
  startOffsetMs: number;
  durationMs: number;
  utid: number;
  tid?: number | null;
  upid?: number | null;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: string[];
  modules: string[];
  reasons: string[];
  semantics?: SegmentSemantics;
  recursionDepth?: number;
  // Children: result of recursing _critical_path_stack on this segment.
  children?: CriticalPathSegment[];
}

export interface CriticalPathModuleStat {
  module: string;
  durationMs: number;
  percentage: number;
  segmentCount: number;
  examples: string[];
}

export interface CriticalPathAnomaly {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  evidence: string[];
}

// === New types (additive) ===

export type SliceKind = 'sleeping' | 'uninterruptible' | 'runnable' | 'running' | 'unknown';

export interface SliceFinding {
  threadStateId: number | null;
  startTs: number;
  endTs: number;
  durationMs: number;
  state: string | null;
  kind: SliceKind;
  cpu: number | null;
  blockedFunction: string | null;
  ioWait: boolean | null;
  // For Running/short slices we may skip critical-path stack lookup.
  skippedReason?: string;
  segmentCount: number;
}

/**
 * Why `available` is false: the selected row is Running, the window holds no
 * S/D/DK/R/R+ time, or Perfetto returned no critical-path stack.
 */
export type CriticalPathUnavailableReason =
  | 'task_state_running'
  | 'no_critical_path_stack'
  | 'no_waiting_time';

export interface CriticalPathAnalysis {
  available: boolean;
  task: CriticalPathTaskInfo;
  totalMs: number;
  blockingMs: number;
  selfMs: number;
  externalBlockingPercentage: number;
  wakeupChain: CriticalPathSegment[];
  moduleBreakdown: CriticalPathModuleStat[];
  anomalies: CriticalPathAnomaly[];
  summary: string;
  recommendations: string[];
  warnings: string[];
  rawRows: number;
  truncated: boolean;
  // Additive fields:
  slices?: SliceFinding[];
  directWaker?: WakerHop | null;
  quantification?: CriticalPathQuantification;
  semanticSources?: Record<string, SemanticSourceStatus>;
  unavailableReason?: CriticalPathUnavailableReason;
}

// === Helpers ===

interface CriticalPathStackRow {
  ts: number;
  dur: number;
  utid: number;
  name: string;
  tableName?: string | null;
  threadName?: string | null;
  processName?: string | null;
}

interface SegmentAccumulator {
  startTs: number;
  dur: number;
  utid: number;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: Set<string>;
  modules: Set<string>;
  reasons: Set<string>;
}

function normalizeIntegerSql(
  value: unknown,
  fieldName: string,
  code: CriticalPathInputErrorCode = 'invalid_integer'
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new CriticalPathInputError(code, `${fieldName} must be an integer`);
  }
  return raw;
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value * 10_000) / total) / 100;
}

function stateLabel(state?: string | null): string {
  if (!state) return '未知状态';
  const first = state[0];
  const labels: Record<string, string> = {
    R: state.includes('+') ? 'Runnable + Preempted' : 'Runnable',
    S: 'Sleeping',
    D: 'Uninterruptible Sleep',
    T: 'Stopped',
    t: 'Traced',
    X: 'Exit Dead',
    Z: 'Zombie',
    I: 'Idle',
    K: 'Wake Kill',
    W: 'Waking',
    P: 'Parked',
    Running: 'Running',
  };
  return labels[state] ?? labels[first] ?? state;
}

function classifySlice(state: string | null): SliceKind {
  if (!state) return 'unknown';
  if (state === 'Running') return 'running';
  const first = state[0];
  if (first === 'S') return 'sleeping';
  if (first === 'D') return 'uninterruptible';
  if (first === 'R') return 'runnable';
  return 'unknown';
}

/** The non-empty strings among `items`. */
function present(items: Array<string | null | undefined>): string[] {
  return items.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stripPrefix(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const stripped = value.slice(prefix.length).trim();
  return stripped.length > 0 ? stripped : null;
}

// Keyword fallback: applies only while a segment has no stdlib signal —
// applySemanticsToSegments replaces these labels when L3 finds one.
// Wait-type classes (locks, IO, scheduling) read only wait evidence (state,
// blocked_function, slices, reasons) on word boundaries: a thread or process
// name ("RenderThread", "pool-1-thread-1") says what a thread is, not what it
// waited on. Role classes may also read names. Order is priority: the first
// label is the segment's primary module.
const TEXT_MODULES: Array<{label: string; waitOnly: boolean; pattern: RegExp}> = [
  {label: 'Binder / IPC', waitOnly: false, pattern: /\bbinder|hwbinder|ipc(threadstate|transaction)|transact/},
  {
    label: '锁 / Futex',
    waitOnly: true,
    pattern: /\b_*(?:futex|rt_mutex|mutex|rwsem|percpu_rwsem)\w*|\bsem_wait\b|\bmonitor\b|\block\b|\bcontention\b|\bcondition\b/,
  },
  {
    label: 'IO / 页缓存 / 文件系统候选',
    waitOnly: true,
    pattern:
      /\bio_wait\b|\bi\/o\b|\bfsync\b|\bfdatasync\b|\bread\b|\bwrite\b|\bpread64\b|\bpwrite64\b|\bsqlite\w*|\bwal\b|\bjournal\b|\b_*(?:io_schedule|wait_on_page|folio_wait|wait_on_buffer|submit_bio|filemap|do_page_fault|page_fault|ext4|f2fs|erofs|jbd2|blk|mmc|ufshcd)\w*/,
  },
  {label: '调度 / CPU 竞争', waitOnly: true, pattern: /\brunnable\b|\bpreempt\w*/},
  {
    label: '图形渲染 / Surface',
    waitOnly: false,
    pattern: /renderthread|surfaceflinger|blast|bufferqueue|queuebuffer|dequeuebuffer|doframe|drawframe|traversal|hwui|skia|egl|vulkan|opengl/,
  },
  {label: '输入链路', waitOnly: false, pattern: /inputdispatcher|inputreader|motionevent|touch|gesture/},
  {label: 'ART / GC', waitOnly: false, pattern: /\bgc\b|garbage|art::|dalvik|jit|dex2oat/},
  {label: 'Kernel / IRQ / Workqueue', waitOnly: false, pattern: /\birq\/|kworker|softirq|workqueue|rcu|kernel|interrupt/},
  {label: '电源 / 唤醒', waitOnly: false, pattern: /wakeup|wakelock|suspend|cpuidle|power/},
];

function classifyModulesFromText(waitTexts: string[], roleTexts: string[]): string[] {
  const waitJoined = waitTexts.join('\n').toLowerCase();
  const allJoined = [...waitTexts, ...roleTexts].join('\n').toLowerCase();
  return TEXT_MODULES.filter(({waitOnly, pattern}) => pattern.test(waitOnly ? waitJoined : allJoined)).map(
    ({label}) => label
  );
}

/** Attributable ms of each stdlib signal on one segment, capped at the segment's duration. */
interface SegmentSignalMs {
  binder: number;
  monitor: number;
  io: number;
  gc: number;
  cpu: number;
}

function segmentSignalMs(segment: CriticalPathSegment): SegmentSignalMs {
  const sem = segment.semantics;
  const sum = <T>(items: T[] | undefined, durMs: (item: T) => number): number =>
    Math.min(segment.durationMs, (items ?? []).reduce((total, item) => total + durMs(item), 0));
  return {
    binder: sum(sem?.binderTxns, (txn) => txn.durMs),
    monitor: sum(sem?.monitorContention, (mc) => mc.durMs),
    io: sum(sem?.ioSignals, (io) => io.durMs),
    gc: sum(sem?.gcEvents, (gc) => gc.durMs),
    cpu: sum(sem?.cpuCompetition, (cpu) => cpu.competingDurMs),
  };
}

// Stdlib-derived modules, longest attributable signal first so the first
// label is the segment's primary module.
function modulesFromSemantics(segment: CriticalPathSegment): string[] {
  const semantics = segment.semantics;
  if (!semantics) return [];
  const ms = segmentSignalMs(segment);
  const signals: Array<[string, boolean, number]> = [
    ['Binder / IPC', semantics.binderTxns.length > 0, ms.binder],
    ['锁 / Monitor', semantics.monitorContention.length > 0, ms.monitor],
    ['IO / 文件系统', semantics.ioSignals.length > 0, ms.io],
    ['ART / GC', semantics.gcEvents.length > 0, ms.gc],
    ['调度 / CPU 竞争', semantics.cpuCompetition.length > 0, ms.cpu],
  ];
  // GC is matched per process, so a concurrent background collection can
  // overlap a segment that was really waiting on a lock or a file. Thread-level
  // signals therefore rank ahead of GC; GC leads only when it stands alone.
  const processLevel = (label: string): number => (label === 'ART / GC' ? 1 : 0);
  return signals
    .filter(([, isPresent]) => isPresent)
    .sort((a, b) => processLevel(a[0]) - processLevel(b[0]) || b[2] - a[2])
    .map(([label]) => label);
}

function addReason(segment: SegmentAccumulator, reason: string | null | undefined): void {
  if (reason && reason.trim()) {
    segment.reasons.add(reason.trim());
  }
}

function getSegment(
  segments: Map<string, SegmentAccumulator>,
  row: CriticalPathStackRow
): SegmentAccumulator {
  const key = `${row.ts}|${row.dur}|${row.utid}`;
  let segment = segments.get(key);
  if (!segment) {
    segment = {
      startTs: row.ts,
      dur: row.dur,
      utid: row.utid,
      processName: row.processName,
      threadName: row.threadName,
      slices: new Set<string>(),
      modules: new Set<string>(),
      reasons: new Set<string>(),
    };
    segments.set(key, segment);
  }
  segment.processName ??= row.processName;
  segment.threadName ??= row.threadName;
  return segment;
}

// The stack query already drops the root thread's own rows, so every row
// here describes an external segment.
function normalizeStackRows(rows: QueryRow[]): CriticalPathStackRow[] {
  return rows
    .map((row) => ({
      ts: toNumber(row.ts),
      dur: toNumber(row.dur),
      utid: toNumber(row.utid),
      name: String(row.name ?? ''),
      tableName: toOptionalString(row.table_name),
      threadName: toOptionalString(row.thread_name),
      processName: toOptionalString(row.process_name),
    }))
    .filter((row) => row.dur > 0 && row.name.length > 0);
}

function buildSegments(
  rows: CriticalPathStackRow[],
  task: CriticalPathTaskInfo
): CriticalPathSegment[] {
  const segments = new Map<string, SegmentAccumulator>();

  for (const row of rows) {
    const segment = getSegment(segments, row);
    const name = row.name;

    const state = stripPrefix(name, 'blocking thread_state:');
    if (state) {
      segment.state = state;
      addReason(segment, stateLabel(state));
    }

    const processName = stripPrefix(name, 'blocking process_name:');
    if (processName) segment.processName = processName;

    const threadName = stripPrefix(name, 'blocking thread_name:');
    if (threadName) segment.threadName = threadName;

    const kernelFunction = stripPrefix(name, 'blocking kernel_function:');
    if (kernelFunction) {
      segment.blockedFunction = kernelFunction;
      addReason(segment, kernelFunction);
    }

    const ioWait = stripPrefix(name, 'blocking io_wait:');
    if (ioWait) {
      segment.ioWait = ioWait === '1' || ioWait.toLowerCase() === 'true';
      if (segment.ioWait) addReason(segment, 'io_wait');
    }

    const cpu = stripPrefix(name, 'cpu:');
    if (cpu) {
      segment.cpu = toNullableNumber(cpu);
      addReason(segment, `CPU ${cpu}`);
    }

    if (row.tableName === 'slice' && !name.startsWith('blocking ') && name !== task.threadName) {
      segment.slices.add(name);
      addReason(segment, name);
    }
  }

  return Array.from(segments.values())
    .map((segment) => {
      const waitTexts = present([
        segment.state,
        segment.blockedFunction,
        ...Array.from(segment.slices).slice(0, 6),
        ...Array.from(segment.reasons).slice(0, 6),
      ]);
      const roleTexts = present([segment.processName, segment.threadName]);
      // Text-based fallback; applySemanticsToSegments() replaces it when L3
      // finds a stdlib signal for this segment.
      const modules = classifyModulesFromText(waitTexts, roleTexts);
      modules.forEach((module) => segment.modules.add(module));
      return {
        startTs: segment.startTs,
        dur: segment.dur,
        startOffsetMs: nsToMs(segment.startTs - task.startTs),
        durationMs: nsToMs(segment.dur),
        utid: segment.utid,
        processName: segment.processName,
        threadName: segment.threadName,
        state: segment.state,
        blockedFunction: segment.blockedFunction,
        ioWait: segment.ioWait,
        cpu: segment.cpu,
        slices: Array.from(segment.slices).slice(0, 8),
        modules: Array.from(segment.modules),
        reasons: Array.from(segment.reasons).slice(0, 8),
      };
    })
    .sort((a, b) => a.startTs - b.startTs || b.dur - a.dur);
}

function mergeAdjacentSegments(segments: CriticalPathSegment[]): CriticalPathSegment[] {
  const merged: CriticalPathSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const sameOwner =
      previous &&
      previous.utid === segment.utid &&
      previous.processName === segment.processName &&
      previous.threadName === segment.threadName &&
      previous.state === segment.state &&
      previous.startTs + previous.dur === segment.startTs;

    if (!sameOwner) {
      merged.push({...segment});
      continue;
    }

    previous.dur += segment.dur;
    previous.durationMs = nsToMs(previous.dur);
    previous.slices = Array.from(new Set([...previous.slices, ...segment.slices])).slice(0, 8);
    previous.modules = Array.from(new Set([...previous.modules, ...segment.modules]));
    previous.reasons = Array.from(new Set([...previous.reasons, ...segment.reasons])).slice(0, 8);
  }
  return merged;
}

function buildModuleBreakdown(
  segments: CriticalPathSegment[],
  totalMs: number
): CriticalPathModuleStat[] {
  const stats = new Map<
    string,
    {durationMs: number; segmentCount: number; examples: Set<string>}
  >();
  // Each segment counts once, under its primary module, so shares of the
  // non-overlapping top-level chain sum to at most 100%.
  for (const segment of segments) {
    const module = segment.modules[0] ?? '未归类';
    const current =
      stats.get(module) ?? {durationMs: 0, segmentCount: 0, examples: new Set<string>()};
    current.durationMs += segment.durationMs;
    current.segmentCount += 1;
    const example = segmentExample(segment);
    if (example) current.examples.add(example);
    stats.set(module, current);
  }

  return Array.from(stats.entries())
    .map(([module, value]) => ({
      module,
      durationMs: Math.round(value.durationMs * 100) / 100,
      percentage: pct(value.durationMs, totalMs),
      segmentCount: value.segmentCount,
      examples: Array.from(value.examples).slice(0, 3),
    }))
    .sort((a, b) => b.durationMs - a.durationMs || a.module.localeCompare(b.module));
}

/** The longest segment of the chain (the earliest wins a tie). */
function longestSegment(segments: CriticalPathSegment[]): CriticalPathSegment | undefined {
  return segments.reduce<CriticalPathSegment | undefined>(
    (best, segment) => (!best || segment.durationMs > best.durationMs ? segment : best),
    undefined
  );
}

function segmentExample(segment: CriticalPathSegment): string {
  return present([segment.processName, segment.threadName, segment.blockedFunction ?? segment.slices[0]]).join(' / ');
}

// Signals below this many attributable ms raise neither an anomaly nor a
// recommendation.
const MIN_SIGNAL_MS = 2;

interface ChainSignal {
  ms: number;
  evidence: string[];
}

/**
 * Typed L3 evidence summed over the top-level chain. Anomalies and
 * recommendations read these sums, never module labels, so a keyword label
 * cannot raise a finding on its own.
 */
interface ChainSignals {
  binder: ChainSignal;
  monitor: ChainSignal;
  gc: ChainSignal;
  cpu: ChainSignal;
  /** First segment with an io_wait flag or an IO signal. */
  ioSegment: CriticalPathSegment | undefined;
}

/** One evidence label and the ms that rank it. */
interface WeightedEvidence {
  label: string;
  ms: number;
}

function collectChainSignals(segments: CriticalPathSegment[]): ChainSignals {
  const sums = segments.map(segmentSignalMs);
  // `evidenceOf` lists a segment's evidence; the three heaviest distinct
  // labels across the chain are kept.
  const signal = (
    key: keyof SegmentSignalMs,
    evidenceOf: (segment: CriticalPathSegment, ms: number) => WeightedEvidence[]
  ): ChainSignal => {
    const evidence = segments
      .flatMap((segment, index) => evidenceOf(segment, sums[index][key]))
      .sort((a, b) => b.ms - a.ms);
    return {
      ms: Math.round(sums.reduce((total, ms) => total + ms[key], 0) * 100) / 100,
      evidence: Array.from(new Set(present(evidence.map(({label}) => label)))).slice(0, 3),
    };
  };
  // A segment that carries the signal is its own evidence.
  const carrier = (segment: CriticalPathSegment, ms: number): WeightedEvidence[] =>
    ms > 0 ? [{label: segmentExample(segment), ms}] : [];
  return {
    binder: signal('binder', carrier),
    monitor: signal('monitor', carrier),
    gc: signal('gc', carrier),
    // Each competitor is evidence, ranked by its own running time.
    cpu: signal('cpu', (segment) =>
      (segment.semantics?.cpuCompetition ?? []).map((competitor) => ({
        label: `CPU ${competitor.cpu}: ${competitor.competingProcess ?? '-'} / ${competitor.competingThread ?? '-'}`,
        ms: competitor.competingDurMs,
      }))
    ),
    ioSegment: segments.find((segment) => segment.ioWait || (segment.semantics?.ioSignals.length ?? 0) > 0),
  };
}

function buildAnomalies(
  task: CriticalPathTaskInfo,
  longest: CriticalPathSegment | undefined,
  signals: ChainSignals,
  blockingMs: number
): CriticalPathAnomaly[] {
  const anomalies: CriticalPathAnomaly[] = [];
  const totalMs = task.durationMs;
  const blockingPct = pct(blockingMs, totalMs);

  if (totalMs >= 50) {
    anomalies.push({
      severity: 'critical',
      title: '选中 task 本身耗时过长',
      detail: `选中区间持续 ${totalMs.toFixed(2)} ms，已经超过 50 ms，足以造成明显交互卡顿或启动阶段长尾。`,
      evidence: [`task=${task.processName ?? '-'} / ${task.threadName ?? '-'}`, `state=${stateLabel(task.state)}`],
    });
  } else if (totalMs >= 16.67) {
    anomalies.push({
      severity: 'warning',
      title: '选中 task 超过单帧预算',
      detail: `选中区间持续 ${totalMs.toFixed(2)} ms，超过 60Hz 单帧 16.67 ms 预算。`,
      evidence: [`state=${stateLabel(task.state)}`],
    });
  }

  if (blockingPct >= 70 && blockingMs >= 8) {
    anomalies.push({
      severity: 'warning',
      title: '外部 critical path 占比过高',
      detail: `外部线程/模块贡献 ${blockingMs.toFixed(2)} ms，占选中区间 ${blockingPct.toFixed(2)}%。这通常不是单点函数慢，而是等待链或调度链拖慢。`,
      evidence: longest
        ? [`最长外部段=${longest.processName ?? '-'} / ${longest.threadName ?? '-'} ${longest.durationMs.toFixed(2)} ms`]
        : [],
    });
  }

  if (longest && longest.durationMs >= 8) {
    anomalies.push({
      severity: longest.durationMs >= 16.67 ? 'warning' : 'info',
      title: '存在长 critical path 段',
      detail: `${longest.processName ?? '-'} / ${longest.threadName ?? '-'} 在 critical path 上持续 ${longest.durationMs.toFixed(2)} ms。`,
      evidence: [...longest.modules, ...longest.reasons].slice(0, 5),
    });
  }

  const ioSegment = signals.ioSegment;
  if (ioSegment) {
    anomalies.push({
      severity: 'warning',
      title: '等待链涉及 IO/page-cache 候选',
      detail:
        'critical path 中出现 io_wait 或 kernel blocked_function 的 IO/page-cache 函数族；blocked_function 是单帧 wchan，需要结合同步读写、fsync、SQLite/WAL、page fault 或 block 层证据确认。',
      evidence: present([
        ioSegment.blockedFunction ?? ioSegment.semantics?.ioSignals[0]?.blockedFunction,
        ...ioSegment.slices,
        `${ioSegment.durationMs.toFixed(2)} ms`,
      ]),
    });
  }

  if (signals.binder.ms >= MIN_SIGNAL_MS) {
    anomalies.push({
      severity: signals.binder.ms >= 8 ? 'warning' : 'info',
      title: '等待链涉及 Binder / IPC',
      detail: `Binder / IPC 在 critical path 中累计 ${signals.binder.ms.toFixed(2)} ms，可能是跨进程服务调用、系统服务或回调链路导致。`,
      evidence: signals.binder.evidence,
    });
  }

  if (signals.monitor.ms >= MIN_SIGNAL_MS) {
    anomalies.push({
      severity: signals.monitor.ms >= 8 ? 'warning' : 'info',
      title: '等待链涉及 Java 锁竞争',
      detail: `Java monitor 锁在 critical path 中累计 ${signals.monitor.ms.toFixed(2)} ms。`,
      evidence: signals.monitor.evidence,
    });
  }

  if (signals.gc.ms >= MIN_SIGNAL_MS) {
    anomalies.push({
      severity: signals.gc.ms >= 8 ? 'warning' : 'info',
      title: 'GC 与等待链重叠',
      detail: `ART / GC 在 critical path 中累计 ${signals.gc.ms.toFixed(2)} ms，可能阻塞 mutator。`,
      evidence: signals.gc.evidence,
    });
  }

  // Only typed competition counts: a Running blocker is the thread doing the
  // work, not evidence that the chain waited for a CPU.
  if (signals.cpu.evidence.length > 0 && blockingMs >= 4) {
    anomalies.push({
      severity: 'info',
      title: '存在调度或 CPU 竞争迹象',
      detail: `可运行段等待 CPU 期间，同一 CPU 上其他线程累计运行 ${signals.cpu.ms.toFixed(2)} ms；建议结合 CPU 轨道确认是否有高优先级线程、RT 线程或大核竞争。`,
      evidence: signals.cpu.evidence,
    });
  }

  if (anomalies.length === 0) {
    anomalies.push({
      severity: 'info',
      title: '未发现明显异常',
      detail:
        '从 critical path 结果看，没有出现长外部等待、IO wait、Binder 长等待或明显 CPU 竞争信号。',
      evidence: [`选中 task=${totalMs.toFixed(2)} ms`, `外部 critical path=${blockingMs.toFixed(2)} ms`],
    });
  }

  return anomalies;
}

function buildRecommendations(
  anomalies: CriticalPathAnomaly[],
  moduleBreakdown: CriticalPathModuleStat[],
  signals: ChainSignals
): string[] {
  const recommendations: string[] = [];
  const modules = new Set(moduleBreakdown.slice(0, 4).map((item) => item.module));

  // Binder / IO / Monitor / GC follow the same typed signals as their
  // anomalies; the remaining classes have no typed source and use the
  // primary-module breakdown.
  if (signals.binder.ms >= MIN_SIGNAL_MS) {
    recommendations.push('沿 Binder / IPC 相关线程继续看调用方与被调服务，确认是否同步跨进程调用阻塞了目标线程。');
  }
  if (signals.ioSegment) {
    recommendations.push('排查选中区间附近的同步 IO、fsync、SQLite/WAL、资源加载或 block 层等待，必要时补充 ftrace block/ext4/f2fs 事件。');
  }
  if (signals.monitor.ms >= MIN_SIGNAL_MS || modules.has('锁 / Futex')) {
    recommendations.push('结合 monitor_contention_chain / futex 相关 slice 和调用栈采样，定位持锁线程以及锁竞争入口。');
  }
  if (modules.has('图形渲染 / Surface')) {
    recommendations.push('把 critical path 与 Choreographer、RenderThread、SurfaceFlinger、BufferQueue/BLAST 时间线对齐，确认卡点在 App 绘制还是系统合成。');
  }
  if (modules.has('调度 / CPU 竞争')) {
    recommendations.push('查看同一时间 CPU 轨道和线程优先级，确认是否被高优先级线程、RT 线程或频率/大小核调度影响。');
  }
  if (signals.gc.ms >= MIN_SIGNAL_MS) {
    recommendations.push('查 GC 类型与频率，关注 mark-compact GC 是否阻塞 mutator；考虑触发条件（堆压力、显式 System.gc）。');
  }

  if (recommendations.length === 0 || anomalies.some((item) => item.severity !== 'info')) {
    recommendations.push('优先从最长 critical path 段入手，而不是只看选中线程自己的 slice；等待链上的外部线程才可能是直接原因。');
  }

  return Array.from(new Set(recommendations)).slice(0, 6);
}

function buildSummary(
  task: CriticalPathTaskInfo,
  topSegment: CriticalPathSegment | undefined,
  moduleBreakdown: CriticalPathModuleStat[],
  anomalies: CriticalPathAnomaly[],
  blockingMs: number
): string {
  const topModules = moduleBreakdown
    .slice(0, 3)
    .map((item) => `${item.module} ${item.durationMs.toFixed(2)} ms`)
    .join('、');
  const highestSeverity =
    anomalies.find((item) => item.severity === 'critical') ??
    anomalies.find((item) => item.severity === 'warning');
  const lines = [
    `选中 task 位于 ${task.processName ?? '-'} / ${task.threadName ?? '-'}，状态 ${stateLabel(task.state)}，持续 ${task.durationMs.toFixed(2)} ms。`,
    `critical path 外部链路累计 ${blockingMs.toFixed(2)} ms，占 ${pct(blockingMs, task.durationMs).toFixed(2)}%。`,
  ];

  if (topSegment) {
    lines.push(
      `最长外部段是 ${topSegment.processName ?? '-'} / ${topSegment.threadName ?? '-'}，持续 ${topSegment.durationMs.toFixed(2)} ms，关联 ${topSegment.modules.join('、') || '未归类'}。`
    );
  }
  if (topModules) {
    lines.push(`主要关联模块：${topModules}。`);
  }
  if (highestSeverity) {
    lines.push(`异常判断：${highestSeverity.title}。${highestSeverity.detail}`);
  }
  if (task.waker?.threadName || task.waker?.interruptContext) {
    const waker = task.waker.interruptContext
      ? 'Interrupt'
      : `${task.waker.processName ?? '-'} / ${task.waker.threadName ?? '-'}`;
    lines.push(`直接唤醒来源：${waker}。`);
  }

  return lines.join('\n');
}

const EMPTY_ANALYSIS_TEXT: Record<
  CriticalPathUnavailableReason,
  {title: string; detail: string; recommendation: string}
> = {
  task_state_running: {
    title: 'Running 状态：无等待链可分析',
    detail:
      '选中 task 的 thread_state 是 Running —— 没有等待链可分析。建议查 callstack samples、slice 树或同时段 CPU 占用。',
    recommendation: '对于 Running 状态的选区，推荐查 perf/简单采样的 callstack、CPU 占用与频率，而非 critical path。',
  },
  no_waiting_time: {
    title: '选区内没有等待时间',
    detail:
      '选中区间内该线程没有 Sleeping / Uninterruptible / Runnable 等待状态，没有等待链可分析。建议查 callstack samples、slice 树或同时段 CPU 占用。',
    recommendation: '选区内没有等待状态；推荐查采样 callstack、CPU 占用与频率，而非 critical path。',
  },
  no_critical_path_stack: {
    title: '没有取到 critical path 等待链',
    detail:
      'Perfetto 没有返回 selected task 范围内的 critical path 等待链。常见原因是 trace 缺少 sched_wakeup / thread_state 数据，或选中区间没有可追踪的等待链。',
    recommendation:
      '确认录制配置包含 sched/sched_switch、sched/sched_wakeup、sched/sched_blocked_reason；如果只是想看整体线程链路，可改用区域选择后再分析。',
  },
};

function buildEmptyAnalysis(
  task: CriticalPathTaskInfo,
  warnings: string[],
  reason: CriticalPathUnavailableReason
): CriticalPathAnalysis {
  const text = EMPTY_ANALYSIS_TEXT[reason];
  const anomalies = [
    {
      severity: 'info' as const,
      title: text.title,
      detail: text.detail,
      evidence: [`task=${task.durationMs.toFixed(2)} ms`, `utid=${task.utid}`],
    },
  ];
  return {
    available: false,
    task,
    totalMs: task.durationMs,
    blockingMs: 0,
    selfMs: task.durationMs,
    externalBlockingPercentage: 0,
    wakeupChain: [],
    moduleBreakdown: [],
    anomalies,
    summary: buildSummary(task, undefined, [], anomalies, 0),
    recommendations: [text.recommendation],
    warnings: Array.from(new Set(warnings)),
    rawRows: 0,
    truncated: false,
    unavailableReason: reason,
  };
}

// Resolve task metadata + (when applicable) split a range selection into the
// underlying thread_state slices. Returns at least one entry; the first entry
// is the canonical task summary.
async function loadTask(
  tp: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions
): Promise<{primary: CriticalPathTaskInfo; slices: SliceFinding[]}> {
  const threadStateId = normalizeIntegerSql(
    options.threadStateId,
    'threadStateId',
    'invalid_thread_state_id'
  );
  if (threadStateId?.startsWith('-')) {
    throw new CriticalPathInputError('invalid_thread_state_id', 'threadStateId must be a non-negative integer');
  }
  if (threadStateId) {
    const rows = await queryRows(
      tp,
      traceId,
      `
      SELECT
        target.id AS thread_state_id,
        target.ts,
        target.dur,
        target.utid,
        target.state,
        target.blocked_function,
        target.io_wait,
        target.cpu,
        thread.tid,
        thread.upid AS thread_upid,
        thread.name AS thread_name,
        process.name AS process_name
      FROM thread_state AS target
      LEFT JOIN thread USING(utid)
      LEFT JOIN process USING(upid)
      WHERE target.id = ${threadStateId}
      LIMIT 1
    `
    );
    const row = rows[0];
    if (!row) {
      throw new CriticalPathInputError('thread_state_not_found', `thread_state ${threadStateId} not found`);
    }
    const dur = toNumber(row.dur);
    const startTs = toNumber(row.ts);
    const state = toOptionalString(row.state);
    const primary: CriticalPathTaskInfo = {
      threadStateId: toNumber(row.thread_state_id),
      utid: toNumber(row.utid),
      tid: toNullableNumber(row.tid),
      upid: toNullableNumber(row.thread_upid),
      startTs,
      dur,
      durationMs: nsToMs(dur),
      state,
      blockedFunction: toOptionalString(row.blocked_function),
      ioWait: toBool(row.io_wait),
      cpu: toNullableNumber(row.cpu),
      threadName: toOptionalString(row.thread_name),
      processName: toOptionalString(row.process_name),
    };
    const slice: SliceFinding = {
      threadStateId: primary.threadStateId ?? null,
      startTs,
      endTs: startTs + dur,
      durationMs: nsToMs(dur),
      state,
      kind: classifySlice(state),
      cpu: toNullableNumber(row.cpu),
      blockedFunction: toOptionalString(row.blocked_function),
      ioWait: toBool(row.io_wait),
      segmentCount: 0,
    };
    return {primary, slices: [slice]};
  }

  // Range mode: utid + startTs + dur
  const utid = normalizeIntegerSql(options.utid, 'utid');
  const startTsRaw = normalizeIntegerSql(options.startTs, 'startTs');
  const durRaw = normalizeIntegerSql(
    options.dur ??
      (options.endTs !== undefined && options.startTs !== undefined
        ? String(toNumber(options.endTs) - toNumber(options.startTs))
        : undefined),
    'dur'
  );
  if (!utid || !startTsRaw || !durRaw) {
    throw new CriticalPathInputError('missing_selector', 'threadStateId or utid/startTs/dur is required');
  }

  const taskStart = toNumber(startTsRaw);
  const taskDur = toNumber(durRaw);
  const taskEnd = taskStart + taskDur;
  if (taskDur <= 0) {
    throw new CriticalPathInputError('non_positive_duration', 'Selected task duration must be positive');
  }

  const threadRows = await queryRows(
    tp,
    traceId,
    `
    SELECT
      thread.utid,
      thread.tid,
      thread.upid AS thread_upid,
      thread.name AS thread_name,
      process.name AS process_name
    FROM thread
    LEFT JOIN process USING(upid)
    WHERE thread.utid = ${utid}
    LIMIT 1
  `
  );
  const threadRow = threadRows[0] ?? {};

  // Pull all overlapping thread_state slices to drive multi-slice splitting.
  // Half-open: a row that ends exactly at the window start (or starts exactly
  // at its end) contributes no time and is not part of the selection.
  const sliceRows = await queryRows(
    tp,
    traceId,
    `
    SELECT id, ts, dur, state, blocked_function, io_wait, cpu
    FROM thread_state
    WHERE utid = ${utid}
      AND ts < ${taskEnd}
      AND ts + dur > ${taskStart}
    ORDER BY ts ASC
  `
  );

  const slices: SliceFinding[] = sliceRows.map((row) => {
    const sliceStart = Math.max(taskStart, toNumber(row.ts));
    const sliceEnd = Math.min(taskEnd, toNumber(row.ts) + toNumber(row.dur));
    const sliceDur = Math.max(0, sliceEnd - sliceStart);
    const state = toOptionalString(row.state);
    return {
      threadStateId: toNullableNumber(row.id),
      startTs: sliceStart,
      endTs: sliceEnd,
      durationMs: nsToMs(sliceDur),
      state,
      kind: classifySlice(state),
      cpu: toNullableNumber(row.cpu),
      blockedFunction: toOptionalString(row.blocked_function),
      ioWait: toBool(row.io_wait),
      segmentCount: 0,
    };
  });

  // The task summary describes the longest waiting slice: that is what the
  // wait chain explains. A window without waiting time falls back to its
  // longest slice so the unavailable result still names the state it saw.
  const dominant = longestWaitingSlice(slices) ?? longestSlice(slices);

  const primary: CriticalPathTaskInfo = {
    utid: toNumber(utid),
    tid: toNullableNumber(threadRow.tid),
    upid: toNullableNumber(threadRow.thread_upid),
    startTs: taskStart,
    dur: taskDur,
    durationMs: nsToMs(taskDur),
    state: dominant?.state ?? null,
    blockedFunction: dominant?.blockedFunction ?? null,
    ioWait: dominant?.ioWait ?? null,
    cpu: dominant?.cpu ?? null,
    threadName: toOptionalString(threadRow.thread_name),
    processName: toOptionalString(threadRow.process_name),
  };

  return {primary, slices};
}

const WAITING_KINDS: ReadonlySet<SliceKind> = new Set<SliceKind>(['sleeping', 'uninterruptible', 'runnable']);

/** The longest slice `keep` accepts (the earliest wins a tie), or null. */
function longestSlice(
  slices: SliceFinding[],
  keep: (slice: SliceFinding) => boolean = () => true
): SliceFinding | null {
  const length = (slice: SliceFinding): number => slice.endTs - slice.startTs;
  return slices.reduce<SliceFinding | null>(
    (best, slice) => (keep(slice) && (!best || length(slice) > length(best)) ? slice : best),
    null
  );
}

/** The longest S/D/DK/R/R+ slice, or null when the slices hold no waiting time. */
function longestWaitingSlice(slices: SliceFinding[]): SliceFinding | null {
  return longestSlice(slices, (slice) => WAITING_KINDS.has(slice.kind) && slice.endTs > slice.startTs);
}

const RANGE_WAKER_HINT = 'resolved for the longest waiting slice in the window';

// L2 — the one waker resolution. Thread-state-id mode resolves the selected
// row; range mode resolves the longest waiting slice. Returns null when there
// is no row to resolve.
async function resolveTaskWaker(
  tp: TraceProcessorService,
  traceId: string,
  task: CriticalPathTaskInfo,
  slices: SliceFinding[]
): Promise<WakerChainResult | null> {
  if (typeof task.threadStateId === 'number') {
    return resolveDirectWaker(tp, traceId, {threadStateId: task.threadStateId});
  }
  const dominantWait = longestWaitingSlice(slices);
  if (dominantWait?.threadStateId === null || dominantWait?.threadStateId === undefined) return null;
  const result = await resolveDirectWaker(tp, traceId, {threadStateId: dominantWait.threadStateId});
  if (result.hop) result.hop.hints.push(RANGE_WAKER_HINT);
  return result;
}

// `task.waker` predates `directWaker`; it is derived from the same hop so the
// two can never disagree.
function taskWakerOf(hop: WakerHop | null): NonNullable<CriticalPathTaskInfo['waker']> {
  return {
    threadStateId: hop?.threadStateId ?? null,
    utid: hop?.utid ?? null,
    threadName: hop?.threadName ?? null,
    processName: hop?.processName ?? null,
    state: hop?.state ?? null,
    interruptContext: hop ? hop.irqContext : null,
  };
}

// Shared budget counter — passed by reference so parallel sibling fetches
// at the same recursion level see each other's increments.
interface BudgetRef {
  consumed: number;
}

interface RecursionContext {
  visited: Set<string>;
  depthLimit: number;
  segmentBudget: number;
  // Counts child segments produced by recursion only; the top-level chain is
  // not charged, so a long chain still recurses.
  budget: BudgetRef;
  // The analysis' own warning list, shared across levels; skipped or failed
  // expansions are reported, never silent.
  warnings: string[];
}

async function fetchCriticalPathStack(
  tp: TraceProcessorService,
  traceId: string,
  utid: number,
  startTs: number,
  dur: number,
  maxRows: number
): Promise<{rows: CriticalPathStackRow[]; raw: number; truncated: boolean}> {
  const rows = await queryRows(
    tp,
    traceId,
    `
    SELECT
      cr.ts,
      cr.dur,
      cr.utid,
      cr.name,
      cr.table_name,
      thread.name AS thread_name,
      process.name AS process_name
    FROM _critical_path_stack(${Math.trunc(utid)}, ${Math.trunc(startTs)}, ${Math.trunc(dur)}, 1, 1, 0, 1) AS cr
    LEFT JOIN thread USING(utid)
    LEFT JOIN process USING(upid)
    WHERE cr.name IS NOT NULL
      AND cr.utid != cr.root_utid
    ORDER BY cr.ts ASC, cr.stack_depth ASC, cr.utid ASC
    LIMIT ${Math.trunc(maxRows) + 1}
  `
  );
  const truncated = rows.length > maxRows;
  return {
    rows: normalizeStackRows(truncated ? rows.slice(0, maxRows) : rows),
    raw: rows.length,
    truncated,
  };
}

function pickRecursionTargets(
  segments: CriticalPathSegment[],
  ctx: RecursionContext
): CriticalPathSegment[] {
  const candidates = [...segments].sort((a, b) => b.durationMs - a.durationMs);
  const picks: CriticalPathSegment[] = [];
  for (const segment of candidates) {
    if (picks.length >= 3) break;
    if (segment.durationMs < 4) break;
    const key = `${segment.utid}|${segment.startTs}|${segment.dur}`;
    if (ctx.visited.has(key)) continue;
    if (ctx.budget.consumed >= ctx.segmentBudget) {
      ctx.warnings.push(
        `critical path recursion stopped at the segment budget (${ctx.segmentBudget}); some long segments were not expanded`
      );
      break;
    }
    picks.push(segment);
  }
  return picks;
}

async function recurseCriticalPath(
  tp: TraceProcessorService,
  traceId: string,
  segments: CriticalPathSegment[],
  ctx: RecursionContext,
  maxRowsPerCall: number
): Promise<void> {
  if (ctx.depthLimit <= 0) return;
  const targets = pickRecursionTargets(segments, ctx);
  // Reserve dedup keys upfront so concurrent siblings don't both walk the same node.
  for (const target of targets) {
    ctx.visited.add(`${target.utid}|${target.startTs}|${target.dur}`);
  }

  // Fetch siblings at this level concurrently — they share `ctx.visited` and
  // `ctx.budget` (BudgetRef) but have no dependency on one another's results.
  const fetched = await Promise.all(
    targets.map((target) =>
      fetchCriticalPathStack(tp, traceId, target.utid, target.startTs, target.dur, maxRowsPerCall).then(
        (stack) => ({target, stack}),
        (error: unknown) => {
          const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
          ctx.warnings.push(`critical path recursion failed for utid ${target.utid}: ${message}`);
          return {target, stack: null};
        }
      )
    )
  );

  const recursionFollowups: Array<Promise<void>> = [];
  for (const {target, stack} of fetched) {
    if (!stack) continue;
    const childTask: CriticalPathTaskInfo = {
      utid: target.utid,
      tid: target.tid ?? null,
      upid: target.upid ?? null,
      startTs: target.startTs,
      dur: target.dur,
      durationMs: target.durationMs,
      state: target.state,
      threadName: target.threadName,
      processName: target.processName,
    };
    const children = mergeAdjacentSegments(buildSegments(stack.rows, childTask));
    if (children.length === 0) continue;

    target.children = children;
    target.recursionDepth = (target.recursionDepth ?? 0) + 1;
    ctx.budget.consumed += children.length;

    // The next level checks the budget itself, so an exhausted budget is
    // reported there rather than silently skipped here.
    recursionFollowups.push(
      recurseCriticalPath(tp, traceId, children, {...ctx, depthLimit: ctx.depthLimit - 1}, maxRowsPerCall)
    );
  }

  await Promise.all(recursionFollowups);
}

/** The segment's entity + window, in the shape `segmentKeyOf` and L3 inputs use. */
function segmentWindow(segment: CriticalPathSegment): {utid: number; startTs: number; endTs: number} {
  return {utid: segment.utid, startTs: segment.startTs, endTs: segment.startTs + segment.dur};
}

function applySemanticsToSegments(
  segments: CriticalPathSegment[],
  semantics: Map<string, SegmentSemantics>
): void {
  for (const segment of segments) {
    const sem = semantics.get(segmentKeyOf(segmentWindow(segment)));
    if (!sem) continue;
    segment.semantics = sem;
    const semModules = modulesFromSemantics(segment);
    if (semModules.length > 0) {
      // A stdlib signal replaces the keyword fallback outright.
      segment.modules = semModules;
    }
    // Push concrete reasons from semantics.
    for (const txn of sem.binderTxns.slice(0, 2)) {
      const label = `binder: ${txn.serverProcess ?? '-'} ${txn.methodName ?? ''}`.trim();
      segment.reasons = Array.from(new Set([...segment.reasons, label])).slice(0, 8);
    }
    for (const mc of sem.monitorContention.slice(0, 2)) {
      const label = `lock: ${mc.shortBlockingMethod ?? '-'}`;
      segment.reasons = Array.from(new Set([...segment.reasons, label])).slice(0, 8);
    }
    if (sem.gcEvents.length > 0) {
      segment.reasons = Array.from(new Set([...segment.reasons, 'GC event in window'])).slice(0, 8);
    }
    if (sem.cpuCompetition.length > 0) {
      segment.reasons = Array.from(new Set([...segment.reasons, `cpu ${sem.cpuCompetition[0].cpu} competition`])).slice(0, 8);
    }
  }
}

export async function analyzeCriticalPath(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions = {}
): Promise<CriticalPathAnalysis> {
  const {primary: task, slices} = await loadTask(traceProcessorService, traceId, options);
  const maxSegments = normalizePositiveInt(options.maxSegments, 160, 20, 1000);
  const recursionDepth = normalizePositiveInt(options.recursionDepth, 2, 0, 2);
  const recursionEnabled = options.recursionEnabled !== false;
  const segmentBudget = normalizePositiveInt(options.segmentBudget, 16, 4, 32);
  const warnings: string[] = [];

  if (task.dur <= 0) {
    throw new CriticalPathInputError('non_positive_duration', 'Selected task duration must be positive');
  }

  // L1 dispatch on waiting time, not on the longest slice: a window whose
  // longest slice is Running can still spend most of its time waiting.
  if (typeof task.threadStateId === 'number') {
    if (slices.every((slice) => slice.kind === 'running')) {
      return {...buildEmptyAnalysis(task, warnings, 'task_state_running'), slices};
    }
  } else if (longestWaitingSlice(slices) === null) {
    return {...buildEmptyAnalysis(task, warnings, 'no_waiting_time'), slices};
  }

  // L2 — direct waker, resolved before the stack so an empty chain still
  // reports who woke the task.
  const wakerResult = await resolveTaskWaker(traceProcessorService, traceId, task, slices);
  const directWaker = wakerResult?.hop ?? null;
  if (wakerResult) {
    task.waker = taskWakerOf(wakerResult.hop);
    warnings.push(...wakerResult.warnings);
  }

  assertQuerySucceeded(
    await traceProcessorService.query(
      traceId,
      'INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;'
    )
  );

  // Self rows are excluded in SQL (enable_self_slice = 0 and the root filter),
  // so the row limit counts only rows that describe external segments.
  const maxRows = maxSegments * 20;
  const stack = await fetchCriticalPathStack(
    traceProcessorService,
    traceId,
    task.utid,
    task.startTs,
    task.dur,
    maxRows
  );

  // `chain` is the whole merged chain: totals, breakdown, anomalies and the
  // counterfactual are computed on it. `segments` is the displayed prefix.
  const chain = mergeAdjacentSegments(buildSegments(stack.rows, task));
  const segments = chain.slice(0, maxSegments);
  const truncated = stack.truncated || chain.length > maxSegments;
  if (stack.truncated) {
    warnings.push(
      `critical path 结果超过 ${maxRows} 行上限，已截断为前 ${chain.length} 个链路段（展示前 ${segments.length} 个）；阻塞时长、模块占比与反事实估计只覆盖截断前的部分。`
    );
  } else if (chain.length > maxSegments) {
    warnings.push(
      `critical path 共 ${chain.length} 个链路段，仅展示前 ${segments.length} 个；阻塞时长、模块占比与反事实估计按完整链路计算。`
    );
  }

  if (segments.length === 0) {
    return {
      ...buildEmptyAnalysis(task, warnings, 'no_critical_path_stack'),
      slices,
      directWaker,
    };
  }

  // L4 — recursion fans out into _critical_path_stack calls on external segments.
  if (recursionEnabled && recursionDepth > 0) {
    await recurseCriticalPath(
      traceProcessorService,
      traceId,
      segments,
      {
        visited: new Set([`${task.utid}|${task.startTs}|${task.dur}`]),
        depthLimit: recursionDepth,
        segmentBudget,
        budget: {consumed: 0},
        warnings,
      },
      maxSegments * 5
    );
  }

  // L3 — Semantic enrichment for ALL segments (whole top-level chain +
  // recursed children of the displayed prefix).
  const flatSegments: CriticalPathSegment[] = [];
  const collectFlat = (list: CriticalPathSegment[]): void => {
    for (const segment of list) {
      flatSegments.push(segment);
      if (segment.children) collectFlat(segment.children);
    }
  };
  collectFlat(chain);

  // Batch the tid/upid lookup into a single SQL query (replaces the previous
  // per-segment N+1 SELECT). All segments needing resolution share one round trip.
  const segmentsNeedingThreadInfo = flatSegments.filter(
    (segment) => segment.tid === null || segment.tid === undefined || segment.upid === null || segment.upid === undefined
  );
  let threadLookupFailed = false;
  if (segmentsNeedingThreadInfo.length > 0) {
    const utidSet = new Set(segmentsNeedingThreadInfo.map((segment) => segment.utid));
    const utidList = Array.from(utidSet).join(', ');
    try {
      const rows = await queryRows(
        traceProcessorService,
        traceId,
        `SELECT utid, tid, upid FROM thread WHERE utid IN (${utidList})`
      );
      const map = new Map<number, {tid: number | null; upid: number | null}>();
      for (const row of rows) {
        const utid = toNullableNumber(row.utid);
        if (utid === null) continue;
        map.set(utid, {tid: toNullableNumber(row.tid), upid: toNullableNumber(row.upid)});
      }
      for (const segment of segmentsNeedingThreadInfo) {
        const info = map.get(segment.utid);
        if (info) {
          segment.tid = info.tid;
          segment.upid = info.upid;
        } else {
          segment.tid = null;
          segment.upid = null;
        }
      }
    } catch {
      // tid/upid stay null. Without upids an empty GC result would read as
      // "no GC", so L3 reports the GC source as not checked instead.
      threadLookupFailed = true;
      warnings.push('thread tid/upid lookup failed; GC evidence not checked');
    }
  }

  const semanticInputs: SemanticSegmentInput[] = flatSegments.map((segment) => ({
    ...segmentWindow(segment),
    tid: segment.tid ?? null,
    upid: segment.upid ?? null,
    state: segment.state ?? null,
  }));

  const enrichment = await enrichSegmentsWithSemantics(
    traceProcessorService,
    traceId,
    semanticInputs,
    {threadLookupFailed}
  );
  applySemanticsToSegments(flatSegments, enrichment.segments);
  warnings.push(...enrichment.warnings);

  const blockingMs =
    Math.round(chain.reduce((sum, segment) => sum + segment.durationMs, 0) * 100) / 100;
  const selfMs = Math.max(0, Math.round((task.durationMs - blockingMs) * 100) / 100);
  const moduleBreakdown = buildModuleBreakdown(chain, task.durationMs);
  const signals = collectChainSignals(chain);
  const longest = longestSegment(chain);
  const anomalies = buildAnomalies(task, longest, signals, blockingMs);
  const recommendations = buildRecommendations(anomalies, moduleBreakdown, signals);

  // L5 — Quantification.
  const quantification = await quantifyCriticalPath(
    traceProcessorService,
    traceId,
    {
      upid: task.upid ?? null,
      startTs: task.startTs,
      endTs: task.startTs + task.dur,
      durMs: task.durationMs,
    },
    chain.map((segment): QuantifySegmentInput => ({
      segmentKey: segmentKeyOf(segmentWindow(segment)),
      durMs: segment.durationMs,
    })),
    flatSegments.map((segment) => segment.semantics).filter((sem): sem is SegmentSemantics => sem !== undefined)
  );
  warnings.push(...quantification.warnings);

  return {
    available: true,
    task,
    totalMs: task.durationMs,
    blockingMs,
    selfMs,
    externalBlockingPercentage: pct(blockingMs, task.durationMs),
    wakeupChain: segments,
    moduleBreakdown,
    anomalies,
    summary: buildSummary(task, longest, moduleBreakdown, anomalies, blockingMs),
    recommendations,
    warnings: Array.from(new Set(warnings)),
    rawRows: stack.raw,
    truncated,
    slices,
    directWaker,
    quantification,
    semanticSources: enrichment.sources,
  };
}
