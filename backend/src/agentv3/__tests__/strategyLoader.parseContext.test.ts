// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {parseInvestigationContract, parseInvestigationProfiles} from '../strategyLoader';

describe('strategy parse failure context', () => {
  it('tags contract requirement failures with the requirement id', () => {
    expect(() => parseInvestigationContract({schema_version: 1, requirements: [
      {id: 'handoff_metric', domain: 'render', description: 'x', condition: {kind: 'bogus'}},
    ]}, new Map())).toThrow('strategy_invalid_investigation_condition#handoff_metric');
  });

  it('keeps the bare code substring matchable when tagged', () => {
    expect(() => parseInvestigationContract({schema_version: 1, requirements: [
      {id: 'r1', domain: 'd', description: 'x', condition: {kind: 'semantic', description: 'ok', extra: 1}},
    ]}, new Map())).toThrow('strategy_invalid_investigation_condition');
  });

  it('tags profile requirement failures with the requirement id', () => {
    expect(() => parseInvestigationProfiles({schema_version: 1, profiles: {scrolling: {version: 1,
      requirements: [{id: 'frame_stall', domain: 'render', description: 'x', evidence_metrics: ['']}]}}}))
      .toThrow('strategy_invalid_investigation_metrics#frame_stall');
  });

  it('does not tag a requirement whose id itself is invalid', () => {
    expect(() => parseInvestigationProfiles({schema_version: 1, profiles: {scrolling: {version: 1,
      requirements: [{id: 'Bad-Id', domain: 'render', description: 'x'}]}}}))
      .toThrow(/^strategy_invalid_investigation_requirement(:|$)/);
  });
});
