// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createScenePacingState, recordSceneAcquisition, recordSceneCommit, recordSceneProposalAttempt,
  recordSceneToolSettled, recordSceneToolStarted, sceneAcquisitionRefusal, sceneAcquisitionReminder,
  sceneClosingReserveMs, slowestRecentSceneRoundMs, type ScenePacingInputs} from '../sceneProposalPacing';

const S = 1000;
// The recorded glm-5.3-flash scene runs: 20 min base budget, 60 min hard, 10 min delivery reserve.
const recorded: ScenePacingInputs = {startedAt: 0, baseBudgetMs: 1200 * S, investigationLimitAt: 3000 * S,
  current: () => 1200 * S, perTurnMs: 60 * S};
function acquire(state: ReturnType<typeof createScenePacingState>, times: number): void {
  for (let index = 0; index < times; index++) recordSceneAcquisition(state);
}

describe('scene proposal pacing', () => {
  it('reminds, then pauses acquisition until a segment-bearing attempt, and re-arms while nothing commits', () => {
    const state = createScenePacingState(recorded);
    acquire(state, 2);
    expect(sceneAcquisitionReminder(state, 10 * S)).toBeUndefined();
    acquire(state, 1);
    expect(sceneAcquisitionReminder(state, 10 * S)).toBe('scene_no_committed_revision');
    acquire(state, 2);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBeUndefined();
    acquire(state, 1);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBe('scene_first_revision_due');
    recordSceneProposalAttempt(state);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBeUndefined();
    acquire(state, 3);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBeUndefined();
    acquire(state, 1);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBe('scene_first_revision_due');
    recordSceneCommit(state, 2);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBeUndefined();
    expect(sceneAcquisitionReminder(state, 10 * S)).toBeUndefined();
  });

  it('pauses on elapsed base budget even with few acquisitions, but never before any evidence returned', () => {
    // rooted_fc_compose_scroll: 7 acquisitions in 21 minutes and no proposal.
    const state = createScenePacingState(recorded);
    expect(sceneAcquisitionRefusal(state, 600 * S)).toBeUndefined();
    acquire(state, 2);
    expect(sceneAcquisitionRefusal(state, 479 * S)).toBeUndefined();
    expect(sceneAcquisitionRefusal(state, 480 * S)).toBe('scene_first_revision_due');
  });

  it('does not treat an unresolved-only revision as a committed timeline', () => {
    const state = createScenePacingState(recorded);
    acquire(state, 6);
    recordSceneCommit(state, 0);
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBe('scene_first_revision_due');
  });

  it('reserves slow rounds before the acquisition limit and stays closed', () => {
    const state = createScenePacingState(recorded);
    recordSceneCommit(state, 3);
    // model rounds observed as gaps between a tool settling and the next dispatch
    let now = 0;
    for (const gap of [53, 56, 132, 502]) {
      recordSceneToolSettled(state, now * S);
      now += gap;
      recordSceneToolStarted(state, now * S);
    }
    expect(slowestRecentSceneRoundMs(state)).toBe(502 * S);
    // 3 x 502 s capped at 30% of the 3000 s acquisition span
    expect(sceneClosingReserveMs(state)).toBe(900 * S);
    expect(sceneAcquisitionRefusal(state, 2099 * S)).toBeUndefined();
    expect(sceneAcquisitionRefusal(state, 2100 * S)).toBe('scene_acquisition_window_closed');
    expect(sceneAcquisitionRefusal(state, 10 * S)).toBe('scene_acquisition_window_closed');
  });

  it('keeps short budgets usable and measures rounds only between idle tool gaps', () => {
    const state = createScenePacingState({startedAt: 0, baseBudgetMs: 60 * S, investigationLimitAt: 60 * S,
      current: () => 60 * S, perTurnMs: 60 * S});
    expect(sceneClosingReserveMs(state)).toBe(18 * S);
    recordSceneToolStarted(state, 1 * S);
    recordSceneToolStarted(state, 2 * S);
    recordSceneToolSettled(state, 3 * S);
    recordSceneToolSettled(state, 4 * S);
    recordSceneToolStarted(state, 9 * S);
    expect(state.rounds).toEqual([5 * S]);
  });

  it('warns when the moving deadline is closer than two slow rounds and the candidate is stale', () => {
    let deadline = 1500 * S;
    const state = createScenePacingState({...recorded, current: () => deadline});
    recordSceneCommit(state, 1);
    acquire(state, 4);
    expect(sceneAcquisitionReminder(state, 1300 * S)).toBeUndefined();
    deadline = 1400 * S;
    expect(sceneAcquisitionReminder(state, 1300 * S)).toBe('scene_deadline_near');
  });
});
