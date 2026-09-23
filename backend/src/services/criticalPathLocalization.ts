// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {
  CriticalPathAnalysis,
  CriticalPathAnomaly,
  CriticalPathSegment,
} from './criticalPathAnalyzer';

const MODULE_EN = new Map<string, string>([
  ['Binder / IPC', 'Binder / IPC'],
  ['锁 / Futex', 'Locks / Futex'],
  ['IO / 页缓存 / 文件系统候选', 'I/O / Page cache / File-system candidate'],
  ['调度 / CPU 竞争', 'Scheduling / CPU contention'],
  ['图形渲染 / Surface', 'Graphics / Surface'],
  ['输入链路', 'Input pipeline'],
  ['ART / GC', 'ART / GC'],
  ['Kernel / IRQ / Workqueue', 'Kernel / IRQ / Workqueue'],
  ['电源 / 唤醒', 'Power / Wakeup'],
  ['锁 / Monitor', 'Locks / Monitor'],
  ['IO / 文件系统', 'I/O / File system'],
  ['未归类', 'Unclassified'],
]);

const TITLE_EN = new Map<string, string>([
  ['选中 task 本身耗时过长', 'The selected task is too long'],
  ['选中 task 超过单帧预算', 'The selected task exceeds the frame budget'],
  ['外部 critical path 占比过高', 'External critical-path share is high'],
  ['存在长 critical path 段', 'A long critical-path segment exists'],
  ['等待链涉及 IO/page-cache 候选', 'The wait chain contains an I/O or page-cache candidate'],
  ['等待链涉及 Binder / IPC', 'The wait chain contains Binder / IPC'],
  ['等待链涉及 Java 锁竞争', 'The wait chain contains Java lock contention'],
  ['GC 与等待链重叠', 'GC overlaps the wait chain'],
  ['存在调度或 CPU 竞争迹象', 'Scheduling or CPU contention is indicated'],
  ['未发现明显异常', 'No clear anomaly was found'],
  ['Running 状态：无等待链可分析', 'Running state: no wait chain to analyze'],
  ['选区内没有等待时间', 'The selection contains no waiting time'],
  ['没有取到 critical path 等待链', 'No critical-path wait chain was found'],
]);

const RECOMMENDATION_EN = new Map<string, string>([
  [
    '沿 Binder / IPC 相关线程继续看调用方与被调服务，确认是否同步跨进程调用阻塞了目标线程。',
    'Follow Binder / IPC threads to the caller and target service to determine whether a synchronous cross-process call blocked the target thread.',
  ],
  [
    '排查选中区间附近的同步 IO、fsync、SQLite/WAL、资源加载或 block 层等待，必要时补充 ftrace block/ext4/f2fs 事件。',
    'Inspect synchronous I/O, fsync, SQLite/WAL, resource loading, and block-layer waits near the selected range; record ftrace block/ext4/f2fs events if needed.',
  ],
  [
    '结合 monitor_contention_chain / futex 相关 slice 和调用栈采样，定位持锁线程以及锁竞争入口。',
    'Use monitor_contention_chain, futex slices, and sampled call stacks to identify the lock owner and contention entry point.',
  ],
  [
    '把 critical path 与 Choreographer、RenderThread、SurfaceFlinger、BufferQueue/BLAST 时间线对齐，确认卡点在 App 绘制还是系统合成。',
    'Align the critical path with Choreographer, RenderThread, SurfaceFlinger, and BufferQueue/BLAST to determine whether the bottleneck is app rendering or system composition.',
  ],
  [
    '查看同一时间 CPU 轨道和线程优先级，确认是否被高优先级线程、RT 线程或频率/大小核调度影响。',
    'Inspect CPU tracks and thread priorities at the same time to check for high-priority or RT-thread contention, frequency limits, or core-placement effects.',
  ],
  [
    '查 GC 类型与频率，关注 mark-compact GC 是否阻塞 mutator；考虑触发条件（堆压力、显式 System.gc）。',
    'Inspect GC type and frequency, especially whether mark-compact GC blocked mutators and whether heap pressure or explicit System.gc triggered it.',
  ],
  [
    '优先从最长 critical path 段入手，而不是只看选中线程自己的 slice；等待链上的外部线程才可能是直接原因。',
    'Start with the longest critical-path segment instead of only the selected thread; an external thread on the wait chain may be the direct cause.',
  ],
  [
    '对于 Running 状态的选区，推荐查 perf/简单采样的 callstack、CPU 占用与频率，而非 critical path。',
    'For a Running selection, inspect sampled call stacks, CPU utilization, and frequency instead of a critical path.',
  ],
  [
    '选区内没有等待状态；推荐查采样 callstack、CPU 占用与频率，而非 critical path。',
    'The selection has no waiting state; inspect sampled call stacks, CPU utilization, and frequency instead of a critical path.',
  ],
  [
    '确认录制配置包含 sched/sched_switch、sched/sched_wakeup、sched/sched_blocked_reason；如果只是想看整体线程链路，可改用区域选择后再分析。',
    'Ensure the trace includes sched/sched_switch, sched/sched_wakeup, and sched/sched_blocked_reason; use a range selection to inspect an overall thread chain.',
  ],
]);

function moduleName(value: string): string {
  return MODULE_EN.get(value) ?? value;
}

const REASON_ZH = new Map<string, string>([
  ['Sleeping', '睡眠'],
  ['Runnable', '可运行'],
  ['Waking', '唤醒中'],
  ['Parked', '停驻'],
  ['Running', '运行中'],
  ['Unknown state', '未知状态'],
]);

function projectReason(
  value: string,
  outputLanguage: OutputLanguage,
): string {
  if (outputLanguage === 'en') return translateEvidence(value);
  return REASON_ZH.get(value) ?? value;
}

// The analyzer writes its own truncation warnings in Chinese; English output
// rewrites them.
const WARNING_EN: Array<[RegExp, string]> = [
  [
    /^critical path 结果超过 (\d+) 行上限，已截断为前 (\d+) 个链路段（展示前 (\d+) 个）；阻塞时长、模块占比与反事实估计只覆盖截断前的部分。$/u,
    'The critical-path result exceeded the $1-row limit and was cut to the first $2 chain segments ($3 shown); blocking time, module shares and the counterfactual cover only the part before the cut.',
  ],
  [
    /^critical path 共 (\d+) 个链路段，仅展示前 (\d+) 个；阻塞时长、模块占比与反事实估计按完整链路计算。$/u,
    'The critical path has $1 chain segments; only the first $2 are shown. Blocking time, module shares and the counterfactual cover the full chain.',
  ],
];

// Technical warnings and waker hints are written in English; Chinese output
// rewrites them.
const WARNING_ZH: Array<[RegExp, string]> = [
  [/^invalid threadStateId$/u, '无效的 threadStateId'],
  [/^waker query failed:/u, 'waker 查询失败：'],
  [/^thread_state (.+) not found$/u, '未找到 thread_state $1'],
  [/^no recorded waker on the wakeup row \(waker_utid is NULL\)$/u, '唤醒行上没有记录 waker（waker_utid 为 NULL）'],
  [/^frames\.timeline include failed:/u, '加载 frames.timeline 失败：'],
  [/^frame timeline query failed:/u, 'frame timeline 查询失败：'],
  [/^stdlib table missing:/u, '缺少 stdlib 表：'],
  [/^schema mismatch:/u, 'schema 不匹配：'],
  [/^query failed:/u, '查询失败：'],
  [/^INCLUDE (.+) failed$/u, '加载模块 $1 失败'],
  [
    /^critical path recursion stopped at the segment budget \((\d+)\); some long segments were not expanded$/u,
    'critical path 递归已达到段预算（$1），部分长链路段未展开',
  ],
  [/^critical path recursion failed for utid (\d+):/u, 'critical path 递归查询 utid $1 失败：'],
  [/^thread tid\/upid lookup failed; GC evidence not checked$/u, '线程 tid/upid 查询失败；未检查 GC 证据'],
  [/^woken in IRQ context \(irq_context=1 on the wakeup row\)$/u, '在 IRQ 上下文中被唤醒（唤醒行 irq_context=1）'],
  [/^woken by idle\/swapper — no upstream wait chain to chase$/u, '由 idle/swapper 唤醒——没有更上游的等待链可追'],
  [/^resolved for the longest waiting slice in the window$/u, '按选区内最长的等待 slice 解析'],
];

function projectWarning(
  value: string,
  outputLanguage: OutputLanguage,
): string {
  const rules = outputLanguage === 'en' ? WARNING_EN : WARNING_ZH;
  for (const [pattern, replacement] of rules) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}

function translateDetail(value: string): string {
  const number = (index: number): string =>
    value.match(/[0-9]+(?:\.[0-9]+)?/g)?.[index] ?? '0';
  if (value.startsWith('选中区间持续') && value.includes('超过 50 ms')) {
    return `The selected range lasts ${number(0)} ms, exceeding 50 ms and long enough to cause visible interaction jank or a startup tail.`;
  }
  if (value.startsWith('选中区间持续') && value.includes('16.67 ms')) {
    return `The selected range lasts ${number(0)} ms, exceeding the 16.67 ms frame budget at 60 Hz.`;
  }
  if (value.startsWith('外部线程/模块贡献')) {
    return `External threads or modules contribute ${number(0)} ms (${number(1)}% of the selected range), indicating a wait or scheduling chain rather than one slow function.`;
  }
  if (value.includes('在 critical path 上持续')) {
    const prefix = value.split(' 在 critical path')[0];
    return `${prefix} remains on the critical path for ${number(0)} ms.`;
  }
  if (value.startsWith('critical path 中出现 io_wait')) {
    return 'The critical path contains io_wait or an I/O/page-cache kernel blocked-function family. A blocked_function is a single-frame wchan; confirm it with synchronous read/write, fsync, SQLite/WAL, page-fault, or block-layer evidence.';
  }
  if (value.startsWith('Binder / IPC 在 critical path 中累计')) {
    return `Binder / IPC contributes ${number(0)} ms on the critical path, possibly from a cross-process service call, system service, or callback chain.`;
  }
  if (value.startsWith('Java monitor 锁在 critical path 中累计')) {
    return `Java monitor contention contributes ${number(0)} ms on the critical path.`;
  }
  if (value.startsWith('ART / GC 在 critical path 中累计')) {
    return `ART / GC contributes ${number(0)} ms on the critical path and may block mutators.`;
  }
  if (value.startsWith('可运行段等待 CPU 期间')) {
    return `While runnable segments waited for a CPU, other threads ran on the same CPU for ${number(0)} ms. Check CPU tracks for high-priority threads, RT threads, or big-core contention.`;
  }
  if (value.startsWith('从 critical path 结果看')) {
    return 'The critical path shows no long external wait, I/O wait, long Binder wait, or clear CPU-contention signal.';
  }
  if (value.startsWith('选中区间内该线程没有')) {
    return 'The thread has no Sleeping, Uninterruptible, or Runnable time in the selected range, so there is no wait chain to analyze. Inspect sampled call stacks, the slice tree, or CPU utilization at the same time.';
  }
  if (value.startsWith('选中 task 的 thread_state 是 Running')) {
    return 'The selected task is Running, so there is no wait chain to analyze. Inspect sampled call stacks, the slice tree, or CPU utilization at the same time.';
  }
  if (value.startsWith('Perfetto 没有返回 selected task')) {
    return 'Perfetto returned no critical-path wait chain for the selected task. The trace may lack sched_wakeup or thread_state data, or the selected range may have no traceable wait chain.';
  }
  return value;
}

function translateEvidence(value: string): string {
  return value
    .replace(/^最长外部段=/, 'longest external segment=')
    .replace(/^选中 task=/, 'selected task=')
    .replace(/^外部 critical path=/, 'external critical path=')
    .replace(/^未知状态$/, 'Unknown state');
}

function projectAnomaly(anomaly: CriticalPathAnomaly): CriticalPathAnomaly {
  return {
    ...anomaly,
    title: TITLE_EN.get(anomaly.title) ?? anomaly.title,
    detail: translateDetail(anomaly.detail),
    evidence: anomaly.evidence.map(translateEvidence),
  };
}

function projectSegment(
  segment: CriticalPathSegment,
  outputLanguage: OutputLanguage,
): CriticalPathSegment {
  return {
    ...segment,
    modules:
      outputLanguage === 'en' ? segment.modules.map(moduleName) : segment.modules,
    reasons: segment.reasons.map(reason =>
      projectReason(reason, outputLanguage),
    ),
    children: segment.children?.map(child =>
      projectSegment(child, outputLanguage),
    ),
  };
}

function englishSummary(analysis: CriticalPathAnalysis): string {
  const lines = [
    `Selected task: ${analysis.task.processName ?? '-'} / ${analysis.task.threadName ?? '-'}, state ${analysis.task.state ?? 'unknown'}, duration ${analysis.task.durationMs.toFixed(2)} ms.`,
    `External critical path: ${analysis.blockingMs.toFixed(2)} ms (${analysis.externalBlockingPercentage.toFixed(2)}%).`,
  ];
  const longest = [...analysis.wakeupChain].sort(
    (a, b) => b.durationMs - a.durationMs,
  )[0];
  if (longest) {
    lines.push(
      `Longest external segment: ${longest.processName ?? '-'} / ${longest.threadName ?? '-'}, ${longest.durationMs.toFixed(2)} ms, modules ${longest.modules.map(moduleName).join(', ') || 'Unclassified'}.`,
    );
  }
  if (analysis.moduleBreakdown.length > 0) {
    lines.push(
      `Primary modules: ${analysis.moduleBreakdown
        .slice(0, 3)
        .map((item) => `${moduleName(item.module)} ${item.durationMs.toFixed(2)} ms`)
        .join(', ')}.`,
    );
  }
  if (analysis.anomalies.length > 0) {
    const anomaly = projectAnomaly(analysis.anomalies[0]);
    lines.push(`Finding: ${anomaly.title}. ${anomaly.detail}`);
  }
  return lines.join('\n');
}

function projectDirectWaker(
  directWaker: CriticalPathAnalysis['directWaker'],
  outputLanguage: OutputLanguage,
): CriticalPathAnalysis['directWaker'] {
  if (!directWaker) return directWaker;
  return {
    ...directWaker,
    hints: directWaker.hints.map(hint => projectWarning(hint, outputLanguage)),
  };
}

export function projectCriticalPathAnalysis(
  analysis: CriticalPathAnalysis,
  outputLanguage: OutputLanguage,
): CriticalPathAnalysis {
  if (outputLanguage !== 'en') {
    return {
      ...analysis,
      wakeupChain: analysis.wakeupChain.map(segment =>
        projectSegment(segment, outputLanguage),
      ),
      warnings: analysis.warnings.map(value =>
        projectWarning(value, outputLanguage),
      ),
      directWaker: projectDirectWaker(analysis.directWaker, outputLanguage),
    };
  }
  return {
    ...analysis,
    wakeupChain: analysis.wakeupChain.map(segment =>
      projectSegment(segment, outputLanguage),
    ),
    moduleBreakdown: analysis.moduleBreakdown.map((item) => ({
      ...item,
      module: moduleName(item.module),
    })),
    anomalies: analysis.anomalies.map(projectAnomaly),
    summary: englishSummary(analysis),
    recommendations: analysis.recommendations.map(
      (value) => RECOMMENDATION_EN.get(value) ?? value,
    ),
    warnings: analysis.warnings.map(value =>
      projectWarning(value, outputLanguage),
    ),
  };
}
