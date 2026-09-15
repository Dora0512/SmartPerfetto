// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto

import {isDeepStrictEqual} from 'node:util';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';

const MARKER = 'final_semantic_source_alias@1' as const;
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Restore only the two exact contract copies represented by the closed marker. */
export function expandSemanticSourceSnapshot(snapshot: unknown): unknown | undefined {
  if (!isPlainJsonObject(snapshot) || !owns(snapshot, 'semanticSourceAlias') ||
      !isPlainJsonObject(snapshot.semanticSourceAlias) ||
      Object.keys(snapshot.semanticSourceAlias).length !== 1 || snapshot.semanticSourceAlias.schemaVersion !== MARKER ||
      !isPlainJsonObject(snapshot.conclusionContract) ||
      owns(snapshot.conclusionContract, 'sourceUseDecision') || owns(snapshot.conclusionContract, 'sourceReferences') ||
      !isPlainJsonObject(snapshot.sourceUse) || snapshot.sourceUse.schemaVersion !== 'source_use_decision@1' ||
      !Array.isArray(snapshot.sourceUse.references)) return undefined;
  const {semanticSourceAlias: _alias, conclusionContract, sourceUse, ...rest} = snapshot;
  return {...rest, conclusionContract: {...conclusionContract,
    sourceUseDecision: sourceUse, sourceReferences: sourceUse.references}, sourceUse};
}

/** Losslessly intern exact source-ledger copies only after provider safety projection. */
export function compactSemanticSourceSnapshot<T>(snapshot: T): T {
  if (!isPlainJsonObject(snapshot) || owns(snapshot, 'semanticSourceAlias') ||
      !isPlainJsonObject(snapshot.conclusionContract) || !isPlainJsonObject(snapshot.sourceUse) ||
      !owns(snapshot.conclusionContract, 'sourceUseDecision') || !owns(snapshot.conclusionContract, 'sourceReferences') ||
      !isDeepStrictEqual(snapshot.conclusionContract.sourceUseDecision, snapshot.sourceUse) ||
      !isDeepStrictEqual(snapshot.conclusionContract.sourceReferences, snapshot.sourceUse.references)) return snapshot;
  const {sourceUseDecision: _decision, sourceReferences: _references, ...contract} = snapshot.conclusionContract;
  const compacted = {...snapshot, conclusionContract: contract, semanticSourceAlias: {schemaVersion: MARKER}};
  const expanded = expandSemanticSourceSnapshot(compacted);
  return expanded !== undefined && isDeepStrictEqual(expanded, snapshot) &&
    Buffer.byteLength(JSON.stringify(compacted), 'utf8') < Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    ? compacted as T : snapshot;
}
