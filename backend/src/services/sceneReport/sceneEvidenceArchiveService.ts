// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'node:path';
import {sceneStoryConfig} from '../../config';
import {SceneEvidenceArchive} from './sceneEvidenceArchive';

let archive: SceneEvidenceArchive | undefined;
export function getSceneEvidenceArchive(): SceneEvidenceArchive {
  return archive ??= new SceneEvidenceArchive(path.join(sceneStoryConfig.reportDir, 'v3'), {
    ttlMs: sceneStoryConfig.reportTtlMs,
  });
}

/** Called before authoritative trace metadata deletion, including unloaded traces. */
export async function invalidateSceneEvidenceForTrace(traceId: string): Promise<void> {
  await getSceneEvidenceArchive().invalidateTrace({traceId});
}
