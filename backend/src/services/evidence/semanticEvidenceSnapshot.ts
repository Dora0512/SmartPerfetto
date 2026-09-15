// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto

import {isDeepStrictEqual} from 'node:util';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';

const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const validIndex = (value: unknown, values: readonly unknown[]): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < values.length;

function expandRecords(snapshot: Record<string, unknown>): unknown[] | undefined {
  if (!Array.isArray(snapshot.records) || !Array.isArray(snapshot.origins)) return undefined;
  const version = snapshot.schemaVersion;
  const fieldDescriptors = version === 'semantic_evidence_snapshot@2' ? snapshot.fieldDescriptors : undefined;
  const displayColumns = version === 'semantic_evidence_snapshot@2' ? snapshot.displayColumns : undefined;
  if (version === 'semantic_evidence_snapshot@2' && (!Array.isArray(fieldDescriptors) || !Array.isArray(displayColumns))) return undefined;
  const records: unknown[] = [];
  for (const rawRecord of snapshot.records) {
    if (!isPlainJsonObject(rawRecord)) {records.push(rawRecord); continue;}
    let fields = rawRecord.fields;
    if (isPlainJsonObject(fields)) {
      const expanded: Array<[string, unknown]> = [];
      for (const [name, rawField] of Object.entries(fields)) {
        const descriptor = version === 'semantic_evidence_snapshot@2'
          ? validIndex(rawField, fieldDescriptors as unknown[]) ? (fieldDescriptors as unknown[])[rawField] : undefined
          : rawField;
        if (!isPlainJsonObject(descriptor)) return undefined;
        if (owns(descriptor, 'originIndex')) {
          if (!validIndex(descriptor.originIndex, snapshot.origins)) return undefined;
          const {originIndex: _originIndex, ...rest} = descriptor;
          expanded.push([name, {...rest, origin: snapshot.origins[descriptor.originIndex]}]);
        } else expanded.push([name, descriptor]);
      }
      // Object.fromEntries creates an own data property even for "__proto__".
      fields = Object.fromEntries(expanded);
    }
    let display = rawRecord.display;
    if (version === 'semantic_evidence_snapshot@2' && isPlainJsonObject(display) && owns(display, 'columnIndexes')) {
      if (!Array.isArray(display.columnIndexes) ||
          display.columnIndexes.some(index => !validIndex(index, displayColumns as unknown[]))) return undefined;
      const {columnIndexes, ...rest} = display;
      display = {...rest, columns: columnIndexes.map(index => (displayColumns as unknown[])[index])};
    }
    records.push({...rawRecord, ...(owns(rawRecord, 'fields') ? {fields} : {}),
      ...(owns(rawRecord, 'display') ? {display} : {})});
  }
  return records;
}

/** Decode only the closed transport formats produced below. */
export function expandSemanticEvidenceSnapshot(snapshot: unknown): unknown {
  if (!isPlainJsonObject(snapshot) ||
      !['semantic_evidence_snapshot@1', 'semantic_evidence_snapshot@2'].includes(String(snapshot.schemaVersion)) ||
      typeof snapshot.sourceSchemaVersion !== 'string' || !Array.isArray(snapshot.reads)) return undefined;
  const records = expandRecords(snapshot);
  if (!records) return undefined;
  const reads: unknown[] = [];
  for (const rawRead of snapshot.reads) {
    if (!isPlainJsonObject(rawRead) || !owns(rawRead, 'recordIndex')) {reads.push(rawRead); continue;}
    if (!validIndex(rawRead.recordIndex, records)) return undefined;
    const {recordIndex, ...rest} = rawRead;
    reads.push({...rest, record: records[recordIndex]});
  }
  const {sourceSchemaVersion, records: _records, origins: _origins, fieldDescriptors: _fieldDescriptors,
    displayColumns: _displayColumns, ...rest} = snapshot;
  return {...rest, schemaVersion: sourceSchemaVersion, reads};
}

function descriptorPool(snapshot: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(snapshot.records)) return undefined;
  const fieldDescriptors: unknown[] = [];
  const displayColumns: unknown[] = [];
  const fieldIndexes = new Map<string, number>();
  const displayIndexes = new Map<string, number>();
  const intern = (value: unknown, values: unknown[], indexes: Map<string, number>) => {
    const serialized = JSON.stringify(value);
    let index = indexes.get(serialized);
    if (index === undefined) {index = values.length; indexes.set(serialized, index); values.push(value);}
    return index;
  };
  const records: unknown[] = [];
  for (const rawRecord of snapshot.records) {
    if (!isPlainJsonObject(rawRecord)) {records.push(rawRecord); continue;}
    let fields = rawRecord.fields;
    if (owns(rawRecord, 'fields')) {
      if (!isPlainJsonObject(fields) || Object.values(fields).some(field => !isPlainJsonObject(field))) return undefined;
      fields = Object.fromEntries(Object.entries(fields).map(([name, field]) =>
        [name, intern(field, fieldDescriptors, fieldIndexes)]));
    }
    let display = rawRecord.display;
    if (isPlainJsonObject(display)) {
      if (owns(display, 'columnIndexes')) return undefined;
      if (owns(display, 'columns')) {
        if (!Array.isArray(display.columns) || display.columns.some(column => !isPlainJsonObject(column))) return undefined;
        const {columns, ...rest} = display;
        display = {...rest, columnIndexes: columns.map(column => intern(column, displayColumns, displayIndexes))};
      }
    }
    records.push({...rawRecord, ...(owns(rawRecord, 'fields') ? {fields} : {}),
      ...(owns(rawRecord, 'display') ? {display} : {})});
  }
  return {...snapshot, schemaVersion: 'semantic_evidence_snapshot@2', records, fieldDescriptors, displayColumns};
}

/** Lossless transport encoding only, never a replacement for issued prepared evidence. */
export function compactSemanticEvidenceSnapshot(snapshot: unknown): unknown {
  if (!isPlainJsonObject(snapshot) || snapshot.schemaVersion !== 'prepared_claim_evidence@1' ||
      !Array.isArray(snapshot.reads)) return snapshot;
  if (['records', 'origins', 'sourceSchemaVersion', 'fieldDescriptors', 'displayColumns'].some(key => owns(snapshot, key))) return snapshot;
  const records: unknown[] = [];
  const origins: unknown[] = [];
  const indexes = new Map<string, number>();
  const originIndexes = new Map<string, number>();
  if (snapshot.reads.some(read => isPlainJsonObject(read) && (owns(read, 'recordIndex') ||
      (isPlainJsonObject(read.record) && (isPlainJsonObject(read.record.display) && owns(read.record.display, 'columnIndexes') ||
        isPlainJsonObject(read.record.fields) && Object.values(read.record.fields).some(field =>
          !isPlainJsonObject(field) || owns(field, 'originIndex'))))))) return snapshot;
  const compactRecord = (record: Record<string, unknown>): Record<string, unknown> => {
    if (!isPlainJsonObject(record.fields)) return record;
    return {...record, fields: Object.fromEntries(Object.entries(record.fields).map(([name, field]) => {
      if (!isPlainJsonObject(field) || !isPlainJsonObject(field.origin)) return [name, field];
      const serialized = JSON.stringify(field.origin);
      let originIndex = originIndexes.get(serialized);
      if (originIndex === undefined) {
        originIndex = origins.length;
        originIndexes.set(serialized, originIndex);
        origins.push(field.origin);
      }
      const {origin: _origin, ...remaining} = field;
      return [name, {...remaining, originIndex}];
    }))};
  };
  const reads = snapshot.reads.map(read => {
    if (!isPlainJsonObject(read) || !isPlainJsonObject(read.record)) return read;
    const serialized = JSON.stringify(read.record);
    let index = indexes.get(serialized);
    if (index === undefined) {
      index = records.length;
      indexes.set(serialized, index);
      records.push(compactRecord(read.record));
    }
    const {record: _record, ...remaining} = read;
    return {...remaining, recordIndex: index};
  });
  const v1 = {...snapshot, schemaVersion: 'semantic_evidence_snapshot@1',
    sourceSchemaVersion: snapshot.schemaVersion, records, origins, reads};
  const v2 = descriptorPool(v1);
  const candidates = [v1, v2].filter((value): value is Record<string, unknown> => Boolean(value &&
    isDeepStrictEqual(expandSemanticEvidenceSnapshot(value), snapshot)));
  const compacted = candidates.sort((left, right) =>
    Buffer.byteLength(JSON.stringify(left), 'utf8') - Buffer.byteLength(JSON.stringify(right), 'utf8'))[0];
  return compacted && Buffer.byteLength(JSON.stringify(compacted), 'utf8') < Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    ? compacted : snapshot;
}
