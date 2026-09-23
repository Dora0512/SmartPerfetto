// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Thread roles and wake-source labels are decided once, in SQL:
// fragments/thread_role.sql and fragments/sleep_wake_source_labels.sql. Skills join
// them directly and the critical-path engine composes them through
// fragments/segment_wake_sources.sql, so one trace cannot get two answers. This
// suite executes the fragments (SQLite is the processor's SQL dialect for GLOB,
// CASE and window functions) and pins each bucket.

import fs from 'fs';
import path from 'path';

import {composeFragmentSql} from '../skillEngine/skillFragments';
import type {WaitClass, WakeSource} from '../criticalPathSemantics';
import {sqliteTraceProcessor} from '../../../tests/helpers/criticalPathTraceProcessorFixture';

const wakeFragmentPath = path.resolve(__dirname, '../../../skills/fragments/sleep_wake_source_labels.sql');

/** The role thread_role.sql gives each named thread (pid 1000 unless noted). */
async function rolesOf(threads: Array<{name: string; tid: number; pid?: number}>): Promise<string[]> {
  const inserts = threads.map((thread, index) =>
    `INSERT INTO process(upid, pid, name) VALUES (${index + 1}, ${thread.pid ?? 1000}, 'p${index}');
     INSERT INTO thread VALUES (${index + 1}, ${thread.tid}, ${index + 1}, '${thread.name}');`).join('\n');
  const {tp} = sqliteTraceProcessor(inserts);
  const result = await tp.query('trace-1', composeFragmentSql({
    leadingCtes: [], fragments: ['thread_role.sql'], select: 'SELECT role FROM thread_roles ORDER BY utid',
  }));
  if (result.error) throw new Error(result.error);
  return result.rows.map((row) => String(row[0]));
}

describe('thread role fragment', () => {
  it('resolves main from tid = pid without claiming the idle thread', async () => {
    expect(await rolesOf([
      {name: 'unch.aosp.heavy', tid: 21307, pid: 21307},
      // swapper has tid 0 in a process whose pid is 0; tid = pid would otherwise
      // report the idle thread as somebody's main thread.
      {name: 'swapper', tid: 0, pid: 0},
    ])).toEqual(['main', 'other']);
  });

  it('matches thread names as the kernel truncates them to 15 characters', async () => {
    expect(await rolesOf([
      {name: 'ReferenceQueueD', tid: 4321},
      {name: 'pool-10-thread-', tid: 4322},
      {name: 'RxCachedWorkerP', tid: 4323},
    ])).toEqual(['gc', 'worker', 'worker']);
  });

  it('classifies binder pool threads in both kernel spellings', async () => {
    expect(await rolesOf([
      {name: 'binder:21307_2', tid: 24744},
      {name: 'Binder:3826_E', tid: 4000},
    ])).toEqual(['binder', 'binder']);
  });

  it('keeps network threads out of the worker bucket', async () => {
    expect(await rolesOf([
      {name: 'OkHttp Dispatch', tid: 5000},
      {name: 'ChromiumNet0', tid: 5001},
      {name: 'NetworkSchedule', tid: 5002},
      {name: 'pool-3-thread-1', tid: 5003},
    ])).toEqual(['network', 'network', 'network', 'worker']);
  });
});

describe('sleep wake-source fragment', () => {
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

  const SLEEPER_NAMES: Record<string, string> = {worker: 'pool-1-thread-1', network: 'OkHttp Dispatch'};

  /** Build the case as trace rows and read the labels the fragment derives. */
  async function labels(row: typeof sleeper): Promise<{wakeSource: string; waitClass: string}> {
    const quote = (value: string | null) => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);
    const wakerUpid = row.wakerUpid ?? 99;
    const processName = wakerUpid === 7 ? 'com.demo' : row.wakerProcessName;
    const setup = `
      INSERT INTO process(upid, pid, name) VALUES (7, 1000, 'com.demo');
      ${wakerUpid === 7 ? '' : `INSERT INTO process(upid, pid, name) VALUES (${wakerUpid}, 2000, ${quote(processName)});`}
      INSERT INTO thread VALUES (1, 1017, 7, '${SLEEPER_NAMES[row.threadRole]}');
      ${row.wakerUtid === null ? '' : `INSERT INTO thread VALUES (${row.wakerUtid}, ${row.wakerTid ?? 'NULL'}, ${wakerUpid}, ${quote(row.wakerThreadName)});`}
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, irq_context) VALUES
        (1, 1, 1000, 500, '${row.state}', NULL, NULL),
        (2, 1, 1500, 100, 'R', ${row.wakerUtid ?? 'NULL'}, ${row.irqContext ? 1 : 0});
    `;
    const {tp} = sqliteTraceProcessor(setup);
    const result = await tp.query('trace-1', composeFragmentSql({
      leadingCtes: ['wake_source_scope AS (SELECT 1 AS utid)'],
      fragments: ['thread_role.sql', 'sleep_wake_source.sql', 'sleep_wake_source_labels.sql'],
      numbers: {start_ts: 0, end_ts: 10_000},
      select: 'SELECT wake_source, wait_class FROM sleep_wake_source',
    }));
    if (result.error) throw new Error(result.error);
    const [wakeSource, waitClass] = result.rows[0] as string[];
    return {wakeSource, waitClass};
  }

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

  it.each(cases)('labels $name', async ({input, wakeSource, waitClass}) => {
    expect(await labels({...sleeper, ...input})).toEqual({wakeSource, waitClass});
  });

  it('covers every bucket the SQL wake_source CASE can produce, and no other', () => {
    expect(sqlCaseLabels(wakeSql, 'wake_source').sort()).toEqual(
      [...new Set(cases.map((entry) => entry.wakeSource))].sort());
  });

  it('covers every bucket the SQL wait_class CASE can produce, and no other', () => {
    expect(sqlCaseLabels(wakeSql, 'wait_class').sort()).toEqual(
      [...new Set(cases.map((entry) => entry.waitClass))].sort());
  });

  it('treats any swapper-prefixed waker as idle', async () => {
    for (const wakerThreadName of ['swapper', 'swapper/0', 'swapper/11', 'swapperd']) {
      expect((await labels({...sleeper, wakerThreadName, wakerTid: 4000, wakerUpid: 7})).wakeSource).toBe('swapper');
    }
  });
});
