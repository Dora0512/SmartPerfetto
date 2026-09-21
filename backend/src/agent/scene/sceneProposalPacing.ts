// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/**
 * When a scene run must turn captured evidence into a committed timeline.
 *
 * Strategy text asks for an early small revision and the tool description
 * repeats it, yet in 26 real runs the first accepted revision landed at
 * 93–100% of acquisition progress and five runs never proposed at all: the
 * budget ran out while the model was still collecting. The remedy has to sit at
 * the decision layer, the acquisition call itself, where it holds for every
 * runtime. This module is the pure policy; wording lives in strategy templates
 * and the registry hook applies the decisions.
 */

/** The budget facts pacing reads; a `ProgressAwareRunDeadline` satisfies it directly. */
export interface ScenePacingInputs {
  readonly startedAt: number;
  /** Initial acquisition budget, before any progress extension. */
  readonly baseBudgetMs: number;
  /** Latest moment acquisition tools may still run; fixed at start. */
  readonly investigationLimitAt: number;
  /** Deadline that ends the run if no further progress arrives; may move. */
  current(): number;
  readonly perTurnMs: number;
}

/** Resource policy, not scenario semantics. */
export interface ScenePacingPolicy {
  /** Completed acquisitions without a committed segment before results carry a reminder. */
  reminderAcquisitions: number;
  /** Completed acquisitions without a committed segment before acquisition pauses. */
  firstRevisionAcquisitions: number;
  /** Fraction of the base budget after which acquisition pauses without a committed segment. */
  firstRevisionBudgetFraction: number;
  /** Acquisitions a segment-bearing attempt buys before the first-revision pause re-arms. */
  attemptGraceAcquisitions: number;
  /** Acquisitions since the last commit before a deadline warning applies. */
  staleRevisionAcquisitions: number;
  /** Warn when the moving deadline is closer than this many slow rounds. */
  deadlineWarningRounds: number;
  /** Rounds reserved before the acquisition limit for the final revision and answer. */
  closingRounds: number;
  /** Upper bound of that reserve as a fraction of the acquisition span. */
  closingMaxFraction: number;
  /** Model rounds retained to estimate provider latency. */
  recentRounds: number;
}

export const DEFAULT_SCENE_PACING_POLICY: Readonly<ScenePacingPolicy> = Object.freeze({
  reminderAcquisitions: 3,
  firstRevisionAcquisitions: 6,
  firstRevisionBudgetFraction: 0.4,
  attemptGraceAcquisitions: 4,
  staleRevisionAcquisitions: 4,
  deadlineWarningRounds: 2,
  closingRounds: 3,
  closingMaxFraction: 0.3,
  recentRounds: 4,
});

export const DEFAULT_SCENE_PACING_PER_TURN_MS = 60_000;

export interface ScenePacingState {
  readonly inputs: ScenePacingInputs;
  readonly policy: Readonly<ScenePacingPolicy>;
  completedAcquisitions: number;
  /** `completedAcquisitions` at the last commit. */
  acquisitionsAtCommit: number;
  /** `completedAcquisitions` at the last segment-bearing, non-replay proposal; undefined before one. */
  acquisitionsAtAttempt?: number;
  committedSegments: number;
  inFlightTools: number;
  lastToolSettledAt?: number;
  rounds: number[];
  /** Monotone: once the closing window opens it stays open. */
  acquisitionClosed: boolean;
}

export type ScenePacingRefusal = 'scene_first_revision_due' | 'scene_acquisition_window_closed';
export type ScenePacingReminder = 'scene_no_committed_revision' | 'scene_deadline_near';

export function createScenePacingState(inputs: ScenePacingInputs,
  policy: Readonly<ScenePacingPolicy> = DEFAULT_SCENE_PACING_POLICY): ScenePacingState {
  return {inputs, policy, completedAcquisitions: 0, acquisitionsAtCommit: 0,
    committedSegments: 0, inFlightTools: 0, rounds: [], acquisitionClosed: false};
}

/** Any tool dispatch. The gap since the previous tool settled is one model round. */
export function recordSceneToolStarted(state: ScenePacingState, now: number): void {
  if (state.inFlightTools === 0 && state.lastToolSettledAt !== undefined) {
    state.rounds.push(Math.max(0, now - state.lastToolSettledAt));
    if (state.rounds.length > state.policy.recentRounds) state.rounds.shift();
  }
  state.inFlightTools++;
}

export function recordSceneToolSettled(state: ScenePacingState, now: number): void {
  state.inFlightTools = Math.max(0, state.inFlightTools - 1);
  state.lastToolSettledAt = now;
}

/** An admitted acquisition that returned data. Refusals and failed queries are not counted. */
export function recordSceneAcquisition(state: ScenePacingState): void {
  state.completedAcquisitions++;
}

/** A non-replay proposal that carried at least one segment, accepted or not. */
export function recordSceneProposalAttempt(state: ScenePacingState): void {
  state.acquisitionsAtAttempt = state.completedAcquisitions;
}

export function recordSceneCommit(state: ScenePacingState, committedSegments: number): void {
  state.committedSegments = committedSegments;
  state.acquisitionsAtCommit = state.completedAcquisitions;
}

export const sceneAcquisitionsSinceCommit = (state: ScenePacingState) => state.completedAcquisitions - state.acquisitionsAtCommit;

export function slowestRecentSceneRoundMs(state: ScenePacingState): number {
  return state.rounds.reduce((max, value) => Math.max(max, value), 0) || state.inputs.perTurnMs;
}

export function sceneClosingReserveMs(state: ScenePacingState): number {
  const {inputs, policy} = state;
  const cap = Math.max(0, Math.floor((inputs.investigationLimitAt - inputs.startedAt) * policy.closingMaxFraction));
  return Math.min(Math.max(policy.closingRounds * slowestRecentSceneRoundMs(state), inputs.perTurnMs), cap);
}

/** Decide whether one more acquisition may run. Lifecycle and authorization refusals are applied before this. */
export function sceneAcquisitionRefusal(state: ScenePacingState, now: number): ScenePacingRefusal | undefined {
  const {inputs, policy} = state;
  if (!state.acquisitionClosed && now >= inputs.investigationLimitAt - sceneClosingReserveMs(state)) {
    state.acquisitionClosed = true;
  }
  if (state.acquisitionClosed) return 'scene_acquisition_window_closed';
  if (state.committedSegments > 0 || state.completedAcquisitions < 1) return undefined;
  const due = state.completedAcquisitions >= policy.firstRevisionAcquisitions ||
    now - inputs.startedAt >= inputs.baseBudgetMs * policy.firstRevisionBudgetFraction;
  const graced = state.acquisitionsAtAttempt !== undefined &&
    state.completedAcquisitions - state.acquisitionsAtAttempt < policy.attemptGraceAcquisitions;
  return due && !graced ? 'scene_first_revision_due' : undefined;
}

/** A reminder carried by an admitted acquisition result; never a refusal. */
export function sceneAcquisitionReminder(state: ScenePacingState, now: number): ScenePacingReminder | undefined {
  const {policy} = state;
  if (state.committedSegments === 0) {
    return state.completedAcquisitions >= policy.reminderAcquisitions ? 'scene_no_committed_revision' : undefined;
  }
  return sceneAcquisitionsSinceCommit(state) >= policy.staleRevisionAcquisitions &&
    state.inputs.current() - now < policy.deadlineWarningRounds * slowestRecentSceneRoundMs(state)
    ? 'scene_deadline_near' : undefined;
}
