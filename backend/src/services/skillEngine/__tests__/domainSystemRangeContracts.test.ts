// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import yaml from 'js-yaml';
import {describe, expect, it} from '@jest/globals';

type Skill = {sql?: string; steps?: Array<{id: string; sql?: string}>};
const loadSkill = (file: string): Skill => yaml.load(
  fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')
) as Skill;
const stepSql = (file: string, id?: string): string => {
  const skill = loadSkill(file);
  const sql = id ? skill.steps?.find(step => step.id === id)?.sql : skill.sql;
  if (!sql) throw new Error(`Missing SQL: ${file}/${id}`);
  return sql;
};
const run = (schema: string, sql: string, start = 10_000_000, end = 20_000_000): Array<Record<string, unknown>> => {
  const params: Record<string, string> = {
    start_ts: String(start), end_ts: String(end), package: '', '__process_scope.upid': '1',
  };
  const statement = sql.replace(/\$\{([^}]+)}/g, (_token, name: string) => {
    if (!(name in params)) throw new Error(`Missing fixture parameter: ${name}`);
    return params[name];
  }).replace(/trace_start\(\)/g, '0').replace(/trace_end\(\)/g, '30000000');
  // SQLite executes the same portable interval arithmetic; native Perfetto SQL
  // schema/module execution is covered by the registered Trace regression gate.
  const result = spawnSync('sqlite3', ['-json', ':memory:'], {
    input: `${schema}\n${statement};`, encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout || '[]');
};

const sliceSchema = `
  CREATE TABLE slice(track_id INTEGER, name TEXT, ts INTEGER, dur INTEGER, id INTEGER PRIMARY KEY);
  CREATE TABLE thread_track(id INTEGER, utid INTEGER);
  CREATE TABLE thread(utid INTEGER, upid INTEGER, name TEXT);
  CREATE TABLE process(upid INTEGER, name TEXT);
  INSERT INTO process VALUES (1, 'app');
  INSERT INTO thread VALUES (1, 1, 'main'), (2, 1, 'kswapd0');
  INSERT INTO thread_track VALUES (1, 1), (2, 2);
`;
const counterSchema = `
  CREATE TABLE counter(id INTEGER, track_id INTEGER, ts INTEGER, value REAL);
  CREATE TABLE counter_track(id INTEGER, name TEXT, unit TEXT, type TEXT);
  CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
`;

describe('domain system evidence range contracts', () => {
  const frequencySql = stepSql('atomic/cpu_freq_residency_summary.skill.yaml', 'freq_residency');
  const frequencySchema = `
    CREATE TABLE cpu(ucpu INTEGER, cpu INTEGER, machine_id INTEGER);
    CREATE TABLE android_cpu_cluster_mapping(ucpu INTEGER, cpu INTEGER, cluster_type TEXT);
    CREATE TABLE cpu_frequency_counters(ucpu INTEGER, cpu INTEGER, ts INTEGER, dur INTEGER, freq REAL);
    INSERT INTO cpu VALUES (1, 0, 0), (2, 1, 0), (3, 2, 0), (4, 0, 1);
    INSERT INTO android_cpu_cluster_mapping VALUES
      (1, 0, 'little'), (2, 1, 'little'), (3, 2, NULL), (4, 0, 'big');
    INSERT INTO cpu_frequency_counters VALUES
      (1, 0, 0, 12000000, 1000000), (1, 0, 12000000, 8000000, 2000000),
      (1, 0, 20000000, 10000000, 9000000),
      (2, 1, 10000000, 5000000, NULL), (2, 1, 15000000, 5000000, 1000000),
      (3, 2, 15000000, -1, 4000000), (4, 0, 10000000, 10000000, 500000);
  `;

  it('weights frequency intersections, reports missing coverage, and joins unique CPUs across machines', () => {
    const rows = run(frequencySchema, frequencySql);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.cluster_type === 'little')).toMatchObject({
      machine_id: 0, cpu_count: 2, weighted_avg_freq_mhz: 1533,
      high_freq_ratio_pct: 86.67, max_freq_mhz: 2000,
      frequency_coverage_pct: 75, frequency_coverage_status: 'partial',
      high_frequency_basis: '80_percent_of_each_cpu_window_observed_peak_not_hardware_limit',
    });
    expect(rows.find(row => row.cluster_type === 'unknown')).toMatchObject({
      weighted_avg_freq_mhz: null, total_residency_sec: null,
      frequency_coverage_pct: 0, frequency_coverage_status: 'missing', censored_interval_count: 1,
    });
    expect(rows.find(row => row.machine_id === 1)).toMatchObject({
      cpu_count: 1, weighted_avg_freq_mhz: 500, frequency_coverage_pct: 100,
    });
    expect(run(frequencySchema, frequencySql, 20, 20)).toEqual([]);
  });

  it('clips GPU operation slices at both boundaries and retains unknown ends without negative durations', () => {
    const sql = stepSql('atomic/gpu_render_in_range.skill.yaml')
      .replace('WITH gpu_slices AS', 'WITH effective_target_processes AS (SELECT 1 AS upid), gpu_slices AS');
    const schema = `${sliceSchema}
      INSERT INTO slice(track_id, name, ts, dur) VALUES
        (1, 'DrawFrame', 5000000, 10000000), (1, 'DrawFrame', 15000000, 10000000),
        (1, 'DrawFrame', 20000000, 10000000), (1, 'DrawFrame', 17000000, -1),
        (1, 'waitForFence', 18000000, -1);
    `;
    const rows = run(schema, sql);
    expect(rows.find(row => row.operation === 'Draw Frame')).toMatchObject({
      count: 3, total_ms: 10, max_ms: 5, avg_ms: 5, censored_slice_count: 1,
    });
    expect(rows.find(row => row.operation === 'Fence Wait')).toMatchObject({
      count: 1, total_ms: null, max_ms: null, avg_ms: null, censored_slice_count: 1,
    });
    expect(run(schema, sql, 20, 20)).toEqual([]);
  });

  const memorySql = stepSql('atomic/memory_pressure_in_range.skill.yaml', 'memory_pressure_analysis');
  const memorySchema = `${sliceSchema}${counterSchema}
    CREATE TABLE raw(ts INTEGER, name TEXT);
    INSERT INTO counter_track(id, name) VALUES (1, 'mem.some_psi');
    INSERT INTO counter VALUES (1, 1, 9000000, 999), (2, 1, 10000000, 10),
      (3, 1, 19000000, 30), (4, 1, 20000000, 999);
    INSERT INTO slice(track_id, name, ts, dur) VALUES
      (2, 'reclaim', 5000000, 10000000),
      (1, 'direct_reclaim', 15000000, 10000000),
      (1, 'direct_reclaim', 17000000, -1),
      (1, 'direct_reclaim', 20000000, 10000000),
      (1, 'compact', 5000000, 20000000),
      (1, 'alloc_pages', 18000000, -1),
      (1, 'lmkd', 10000000, 0), (1, 'lmkd', 20000000, 0);
    INSERT INTO raw VALUES (10000000, 'mm_filemap_add_to_page_cache'),
      (20000000, 'mm_filemap_add_to_page_cache');
  `;

  it('clips memory spans, counts half-open instant events, and labels PSI arithmetic sample means', () => {
    const [row] = run(memorySchema, memorySql);
    expect(row).toMatchObject({
      kswapd_events: 1, kswapd_total_ms: 5,
      direct_reclaim_events: 2, direct_reclaim_total_ms: 5,
      compaction_total_ms: 10, alloc_stall_max_ms: null,
      lmk_events: 1, page_cache_add_events: 1,
      psi_max: 30, psi_avg: 20, psi_sample_count: 2, psi_metric_count: 1,
      censored_event_count: 2,
    });
    expect(row.psi_aggregation_basis).toContain('not_time_weighted');
    expect(row.duration_basis).toContain('unknown_ends_excluded');
  });

  it('does not combine incompatible PSI tracks into one scalar', () => {
    const [row] = run(`${memorySchema}
      INSERT INTO counter_track(id, name) VALUES (2, 'mem.full_psi');
      INSERT INTO counter VALUES (5, 2, 15000000, 9000);
    `, memorySql);
    expect(row).toMatchObject({psi_max: null, psi_avg: null, psi_sample_count: 3, psi_metric_count: 2});
  });

  const thermalSchema = `${counterSchema}
    INSERT INTO counter_track VALUES
      (1, 'thermal.cpu', 'C', 'thermal_temperature'), (2, 'cooling_device', NULL, 'cooling_device_counter');
    INSERT INTO cpu_counter_track VALUES (3, 0, 'cpufreq');
    INSERT INTO counter VALUES
      (1, 1, 0, 99), (2, 1, 10000000, 40), (3, 1, 19000000, 60), (4, 1, 20000000, 999),
      (5, 2, 0, 99), (6, 2, 10000000, 2), (7, 2, 19000000, 4), (8, 2, 20000000, 99),
      (9, 3, 9999999, 2000000), (10, 3, 10000000, 1000000),
      (11, 3, 19000000, 500000), (12, 3, 20000000, 100000);
  `;
  const thermalSql = (id: string): string => stepSql('modules/hardware/thermal_module.skill.yaml', id);

  it('bounds thermal samples in all evidence paths and keeps the predecessor of a window-start drop', () => {
    const [overview] = run(thermalSchema, thermalSql('temperature_overview'));
    expect(overview).toMatchObject({sample_count: 2, min_temp: 40, max_temp: 60, avg_temp: 50, source_unit: 'C'});
    expect(overview.aggregation_basis).toContain('sample_mean');
    expect(run(thermalSchema, thermalSql('temperature_timeline'))[0]).toMatchObject({avg_temp: 50, max_temp: 60});
    expect(run(thermalSchema, thermalSql('high_temp_periods'))).toEqual([]);
    expect(run(thermalSchema, thermalSql('cooling_activity'))[0]).toMatchObject({
      min_level: 2, max_level: 4, avg_level: 3, sample_count: 2,
    });
    expect(run(thermalSchema, thermalSql('throttling_events'))).toEqual([
      expect.objectContaining({ts: 10000000, prev_freq_mhz: 2000, new_freq_mhz: 1000}),
      expect.objectContaining({ts: 19000000, prev_freq_mhz: 1000, new_freq_mhz: 500}),
    ]);
    expect(run(thermalSchema, thermalSql('thermal_cpu_correlation'))[0]).toMatchObject({
      max_temp: 60, avg_freq_mhz: 750, status: 'no_threshold_coincidence',
      correlation_basis: 'same_second_sample_aggregation_not_causal_or_time_weighted',
    });
  });

  it('retains untyped temperature samples without inventing Celsius or thermal thresholds', () => {
    const schema = `${thermalSchema}
      UPDATE counter_track SET unit = NULL WHERE id = 1;
      UPDATE counter SET value = value * 1000 WHERE track_id = 1;
    `;
    expect(run(schema, thermalSql('temperature_overview'))[0]).toMatchObject({
      source_unit: null, avg_temp: 50000, status: 'unit_unknown_or_unsupported',
    });
    expect(run(schema, thermalSql('high_temp_periods'))).toEqual([]);
    expect(run(schema, thermalSql('thermal_cpu_correlation'))).toEqual([]);
  });

  it('identifies the first-to-last high sample span without claiming continuous high temperature', () => {
    const schema = `${thermalSchema}
      INSERT INTO counter VALUES (13, 1, 2000000000, 75), (14, 1, 9000000000, 80);
    `;
    const [row] = run(schema, thermalSql('high_temp_periods'), 1_000_000_000, 10_000_000_000);
    expect(row).toMatchObject({duration_sec: 7, sample_count: 2,
      duration_basis: 'first_to_last_high_sample_span_not_continuous_hot_duration'});
  });

  const cpuLoadSql = (id: string): string => stepSql('atomic/cpu_load_in_range.skill.yaml', id)
    .replace('WITH system_windows AS', `WITH ${fs.readFileSync(
      path.join(process.cwd(), 'skills/fragments/system_sched_spans.sql'), 'utf8'
    )}, system_windows AS`);
  const cpuLoadSchema = `${counterSchema}
    ALTER TABLE cpu_counter_track ADD COLUMN machine_id INTEGER;
    CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
    INSERT INTO trace_bounds VALUES(0,20000000);
    CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
    INSERT INTO cpu VALUES (1,0,0,0,100),(2,1,0,1,200),(3,2,0,2,300),(4,3,0,2,300),(5,0,1,0,300);
    CREATE TABLE thread(utid INTEGER,upid INTEGER,is_idle INTEGER);
    INSERT INTO thread VALUES (99,NULL,1),(10,1,0),(11,1,0),(12,2,0);
    CREATE TABLE sched_slice(id INTEGER,utid INTEGER,cpu INTEGER,ucpu INTEGER,
      ts INTEGER,dur INTEGER,end_state TEXT,priority INTEGER);
    INSERT INTO sched_slice VALUES
      (1,99,0,1,5000000,10000000,'S',120),
      (2,10,1,2,0,10000000,'S',120),
      (3,10,0,1,15000000,5000000,'S',120),
      (4,11,0,1,0,5000000,'S',120),
      (5,11,1,2,10000000,5000000,'S',120),
      (6,11,2,3,15000000,-1,'R+',120),
      (7,88,1,2,15000000,5000000,'S',120),
      (8,12,0,1,0,5000000,'S',120),
      (9,12,0,5,10000000,5000000,'S',120);
  `;

  it('CPU load uses native idle identity and CPU-window denominators without multiplying by thread count', () => {
    const rows = run(cpuLoadSchema, cpuLoadSql('cpu_utilization'));
    expect(rows.find(row => row.core_type === 'little')).toMatchObject({
      cpu_count: 1, utilization_pct: 50, total_time_ms: 10, busy_ns: 5000000,
      idle_ns: 5000000, sched_coverage_pct: 100, sched_evidence: 'observed',
    });
    expect(rows.find(row => row.core_type === 'medium')).toMatchObject({
      utilization_pct: 50, idle_identity_unknown_ns: 5000000, sched_evidence: 'partial',
    });
    expect(rows.find(row => row.core_type === 'big')).toMatchObject({
      cpu_count: 2, utilization_pct: 25, cluster_window_ns: 20000000,
      unfinished_sched_ns: 5000000, sched_coverage_pct: 25, sched_evidence: 'partial',
    });
    expect(rows.find(row => row.machine_id === 1)).toMatchObject({
      core_type: 'unknown', cpu_count: 1, utilization_pct: 50,
    });
  });

  it('runqueue samples resolve CPU ordinal with machine identity and retain a labeled arithmetic mean', () => {
    const rows = run(`${cpuLoadSchema}
      INSERT INTO cpu_counter_track VALUES (1,0,'runqueue_length',0),(2,0,'runqueue_length',1);
      INSERT INTO counter VALUES (1,1,9000000,99),(2,1,10000000,2),(3,1,19000000,6),
        (4,1,20000000,99),(5,2,11000000,20);
    `, cpuLoadSql('runqueue_depth'));
    expect(rows).toEqual([
      expect.objectContaining({ucpu:1,cpu:0,machine_id:0,avg_runqueue:4,max_runqueue:6,sample_count:2,
        aggregation_basis:'arithmetic_sample_mean_not_time_weighted'}),
      expect.objectContaining({ucpu:5,cpu:0,machine_id:1,avg_runqueue:20,sample_count:1}),
    ]);
  });

  it('migration arrivals include window-start transitions, use native clusters and reject cross-machine continuity', () => {
    expect(run(cpuLoadSchema, cpuLoadSql('thread_migrations'))[0]).toMatchObject({
      migration_count: 3, cross_cluster_migrations: 3, little_big_group_migrations: 2,
      unresolved_transition_count: 1, migration_coverage_status: 'unresolved_transitions',
    });
    expect(run(cpuLoadSchema, cpuLoadSql('thread_migrations'), 20, 20)[0]).toMatchObject({
      migration_count: 0, cross_cluster_migrations: 0,
      migration_coverage_status: 'no_observed_runs',
    });
  });
});
