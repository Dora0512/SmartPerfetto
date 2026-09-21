// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {appendSceneAwareReplayEvent, includeLatestSceneReplay} from '../sceneTimelineReplay';
import type {BufferedSseEvent} from '../streamProjector';

const event = (seqId: number, eventType = 'scene_timeline_updated', runId = 'a'): BufferedSseEvent =>
  ({seqId, eventType, runId, eventData: JSON.stringify({revision: seqId})});
describe('scene full snapshot replay retention', () => {
  it('compacts only the same run snapshot without altering progress or terminal cursors', () => {
    const buffer = [event(1), event(2, 'progress'), event(3, 'scene_timeline_updated', 'b'), event(4, 'analysis_completed')];
    appendSceneAwareReplayEvent(buffer, event(5));
    expect(buffer.map(item => item.seqId)).toEqual([2, 3, 4, 5]);
    appendSceneAwareReplayEvent(buffer, event(6, 'answer_token'));
    expect(buffer.map(item => item.seqId)).toEqual([2, 3, 4, 5, 6]);
  });
  it('restores the latest current-run snapshot after ordinary ring eviction and never crosses runs', () => {
    const latest = event(2);
    expect(includeLatestSceneReplay([event(4, 'progress')], latest, 'a').map(item => item.seqId)).toEqual([2, 4]);
    expect(includeLatestSceneReplay([latest], latest, 'a')).toHaveLength(1);
    expect(includeLatestSceneReplay([], latest, 'b')).toEqual([]);
  });
});
