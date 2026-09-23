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
        'critical path 结果超过 3200 行上限，已截断为前 170 个链路段（展示前 160 个）；阻塞时长、模块占比与反事实估计只覆盖截断前的部分。',
        'critical path 共 180 个链路段，仅展示前 160 个；阻塞时长、模块占比与反事实估计按完整链路计算。',
        'no recorded waker on the wakeup row (waker_utid is NULL)',
        'critical path recursion stopped at the segment budget (16); some long segments were not expanded',
        'critical path recursion failed for utid 42: no such table: foo',
        'thread tid/upid lookup failed; GC evidence not checked',
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
      '线程 tid/upid 查询失败；未检查 GC 证据',
    ]);
    expect(zh.directWaker?.hints).toEqual([
      '在 IRQ 上下文中被唤醒（唤醒行 irq_context=1）',
      '由 idle/swapper 唤醒——没有更上游的等待链可追',
      '按选区内最长的等待 slice 解析',
    ]);

    const en = projectCriticalPathAnalysis(fixture, 'en');
    expect(en.warnings.slice(0, 2)).toEqual([
      'The critical-path result exceeded the 3200-row limit and was cut to the first 170 chain segments (160 shown); blocking time, module shares and the counterfactual cover only the part before the cut.',
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
});
