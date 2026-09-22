// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { applyEnterpriseMinimalSchema } from './enterpriseSchema';

export const ENTERPRISE_DB_PATH_ENV = 'SMARTPERFETTO_ENTERPRISE_DB_PATH';

export function resolveEnterpriseDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ENTERPRISE_DB_PATH_ENV];
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  const dataRoot = env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim()
    ? path.resolve(env.SMARTPERFETTO_BACKEND_DATA_DIR)
    : path.resolve(process.cwd(), 'data');
  return path.join(dataRoot, 'sessions', 'sessions.db');
}

export function openEnterpriseDb(dbPath = resolveEnterpriseDbPath()): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // busy_timeout covers waiting for the write lock, not upgrading to it: a
  // deferred transaction that reads first fails at once with
  // SQLITE_BUSY_SNAPSHOT when another process commits in between. Transactions
  // that read before writing therefore run with `.immediate()`.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  applyEnterpriseMinimalSchema(db);
  return db;
}
