// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {SQLValidator} from '../sqlValidator';

const validate = (sql: string) => new SQLValidator().validateSQL(sql);

describe('SQLValidator', () => {
  it('accepts built-in tables, stdlib module tables and the query\'s own CTEs', () => {
    const result = validate(`
      INCLUDE PERFETTO MODULE android.startup.startups;
      WITH main AS (SELECT utid FROM thread t WHERE t.is_main_thread = 1)
      SELECT s.startup_id, ts.state
      FROM android_startups s
      JOIN thread_state AS ts ON ts.ts BETWEEN s.ts AND s.ts + s.dur
      JOIN main m USING (utid)
      LEFT JOIN (SELECT id FROM slice) sub ON sub.id = s.startup_id
    `);
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('rejects tables that exist in neither the trace processor nor the stdlib', () => {
    const result = validate('SELECT msg FROM android_log WHERE prio > 4');
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(['Unknown table: android_log']);
  });

  it('ignores names inside comments and string literals', () => {
    const result = validate("-- FROM not_a_table\nSELECT 'FROM also_not_a_table' AS note FROM slice");
    expect(result.errors).toEqual([]);
  });

  it('keeps the syntax checks that Perfetto SQL actually rejects', () => {
    expect(validate("SELECT STRING_AGG(name, ',') FROM slice").errors)
      .toEqual(['STRING_AGG is not supported; use GROUP_CONCAT']);
    expect(validate("SELECT GROUP_CONCAT(name, ',') FROM slice").isValid).toBe(true);
  });
});
