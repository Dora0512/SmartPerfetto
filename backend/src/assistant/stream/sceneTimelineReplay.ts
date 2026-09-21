// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {BufferedSseEvent} from './streamProjector';

/** Scene updates are full display snapshots. Keep one per run without changing
 * ordinary event ordering or sequence numbers. Final events remain untouched.
 */
export function appendSceneAwareReplayEvent(buffer: BufferedSseEvent[], event: BufferedSseEvent): void {
  if (event.eventType === 'scene_timeline_updated' && event.runId) {
    for (let index = buffer.length - 1; index >= 0; index--) {
      if (buffer[index].eventType === event.eventType && buffer[index].runId === event.runId) buffer.splice(index, 1);
    }
  }
  buffer.push(event);
}

export function includeLatestSceneReplay(buffer: readonly BufferedSseEvent[], latest: BufferedSseEvent | undefined,
  runId: string | undefined): BufferedSseEvent[] {
  const copy = [...buffer];
  if (latest && latest.runId === runId && !copy.some(event => event.seqId === latest.seqId)) copy.push(latest);
  return copy.sort((a, b) => a.seqId - b.seqId);
}
