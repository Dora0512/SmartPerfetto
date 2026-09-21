// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {summarizeSqlResult} from '../sqlSummarizer';

describe('SQL summary sample rows', () => {
  it('keeps the original row index of samples re-ordered by interest', () => {
    const rows = Array.from({length: 30}, (_, index) => [index, (index * 7) % 30]);
    const summary = summarizeSqlResult(['id', 'dur'], rows);
    expect(summary.sampleRows).toHaveLength(10);
    summary.sampleRows.forEach((row, position) => expect(rows[summary.sampleRowIndices[position]]).toBe(row));
    expect(summary.sampleRowIndices[0]).not.toBe(0);
  });

  it('uses identity indices when every row is returned and evenly spaced indices without an interest column', () => {
    expect(summarizeSqlResult(['name'], [['a'], ['b']]).sampleRowIndices).toEqual([0, 1]);
    const spaced = summarizeSqlResult(['name'], Array.from({length: 40}, (_, index) => [`n${index}`]));
    expect(spaced.sampleRowIndices).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
  });
});
