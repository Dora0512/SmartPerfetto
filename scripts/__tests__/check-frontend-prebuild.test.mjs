// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../check-frontend-prebuild.cjs');

function runCheck(frontendDir) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {...process.env, SMARTPERFETTO_PREBUILD_CHECK_DIR: frontendDir},
  });
}

test('rejects the retired critical-path static page, its injection and its styles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-prebuild-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<html><head><script defer src="/assistant-critical-path.js"></script></head></html>');
    fs.writeFileSync(path.join(dir, 'assistant-critical-path.js'), '// legacy');
    fs.writeFileSync(path.join(dir, 'assistant-flamegraph.css'), '.sp-critical-path-drawer { display: none; }');

    const result = runCheck(dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /retired static asset is present: frontend\/assistant-critical-path\.js/);
    assert.match(result.stderr, /index\.html still loads the retired static asset assistant-critical-path\.js/);
    assert.match(result.stderr, /assistant-flamegraph\.css still styles \.sp-critical-path-\*/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('requires every declared static asset and nothing undeclared at the top level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-prebuild-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<html><head><script defer src="/assistant-flamegraph.js"></script></head></html>');
    fs.writeFileSync(path.join(dir, 'assistant-flamegraph.js'), '// page');
    fs.writeFileSync(path.join(dir, 'stray.js'), '// not declared');

    const result = runCheck(dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /declared static asset is missing: frontend\/assistant-flamegraph\.css/);
    assert.match(result.stderr, /undeclared top-level entry in frontend\/: stray\.js/);
    assert.doesNotMatch(result.stderr, /retired static asset/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
