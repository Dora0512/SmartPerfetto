// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';

const skill = yaml.load(fs.readFileSync(path.join(__dirname, '../../skills/atomic/scene_response_markers.skill.yaml'), 'utf8')) as {
  steps: Array<{id: string; sql: string; sql_fragments: string[]}>;
};
describe('scene response marker inventory', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER); INSERT INTO trace_bounds VALUES(0,1000000000);
      CREATE TABLE slice(id INTEGER,ts INTEGER,dur INTEGER,name TEXT,track_id INTEGER);
      CREATE TABLE track(id INTEGER,name TEXT,type TEXT);
      CREATE TABLE thread_track(id INTEGER,utid INTEGER); CREATE TABLE thread(utid INTEGER,upid INTEGER,name TEXT);
      CREATE TABLE process_track(id INTEGER,upid INTEGER); CREATE TABLE process(upid INTEGER,name TEXT);
      INSERT INTO track VALUES(178,'main','thread_execution'),(331,'Scroll','atrace_async_slice'),(999,'global','generic');
      INSERT INTO thread_track VALUES(178,77); INSERT INTO thread VALUES(77,885,'main');
      INSERT INTO process_track VALUES(331,885); INSERT INTO process VALUES(885,'app');`);
  });
  afterEach(() => db.close());
  const marker = (id: number, ts: bigint, dur: bigint, name: string, track = 178) =>
    db.prepare('INSERT INTO slice VALUES(?,?,?,?,?)').run(id, ts, dur, name, track);
  function rows(step: string, start = 'NULL', end = 'NULL', limit = 4096): Array<Record<string, any>> {
    const selected = skill.steps.find(value => value.id === step)!;
    const fragment = selected.sql_fragments.map(file => fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')).join('\n,\n');
    const sql = `WITH ${fragment}\n${selected.sql}`.replace(/\$\{start_ts\}/g, start).replace(/\$\{end_ts\}/g, end)
      .replace(/\$\{row_limit\|4096\}/g, String(limit));
    return db.prepare(sql).all() as Array<Record<string, any>>;
  }
  it('retains the thread FlingStart and process-track Scroll without using name duration as the action end', () => {
    marker(6861, 200000000n, 781n, 'FlingStart duration=1580, direction=VERTICAL, caller=UNKNOWN');
    marker(2169, 300000000n, 100600833n, 'Scroll', 331);
    const observed = rows('response_markers');
    expect(observed[0]).toMatchObject({slice_id: 6861, ts: '200000000', dur: '781', end_ts: '200000781',
      raw_name: 'FlingStart duration=1580, direction=VERTICAL, caller=UNKNOWN', upid: 885, utid: 77,
      process_name: 'app', identity_basis: 'thread_track', source_status: 'observed', name_parameter_semantics: 'uninterpreted_producer_text'});
    expect(observed[1]).toMatchObject({slice_id: 2169, raw_name: 'Scroll', ts: '300000000', dur: '100600833', end_ts: '400600833',
      upid: 885, utid: null, identity_basis: 'process_track', track_type: 'atrace_async_slice'});
    expect(observed.every(row => row.semantic_limit === 'slice_execution_only_not_action_extent_or_presentation')).toBe(true);
    expect(rows('response_sources')[0]).toMatchObject({total_rows: 2, cursor_closed: 1, output_truncated: 0, capture_status: 'unknown'});
  });
  it('matches only the declared exact names and FlingStart space prefix', () => {
    ['FlingStart', 'FlingStart duration=1497', 'Scroll', 'FlingStartFake', 'otherScroll', 'flingstart', 'ScrollView'].forEach((name, index) =>
      marker(index + 1, BigInt(index), 1n, name));
    expect(rows('response_markers').map(row => row.raw_name)).toEqual(['FlingStart', 'FlingStart duration=1497', 'Scroll']);
  });
  it('reports zero matching rows without claiming a complete capture or absent application response', () => {
    expect(rows('response_markers')).toEqual([]);
    expect(rows('response_sources')[0]).toMatchObject({total_rows: 0, cursor_closed: 1, source_status: 'unavailable',
      capture_status: 'unknown', coverage_limit: 'query_population_only_not_all_application_responses'});
  });
  it('keeps open ends null and unknown tracks unassigned', () => {
    marker(1, 100n, -1n, 'FlingStart duration=999999', 999);
    expect(rows('response_markers')).toEqual([expect.objectContaining({ts: '100', dur: '-1', end_ts: null,
      scan_end_ts: null, boundary_kind: 'open', source_status: 'partial', upid: null, identity_basis: 'unresolved'})]);
    expect(rows('response_sources')[0]).toMatchObject({total_rows: 1, open_marker_count: 1, parse_failure_count: 0});
  });
  it('preserves raw execution bounds while clipping only the scan intersection', () => {
    marker(1, 100n, 100n, 'Scroll', 331);
    expect(rows('response_markers', '130', '160')[0]).toMatchObject({ts: '100', dur: '100', end_ts: '200',
      scan_start_ts: '130', scan_end_ts: '160', window_clipped: 1, source_status: 'partial'});
    expect(rows('response_sources', '130', '160')[0]).toMatchObject({start_ts: '130', end_ts: '160', total_rows: 1});
    expect(rows('response_markers', '150', '150')).toEqual([]);
  });
  it('preserves int64 timestamps and exposes a producer-truncated tail', () => {
    db.exec('DELETE FROM trace_bounds; INSERT INTO trace_bounds VALUES(9007199254740993,9007199254741993)');
    marker(1, 9007199254740994n, 1n, 'Scroll'); marker(2, 9007199254740996n, 1n, 'FlingStart');
    expect(rows('response_markers', 'NULL', 'NULL', 1)).toEqual([expect.objectContaining({ts: '9007199254740994',
      dur: '1', end_ts: '9007199254740995', total_rows: 2, output_truncated: 1})]);
    expect(rows('response_sources', 'NULL', 'NULL', 1)[0]).toMatchObject({total_rows: 2, output_truncated: 1});
    expect(rows('response_markers', 'NULL', 'NULL', -1)).toHaveLength(1);
  });
  it('does not assign conflicting thread/process owners or invent an overflowing end', () => {
    db.exec('INSERT INTO process_track VALUES(178,886); DELETE FROM trace_bounds; INSERT INTO trace_bounds VALUES(0,9223372036854775807)');
    marker(1, 9223372036854775700n, 200n, 'Scroll');
    expect(rows('response_markers')[0]).toMatchObject({end_ts: null, boundary_kind: 'invalid', upid: null,
      utid: null, identity_basis: 'conflict', source_status: 'partial'});
    expect(rows('response_sources')[0].parse_failure_count).toBe(1);
  });
  it('places instant markers in a single adjacent window and retains a trace-tail instant', () => {
    marker(1, 50n, 0n, 'Scroll'); marker(2, 1000000000n, 0n, 'FlingStart');
    expect(rows('response_markers', '0', '50')).toEqual([]);
    expect(rows('response_markers', '50', '100').map(row => row.slice_id)).toEqual([1]);
    expect(rows('response_markers', '1000000000', '1000000000').map(row => row.slice_id)).toEqual([2]);
  });
});
