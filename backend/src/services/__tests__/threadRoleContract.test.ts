// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Thread roles are decided twice: once in SQL for every Skill that joins
// fragments/thread_role.sql, and once in TypeScript for the critical-path
// engine. A wait attributed to `network` in one and `worker` in the other would
// give the same trace two different answers depending on which surface asked,
// so the two rule sets are held equal here rather than by convention.

import fs from 'fs';
import path from 'path';

import {
  THREAD_ROLE_PATTERNS,
  classifyThreadRole,
  __INTERNAL__ as SEMANTICS_INTERNAL,
} from '../criticalPathSemantics';
import type {WaitClass, WakeSource} from '../criticalPathSemantics';

const {classifyWaitClass, classifyWakeSource} = SEMANTICS_INTERNAL;

const fragmentPath = path.resolve(__dirname, '../../../skills/fragments/thread_role.sql');
const wakeFragmentPath = path.resolve(__dirname, '../../../skills/fragments/sleep_wake_source.sql');

function parseSqlRolePatterns(sql: string): Array<{role: string; patterns: string[]}> {
  // Strip comment lines first: the header explains the rules in prose and
  // mentions patterns that are deliberately NOT applied.
  const executable = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const rules: Array<{role: string; patterns: string[]}> = [];
  const whenThen = /WHEN([\s\S]*?)THEN '([a-z_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = whenThen.exec(executable)) !== null) {
    const patterns = [...match[1].matchAll(/GLOB\s+'([^']*)'/g)].map((glob) => glob[1]);
    if (patterns.length === 0) continue;
    rules.push({role: match[2], patterns});
  }
  return rules;
}

describe('thread role contract', () => {
  const sql = fs.readFileSync(fragmentPath, 'utf8');
  const sqlRules = parseSqlRolePatterns(sql);

  it('parses at least the name-matched roles out of the fragment', () => {
    expect(sqlRules.length).toBeGreaterThan(0);
    expect(sqlRules.map((rule) => rule.role)).toContain('network');
  });

  it('declares the same roles in the same evaluation order as TypeScript', () => {
    expect(sqlRules.map((rule) => rule.role)).toEqual(Object.keys(THREAD_ROLE_PATTERNS));
  });

  it('declares the same GLOB patterns per role as TypeScript', () => {
    for (const {role, patterns} of sqlRules) {
      expect({role, patterns}).toEqual({
        role,
        patterns: [...(THREAD_ROLE_PATTERNS[role] ?? [])],
      });
    }
  });

  it('resolves main from tid = pid without claiming the idle thread', () => {
    expect(classifyThreadRole('unch.aosp.heavy', 21307, 21307)).toBe('main');
    // swapper has tid 0 in a process whose pid is 0; tid = pid would otherwise
    // report the idle thread as somebody's main thread.
    expect(classifyThreadRole('swapper', 0, 0)).toBe('other');
  });

  it('matches thread names as the kernel truncates them to 15 characters', () => {
    expect(classifyThreadRole('ReferenceQueueD', 4321, 1000)).toBe('gc');
    expect(classifyThreadRole('pool-10-thread-', 4322, 1000)).toBe('worker');
    expect(classifyThreadRole('RxCachedWorkerP', 4323, 1000)).toBe('worker');
  });

  it('classifies binder pool threads in both kernel spellings', () => {
    expect(classifyThreadRole('binder:21307_2', 24744, 21307)).toBe('binder');
    expect(classifyThreadRole('Binder:3826_E', 4000, 3826)).toBe('binder');
  });

  it('keeps network threads out of the worker bucket', () => {
    expect(classifyThreadRole('OkHttp Dispatch', 5000, 1000)).toBe('network');
    expect(classifyThreadRole('ChromiumNet0', 5001, 1000)).toBe('network');
    expect(classifyThreadRole('NetworkSchedule', 5002, 1000)).toBe('network');
    expect(classifyThreadRole('pool-3-thread-1', 5003, 1000)).toBe('worker');
  });
});

// The two wake labels are decided twice as well: once by the `wake_source` and
// `wait_class` CASE expressions in fragments/sleep_wake_source.sql, and once by
// classifyWakeSource/classifyWaitClass for the critical-path engine. A Skill
// that reported `binder_reply` while the wait-chain tool reported
// `worker_handoff` for the same sleep would give one trace two root causes.
describe('wake source contract', () => {
  const wakeSql = fs.readFileSync(wakeFragmentPath, 'utf8');

  /**
   * Bucket labels a CASE expression can produce, in evaluation order and
   * de-duplicated (both CASEs answer `unknown` twice: no recorded waker, and
   * the ELSE). Comment lines are stripped first — the header names labels in
   * prose while explaining why a rule is ordered the way it is.
   */
  function sqlCaseLabels(sql: string, alias: string): string[] {
    const executable = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    // Take the CASE nearest the alias, not the first one in the file: the two
    // CASEs are siblings, so a lazy `CASE...END AS wait_class` would start at
    // the wake_source CASE and swallow both label sets.
    const end = executable.indexOf(`END AS ${alias}`);
    if (end < 0) throw new Error(`no END AS ${alias} in the fragment`);
    const start = executable.lastIndexOf('CASE', end);
    if (start < 0) throw new Error(`no CASE before END AS ${alias} in the fragment`);
    const body = executable.slice(start, end);
    return [...new Set([...body.matchAll(/THEN '([a-z_]+)'|ELSE '([a-z_]+)'/g)]
      .map((match) => match[1] ?? match[2]))];
  }

  // A sleeping application worker; each case below overrides only what its own
  // bucket turns on, so an accidental extra condition shows up as a wrong label.
  const sleeper = {
    state: 'S' as string | null,
    irqContext: false,
    threadRole: 'worker',
    wakerUtid: 40 as number | null,
    wakerTid: 4000 as number | null,
    wakerThreadName: 'pool-2-thread-1' as string | null,
    wakerRole: 'worker',
    wakerUpid: 9 as number | null,
    sleeperUpid: 7 as number | null,
    wakerProcessName: 'com.other.app' as string | null,
  };

  const cases: Array<{
    name: string;
    input: Partial<typeof sleeper>;
    wakeSource: WakeSource;
    waitClass: WaitClass;
  }> = [
    {
      // Only the sleeping thread's role narrows an IRQ wake, and only for an
      // interruptible sleep; the wake source itself stays `irq_or_softirq`.
      name: 'irq wake of a network-role thread in S',
      input: {irqContext: true, threadRole: 'network'},
      wakeSource: 'irq_or_softirq',
      waitClass: 'network_receive_candidate',
    },
    {
      name: 'irq wake of a network-role thread in I',
      input: {irqContext: true, threadRole: 'network', state: 'I'},
      wakeSource: 'irq_or_softirq',
      waitClass: 'network_receive_candidate',
    },
    {
      // D is uninterruptible: a socket receive is never in it, so the same IRQ
      // wake on the same thread is not a receive candidate.
      name: 'irq wake of a network-role thread in D',
      input: {irqContext: true, threadRole: 'network', state: 'D'},
      wakeSource: 'irq_or_softirq',
      waitClass: 'timer_or_device_wake',
    },
    {
      name: 'irq wake of any other role',
      input: {irqContext: true},
      wakeSource: 'irq_or_softirq',
      waitClass: 'timer_or_device_wake',
    },
    {
      name: 'no recorded waker',
      input: {wakerUtid: null, wakerTid: null, wakerThreadName: null,
        wakerRole: 'unknown', wakerUpid: null, wakerProcessName: null},
      wakeSource: 'unknown',
      waitClass: 'unknown',
    },
    {
      name: 'kernel idle thread',
      input: {wakerTid: 0, wakerThreadName: 'swapper/3', wakerRole: 'other'},
      wakeSource: 'swapper',
      // wait_class has no swapper bucket: an idle-thread wake says nothing
      // about what the sleeper was waiting for.
      waitClass: 'unknown',
    },
    {
      // In-process binder pool thread: binder is tested BEFORE same-process in
      // both CASEs, because delivering a transaction is a binder wake rather
      // than an application hand-off.
      name: 'binder pool thread inside the sleeper process',
      input: {wakerRole: 'binder', wakerThreadName: 'binder:7_2', wakerUpid: 7},
      wakeSource: 'binder_thread',
      waitClass: 'binder_reply',
    },
    {
      name: 'another thread of the same process',
      input: {wakerUpid: 7},
      wakeSource: 'same_process_thread',
      waitClass: 'worker_handoff',
    },
    {
      name: 'system_server',
      input: {wakerProcessName: 'system_server'},
      wakeSource: 'system_process',
      waitClass: 'system_service',
    },
    {
      name: 'surfaceflinger',
      input: {wakerProcessName: '/system/bin/surfaceflinger'},
      wakeSource: 'system_process',
      waitClass: 'system_service',
    },
    {
      name: 'a vendor HAL',
      input: {wakerProcessName: 'vendor.qti.hardware.display'},
      wakeSource: 'system_process',
      waitClass: 'system_service',
    },
    {
      name: 'an unrelated third-party process',
      input: {},
      wakeSource: 'unknown',
      waitClass: 'unknown',
    },
  ];

  it.each(cases)('labels $name the same way the SQL CASE does', ({input, wakeSource, waitClass}) => {
    const row = {...sleeper, ...input};
    expect(classifyWakeSource(row)).toBe(wakeSource);
    expect(classifyWaitClass(row)).toBe(waitClass);
  });

  it('covers every bucket the SQL wake_source CASE can produce, and no other', () => {
    expect(sqlCaseLabels(wakeSql, 'wake_source').sort()).toEqual(
      [...new Set(cases.map((entry) => entry.wakeSource))].sort());
  });

  it('covers every bucket the SQL wait_class CASE can produce, and no other', () => {
    expect(sqlCaseLabels(wakeSql, 'wait_class').sort()).toEqual(
      [...new Set(cases.map((entry) => entry.waitClass))].sort());
  });

  it('treats a swapper-prefixed waker as idle, exactly as the fragment GLOB does', () => {
    // fragments/sleep_wake_source.sql tests `thread_name GLOB 'swapper*'`, so a
    // spelling other than `swapper/N` must not fall through to same-process.
    expect(sqlCaseLabels(wakeSql, 'wake_source')).toContain('swapper');
    expect(wakeSql).toContain("GLOB 'swapper*'");
    for (const wakerThreadName of ['swapper', 'swapper/0', 'swapper/11', 'swapperd']) {
      expect(classifyWakeSource({...sleeper, wakerThreadName, wakerTid: 4000, wakerUpid: 7}))
        .toBe('swapper');
    }
  });
});
