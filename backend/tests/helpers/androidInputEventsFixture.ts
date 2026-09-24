// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type Database from 'better-sqlite3';
import {loadPerfettoSqlDocsAsset} from '../../src/services/perfettoSqlDocs';

/**
 * Columns of the stdlib `android_input_events` table, from the generated
 * Perfetto SQL docs of the pinned runtime. Skills read it only through
 * `fragments/android_input_events_normalized.sql`, which names every column,
 * so a SQLite stand-in must carry the full schema.
 */
function androidInputEventsColumns(): Array<readonly [string, 'INTEGER' | 'TEXT']> {
  const entry = loadPerfettoSqlDocsAsset()?.entries.find(candidate => candidate.id === 'stdlib.android.input.android_input_events');
  if (!entry?.columns?.length) throw new Error('perfettoSqlDocs.json has no android_input_events columns');
  return entry.columns.map(column => [column.name, column.type === 'STRING' ? 'TEXT' : 'INTEGER'] as const);
}

/** CREATE TABLE for a full-schema `android_input_events` stand-in. */
export function androidInputEventsTableDdl(): string {
  return `CREATE TABLE android_input_events(${androidInputEventsColumns().map(([name, type]) => `${name} ${type}`).join(', ')});`;
}

/**
 * Add the stdlib columns a narrow fixture table left out, as NULL. Call it after
 * positional INSERTs into the narrow table and before running Skill SQL.
 */
export function completeAndroidInputEventsFixture(db: Database.Database): void {
  const present = new Set((db.prepare('PRAGMA table_info(android_input_events)').all() as Array<{name: string}>)
    .map(column => column.name));
  for (const [name, type] of androidInputEventsColumns()) {
    if (!present.has(name)) db.exec(`ALTER TABLE android_input_events ADD COLUMN ${name} ${type}`);
  }
}
