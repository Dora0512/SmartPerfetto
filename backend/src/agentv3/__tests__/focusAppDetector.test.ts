// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { detectFocusApps, focusAppTimeRangeFromSelection } from '../focusAppDetector';
import type { TraceProcessorService } from '../../services/traceProcessorService';

function mockTraceProcessor(rowsByCall: unknown[][][]): TraceProcessorService {
  const query = jest.fn(async (_traceId: string, _sql: string) => {
    const rows = rowsByCall.shift() || [];
    return { columns: [], rows };
  });
  return { query } as unknown as TraceProcessorService;
}

/** Always answers tier 1, so every call that reaches the trace is visible. */
function mockRepeatingTraceProcessor(packageName: string): TraceProcessorService {
  const query = jest.fn(async () => ({ columns: [], rows: [[packageName, 4_000_000_000, 1]] }));
  return { query } as unknown as TraceProcessorService;
}

describe('detectFocusApps', () => {
  it('requires complete selection bounds before deriving a focus app time range', () => {
    expect(focusAppTimeRangeFromSelection({
      kind: 'area',
      endNs: 2_000_000_000,
    })).toBeUndefined();
    expect(focusAppTimeRangeFromSelection({
      kind: 'area',
      startNs: 1_000_000_000,
      endNs: 2_000_000_000,
    })).toEqual({ startNs: 1_000_000_000, endNs: 2_000_000_000 });
  });

  it('uses battery_stats.top and filters system packages', async () => {
    const service = mockTraceProcessor([
      [
        ['com.android.systemui', 5_000_000_000, 1],
        ['com.miui.home', 4_500_000_000, 1],
        ['/vendor/bin/hw/vendor.foo', 4_250_000_000, 1],
        ['surfaceflinger', 4_100_000_000, 1],
        ['com.example.app', 4_000_000_000, 1],
      ],
    ]);

    const result = await detectFocusApps(service, 'trace-1');

    expect(result.method).toBe('battery_stats');
    expect(result.primaryApp).toBe('com.example.app');
    expect(result.apps.map(app => app.packageName)).toEqual(['com.example.app']);
  });

  it('scopes battery_stats focus detection to the selected time range', async () => {
    const service = mockTraceProcessor([
      [
        ['com.example.app', 800_000_000, 1],
      ],
    ]);

    const result = await detectFocusApps(service, 'trace-1', {
      timeRange: { startNs: 1_000_000_000, endNs: 2_000_000_000 },
    });
    const queryMock = service.query as jest.Mock;
    const batterySql = String(queryMock.mock.calls[0][1]);

    expect(result.method).toBe('battery_stats');
    expect(result.primaryApp).toBe('com.example.app');
    expect(result.timeRange).toEqual({ startNs: 1_000_000_000, endNs: 2_000_000_000 });
    expect(result.apps[0]).toMatchObject({
      scopeStartNs: 1_000_000_000,
      scopeEndNs: 2_000_000_000,
    });
    expect(batterySql).toContain('ts');
    expect(batterySql).toContain('1000000000');
    expect(batterySql).toContain('2000000000');
    expect(batterySql).toContain('SUM(MAX(0, MIN((ts) + (safe_dur), 2000000000) - MAX((ts), 1000000000)))');
  });

  it('does not filter user packages that merely contain system words', async () => {
    const service = mockTraceProcessor([
      [
        ['com.example.initializer', 4_000_000_000, 1],
      ],
    ]);

    const result = await detectFocusApps(service, 'trace-1');

    expect(result.method).toBe('battery_stats');
    expect(result.primaryApp).toBe('com.example.initializer');
  });

  it('falls back to oom_adj with android process metadata package names', async () => {
    const service = mockTraceProcessor([
      [],
      [['com.correct.app', 3_000_000_000, 2]],
    ]);

    const result = await detectFocusApps(service, 'trace-1');
    const queryMock = service.query as jest.Mock;
    const oomSql = String(queryMock.mock.calls[1][1]);

    expect(result.method).toBe('oom_adj');
    expect(result.primaryApp).toBe('com.correct.app');
    expect(oomSql).toContain('INCLUDE PERFETTO MODULE android.process_metadata');
    expect(oomSql).toContain('oa.score <= 0');
    expect(oomSql).not.toContain('oa.oom_adj');
    expect(oomSql).not.toContain('50000000');
  });

  it('falls back to FrameTimeline with metadata package and layer before raw process names', async () => {
    const service = mockTraceProcessor([
      [],
      [],
      [['com.layer.owner', 2_000_000_000, 120]],
    ]);

    const result = await detectFocusApps(service, 'trace-1');
    const queryMock = service.query as jest.Mock;
    const frameSql = String(queryMock.mock.calls[2][1]);

    expect(result.method).toBe('frame_timeline');
    expect(result.primaryApp).toBe('com.layer.owner');
    expect(frameSql).toContain('INCLUDE PERFETTO MODULE android.process_metadata');
    expect(frameSql).toContain('actual_frame_timeline_slice');
    expect(frameSql.indexOf("NULLIF(m.package_name, '')")).toBeLessThan(frameSql.indexOf("NULLIF(m.process_name, '')"));
    expect(frameSql.indexOf("THEN SUBSTR(layer_name, 6")).toBeLessThan(frameSql.indexOf("NULLIF(m.process_name, '')"));
    expect(frameSql).not.toContain('50000000');
  });

  // Bounded turns run this preflight too, so a second question about the same
  // trace must not walk the tier ladder again. The scope is part of the key:
  // a different selected range is a different answer.
  it('reuses a detected focus app per trace and scope without re-querying', async () => {
    const service = mockRepeatingTraceProcessor('com.example.app');
    const queryMock = service.query as jest.Mock;

    expect((await detectFocusApps(service, 'trace-1')).primaryApp).toBe('com.example.app');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((await detectFocusApps(service, 'trace-1')).primaryApp).toBe('com.example.app');
    expect(queryMock).toHaveBeenCalledTimes(1);

    await detectFocusApps(service, 'trace-1', { timeRange: { startNs: 1, endNs: 2 } });
    expect(queryMock).toHaveBeenCalledTimes(2);
    await detectFocusApps(service, 'trace-2');
    expect(queryMock).toHaveBeenCalledTimes(3);
    await detectFocusApps(service, 'trace-1', { timeRange: { startNs: 1, endNs: 2 } });
    expect(queryMock).toHaveBeenCalledTimes(3);

    // A different processor service is a different trace world.
    const other = mockRepeatingTraceProcessor('com.other.app');
    expect((await detectFocusApps(other, 'trace-1')).primaryApp).toBe('com.other.app');
    expect(other.query).toHaveBeenCalledTimes(1);
  });

  // `none` cannot tell an empty trace from a transient failure, so caching it
  // would pin that failure to the trace for the life of the process.
  it('does not cache a result that found no focus app', async () => {
    const service = mockTraceProcessor([[], [], [], [['com.example.app', 4_000_000_000, 1]]]);
    const queryMock = service.query as jest.Mock;

    expect((await detectFocusApps(service, 'trace-none')).method).toBe('none');
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect((await detectFocusApps(service, 'trace-none')).primaryApp).toBe('com.example.app');
    expect(queryMock).toHaveBeenCalledTimes(4);
  });
});
