// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {
  MAX_THREAD_CANDIDATES,
  resolveCriticalPathThread,
} from '../criticalPathThreadResolver';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';

const COLUMNS = ['utid', 'tid', 'thread_name', 'thread_upid', 'is_main_thread', 'pid', 'process_name'];

function threadRow(
  utid: number,
  tid: number,
  threadName: string,
  options: {upid?: number; pid?: number; processName?: string; main?: boolean} = {},
): unknown[] {
  return [
    utid,
    tid,
    threadName,
    options.upid ?? 7,
    options.main ? 1 : 0,
    options.pid ?? 1200,
    options.processName ?? 'com.example.app',
  ];
}

/**
 * The resolver runs one pass per process-name strategy, so a test fixture has to
 * answer per-query rather than per-call: the exact pass must be able to miss
 * while the prefix pass hits.
 */
function mockedService(responder: (sql: string) => unknown[][]): {
  service: TraceProcessorService;
  queries: string[];
} {
  const queries: string[] = [];
  const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async (_traceId, sql) => {
    queries.push(sql);
    return {columns: COLUMNS, rows: responder(sql), durationMs: 1} satisfies QueryResult;
  });
  return {service: {query} as unknown as TraceProcessorService, queries};
}

describe('resolveCriticalPathThread', () => {
  it('resolves a unique match and carries process identity back', async () => {
    const {service} = mockedService(() => [
      threadRow(42, 1200, 'com.example.app', {main: true}),
    ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {
      processName: 'com.example.app',
      mainThread: true,
    });

    expect(resolution).toEqual({
      status: 'resolved',
      thread: {
        utid: 42,
        tid: 1200,
        threadName: 'com.example.app',
        upid: 7,
        pid: 1200,
        processName: 'com.example.app',
        isMainThread: true,
      },
    });
  });

  it('scopes the main-thread selector in SQL rather than filtering afterwards', async () => {
    const {service, queries} = mockedService(() => [threadRow(42, 1200, 'com.example.app', {main: true})]);

    await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.example.app', mainThread: true});

    expect(queries[0]).toContain('thread.is_main_thread = 1');
    expect(queries[0]).toContain("process.name = 'com.example.app'");
  });

  it('prefers the exact process over a longer one that shares its prefix', async () => {
    // `com.example.app:push` is a real sibling process. Resolving the parent
    // package to the push process would answer about the wrong app entirely.
    const {service, queries} = mockedService(sql =>
      sql.includes("process.name = 'com.example.app'")
        ? [threadRow(42, 1200, 'com.example.app', {main: true})]
        : [
          threadRow(42, 1200, 'com.example.app', {main: true}),
          threadRow(90, 1400, 'com.example.app', {upid: 9, pid: 1400, processName: 'com.example.app:push', main: true}),
        ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.example.app'});

    expect(resolution).toMatchObject({status: 'resolved', thread: {utid: 42}});
    // The prefix pass never ran, because the exact pass answered.
    expect(queries).toHaveLength(1);
  });

  it('falls back to a prefix match when no process matches exactly', async () => {
    const {service, queries} = mockedService(sql =>
      sql.includes("process.name = 'com.example'")
        ? []
        : [threadRow(42, 1200, 'com.example.app', {main: true})]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.example'});

    expect(resolution).toMatchObject({status: 'resolved', thread: {processName: 'com.example.app'}});
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("process.name GLOB 'com.example*'");
  });

  it('matches a thread name as a prefix, because kernel comm is truncated to 15 characters', async () => {
    const {service, queries} = mockedService(() => [
      threadRow(55, 1301, 'OkHttp Dispatch', {processName: 'com.example.app'}),
    ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {
      processName: 'com.example.app',
      threadName: 'OkHttp',
    });

    expect(resolution).toMatchObject({status: 'resolved', thread: {threadName: 'OkHttp Dispatch'}});
    expect(queries[0]).toContain("thread.name GLOB 'OkHttp*'");
  });

  it('reports ambiguity instead of picking the first of several threads', async () => {
    const {service} = mockedService(() => [
      threadRow(61, 1401, 'pool-1-thread-1'),
      threadRow(62, 1402, 'pool-1-thread-2'),
      threadRow(63, 1403, 'pool-1-thread-3'),
    ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {
      processName: 'com.example.app',
      threadName: 'pool-1-thread',
    });

    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') throw new Error('expected ambiguity');
    expect(resolution.candidatesAtLeast).toBe(3);
    expect(resolution.candidates.map(candidate => candidate.utid)).toEqual([61, 62, 63]);
  });

  it('caps the candidate list it hands back', async () => {
    const {service, queries} = mockedService(() =>
      Array.from({length: MAX_THREAD_CANDIDATES + 1}, (_, index) =>
        threadRow(100 + index, 2000 + index, `pool-1-thread-${index}`)));

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {threadName: 'pool-1-thread'});

    if (resolution.status !== 'ambiguous') throw new Error('expected ambiguity');
    expect(resolution.candidates).toHaveLength(MAX_THREAD_CANDIDATES);
    // A lower bound, not a total: the query stopped at the cap plus one, so
    // this says "at least eleven", which is what `candidatesTruncated` reports.
    expect(resolution.candidatesAtLeast).toBe(MAX_THREAD_CANDIDATES + 1);
    expect(queries[0]).toContain(`LIMIT ${MAX_THREAD_CANDIDATES + 1}`);
  });

  it('reports not found when nothing matches either pass', async () => {
    const {service} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {processName: 'com.absent'}))
      .resolves.toEqual({status: 'not_found', reason: 'no_match'});
  });

  it('reports a missing selector without querying the trace', async () => {
    const {service, queries} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {}))
      .resolves.toEqual({status: 'not_found', reason: 'no_selector'});
    expect(queries).toHaveLength(0);
  });

  it('escapes a quote in a name rather than letting it close the literal', async () => {
    const {service, queries} = mockedService(() => []);

    await resolveCriticalPathThread(service, 'trace-1', {processName: "com.ex'ample"});

    expect(queries[0]).toContain("process.name = 'com.ex''ample'");
  });

  it('rejects a non-numeric integer selector', async () => {
    const {service} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {utid: '1 OR 1=1'}))
      .rejects.toThrow('utid must be a non-negative integer');
  });

  // GLOB metacharacters are ordinary characters in a comm or process name, and
  // the prefix pass is the only place a pattern is built. Unescaped, `[` turned
  // the rest of the name into a character class and `*` matched anything.
  it('escapes GLOB metacharacters in a thread name instead of treating them as a pattern', async () => {
    const {service, queries} = mockedService(() => []);

    await resolveCriticalPathThread(service, 'trace-1', {threadName: 'pool[1]-*-?'});

    expect(queries[0]).toContain("thread.name GLOB 'pool[[]1]-[*]-[?]*'");
  });

  it('escapes GLOB metacharacters in a process name, but not in the exact pass', async () => {
    const {service, queries} = mockedService(() => []);

    await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.ex[a]mple*'});

    // The exact pass compares with `=`, where the name is already a literal.
    expect(queries[0]).toContain("process.name = 'com.ex[a]mple*'");
    expect(queries[1]).toContain("process.name GLOB 'com.ex[[]a]mple[*]*'");
  });

  it('still matches the escaped name itself, not only its literal spelling', async () => {
    // Guards the direction the escape exists for: the pattern must select the
    // very thread whose name contains the metacharacters.
    const {service} = mockedService(sql =>
      sql.includes("thread.name GLOB 'pool[[]1]-thread*'")
        ? [threadRow(70, 1500, 'pool[1]-thread-3')]
        : []);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {threadName: 'pool[1]-thread'});

    expect(resolution).toMatchObject({status: 'resolved', thread: {threadName: 'pool[1]-thread-3'}});
  });
});
