// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';

const skill = yaml.load(fs.readFileSync(path.join(__dirname,
  '../../skills/atomic/scene_device_state_changes.skill.yaml'), 'utf8')) as {
  steps: Array<{id: string; sql: string; sql_fragments?: string[]}>;
};

describe('scene device facts retain state semantics', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0,100);
      CREATE TABLE android_screen_state(id INTEGER, ts INTEGER, dur INTEGER,
        simple_screen_state TEXT, short_screen_state TEXT);
      CREATE TABLE android_charging_states(id INTEGER, ts INTEGER, dur INTEGER,
        short_charging_state TEXT, charging_state TEXT);
      CREATE TABLE track(id INTEGER, name TEXT);
      CREATE TABLE slice(id INTEGER, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);`);
  });
  afterEach(() => db.close());
  function rows(step: string, start = 'NULL', end = 'NULL', limit = 4096): Array<Record<string, unknown>> {
    const selected = skill.steps.find(item => item.id === step)!;
    const fragments = (selected.sql_fragments || []).map(file => fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')).join('\n,\n');
    const sql = `${fragments ? `WITH ${fragments}\n` : ''}${selected.sql}`
      .replace(/\$\{start_ts\}/g, start).replace(/\$\{end_ts\}/g, end)
      .replace(/\$\{row_limit\|4096\}/g, String(limit));
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  }

  it('reports missing sources rather than fabricating a stable on/unfolded/charging state', () => {
    expect(rows('state_intervals')).toEqual([]);
    expect(rows('state_sources')).toHaveLength(3);
    expect(rows('state_sources').every(row => row.source_status === 'unavailable')).toBe(true);
  });

  it('retains charging changes, full and not_charging as separate observed states', () => {
    db.exec(`INSERT INTO android_charging_states VALUES
      (1,0,20,'discharging','Discharging'),(2,20,20,'charging','Charging'),
      (3,40,20,'full','Full'),(4,60,40,'not_charging','Not charging');`);
    expect(rows('state_intervals').map(row => row.state_value))
      .toEqual(['discharging', 'charging', 'full', 'not_charging']);
  });

  it('distinguishes Doze/off/unknown and makes no keyguard assertion', () => {
    db.exec(`INSERT INTO android_screen_state VALUES
      (1,0,10,'unknown','unknown'),(2,10,30,'on','on'),
      (3,40,20,'off','off'),(4,60,40,'doze','doze-suspend');`);
    const result = rows('state_intervals');
    expect(result.map(row => row.state_value)).toEqual(['unknown', 'on', 'off', 'doze']);
    expect(result[0].source_status).toBe('unknown');
    expect(result.every(row => row.semantic_limit === 'screen_state_is_not_lock_state')).toBe(true);
  });

  it('reads the DeviceStateChanged track, preserves vendor ids, and carries prior state into a selected window', () => {
    db.exec(`INSERT INTO track VALUES(1,'DeviceStateChanged'),(2,'other');
      INSERT INTO slice VALUES(1,1,10,0,'7:CUSTOM_A'),(2,1,50,0,'42:CUSTOM_B'),
      (3,2,20,0,'DeviceStateChanged'),(4,1,60,5,'not an instant');`);
    const facts = rows('state_intervals', '30', '80');
    expect(facts.filter(row => row.fact_kind === 'event')).toEqual([expect.objectContaining({start_ts: '50', end_ts: '50', dur_ns: '0', state_value: '42:CUSTOM_B'})]);
    const result = facts.filter(row => row.fact_kind === 'state_span');
    expect(result.map(row => [row.start_ts, row.end_ts, row.state_value]))
      .toEqual([['30', '50', '7:CUSTOM_A'], ['50', '80', '42:CUSTOM_B']]);
    expect(result[1].previous_value).toBe('7:CUSTOM_A');
    expect(result.every(row => row.semantic_limit === 'posture_requires_device_state_configuration')).toBe(true);
    expect(result[0].source_start_ts).toBe('10');
  });

  it('preserves large exact timestamps and discloses a truncated tail', () => {
    db.exec(`DELETE FROM trace_bounds;
      INSERT INTO trace_bounds VALUES(9007199254740993,9007199254741093);
      INSERT INTO track VALUES(1,'DeviceStateChanged');
      INSERT INTO slice VALUES(1,1,9007199254740993,0,'A'),(2,1,9007199254740994,0,'B');`);
    const result = rows('state_intervals', 'NULL', 'NULL', 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({start_ts: '9007199254740993', end_ts: '9007199254740993', fact_kind: 'event', dur_ns: '0'});
    expect(result[1]).toMatchObject({start_ts: '9007199254740993', end_ts: '9007199254740994',
      fact_kind: 'state_span', dur_ns: '1', total_rows: 4, output_truncated: 1});
  });
  it('uses the exact clipped fact population for source counts including unknown states', () => {
    db.exec(`INSERT INTO android_screen_state VALUES(1,0,50,'unknown','unknown'),(2,50,50,'on','on');`);
    const summary = rows('state_sources', '20', '80').find(row => row.dimension === 'screen')!;
    expect(summary).toMatchObject({total_rows: 2, observed_rows: 1, output_truncated: 0, cursor_closed: 1});
    expect(rows('state_intervals', '20', '80').length).toBe(summary.total_rows);
    expect(rows('state_sources', '20', '80', 1).every(row => row.output_truncated === 1)).toBe(true);
  });

  it('preserves every same-timestamp commit as an instant and extends only the last commit', () => {
    db.exec(`INSERT INTO track VALUES(1,'DeviceStateChanged');
      INSERT INTO slice VALUES(9,1,10,0,'A'),(10,1,10,0,'B'),(11,1,40,0,'C');`);
    const facts = rows('state_intervals');
    expect(facts.filter(row => row.fact_kind === 'event').map(row => [row.source_id, row.state_value, row.start_ts, row.end_ts, row.dur_ns]))
      .toEqual([['9','A','10','10','0'],['10','B','10','10','0'],['11','C','40','40','0']]);
    expect(facts.filter(row => row.fact_kind === 'state_span').map(row => [row.state_value, row.start_ts, row.end_ts]))
      .toEqual([['B','10','40'],['C','40','100']]);
    expect(rows('state_sources').find(row => row.dimension === 'device_state')).toMatchObject({total_rows: 5, observed_rows: 5});
  });
  it('keeps trace-tail commits without creating a one-nanosecond state span', () => {
    db.exec(`INSERT INTO track VALUES(1,'DeviceStateChanged'); INSERT INTO slice VALUES(1,1,100,0,'TAIL');`);
    expect(rows('state_intervals')).toEqual([expect.objectContaining({fact_kind: 'event', start_ts: '100', end_ts: '100',
      dur_ns: '0', boundary_basis: 'observed_state_commit', state_value: 'TAIL'})]);
    expect(rows('state_sources').find(row => row.dimension === 'device_state')).toMatchObject({total_rows: 1, observed_rows: 1});
  });
  it('assigns boundary events to one adjacent scan and counts event/span truncation together', () => {
    db.exec(`INSERT INTO track VALUES(1,'DeviceStateChanged');
      INSERT INTO slice VALUES(1,1,10,0,'A'),(2,1,50,0,'B'),(3,1,100,0,'TAIL');`);
    const left = rows('state_intervals', '0', '50'); const right = rows('state_intervals', '50', '100');
    expect(left.filter(row => row.fact_kind === 'event').map(row => row.source_id)).toEqual(['1']);
    expect(right.filter(row => row.fact_kind === 'event').map(row => row.source_id)).toEqual(['2','3']);
    expect(rows('state_sources', '50', '100', 1).find(row => row.dimension === 'device_state'))
      .toMatchObject({total_rows: 3, output_truncated: 1, cursor_closed: 1});
    expect(rows('state_intervals', '50', '100', 1)).toEqual([expect.objectContaining({total_rows: 3, output_truncated: 1, fact_kind: 'event'})]);
  });

  it('does not turn an empty requested window into a fabricated zero-duration state span', () => {
    db.exec(`INSERT INTO track VALUES(1,'DeviceStateChanged');
      INSERT INTO slice VALUES(1,1,10,0,'A'),(2,1,100,0,'TAIL');`);
    expect(rows('state_intervals', '50', '50')).toEqual([]);
    expect(rows('state_sources', '50', '50').every(row => row.total_rows === 0)).toBe(true);
    expect(rows('state_intervals', '100', '100')).toEqual([expect.objectContaining({
      fact_kind: 'event', state_value: 'TAIL', start_ts: '100', end_ts: '100', dur_ns: '0'})]);
  });

});
