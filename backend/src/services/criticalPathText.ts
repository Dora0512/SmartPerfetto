// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The critical-path text catalog. The engine records stable ids with numeric or
// trace-data parameters; every sentence a user reads is rendered here, at the
// edge, through `localize`. Nothing parses rendered text back into data, so a
// new id without text in both languages is a type error, not a silent mix of
// languages.

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';

export const CRITICAL_PATH_MODULE_IDS = [
  'binder_ipc',
  'lock_futex',
  'io_candidate',
  'sched_cpu',
  'graphics_surface',
  'input',
  'art_gc',
  'kernel_irq',
  'power_wakeup',
  'lock_monitor',
  'io_filesystem',
  'network_receive_candidate',
  'worker_handoff',
  'unclassified',
] as const;
export type CriticalPathModuleId = (typeof CRITICAL_PATH_MODULE_IDS)[number];

const MODULE_TEXT: Record<CriticalPathModuleId, [zh: string, en: string]> = {
  binder_ipc: ['Binder / IPC', 'Binder / IPC'],
  lock_futex: ['锁 / Futex', 'Locks / Futex'],
  io_candidate: ['IO / 页缓存 / 文件系统候选', 'I/O / Page cache / File-system candidate'],
  sched_cpu: ['调度 / CPU 竞争', 'Scheduling / CPU contention'],
  graphics_surface: ['图形渲染 / Surface', 'Graphics / Surface'],
  input: ['输入链路', 'Input pipeline'],
  art_gc: ['ART / GC', 'ART / GC'],
  kernel_irq: ['Kernel / IRQ / Workqueue', 'Kernel / IRQ / Workqueue'],
  power_wakeup: ['电源 / 唤醒', 'Power / Wakeup'],
  lock_monitor: ['锁 / Monitor', 'Locks / Monitor'],
  io_filesystem: ['IO / 文件系统', 'I/O / File system'],
  network_receive_candidate: ['网络收包等待候选', 'Network-receive wait candidate'],
  worker_handoff: ['worker 交接等待', 'Worker hand-off wait'],
  unclassified: ['未归类', 'Unclassified'],
};

export function moduleText(id: CriticalPathModuleId, language: OutputLanguage): string {
  const [zh, en] = MODULE_TEXT[id];
  return localize(language, zh, en);
}

export type TextParams = Readonly<Record<string, string | number | boolean | null>>;

/** A product-authored message: a stable code plus the values it quotes. */
export interface CriticalPathTextCode<C extends string = string> {
  code: C;
  params?: TextParams;
}

const str = (params: TextParams | undefined, key: string): string => {
  const value = params?.[key];
  return value === undefined || value === null ? '-' : String(value);
};
const ms = (params: TextParams | undefined, key: string): string => {
  const value = Number(params?.[key] ?? 0);
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
};

// ── States ──────────────────────────────────────────────────────────────────

const STATE_TEXT: Record<string, [zh: string, en: string]> = {
  R: ['可运行', 'Runnable'],
  'R+': ['可运行（被抢占）', 'Runnable + Preempted'],
  S: ['睡眠', 'Sleeping'],
  D: ['不可中断睡眠', 'Uninterruptible Sleep'],
  T: ['已停止', 'Stopped'],
  t: ['被跟踪', 'Traced'],
  X: ['已退出', 'Exit Dead'],
  Z: ['僵尸', 'Zombie'],
  I: ['空闲', 'Idle'],
  K: ['唤醒终止', 'Wake Kill'],
  W: ['唤醒中', 'Waking'],
  P: ['停驻', 'Parked'],
  Running: ['运行中', 'Running'],
};

/** A thread_state state, spelled for the reader; unknown codes pass through. */
export function stateText(state: string | null | undefined, language: OutputLanguage): string {
  if (!state) return localize(language, '未知状态', 'Unknown state');
  const entry = STATE_TEXT[state] ?? STATE_TEXT[state[0]];
  return entry ? localize(language, entry[0], entry[1]) : state;
}

// ── Wait classes ────────────────────────────────────────────────────────────

const WAIT_CLASS_TEXT: Record<string, [zh: string, en: string]> = {
  network_receive_candidate: ['网络收包候选', 'network-receive candidate'],
  timer_or_device_wake: ['定时器或设备唤醒', 'timer or device wake'],
  worker_handoff: ['线程交接', 'worker hand-off'],
  binder_reply: ['Binder 回复', 'binder reply'],
  system_service: ['系统服务唤醒', 'system service'],
  unknown: ['未知', 'unknown'],
};

export function waitClassText(waitClass: string, language: OutputLanguage): string {
  const entry = WAIT_CLASS_TEXT[waitClass];
  return entry ? localize(language, entry[0], entry[1]) : waitClass;
}

// ── Segment reasons ─────────────────────────────────────────────────────────

/** Why a segment is labelled what it is; `slice` and `kernel_function` are trace data. */
export type CriticalPathReason =
  | {kind: 'state'; state: string}
  | {kind: 'kernel_function'; name: string}
  | {kind: 'io_wait'}
  | {kind: 'cpu'; cpu: number | null}
  | {kind: 'slice'; name: string}
  | {kind: 'binder'; process: string | null; method: string | null}
  | {kind: 'lock'; method: string | null}
  | {kind: 'gc_in_window'}
  | {kind: 'cpu_competition'; cpu: number}
  | {kind: 'wake_class'; waitClass: string};

export function reasonText(reason: CriticalPathReason, language: OutputLanguage): string {
  switch (reason.kind) {
    case 'state':
      return stateText(reason.state, language);
    case 'kernel_function':
    case 'slice':
      return reason.name;
    case 'io_wait':
      return 'io_wait';
    case 'cpu':
      return `CPU ${reason.cpu ?? '-'}`;
    case 'binder':
      return `binder: ${reason.process ?? '-'} ${reason.method ?? ''}`.trim();
    case 'lock':
      return `lock: ${reason.method ?? '-'}`;
    case 'gc_in_window':
      return localize(language, '窗口内有 GC 事件', 'GC event in window');
    case 'cpu_competition':
      return localize(language, `CPU ${reason.cpu} 竞争`, `cpu ${reason.cpu} competition`);
    case 'wake_class':
      return localize(
        language,
        `唤醒来源：${waitClassText(reason.waitClass, language)}`,
        `wake: ${waitClassText(reason.waitClass, language)}`,
      );
  }
}

/** Stable identity of a reason, for de-duplication. */
export function reasonKey(reason: CriticalPathReason): string {
  return JSON.stringify(reason);
}

// ── Anomaly evidence ────────────────────────────────────────────────────────

export type CriticalPathEvidence =
  | {kind: 'text'; text: string}
  | {kind: 'task'; process: string | null; thread: string | null}
  | {kind: 'state'; state: string | null}
  | {kind: 'longest_segment'; process: string | null; thread: string | null; ms: number}
  | {kind: 'duration'; ms: number}
  | {kind: 'selected_task'; ms: number}
  | {kind: 'external_path'; ms: number}
  | {kind: 'task_duration'; ms: number}
  | {kind: 'utid'; utid: number}
  | {kind: 'module'; id: CriticalPathModuleId}
  | {kind: 'reason'; reason: CriticalPathReason};

export function evidenceText(item: CriticalPathEvidence, language: OutputLanguage): string {
  switch (item.kind) {
    case 'text':
      return item.text;
    case 'task':
      return `task=${item.process ?? '-'} / ${item.thread ?? '-'}`;
    case 'state':
      return `state=${stateText(item.state, language)}`;
    case 'longest_segment':
      return localize(
        language,
        `最长外部段=${item.process ?? '-'} / ${item.thread ?? '-'} ${item.ms.toFixed(2)} ms`,
        `longest external segment=${item.process ?? '-'} / ${item.thread ?? '-'} ${item.ms.toFixed(2)} ms`,
      );
    case 'duration':
      return `${item.ms.toFixed(2)} ms`;
    case 'selected_task':
      return localize(language, `选中 task=${item.ms.toFixed(2)} ms`, `selected task=${item.ms.toFixed(2)} ms`);
    case 'external_path':
      return localize(language, `外部 critical path=${item.ms.toFixed(2)} ms`, `external critical path=${item.ms.toFixed(2)} ms`);
    case 'task_duration':
      return `task=${item.ms.toFixed(2)} ms`;
    case 'utid':
      return `utid=${item.utid}`;
    case 'module':
      return moduleText(item.id, language);
    case 'reason':
      return reasonText(item.reason, language);
  }
}

// ── Anomalies ───────────────────────────────────────────────────────────────

export const CRITICAL_PATH_ANOMALY_IDS = [
  'task_too_long',
  'task_over_frame_budget',
  'external_share_high',
  'long_segment',
  'io_candidate',
  'network_receive_wait',
  'worker_handoff_wait',
  'binder_ipc',
  'java_monitor',
  'gc_overlap',
  'cpu_contention',
  'no_clear_anomaly',
  'task_state_running',
  'no_waiting_time',
  'no_critical_path_stack',
] as const;
export type CriticalPathAnomalyId = (typeof CRITICAL_PATH_ANOMALY_IDS)[number];

type Render = (params: TextParams | undefined, language: OutputLanguage) => string;
const fixed = (zh: string, en: string): Render => (_params, language) => localize(language, zh, en);

const ANOMALY_TEXT: Record<CriticalPathAnomalyId, {title: Render; detail: Render}> = {
  task_too_long: {
    title: fixed('选中 task 本身耗时过长', 'The selected task is too long'),
    detail: (p, l) => localize(
      l,
      `选中区间持续 ${ms(p, 'ms')} ms，已经超过 50 ms，足以造成明显交互卡顿或启动阶段长尾。`,
      `The selected range lasts ${ms(p, 'ms')} ms, exceeding 50 ms and long enough to cause visible interaction jank or a startup tail.`,
    ),
  },
  task_over_frame_budget: {
    title: fixed('选中 task 超过单帧预算', 'The selected task exceeds the frame budget'),
    detail: (p, l) => localize(
      l,
      `选中区间持续 ${ms(p, 'ms')} ms，超过 60Hz 单帧 16.67 ms 预算。`,
      `The selected range lasts ${ms(p, 'ms')} ms, exceeding the 16.67 ms frame budget at 60 Hz.`,
    ),
  },
  external_share_high: {
    title: fixed('外部 critical path 占比过高', 'External critical-path share is high'),
    detail: (p, l) => localize(
      l,
      `外部线程/模块贡献 ${ms(p, 'ms')} ms，占选中区间 ${ms(p, 'percent')}%。这通常不是单点函数慢，而是等待链或调度链拖慢。`,
      `External threads or modules contribute ${ms(p, 'ms')} ms (${ms(p, 'percent')}% of the selected range), indicating a wait or scheduling chain rather than one slow function.`,
    ),
  },
  long_segment: {
    title: fixed('存在长 critical path 段', 'A long critical-path segment exists'),
    detail: (p, l) => localize(
      l,
      `${str(p, 'process')} / ${str(p, 'thread')} 在 critical path 上持续 ${ms(p, 'ms')} ms。`,
      `${str(p, 'process')} / ${str(p, 'thread')} remains on the critical path for ${ms(p, 'ms')} ms.`,
    ),
  },
  io_candidate: {
    title: fixed('等待链涉及 IO/page-cache 候选', 'The wait chain contains an I/O or page-cache candidate'),
    detail: fixed(
      'critical path 中出现 io_wait 或 kernel blocked_function 的 IO/page-cache 函数族；blocked_function 是单帧 wchan，需要结合同步读写、fsync、SQLite/WAL、page fault 或 block 层证据确认。',
      'The critical path contains io_wait or an I/O/page-cache kernel blocked-function family. A blocked_function is a single-frame wchan; confirm it with synchronous read/write, fsync, SQLite/WAL, page-fault, or block-layer evidence.',
    ),
  },
  network_receive_wait: {
    title: fixed('等待链涉及网络收包等待候选', 'The wait chain contains a network-receive wait candidate'),
    detail: fixed(
      'critical path 中有 S 态等待由 irq 上下文唤醒，且等待线程是网络角色。Android 只对 D 态发 sched_blocked_reason，S 态没有 blocked_function，irq 唤醒同样可能是定时器到期；要确认为收包，需要 rx 包时间相关或网络库请求埋点。',
      'The critical path contains an S-state wait ended by an IRQ-context wake on a network-role thread. Android emits sched_blocked_reason only for D state, so an S-state wait has no blocked_function, and an IRQ-context wake is equally a timer expiry. Confirm a receive with rx-packet correlation or network-library request instrumentation.',
    ),
  },
  worker_handoff_wait: {
    title: fixed('等待链涉及 worker 交接等待', 'The wait chain contains a worker hand-off wait'),
    detail: fixed(
      'critical path 中有 S 态等待由同进程线程唤醒，属于线程间交接。交接本身不说明谁慢，需要看上游线程在这段等待里做了什么。',
      'The critical path contains an S-state wait ended by another thread in the same process, which is a hand-off. A hand-off does not say who was slow; inspect what the upstream thread did during the wait.',
    ),
  },
  binder_ipc: {
    title: fixed('等待链涉及 Binder / IPC', 'The wait chain contains Binder / IPC'),
    detail: (p, l) => localize(
      l,
      `Binder / IPC 在 critical path 中累计 ${ms(p, 'ms')} ms，可能是跨进程服务调用、系统服务或回调链路导致。`,
      `Binder / IPC contributes ${ms(p, 'ms')} ms on the critical path, possibly from a cross-process service call, system service, or callback chain.`,
    ),
  },
  java_monitor: {
    title: fixed('等待链涉及 Java 锁竞争', 'The wait chain contains Java lock contention'),
    detail: (p, l) => localize(
      l,
      `Java monitor 锁在 critical path 中累计 ${ms(p, 'ms')} ms。`,
      `Java monitor contention contributes ${ms(p, 'ms')} ms on the critical path.`,
    ),
  },
  gc_overlap: {
    title: fixed('GC 与等待链重叠', 'GC overlaps the wait chain'),
    detail: (p, l) => localize(
      l,
      `ART / GC 在 critical path 中累计 ${ms(p, 'ms')} ms，可能阻塞 mutator。`,
      `ART / GC contributes ${ms(p, 'ms')} ms on the critical path and may block mutators.`,
    ),
  },
  cpu_contention: {
    title: fixed('存在调度或 CPU 竞争迹象', 'Scheduling or CPU contention is indicated'),
    detail: (p, l) => localize(
      l,
      `可运行段等待 CPU 期间，同一 CPU 上其他线程累计运行 ${ms(p, 'ms')} ms；建议结合 CPU 轨道确认是否有高优先级线程、RT 线程或大核竞争。`,
      `While runnable segments waited for a CPU, other threads ran on the same CPU for ${ms(p, 'ms')} ms. Check CPU tracks for high-priority threads, RT threads, or big-core contention.`,
    ),
  },
  no_clear_anomaly: {
    title: fixed('未发现明显异常', 'No clear anomaly was found'),
    detail: fixed(
      '从 critical path 结果看，没有出现长外部等待、IO wait、Binder 长等待或明显 CPU 竞争信号。',
      'The critical path shows no long external wait, I/O wait, long Binder wait, or clear CPU-contention signal.',
    ),
  },
  task_state_running: {
    title: fixed('Running 状态：无等待链可分析', 'Running state: no wait chain to analyze'),
    detail: fixed(
      '选中 task 的 thread_state 是 Running —— 没有等待链可分析。建议查 callstack samples、slice 树或同时段 CPU 占用。',
      'The selected task is Running, so there is no wait chain to analyze. Inspect sampled call stacks, the slice tree, or CPU utilization at the same time.',
    ),
  },
  no_waiting_time: {
    title: fixed('选区内没有等待时间', 'The selection contains no waiting time'),
    detail: fixed(
      '选中区间内该线程没有 Sleeping / Uninterruptible / Runnable 等待状态，没有等待链可分析。建议查 callstack samples、slice 树或同时段 CPU 占用。',
      'The thread has no Sleeping, Uninterruptible, or Runnable time in the selected range, so there is no wait chain to analyze. Inspect sampled call stacks, the slice tree, or CPU utilization at the same time.',
    ),
  },
  no_critical_path_stack: {
    title: fixed('没有取到 critical path 等待链', 'No critical-path wait chain was found'),
    detail: fixed(
      'Perfetto 没有返回 selected task 范围内的 critical path 等待链。常见原因是 trace 缺少 sched_wakeup / thread_state 数据，或选中区间没有可追踪的等待链。',
      'Perfetto returned no critical-path wait chain for the selected task. The trace may lack sched_wakeup or thread_state data, or the selected range may have no traceable wait chain.',
    ),
  },
};

export function anomalyText(
  id: CriticalPathAnomalyId,
  params: TextParams | undefined,
  language: OutputLanguage,
): {title: string; detail: string} {
  const text = ANOMALY_TEXT[id];
  return {title: text.title(params, language), detail: text.detail(params, language)};
}

// ── Recommendations ─────────────────────────────────────────────────────────

export const CRITICAL_PATH_RECOMMENDATION_IDS = [
  'follow_binder',
  'inspect_io',
  'inspect_locks',
  'align_rendering',
  'inspect_scheduling',
  'inspect_gc',
  'start_longest_segment',
  'running_selection',
  'no_waiting_selection',
  'record_sched_events',
] as const;
export type CriticalPathRecommendationId = (typeof CRITICAL_PATH_RECOMMENDATION_IDS)[number];

const RECOMMENDATION_TEXT: Record<CriticalPathRecommendationId, [zh: string, en: string]> = {
  follow_binder: [
    '沿 Binder / IPC 相关线程继续看调用方与被调服务，确认是否同步跨进程调用阻塞了目标线程。',
    'Follow Binder / IPC threads to the caller and target service to determine whether a synchronous cross-process call blocked the target thread.',
  ],
  inspect_io: [
    '排查选中区间附近的同步 IO、fsync、SQLite/WAL、资源加载或 block 层等待，必要时补充 ftrace block/ext4/f2fs 事件。',
    'Inspect synchronous I/O, fsync, SQLite/WAL, resource loading, and block-layer waits near the selected range; record ftrace block/ext4/f2fs events if needed.',
  ],
  inspect_locks: [
    '结合 monitor_contention_chain / futex 相关 slice 和调用栈采样，定位持锁线程以及锁竞争入口。',
    'Use monitor_contention_chain, futex slices, and sampled call stacks to identify the lock owner and contention entry point.',
  ],
  align_rendering: [
    '把 critical path 与 Choreographer、RenderThread、SurfaceFlinger、BufferQueue/BLAST 时间线对齐，确认卡点在 App 绘制还是系统合成。',
    'Align the critical path with Choreographer, RenderThread, SurfaceFlinger, and BufferQueue/BLAST to determine whether the bottleneck is app rendering or system composition.',
  ],
  inspect_scheduling: [
    '查看同一时间 CPU 轨道和线程优先级，确认是否被高优先级线程、RT 线程或频率/大小核调度影响。',
    'Inspect CPU tracks and thread priorities at the same time to check for high-priority or RT-thread contention, frequency limits, or core-placement effects.',
  ],
  inspect_gc: [
    '查 GC 类型与频率，关注 mark-compact GC 是否阻塞 mutator；考虑触发条件（堆压力、显式 System.gc）。',
    'Inspect GC type and frequency, especially whether mark-compact GC blocked mutators and whether heap pressure or explicit System.gc triggered it.',
  ],
  start_longest_segment: [
    '优先从最长 critical path 段入手，而不是只看选中线程自己的 slice；等待链上的外部线程才可能是直接原因。',
    'Start with the longest critical-path segment instead of only the selected thread; an external thread on the wait chain may be the direct cause.',
  ],
  running_selection: [
    '对于 Running 状态的选区，推荐查 perf/简单采样的 callstack、CPU 占用与频率，而非 critical path。',
    'For a Running selection, inspect sampled call stacks, CPU utilization, and frequency instead of a critical path.',
  ],
  no_waiting_selection: [
    '选区内没有等待状态；推荐查采样 callstack、CPU 占用与频率，而非 critical path。',
    'The selection has no waiting state; inspect sampled call stacks, CPU utilization, and frequency instead of a critical path.',
  ],
  record_sched_events: [
    '确认录制配置包含 sched/sched_switch、sched/sched_wakeup、sched/sched_blocked_reason；如果只是想看整体线程链路，可改用区域选择后再分析。',
    'Ensure the trace includes sched/sched_switch, sched/sched_wakeup, and sched/sched_blocked_reason; use a range selection to inspect an overall thread chain.',
  ],
};

export function recommendationText(id: CriticalPathRecommendationId, language: OutputLanguage): string {
  const [zh, en] = RECOMMENDATION_TEXT[id];
  return localize(language, zh, en);
}

// ── Warnings and hints ──────────────────────────────────────────────────────

export const CRITICAL_PATH_WARNING_CODES = [
  'chain_cut',
  'display_cut',
  'recursion_budget',
  'recursion_failed',
  'recursion_cut',
  'invalid_thread_state_id',
  'waker_query_failed',
  'thread_state_not_found',
  'no_recorded_waker',
  'include_failed',
  'stdlib_table_missing',
  'schema_mismatch',
  'query_failed',
  'loader_row_cap',
  'frames_include_failed',
  'frame_query_failed',
] as const;
export type CriticalPathWarningCode = (typeof CRITICAL_PATH_WARNING_CODES)[number];
export type CriticalPathWarning = CriticalPathTextCode<CriticalPathWarningCode>;

const WARNING_TEXT: Record<CriticalPathWarningCode, Render> = {
  chain_cut: (p, l) => localize(
    l,
    `critical path 超过 ${str(p, 'cap')} 个原始链路段上限，已截断（合并后 ${str(p, 'merged')} 段，展示前 ${str(p, 'shown')} 段）；阻塞时长、模块占比与反事实估计只覆盖截断前的部分。`,
    `The critical path exceeded the ${str(p, 'cap')} stack-segment limit and was cut (${str(p, 'merged')} segments once merged, ${str(p, 'shown')} shown); blocking time, module shares and the counterfactual cover only the part before the cut.`,
  ),
  display_cut: (p, l) => localize(
    l,
    `critical path 共 ${str(p, 'total')} 个链路段，仅展示前 ${str(p, 'shown')} 个；阻塞时长、模块占比与反事实估计按完整链路计算。`,
    `The critical path has ${str(p, 'total')} chain segments; only the first ${str(p, 'shown')} are shown. Blocking time, module shares and the counterfactual cover the full chain.`,
  ),
  recursion_budget: (p, l) => localize(
    l,
    `critical path 递归已达到段预算（${str(p, 'budget')}），部分长链路段未展开`,
    `critical path recursion stopped at the segment budget (${str(p, 'budget')}); some long segments were not expanded`,
  ),
  recursion_failed: (p, l) => localize(
    l,
    `critical path 递归查询 utid ${str(p, 'utid')} 失败：${str(p, 'message')}`,
    `critical path recursion failed for utid ${str(p, 'utid')}: ${str(p, 'message')}`,
  ),
  recursion_cut: (p, l) => localize(
    l,
    `critical path 递归查询 utid ${str(p, 'utid')} 在 ${str(p, 'cap')} 个链路段处截断`,
    `critical path recursion for utid ${str(p, 'utid')} was cut at ${str(p, 'cap')} segments`,
  ),
  invalid_thread_state_id: fixed('无效的 threadStateId', 'invalid threadStateId'),
  waker_query_failed: (p, l) => localize(l, `waker 查询失败：${str(p, 'message')}`, `waker query failed: ${str(p, 'message')}`),
  thread_state_not_found: (p, l) => localize(l, `未找到 thread_state ${str(p, 'id')}`, `thread_state ${str(p, 'id')} not found`),
  no_recorded_waker: fixed(
    '唤醒行上没有记录 waker（waker_utid 为 NULL）',
    'no recorded waker on the wakeup row (waker_utid is NULL)',
  ),
  include_failed: (p, l) => localize(l, `加载模块 ${str(p, 'module')} 失败`, `INCLUDE ${str(p, 'module')} failed`),
  stdlib_table_missing: (p, l) => localize(l, `缺少 stdlib 表：${str(p, 'message')}`, `stdlib table missing: ${str(p, 'message')}`),
  schema_mismatch: (p, l) => localize(l, `schema 不匹配：${str(p, 'message')}`, `schema mismatch: ${str(p, 'message')}`),
  query_failed: (p, l) => localize(l, `查询失败：${str(p, 'message')}`, `query failed: ${str(p, 'message')}`),
  loader_row_cap: (p, l) => localize(
    l,
    `${str(p, 'source')} 证据达到 ${str(p, 'cap')} 行上限，最短的链路段可能缺少该证据`,
    `${str(p, 'source')} evidence reached the ${str(p, 'cap')}-row limit; the shortest segments may lack it`,
  ),
  frames_include_failed: (p, l) => localize(
    l,
    `加载 frames.timeline 失败：${str(p, 'message')}`,
    `frames.timeline include failed: ${str(p, 'message')}`,
  ),
  frame_query_failed: (p, l) => localize(
    l,
    `frame timeline 查询失败：${str(p, 'message')}`,
    `frame timeline query failed: ${str(p, 'message')}`,
  ),
};

export function warningText(warning: CriticalPathWarning, language: OutputLanguage): string {
  return WARNING_TEXT[warning.code](warning.params, language);
}

/** The first line of an error, the only part a warning quotes. */
export function errorLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

export const CRITICAL_PATH_HINT_CODES = ['irq_wakeup', 'swapper_wakeup', 'range_longest_waiting_slice'] as const;
export type CriticalPathHintCode = (typeof CRITICAL_PATH_HINT_CODES)[number];

const HINT_TEXT: Record<CriticalPathHintCode, [zh: string, en: string]> = {
  irq_wakeup: [
    '在 IRQ 上下文中被唤醒（唤醒行 irq_context=1）',
    'woken in IRQ context (irq_context=1 on the wakeup row)',
  ],
  swapper_wakeup: [
    '由 idle/swapper 唤醒——没有更上游的等待链可追',
    'woken by idle/swapper — no upstream wait chain to chase',
  ],
  range_longest_waiting_slice: [
    '按选区内最长的等待 slice 解析',
    'resolved for the longest waiting slice in the window',
  ],
};

export function hintText(code: CriticalPathHintCode, language: OutputLanguage): string {
  const [zh, en] = HINT_TEXT[code];
  return localize(language, zh, en);
}

// ── Hypotheses ──────────────────────────────────────────────────────────────

export const CRITICAL_PATH_HYPOTHESIS_IDS = [
  'h-binder-server-gc',
  'h-monitor-blocking',
  'h-io-wait',
  'h-gc-stall',
  'h-cpu-competition',
] as const;
export type CriticalPathHypothesisId = (typeof CRITICAL_PATH_HYPOTHESIS_IDS)[number];

const window = (p: TextParams | undefined): string => `[${str(p, 'start')}, ${str(p, 'end')})`;

/**
 * Hypothesis statements quote only numbers and enums (ids, utids, windows,
 * durations): the AI summary exempts them from clamping for that reason.
 */
const HYPOTHESIS_TEXT: Record<CriticalPathHypothesisId, Render> = {
  'h-binder-server-gc': (p, l) => localize(
    l,
    `同步 binder 客户端等待（txn id=${str(p, 'txnId')}）占 utid=${str(p, 'utid')} 关键路径段 ${window(p)} 中的 ${str(p, 'durMs')} ms（已裁剪到该段；整个事务持续 ${str(p, 'eventDurMs')} ms），是主要原因；请验证服务端进程在该段内是否在执行 GC。`,
    `Sync binder client wait (txn id=${str(p, 'txnId')}) covers ${str(p, 'durMs')} ms of the critical-path segment of utid=${str(p, 'utid')} ${window(p)} (clipped to the segment; the whole transaction lasts ${str(p, 'eventDurMs')} ms) and is the dominant reason; verify that the server process was running GC during this segment.`,
  ),
  'h-monitor-blocking': (p, l) => p?.side === 'owner'
    ? localize(
      l,
      `utid=${str(p, 'utid')} 持有 utid=${str(p, 'blockedUtid')} 在等的 Java monitor（contention row id=${str(p, 'rowId')}），占持锁者关键路径段 ${window(p)} 中的 ${str(p, 'durMs')} ms（已裁剪到该段；整个竞争持续 ${str(p, 'eventDurMs')} ms）；请通过 android_monitor_contention_chain 验证持锁线程的调用链。`,
      `utid=${str(p, 'utid')} holds the Java monitor (contention row id=${str(p, 'rowId')}) that utid=${str(p, 'blockedUtid')} waits on for ${str(p, 'durMs')} ms of the owner's critical-path segment ${window(p)} (clipped to the segment; the whole contention lasts ${str(p, 'eventDurMs')} ms); verify the blocking thread's call chain via android_monitor_contention_chain.`,
    )
    : localize(
      l,
      `Java monitor 竞争（row id=${str(p, 'rowId')}）阻塞 utid=${str(p, 'utid')}，占其关键路径段 ${window(p)} 中的 ${str(p, 'durMs')} ms（已裁剪到该段；整个竞争持续 ${str(p, 'eventDurMs')} ms）；请通过 android_monitor_contention_chain 验证持锁线程的调用链。`,
      `A Java monitor contention (row id=${str(p, 'rowId')}) blocks utid=${str(p, 'utid')} for ${str(p, 'durMs')} ms of its critical-path segment ${window(p)} (clipped to the segment; the whole contention lasts ${str(p, 'eventDurMs')} ms); verify the blocking thread's call chain via android_monitor_contention_chain.`,
    ),
  'h-io-wait': (p, l) => localize(
    l,
    `线程 utid=${str(p, 'utid')} 在关键路径段 ${window(p)} 中有 ${str(p, 'durMs')} ms 处于 io_wait 或 IO/页缓存 blocked_function 候选（已裁剪到该段；整个 D/DK 片段持续 ${str(p, 'eventDurMs')} ms）；blocked_function 只是单帧内核 wchan，请结合 D/DK 片段与文件、缺页或块 IO 证据验证。`,
    `Thread utid=${str(p, 'utid')} spends ${str(p, 'durMs')} ms of its critical-path segment ${window(p)} in an io_wait or IO/page-cache blocked_function candidate (clipped to the segment; the whole D/DK slice lasts ${str(p, 'eventDurMs')} ms); blocked_function is a single-frame kernel wchan, so verify with D/DK slices plus file/page-fault/block-I/O evidence.`,
  ),
  'h-gc-stall': (p, l) => localize(
    l,
    `进程 upid=${str(p, 'upid')} 的一次 GC 与 utid=${str(p, 'utid')} 的关键路径段 ${window(p)} 重叠 ${str(p, 'durMs')} ms（已裁剪到该段；整个 GC 持续 ${str(p, 'eventDurMs')} ms）；请验证与该段重叠的所有 GC 事件。`,
    `A GC event in process upid=${str(p, 'upid')} overlaps the critical-path segment of utid=${str(p, 'utid')} ${window(p)} for ${str(p, 'durMs')} ms (clipped to the segment; the whole GC lasts ${str(p, 'eventDurMs')} ms); verify all GC events touching the segment.`,
  ),
  'h-cpu-competition': (p, l) => localize(
    l,
    `utid=${str(p, 'utid')} 在关键路径段 ${window(p)} 中可运行时，竞争线程（utid=${str(p, 'competingUtid')}）在 CPU ${str(p, 'cpu')} 上运行了 ${str(p, 'durMs')} ms（已裁剪到该段；整个 Running 片段持续 ${str(p, 'eventDurMs')} ms）；请验证优先级与抢占。`,
    `While utid=${str(p, 'utid')} was runnable in its critical-path segment ${window(p)}, a competing thread (utid=${str(p, 'competingUtid')}) ran on CPU ${str(p, 'cpu')} for ${str(p, 'durMs')} ms (clipped to the segment; the whole Running slice lasts ${str(p, 'eventDurMs')} ms); verify priority and preemption.`,
  ),
};

export function hypothesisText(
  id: CriticalPathHypothesisId,
  params: TextParams | undefined,
  language: OutputLanguage,
): string {
  return HYPOTHESIS_TEXT[id](params, language);
}

export const CRITICAL_PATH_NOTE_CODES = [
  'sync_binder_client',
  'main_thread_blocked',
  'non_main_thread',
  'io_wait_confirmed',
  'inferred_from_blocked_function',
  'mark_compact',
  'non_mark_compact',
  'cpu_max_freq',
  'best_case_only',
] as const;
export type CriticalPathNoteCode = (typeof CRITICAL_PATH_NOTE_CODES)[number];
export type CriticalPathNote = CriticalPathTextCode<CriticalPathNoteCode>;

const NOTE_TEXT: Record<CriticalPathNoteCode, Render> = {
  sync_binder_client: fixed('客户端侧的同步 binder 调用', 'sync binder call on client side'),
  main_thread_blocked: fixed('主线程被阻塞', 'main thread blocked'),
  non_main_thread: fixed('非主线程', 'non-main thread'),
  io_wait_confirmed: fixed('已确认 io_wait 标记', 'io_wait flag confirmed'),
  inferred_from_blocked_function: fixed('由 blocked_function 模式推断', 'inferred from blocked_function pattern'),
  mark_compact: fixed('mark-compact（会阻塞堆）', 'mark-compact (heap-blocking)'),
  non_mark_compact: fixed('非 mark-compact', 'non-mark-compact'),
  cpu_max_freq: (p, l) => localize(l, `该段内 CPU 最高频率：${str(p, 'khz')} kHz`, `CPU max freq during segment: ${str(p, 'khz')} kHz`),
  best_case_only: fixed(
    '仅为最好情况——bestCaseDurationMs 是最长外部段耗时为零时剩下的任务时长；节省至多为 maxSavingMs，原本更短的路径可能成为新的关键路径，所以任务实际缩短可能更少。',
    'BEST CASE ONLY — bestCaseDurationMs is the task duration left if the longest external segment took no time; the saving is at most maxSavingMs, and a previously shorter path may become critical, so the task may shrink by less.',
  ),
};

export function noteText(note: CriticalPathNote, language: OutputLanguage): string {
  return NOTE_TEXT[note.code](note.params, language);
}
