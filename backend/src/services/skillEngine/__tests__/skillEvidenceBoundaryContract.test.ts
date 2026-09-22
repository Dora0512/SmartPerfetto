// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { describe, expect, it } from '@jest/globals';

const repoRoot = path.resolve(__dirname, '../../../..');

function readBackendFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Skill evidence boundary contracts', () => {
  it('keeps network_analysis scoped to packet evidence unless request telemetry exists', () => {
    const content = readBackendFile('skills/composite/network_analysis.skill.yaml');

    expect(content).toContain('id: evidence_scope');
    expect(content).toContain('trace_direct:packet_activity');
    expect(content).toContain('不能直接证明 DNS/TCP/TLS/TTFB/请求体/响应体/解码/服务端处理阶段耗时');
    expect(content).toContain('HTTPDNS 缓存/TTL');
    expect(content).toContain('ECH/CT/local-network permission/NetworkCallback');
    expect(content).toContain('OkHttp/Cronet/HttpEngine/自研网络库阶段埋点');
    expect(content).toContain('NETWORK_DNS_PACKET_ACTIVITY');
    expect(content).toContain('当前 packet trace 不能直接证明 DNS 阶段耗时或请求延迟');
    expect(content).not.toContain('DNS 查询频繁，可能导致网络延迟');
  });

  it('keeps wakelock vitals hints tied to the observed window', () => {
    const content = readBackendFile('skills/atomic/android_kernel_wakelock_summary.skill.yaml');

    expect(content).toContain('observed_window_hours');
    expect(content).toContain('evidence_scope');
    expect(content).toContain('partial_trace_window');
    expect(content).toContain('partial_window_not_vitals_judgment');
    expect(content).not.toContain('excessive_if_24h_window');
  });
});

// Execute the maintained SQL rather than mirroring the temperature filters.
function thermalQuery(db: Database.Database, stepId: string, start = 'NULL', end = 'NULL'): any[] {
  const definition = yaml.load(readBackendFile('skills/composite/thermal_throttling.skill.yaml')) as any;
  const step = definition.steps.find((item: any) => item.id === stepId);
  const fragments = (step.sql_fragments ?? []).map((file: string) => readBackendFile(`skills/${file}`)).join('\n,\n');
  let sql: string = step.sql;
  if (fragments) sql = /^WITH\s/i.test(sql) ? sql.replace(/^WITH\s/i, `WITH ${fragments}\n,\n`) : `WITH ${fragments}\n${sql}`;
  sql = sql.replace(/\$\{start_ts\}/g, start).replace(/\$\{end_ts\}/g, end)
    .replace(/\$\{[^}|]+\|([^}]*)\}/g, (_: string, fallback: string) => fallback);
  return db.prepare(sql).all();
}

function temperatureFixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
    CREATE TABLE counter_track(id INTEGER, name TEXT, unit TEXT, type TEXT);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);`);
  return db;
}

function addTemperature(db: Database.Database, id: number, name: string, unit: string | null, values: number[], interval = 1000000000, type: string | null = null) {
  db.prepare('INSERT INTO counter_track(id,name,unit,type) VALUES(?,?,?,?)').run(id,name,unit,type);
  values.forEach((value, index) => db.prepare('INSERT INTO counter(track_id,ts,value) VALUES(?,?,?)').run(id,index*interval,value));
}

describe('temperature evidence quality and DVFS causal boundary', () => {
  it('excludes sparse spikes and UI counters from peaks, retaining skin identity and reasons', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'virtual-sensor-skin Temperature',null,[34114,34800,35500,35874,35000,34400]);
      addTemperature(db,2,'cpu-1-0-1 Temperature',null,[90300,74800],19598000);
      addTemperature(db,3,'VRI[ThermalActivity]',null,[0,1,2,3,4,0]);
      const rows = thermalQuery(db,'thermal_overview');
      expect(rows.find(row=>row.sensor_track_id===1)).toMatchObject({max_temp_c:35.9,sample_quality:'accepted',unit_basis:'inferred_from_track_range'});
      expect(rows.find(row=>row.sensor_track_id===2)).toMatchObject({max_temp_c:null,raw_max_temp_c:90.3,sample_quality:'insufficient_samples'});
      expect(rows.find(row=>row.sensor_track_id===3)).toMatchObject({max_temp_c:null,sample_quality:'implausible_range'});
      expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'DATA_SUSPECT',peak_temp_c:35.9,throttled_cpu_count:null});
      expect(thermalQuery(db,'thermal_timeline').every(row=>row.sensor_track_id===1)).toBe(true);
      expect(thermalQuery(db,'high_temp_periods')).toEqual([]);
    } finally {db.close();}
  });

  it('reads Perfetto-typed thermal_temperature tracks as millidegrees regardless of value range', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'cpu-big Temperature',null,[34000,35000,36000,37000,38000,39000],1000000000,'thermal_temperature');
      addTemperature(db,2,'skin-ish Temperature',null,[34,35,36,37,38,39]);
      const rows = thermalQuery(db,'thermal_overview');
      expect(rows.find(row=>row.sensor_track_id===1)).toMatchObject({unit_basis:'perfetto_track_type',sample_quality:'accepted',max_temp_c:39});
      expect(rows.find(row=>row.sensor_track_id===2)).toMatchObject({unit_basis:'inferred_from_track_range',sample_quality:'accepted',max_temp_c:39});
    } finally {db.close();}
  });

  it('keeps same-name tracks separate, detects jumps, respects units and analysis bounds', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'cpu Temperature','C',[70,71,72,73,74]);
      addTemperature(db,2,'cpu Temperature','C',[90,70,71,72,73],20000000);
      addTemperature(db,3,'other Temperature','F',[70,71,72,73,74]);
      const rows = thermalQuery(db,'thermal_overview');
      expect(rows).toHaveLength(3);
      expect(rows.find(row=>row.sensor_track_id===1)).toMatchObject({sample_quality:'accepted',max_temp_c:74});
      expect(rows.find(row=>row.sensor_track_id===2)).toMatchObject({sample_quality:'abrupt_jump',max_temp_c:null});
      expect(rows.find(row=>row.sensor_track_id===3)).toMatchObject({sample_quality:'unsupported_unit',max_temp_c:null});
      expect(thermalQuery(db,'thermal_overview','0','2000000000').every(row=>row.sample_quality!=='accepted')).toBe(true);
    } finally {db.close();}
  });

  it('preserves real high temperatures and sustained periods without inferring throttling', () => {
    const db = temperatureFixture();
    try {
      addTemperature(db,1,'cpu Temperature','C',[80,81,82,83,84,85]);
      expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'HIGH_TEMP_OBSERVED',peak_temp_c:85,thermal_throttling_evidence:'not_established'});
      expect(thermalQuery(db,'high_temp_periods')[0]).toMatchObject({duration_sec:5,sample_count:6,peak_temp_c:85});
      addTemperature(db,2,'skin Temperature','C',[34,35,35,35,34,34]);
      expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'DATA_SUSPECT',peak_temp_c:85});
      expect(thermalQuery(db,'thermal_overview').every(row=>row.sample_quality==='accepted')).toBe(true);
    } finally {db.close();}
  });

  it('reports unavailable temperature as null rather than a normal zero-degree sample', () => {
    const db = temperatureFixture();
    try {expect(thermalQuery(db,'root_cause_classification')[0]).toMatchObject({classification:'THERMAL_DATA_UNAVAILABLE',peak_temp_c:null});}
    finally {db.close();}
  });

  it('keeps frequency-only decline as an observation with thermal mechanism unknown', () => {
    const db = temperatureFixture();
    try {
      db.exec(`CREATE TABLE _cpu_topology(cpu_id INTEGER,core_type TEXT);
        INSERT INTO _cpu_topology VALUES(0,'big');
        INSERT INTO cpu_counter_track VALUES(1,0,'cpufreq');
        INSERT INTO counter(track_id,ts,value) VALUES(1,0,3000000),(1,1000000000,2000000),(1,2000000000,400000);`);
      const range = yaml.load(readBackendFile('skills/atomic/cpu_throttling_in_range.skill.yaml')) as any;
      const predictor = yaml.load(readBackendFile('skills/atomic/thermal_predictor.skill.yaml')) as any;
      const run = (sql: string) => db.prepare(sql.replace(/\$\{([^}]+)\}/g, (_: string,key: string)=> {
        if(key==='start_ts') return '0'; if(key==='end_ts') return '3000000000';
        const fallback = key.split('|')[1]; if(fallback!==undefined) return fallback;
        if(/^[a-z_]+\.data\[/.test(key)) return ''; throw new Error(key);
      })).all() as any[];
      expect(run(range.steps.find((step:any)=>step.id==='throttle_detection').sql)[0]).toMatchObject({frequency_variation_detected:1,throttle_detected:null,evidence_status:'thermal_evidence_missing'});
      expect(run(predictor.sql)[0]).toMatchObject({frequency_trend_risk:'high',thermal_risk:'unknown'});
    } finally {db.close();}
  });
});
