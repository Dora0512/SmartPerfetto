// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {builtInSkillFragment, injectFragmentCtes} from '../../src/services/skillEngine/skillFragments';

/** Prepend a step's declared built-in fragments exactly as the Skill executor does. */
export function withStepFragments(sql: string, fragments: readonly string[] | undefined): string {
  return injectFragmentCtes(sql, (fragments || []).map(path => builtInSkillFragment(path.replace(/^fragments\//, ''))));
}
