// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The one reader for SQL fragment files (`skills/fragments/*.sql`). The Skill
// loader reads every root's fragments through it, and code that composes the
// same fragments (the critical-path engine) reads the built-in ones through it,
// so a fragment has exactly one source and one load path.

import fs from 'fs';
import path from 'path';

/** The built-in skills directory shipped with the backend. */
export function builtInSkillsDir(): string {
  return path.resolve(__dirname, '../../../skills');
}

/** Registry key of a fragment file, e.g. `fragments/thread_role.sql`. */
export function skillFragmentKey(file: string): string {
  return `fragments/${file}`;
}

/** A fragment file's CTE text, trimmed as Skill step injection expects it. */
export function readSkillFragmentFile(fragmentsDir: string, file: string): string {
  return fs.readFileSync(path.join(fragmentsDir, file), 'utf-8').trim();
}

const builtInCache = new Map<string, string>();

/**
 * A built-in fragment by file name. Self-Evolution copies base fragments
 * unchanged, so the built-in file is also what every effective registry holds.
 */
export function builtInSkillFragment(file: string): string {
  const cached = builtInCache.get(file);
  if (cached !== undefined) return cached;
  const content = readSkillFragmentFile(path.join(builtInSkillsDir(), 'fragments'), file);
  builtInCache.set(file, content);
  return content;
}

/**
 * Compose fragments into one statement: `WITH <leading CTEs>, <fragments...> <select>`.
 * `${name}` placeholders are bound to numbers only; a placeholder left unbound
 * is an error, never silently sent to the processor.
 */
export function composeFragmentSql(input: {
  leadingCtes: string[];
  fragments: string[];
  select: string;
  numbers?: Record<string, number>;
}): string {
  const bound = input.fragments.map((file) =>
    builtInSkillFragment(file).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
      const value = input.numbers?.[name];
      if (value === undefined || !Number.isFinite(value)) {
        throw new Error(`fragment ${file} needs a numeric ${placeholder}`);
      }
      return String(Math.trunc(value));
    })
  );
  // Separators go on their own line: a fragment may end in a `--` comment.
  return `WITH\n${[...input.leadingCtes, ...bound].join('\n,\n')}\n${input.select}`;
}
