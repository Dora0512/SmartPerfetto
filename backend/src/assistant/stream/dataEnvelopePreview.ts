// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {DataEnvelope, DataPayload} from '../../types/dataContract';

export const TABLE_PREVIEW_MAX_ROWS = 200;
export const TABLE_PREVIEW_MAX_BYTES = 256 * 1024;

// A conservative bound avoids serializing a potentially enormous row just to
// decide whether it fits. JSON strings need at most six bytes per UTF-16 unit.
function jsonSizeBound(value: unknown, remaining: number, depth = 0): number {
  if (remaining < 0 || depth > 32) return Infinity;
  if (typeof value === 'string') return 2 + value.length * 6;
  if (value === null || value === undefined) return 4;
  if (typeof value === 'boolean') return 5;
  if (typeof value === 'number') return 32;
  if (typeof value !== 'object') return Infinity;
  let size = 2;
  if (Array.isArray(value)) {
    // JSON encodes sparse slots as null too; enumerating own keys misses them.
    if (value.length * 2 + 2 > remaining) return Infinity;
    for (let i = 0; i < value.length; i++) {
      size += 1 + jsonSizeBound(value[i], remaining - size, depth + 1);
      if (size > remaining) return Infinity;
    }
    return size;
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    size += 3 + key.length * 6;
    size += 1 + jsonSizeBound((value as Record<string, unknown>)[key], remaining - size, depth + 1);
    if (size > remaining) return Infinity;
  }
  return size;
}

/** Project only chat table data. Never pass this preview to evidence capture. */
export function projectDataEnvelopePreview(envelope: DataEnvelope): DataEnvelope {
  if (!envelope?.data || !envelope.display ||
      (envelope.display.format && envelope.display.format !== 'table') ||
      !Array.isArray(envelope.data.rows)) return envelope;
  const originalRows = envelope.data.rows;
  const previous = envelope.display.preview;
  let detailsOmitted = previous?.detailsOmitted === true;
  const {rows: _rows, expandableData: _details, ...rest} = envelope.data;
  let base: DataPayload = rest;
  let size = jsonSizeBound(base, TABLE_PREVIEW_MAX_BYTES);
  if (size > TABLE_PREVIEW_MAX_BYTES) {
    base = {columns: envelope.data.columns};
    size = jsonSizeBound(base, TABLE_PREVIEW_MAX_BYTES);
    detailsOmitted = true;
  }
  if (size + 128 > TABLE_PREVIEW_MAX_BYTES) {
    base = {columns: []};
    size = jsonSizeBound(base, TABLE_PREVIEW_MAX_BYTES);
    detailsOmitted = true;
    return {
      ...envelope,
      data: {...base, rows: []},
      display: {...envelope.display, preview: {
        totalRows: Math.max(previous?.totalRows ?? 0, originalRows.length),
        returnedRows: 0, reason: 'byte_limit', detailsOmitted,
      }},
    };
  }
  // Reserve the rows/expandableData property names and array delimiters.
  size += 128;
  const rows: typeof originalRows = [];
  let byteLimited = false;
  for (let i = 0; i < Math.min(originalRows.length, TABLE_PREVIEW_MAX_ROWS); i++) {
    const rowSize = 1 + jsonSizeBound(originalRows[i], TABLE_PREVIEW_MAX_BYTES - size);
    if (size + rowSize > TABLE_PREVIEW_MAX_BYTES) {
      byteLimited = true;
      break;
    }
    rows.push(originalRows[i]);
    size += rowSize;
  }
  let expandableData = envelope.data.expandableData?.slice(0, rows.length);
  if ((envelope.data.expandableData?.length ?? 0) > (expandableData?.length ?? 0)) {
    detailsOmitted = true;
  }
  if (expandableData && jsonSizeBound(expandableData, TABLE_PREVIEW_MAX_BYTES - size) > TABLE_PREVIEW_MAX_BYTES - size) {
    expandableData = undefined;
    detailsOmitted = true;
  }
  if (rows.length === originalRows.length && !detailsOmitted && !previous) return envelope;
  return {
    ...envelope,
    data: {...base, rows, expandableData},
    display: {
      ...envelope.display,
      preview: {
        totalRows: Math.max(previous?.totalRows ?? 0, originalRows.length),
        returnedRows: rows.length,
        reason: byteLimited || detailsOmitted ? 'byte_limit' : previous?.reason ?? 'row_limit',
        ...(detailsOmitted ? {detailsOmitted: true} : {}),
      },
    },
  };
}

export function projectDataEventPayload(eventType: string, payload: unknown): unknown {
  if (eventType !== 'data' || !payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  const envelope = record.envelope;
  if (!envelope || typeof envelope !== 'object') return payload;
  return {
    ...record,
    envelope: Array.isArray(envelope)
      ? envelope.map(item => projectDataEnvelopePreview(item))
      : projectDataEnvelopePreview(envelope as DataEnvelope),
  };
}

/** Old persisted/replay events may predate the presentation budget. */
export function projectSerializedDataEvent(eventType: string, eventData: string): string {
  if (eventType !== 'data') return eventData;
  return JSON.stringify(projectDataEventPayload(eventType, JSON.parse(eventData)));
}
