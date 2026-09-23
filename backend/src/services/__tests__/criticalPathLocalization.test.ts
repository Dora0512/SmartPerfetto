// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CriticalPathAnalysis} from '../criticalPathAnalyzer';
import {projectCriticalPathAnalysis} from '../criticalPathLocalization';

const analysis = {
  available: true,
  task: {
    threadStateId: 1,
    utid: 2,
    startTs: 3,
    dur: 50_000_000,
    durationMs: 50,
    state: 'S',
    processName: 'app',
    threadName: 'main',
  },
  totalMs: 50,
  blockingMs: 40,
  selfMs: 10,
  externalBlockingPercentage: 80,
  wakeupChain: [{
    startTs: 3,
    dur: 40_000_000,
    startOffsetMs: 0,
    durationMs: 40,
    utid: 2,
    modules: ['IO / 文件系统'],
    reasons: ['未知状态'],
    slices: ['stable_slice_name'],
  }],
  moduleBreakdown: [{
    module: 'IO / 文件系统',
    durationMs: 40,
    percentage: 80,
    segmentCount: 1,
    examples: ['stable.example'],
  }],
  anomalies: [{
    severity: 'warning',
    title: '等待链涉及 IO/page-cache 候选',
    detail: 'critical path 中出现 io_wait 或 kernel blocked_function 的 IO/page-cache 函数族；blocked_function 是单帧 wchan，需要结合同步读写、fsync、SQLite/WAL、page fault 或 block 层证据确认。',
    evidence: ['stable_evidence_id'],
  }],
  summary: '原始中文摘要',
  recommendations: [
    '排查选中区间附近的同步 IO、fsync、SQLite/WAL、资源加载或 block 层等待，必要时补充 ftrace block/ext4/f2fs 事件。',
  ],
  warnings: ['critical path 共 180 个链路段，仅展示前 160 个；阻塞时长、模块占比与反事实估计按完整链路计算。'],
  rawRows: 1,
  truncated: true,
} satisfies CriticalPathAnalysis;

describe('criticalPathLocalization', () => {
  it('projects presentation fields while preserving evidence identifiers', () => {
    const raw = structuredClone(analysis);
    const projected = projectCriticalPathAnalysis(analysis, 'en');

    expect(projected.summary).not.toMatch(/\p{Script=Han}/u);
    expect(projected.moduleBreakdown[0].module).toBe('I/O / File system');
    expect(projected.anomalies[0].title).not.toMatch(/\p{Script=Han}/u);
    expect(projected.recommendations[0]).not.toMatch(/\p{Script=Han}/u);
    expect(projected.warnings[0]).not.toMatch(/\p{Script=Han}/u);
    expect(projected.wakeupChain[0].slices).toEqual(['stable_slice_name']);
    expect(projected.anomalies[0].evidence).toEqual(['stable_evidence_id']);
    expect(analysis).toEqual(raw);
  });

  it('projects technical warnings and state reasons for Chinese output', () => {
    const fixture: CriticalPathAnalysis = {
      ...structuredClone(analysis),
      wakeupChain: [{
        ...structuredClone(analysis.wakeupChain[0]),
        reasons: ['Sleeping', 'stable_slice_name'],
      }],
      warnings: [
        'invalid threadStateId',
        'frame timeline query failed: no such table',
      ],
    };
    const raw = structuredClone(fixture);
    const projected = projectCriticalPathAnalysis(fixture, 'zh-CN');

    expect(projected.wakeupChain[0].reasons).toEqual([
      '睡眠',
      'stable_slice_name',
    ]);
    expect(projected.warnings).toEqual([
      '无效的 threadStateId',
      'frame timeline 查询失败： no such table',
    ]);
    expect(fixture).toEqual(raw);
  });

  it('projects every truncation, recursion, lookup and waker string the analyzer writes', () => {
    const fixture: CriticalPathAnalysis = {
      ...structuredClone(analysis),
      warnings: [
        'critical path 超过 5000 个原始链路段上限，已截断（合并后 170 段，展示前 160 段）；阻塞时长、模块占比与反事实估计只覆盖截断前的部分。',
        'critical path 共 180 个链路段，仅展示前 160 个；阻塞时长、模块占比与反事实估计按完整链路计算。',
        'no recorded waker on the wakeup row (waker_utid is NULL)',
        'critical path recursion stopped at the segment budget (16); some long segments were not expanded',
        'critical path recursion failed for utid 42: no such table: foo',
        'critical path recursion for utid 42 was cut at 160 segments',
      ],
      directWaker: {
        threadStateId: null,
        utid: 5,
        tid: 0,
        threadName: 'swapper/0',
        processName: null,
        state: null,
        cpu: null,
        irqContext: true,
        kind: 'irq',
        hints: [
          'woken in IRQ context (irq_context=1 on the wakeup row)',
          'woken by idle/swapper — no upstream wait chain to chase',
          'resolved for the longest waiting slice in the window',
        ],
      },
    };
    const raw = structuredClone(fixture);

    const zh = projectCriticalPathAnalysis(fixture, 'zh-CN');
    expect(zh.warnings).toEqual([
      fixture.warnings[0],
      fixture.warnings[1],
      '唤醒行上没有记录 waker（waker_utid 为 NULL）',
      'critical path 递归已达到段预算（16），部分长链路段未展开',
      'critical path 递归查询 utid 42 失败： no such table: foo',
      'critical path 递归查询 utid 42 在 160 个链路段处截断',
    ]);
    expect(zh.directWaker?.hints).toEqual([
      '在 IRQ 上下文中被唤醒（唤醒行 irq_context=1）',
      '由 idle/swapper 唤醒——没有更上游的等待链可追',
      '按选区内最长的等待 slice 解析',
    ]);

    const en = projectCriticalPathAnalysis(fixture, 'en');
    expect(en.warnings.slice(0, 2)).toEqual([
      'The critical path exceeded the 5000 stack-segment limit and was cut (170 segments once merged, 160 shown); blocking time, module shares and the counterfactual cover only the part before the cut.',
      'The critical path has 180 chain segments; only the first 160 are shown. Blocking time, module shares and the counterfactual cover the full chain.',
    ]);
    for (const value of [...en.warnings, ...(en.directWaker?.hints ?? [])]) {
      expect(value).not.toMatch(/\p{Script=Han}/u);
    }
    expect(fixture).toEqual(raw);
  });

  it('projects the no-waiting-time result and the typed CPU-contention finding to English', () => {
    const fixture: CriticalPathAnalysis = {
      ...structuredClone(analysis),
      anomalies: [
        {
          severity: 'info',
          title: '选区内没有等待时间',
          detail:
            '选中区间内该线程没有 Sleeping / Uninterruptible / Runnable 等待状态，没有等待链可分析。建议查 callstack samples、slice 树或同时段 CPU 占用。',
          evidence: ['task=20.00 ms'],
        },
        {
          severity: 'info',
          title: '存在调度或 CPU 竞争迹象',
          detail:
            '可运行段等待 CPU 期间，同一 CPU 上其他线程累计运行 7.25 ms；建议结合 CPU 轨道确认是否有高优先级线程、RT 线程或大核竞争。',
          evidence: ['CPU 3: com.demo / RenderThread'],
        },
      ],
      recommendations: ['选区内没有等待状态；推荐查采样 callstack、CPU 占用与频率，而非 critical path。'],
      unavailableReason: 'no_waiting_time',
    };

    const en = projectCriticalPathAnalysis(fixture, 'en');

    expect(en.anomalies.map((a) => a.title)).toEqual([
      'The selection contains no waiting time',
      'Scheduling or CPU contention is indicated',
    ]);
    expect(en.anomalies[1].detail).toContain('7.25 ms');
    for (const text of [...en.anomalies.flatMap((a) => [a.title, a.detail]), ...en.recommendations]) {
      expect(text).not.toMatch(/\p{Script=Han}/u);
    }
    expect(en.unavailableReason).toBe('no_waiting_time');
    expect(projectCriticalPathAnalysis(fixture, 'zh-CN').unavailableReason).toBe('no_waiting_time');
  });

  // The wake-source layer added two modules and two findings. An unmapped label
  // falls through as Chinese into an English answer, which is silent: the
  // projector returns the input rather than failing.
  it('projects the wake-source modules, titles and details into English', () => {
    const fixture: CriticalPathAnalysis = {
      ...structuredClone(analysis),
      wakeupChain: [{
        ...structuredClone(analysis.wakeupChain[0]),
        threadName: 'OkHttp Dispatch',
        modules: ['网络收包等待候选', 'worker 交接等待'],
        reasons: ['wake: network_receive_candidate'],
        wakeSourceClass: 'network_receive_candidate',
      }],
      moduleBreakdown: [
        {module: '网络收包等待候选', durationMs: 30, percentage: 60, segmentCount: 1, examples: ['stable.network']},
        {module: 'worker 交接等待', durationMs: 12, percentage: 24, segmentCount: 1, examples: ['stable.worker']},
      ],
      anomalies: [{
        severity: 'info',
        title: '等待链涉及网络收包等待候选',
        detail: 'critical path 中有 S 态等待由 irq 上下文唤醒，且等待线程是网络角色。Android 只对 D 态发 sched_blocked_reason，S 态没有 blocked_function，irq 唤醒同样可能是定时器到期；要确认为收包，需要 rx 包时间相关或网络库请求埋点。',
        evidence: ['com.demo / OkHttp Dispatch', '30.00 ms'],
      }, {
        severity: 'info',
        title: '等待链涉及 worker 交接等待',
        detail: 'critical path 中有 S 态等待由同进程线程唤醒，属于线程间交接。交接本身不说明谁慢，需要看上游线程在这段等待里做了什么。',
        evidence: ['com.demo / pool-1-thread-2', '12.00 ms'],
      }],
    };
    const raw = structuredClone(fixture);
    const projected = projectCriticalPathAnalysis(fixture, 'en');

    expect(projected.moduleBreakdown.map(item => item.module)).toEqual([
      'Network-receive wait candidate', 'Worker hand-off wait',
    ]);
    expect(projected.wakeupChain[0].modules).toEqual([
      'Network-receive wait candidate', 'Worker hand-off wait',
    ]);
    expect(projected.anomalies.map(item => item.title)).toEqual([
      'The wait chain contains a network-receive wait candidate',
      'The wait chain contains a worker hand-off wait',
    ]);
    for (const anomaly of projected.anomalies) {
      expect(anomaly.detail).not.toMatch(/\p{Script=Han}/u);
    }
    // The candidate caveat is the point of the finding; it must survive.
    expect(projected.anomalies[0].detail).toContain('timer expiry');
    expect(projected.anomalies[1].detail).toContain('hand-off');
    // The classification itself is data, not presentation.
    expect(projected.wakeupChain[0].wakeSourceClass).toBe('network_receive_candidate');
    // So is the `wake:` reason: it names the class identifier in either language.
    expect(projected.wakeupChain[0].reasons).toEqual(['wake: network_receive_candidate']);
    expect(projectCriticalPathAnalysis(fixture, 'zh-CN').wakeupChain[0].reasons)
      .toEqual(['wake: network_receive_candidate']);
    expect(projected.anomalies[0].evidence).toEqual(['com.demo / OkHttp Dispatch', '30.00 ms']);
    expect(fixture).toEqual(raw);
  });
});
