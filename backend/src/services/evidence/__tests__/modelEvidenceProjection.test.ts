// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {captureEvidenceTable, MODEL_EVIDENCE_STRING_MAX_BYTES,
  MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT, MODEL_EVIDENCE_UNIT_MAX_BYTES,
  projectEvidenceTableForModel} from '../evidenceCapture';

describe('model evidence projection', () => {
  it('restores typed scalar cells in display column order', () => {
    const long = 'raw-'.repeat(40);
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'fixture-v1', skillId: 'fixture'};
    const witness = captureEvidenceTable({columns: ['text', 'missing', 'enabled', 'count'],
      rows: [[long, null, false, 7]]}, {count: {origin, unit: 'ms'}});
    const display = {columns: ['enabled', 'text', 'missing'], rows: [['否', `${long.slice(0, 97)}...`, '-']]};
    const projected = projectEvidenceTableForModel(display, witness);
    expect(projected).toEqual({
      data: {columns: ['enabled', 'text', 'missing'], rows: [[false, long, null]]},
      modelProjection: {status: 'exact'},
    });
  });

  it('exposes only trusted explicit units without inferring percentage scale', () => {
    const trusted = {kind: 'skill_literal' as const, definitionFingerprint: 'fixture-v1', skillId: 'fixture'};
    const missingFingerprint = {kind: 'skill_literal' as const, definitionFingerprint: '', skillId: 'fixture'};
    const witness = captureEvidenceTable({columns: ['ttid_ms', 'busy_pct', 'ambiguous_pct', 'unsafe', 'untrusted'],
      rows: [[1912.2, 68.1, 0.3, 1, 2]]}, {
      ttid_ms: {origin: trusted, unit: 'ms'},
      busy_pct: {origin: trusted, unit: '%'},
      unsafe: {origin: trusted, unit: `x\n${'u'.repeat(MODEL_EVIDENCE_UNIT_MAX_BYTES)}`},
      untrusted: {origin: missingFingerprint, unit: 'ms'},
    });
    const projected = projectEvidenceTableForModel({
      columns: ['ambiguous_pct', 'busy_pct', 'ttid_ms', 'unsafe', 'untrusted'],
      rows: [['30%', '68.1%', '1912.20 ms', '1', '2']],
    }, witness);
    expect(projected.columnUnits).toEqual({busy_pct: '%', ttid_ms: 'ms'});
    expect(projected.columnUnits).not.toHaveProperty('ambiguous_pct');
    expect(projected.columnUnits).not.toHaveProperty('unsafe');
    expect(projected.columnUnits).not.toHaveProperty('untrusted');
  });

  it('bounds UTF-8 strings and caps truncation locators', () => {
    const raw = '中'.repeat(MODEL_EVIDENCE_STRING_MAX_BYTES);
    const columns = Array.from({length: MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT + 3}, (_, index) => `c${index}`);
    const witness = captureEvidenceTable({columns, rows: [columns.map(() => raw)]});
    const projected = projectEvidenceTableForModel({columns, rows: [columns.map(() => '中...')]}, witness);
    const first = (projected.data as {rows: string[][]}).rows[0][0];
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(MODEL_EVIDENCE_STRING_MAX_BYTES);
    expect(projected.modelProjection).toMatchObject({status: 'truncated',
      truncatedCellCount: MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT + 3,
      truncatedCellsOmitted: 3});
    expect(projected.modelProjection.truncatedCells).toHaveLength(MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT);
  });

  it.each([
    ['unissued_witness', undefined, {columns: ['value'], rows: [['-']]}],
    ['unavailable_witness', captureEvidenceTable(undefined, {}, 'unmapped'), {columns: ['value'], rows: [['-']]}],
    ['row_mismatch', captureEvidenceTable({columns: ['value'], rows: [[null], [null]]}), {columns: ['value'], rows: [['-']]}],
    ['duplicate_columns', captureEvidenceTable({columns: ['value'], rows: [[null]]}), {columns: ['value', 'value'], rows: [['-', '-']]}],
    ['column_mismatch', captureEvidenceTable({columns: ['value'], rows: [[null]]}), {columns: ['other'], rows: [['-']]}],
    ['unsupported_raw_cell', captureEvidenceTable({columns: ['value'], rows: [[undefined]]}), {columns: ['value'], rows: [['-']]},],
  ] as const)('fails closed without turning unknown cells into SQL NULL: %s', (reason, witness, display) => {
    const projected = projectEvidenceTableForModel(display, witness);
    expect(projected.data).toBe(display);
    expect(projected.modelProjection).toEqual({status: 'unavailable', reason});
  });

  it('rejects transformed and non-table display shapes', () => {
    const witness = captureEvidenceTable({columns: ['value'], rows: [[null]]});
    const display = {text: 'no data'};
    expect(projectEvidenceTableForModel(display, witness)).toEqual({data: display,
      modelProjection: {status: 'unavailable', reason: 'not_table'}});
  });
});
