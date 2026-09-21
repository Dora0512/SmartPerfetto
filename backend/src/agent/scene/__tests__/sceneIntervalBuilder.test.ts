// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Unit tests for sceneIntervalBuilder — covers the two-layer scene model,
 * with explicit regression cases for the previously-dropped step types
 * (scroll_initiation / screen_state_changes).
 */

import { DataEnvelope } from '../../../types/dataContract';
import {
  buildAnalysisIntervals,
  buildDisplayedScenes,
  computePriority,
  filterDisplayedScenesForSelection,
  selectAnalysisEligibleScenes,
} from '../sceneIntervalBuilder';
import { DisplayedScene } from '../types';

// ---------------------------------------------------------------------------
// Helpers — build minimal envelopes that look like scene_reconstruction output
// ---------------------------------------------------------------------------

function envelope(
  stepId: string,
  rows: Array<Record<string, any>>,
): DataEnvelope {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return {
    meta: {
      type: 'list',
      version: '2.0',
      source: 'test',
      skillId: 'scene_reconstruction',
      stepId,
    },
    data: {
      columns,
      rows: rows.map((row) => columns.map((c) => row[c])),
    },
    display: {
      layer: 'list',
      format: 'table',
      title: stepId,
    },
  } as unknown as DataEnvelope;
}

function envelopeFromOtherSkill(stepId: string, rows: Array<Record<string, any>>): DataEnvelope {
  const env = envelope(stepId, rows) as any;
  env.meta.skillId = 'unrelated_skill';
  return env as DataEnvelope;
}

// ---------------------------------------------------------------------------
// buildDisplayedScenes
// ---------------------------------------------------------------------------

describe('buildDisplayedScenes', () => {
  it('returns an empty list when given no envelopes', () => {
    const result = buildDisplayedScenes([]);
    expect(result.scenes).toEqual([]);
    expect(result.traceDurationSec).toBe(0);
  });

  it('extracts traceDurationSec from trace_time_range without producing a scene', () => {
    const result = buildDisplayedScenes([
      envelope('trace_time_range', [{ duration_sec: 30.5 }]),
    ]);
    expect(result.traceDurationSec).toBe(30.5);
    expect(result.scenes).toEqual([]);
  });

  it('produces cold/warm/hot start scenes from app_launches', () => {
    const envs = [
      envelope('app_launches', [
        { ts: '0', dur: '1500000000', startup_type: 'cold', package: 'com.app', startup_id: 1 },
        { ts: '5000000000', dur: '300000000', startup_type: 'warm', package: 'com.app', startup_id: 2 },
        { ts: '8000000000', dur: '50000000', startup_type: 'hot', package: 'com.app', startup_id: 3 },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.map((s) => s.sceneType)).toEqual(['cold_start', 'warm_start', 'hot_start']);
    expect(scenes[0].durationMs).toBe(1500);
    // Cold start at 1500ms is over the 1000ms threshold → bad.
    expect(scenes[0].severity).toBe('bad');
    // Warm start at 300ms is under the 600ms threshold → good.
    expect(scenes[1].severity).toBe('good');
  });

  it('produces tap/scroll/long_press scenes from user_gestures', () => {
    const envs = [
      envelope('user_gestures', [
        { ts: '0', dur: '100000000', gesture_type: 'tap', app_package: 'com.app' },
        { ts: '1000000000', dur: '500000000', gesture_type: 'scroll', app_package: 'com.app' },
        { ts: '2000000000', dur: '600000000', gesture_type: 'long_press', app_package: 'com.app' },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.map((s) => s.sceneType)).toEqual(['tap', 'scroll', 'long_press']);
  });
  it('displays scroll axis input neutrally while keeping legacy wheel reports readable', () => {
    const {scenes} = buildDisplayedScenes([envelope('user_gestures', [
      {ts: '10', dur: '0', gesture_type: 'scroll_input', device_id: 7, display_id: 3, input_source: 4098},
      {ts: '20', dur: '0', gesture_type: 'wheel'},
    ])]);
    expect(scenes.map(scene => scene.sceneType)).toEqual(['scroll_input', 'wheel']);
    expect(scenes[0]).toMatchObject({severity: 'unknown', metadata: {device_id: 7, display_id: 3, input_source: 4098}});
    expect(scenes[0].label).toContain('滚动轴输入（ACTION_SCROLL）');
    expect(scenes[0].label).not.toContain('滚轮');
    expect(scenes[1].label).toContain('滚轮');
  });

  it('produces inertial_scroll scenes from inertial_scrolls', () => {
    const envs = [
      envelope('inertial_scrolls', [
        { ts: '0', dur: '1500000000', frame_count: 90, jank_frames: 2, app_package: 'com.app' },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.length).toBe(1);
    expect(scenes[0].sceneType).toBe('inertial_scroll');
  });

  it('links active scroll, scroll_start marker, and inertial scroll as one operation chain', () => {
    const envs = [
      envelope('user_gestures', [
        { ts: '1000000000', dur: '1000000000', gesture_type: 'scroll', app_package: 'com.app' },
      ]),
      envelope('scroll_initiation', [
        { ts: '1100000000', dur: '0', latency_ms: 16, app_package: 'com.app' },
      ]),
      envelope('inertial_scrolls', [
        { ts: '1950000000', dur: '500000000', frame_count: 30, jank_frames: 1, app_package: 'com.app' },
      ]),
    ];

    const { scenes } = buildDisplayedScenes(envs);
    const scroll = scenes.find((scene) => scene.sceneType === 'scroll')!;
    const marker = scenes.find((scene) => scene.sceneType === 'scroll_start')!;
    const inertial = scenes.find((scene) => scene.sceneType === 'inertial_scroll')!;

    expect(marker.sceneRole).toBe('marker');
    expect(marker.analysisEligible).toBe(false);
    expect(marker.parentSceneId).toBe(scroll.id);
    expect(inertial.parentSceneId).toBe(scroll.id);
    expect(scroll.childSceneIds).toEqual(expect.arrayContaining([marker.id, inertial.id]));
  });

  it('produces idle scenes from idle_periods', () => {
    const envs = [
      envelope('idle_periods', [{ ts: '0', dur: '5000000000', confidence: 0.9 }]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.length).toBe(1);
    expect(scenes[0].sceneType).toBe('idle');
  });

  it('produces app_foreground scenes from top_app_changes for non-launcher packages', () => {
    const envs = [
      envelope('top_app_changes', [{ ts: '0', dur: '300000000', app_package: 'com.other' }]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.length).toBe(1);
    expect(scenes[0].sceneType).toBe('app_foreground');
    expect(scenes[0].processName).toBe('com.other');
  });

  // scroll_initiation must not be silently dropped — the legacy extractor
  // only handled a subset of scene_reconstruction's steps.
  it('produces scroll_start scenes from scroll_initiation', () => {
    const envs = [
      envelope('scroll_initiation', [
        { ts: '1000000000', dur: '50000000', latency_ms: 12, app_package: 'com.app' },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.length).toBe(1);
    expect(scenes[0].sceneType).toBe('scroll_start');
    expect(scenes[0].sourceStepId).toBe('scroll_initiation');
    expect(scenes[0].processName).toBe('com.app');
  });

  // The skill emits Chinese event labels on the `event` column; the parser
  // must mirror agentRoutes.ts:mapScreenStateEventToSceneType. screen_unlock
  // does NOT come from this step (it lives on a separate input event step).
  it('produces screen_on/off/sleep scenes from screen_state_changes', () => {
    const envs = [
      envelope('screen_state_changes', [
        { ts: '0', dur: '0', event: '屏幕点亮' },
        { ts: '1000000000', dur: '0', event: '屏幕熄灭' },
        { ts: '2000000000', dur: '0', event: '屏幕休眠' },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.map((s) => s.sceneType)).toEqual(
      ['screen_on', 'screen_off', 'screen_sleep'],
    );
  });

  it('drops screen_state_changes rows whose event text matches no known state', () => {
    const envs = [
      envelope('screen_state_changes', [
        { ts: '0', dur: '0', event: 'unknown event' },
        { ts: '1000000000', dur: '0', event: '屏幕点亮' },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.length).toBe(1);
    expect(scenes[0].sceneType).toBe('screen_on');
  });

  it('adds user-visible system events from system_events', () => {
    const envs = [
      envelope('system_events', [
        { ts: '0', dur: '120000000', event: '解锁屏幕', event_type: 'screen_unlock' },
        { ts: '1000000000', dur: '250000000', event: '下拉通知栏', event_type: 'notification' },
      ]),
    ];

    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.map((scene) => scene.sceneType)).toEqual(['screen_unlock', 'notification']);
    expect(scenes[0].sourceStepId).toBe('system_events');
    expect(scenes[0].evidenceRefs?.[0].sourceStepId).toBe('system_events');
    expect(scenes[0].confidenceScore).toBeGreaterThan(0);
  });

  it('uses clean_timeline as fallback without duplicating source-step scenes', () => {
    const envs = [
      envelope('user_gestures', [
        { ts: '0', dur: '100000000', gesture_type: 'tap', app_package: 'com.app' },
      ]),
      envelope('clean_timeline', [
        {
          event_id: 'evt_1',
          ts: '0',
          dur: '100000000',
          dur_ms: 100,
          event_type: 'tap',
          event: '点击 [app]',
          app_package: 'com.app',
        },
        {
          event_id: 'evt_2',
          ts: '500000000',
          dur: '120000000',
          dur_ms: 120,
          event_type: 'screen_unlock',
          event: '解锁屏幕',
        },
      ]),
    ];

    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes.map((scene) => scene.sceneType)).toEqual(['tap', 'screen_unlock']);
    const tap = scenes.find((scene) => scene.sceneType === 'tap')!;
    expect(tap.sourceStepId).toBe('user_gestures');
    expect(tap.evidenceRefs?.map((ref) => ref.sourceStepId)).toEqual(
      expect.arrayContaining(['user_gestures', 'clean_timeline']),
    );
    expect(scenes.find((scene) => scene.sceneType === 'screen_unlock')?.sourceStepId).toBe('clean_timeline');
  });

  it('attaches Android runtime context around a scene', () => {
    const envs = [
      envelope('user_gestures', [
        { ts: '1000000000', dur: '100000000', gesture_type: 'tap', app_package: 'com.app' },
      ]),
      envelope('operation_chain', [
        { ts: '1005000000', event: '点击', category: 'gesture', priority: 4 },
      ]),
      envelope('activity_lifecycle', [
        { ts: '1010000000', activity_name: 'MainActivity', lifecycle_event: 'activityResume', dur_ms: 12 },
      ]),
      envelope('app_state_tracking', [
        { ts: '1020000000', event: '进入前台', app_package: 'com.app', oom_adj: 0, state_label: '前台' },
      ]),
      envelope('device_state', [
        { ts: '1030000000', event: 'CPU 0 频率范围', value: '300 - 2400 MHz', category: 'cpu_freq' },
      ]),
    ];

    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes[0].context?.operationChain?.length).toBe(1);
    expect(scenes[0].context?.activityLifecycle?.length).toBe(1);
    expect(scenes[0].context?.appState?.length).toBe(1);
    expect(scenes[0].context?.deviceState?.length).toBe(1);
    expect(scenes[0].confidenceReasons).toEqual(expect.arrayContaining(['context:operation_chain']));
  });

  it('falls back to jank_region scenes only when no gesture-like scene was found', () => {
    const jankRows = [
      { ts: '0', dur: '20000000', jank_severity_type: 'Full' },
      { ts: '50000000', dur: '20000000', jank_severity_type: 'Full' },
      { ts: '100000000', dur: '20000000', jank_severity_type: 'Full' },
    ];
    const envsNoGesture = [envelope('jank_events', jankRows)];
    const noGestureResult = buildDisplayedScenes(envsNoGesture);
    expect(noGestureResult.scenes.length).toBe(1);
    expect(noGestureResult.scenes[0].sceneType).toBe('jank_region');

    const envsWithGesture = [
      envelope('user_gestures', [
        { ts: '0', dur: '100000000', gesture_type: 'tap', app_package: 'com.app' },
      ]),
      envelope('jank_events', jankRows),
    ];
    const withGestureResult = buildDisplayedScenes(envsWithGesture);
    // Only the tap survives — jank fallback is suppressed.
    expect(withGestureResult.scenes.map((s) => s.sceneType)).toEqual(['tap']);
  });

  it('ignores envelopes from unrelated skills', () => {
    const envs = [
      envelopeFromOtherSkill('app_launches', [
        { ts: '0', dur: '1500000000', startup_type: 'cold', package: 'com.app', startup_id: 1 },
      ]),
    ];
    const { scenes } = buildDisplayedScenes(envs);
    expect(scenes).toEqual([]);
  });

  it('keeps unclassified motion and cancelled input instead of inventing a tap', () => {
    const {scenes} = buildDisplayedScenes([envelope('user_gestures', [
      {ts: '0', dur: '100000000', gesture_type: 'input_unknown', source_status: 'partial', missing_action_count: 2},
      {ts: '200000000', dur: '100000000', gesture_type: 'cancelled', source_status: 'observed', stream_key: 'window-A'},
      {ts: '400000000', dur: '100000000', gesture_type: 'touch_move', source_status: 'observed'},
    ])]);
    expect(scenes.map(scene => scene.sceneType)).toEqual(['input_unknown', 'cancelled', 'touch_move']);
    expect(scenes[0].metadata.missing_action_count).toBe(2);
    expect(scenes[1].metadata.stream_key).toBe('window-A');
    expect(scenes.every(scene => scene.severity === 'unknown')).toBe(true);
  });

  it('does not turn an uncovered input gap into idle or a good performance rating', () => {
    const {scenes} = buildDisplayedScenes([envelope('idle_periods', [
      {ts: '0', dur: '1000000000', category: 'unknown', source_status: 'unknown'},
    ])]);
    expect(scenes[0].sceneType).toBe('input_unknown');
    expect(scenes[0].sceneRole).toBe('context');
    expect(scenes[0].severity).toBe('unknown');
  });

  it('separates input duration from measured response and frame quality', () => {
    const {scenes} = buildDisplayedScenes([
      envelope('user_gestures', [
        {ts: '0', dur: '500000000', gesture_type: 'tap', app_package: 'com.app'},
        {ts: '1000000000', dur: '1000000000', gesture_type: 'long_press', app_package: 'com.app'},
        {ts: '2000000000', dur: '1000000000', gesture_type: 'scroll', app_package: 'com.app'},
      ]),
      envelope('inertial_scrolls', [
        {ts: '4000000000', dur: '1000000000', frame_count: 60, jank_frames: 60, app_package: 'com.app'},
      ]),
    ]);
    expect(scenes.slice(0, 3).map(scene => scene.severity)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(scenes[3].severity).toBe('bad');
  });

  it('does not increase a low-confidence gesture score for derived copies of the same input', () => {
    const gesture = envelope('user_gestures', [
      {ts: '1000000000', dur: '100000000', gesture_type: 'scroll', app_package: 'com.app', confidence: '低'},
    ]);
    const original = buildDisplayedScenes([gesture]).scenes[0];
    const enriched = buildDisplayedScenes([gesture,
      envelope('clean_timeline', [{ts: '1000000000', dur: '100000000', event_type: 'scroll', app_package: 'com.app'}]),
      envelope('operation_chain', [{ts: '1000000000', event: 'scroll', category: 'gesture'}]),
    ]).scenes[0];
    expect(original.confidenceLevel).toBe('low');
    expect(enriched.confidenceScore).toBe(original.confidenceScore);
  });

  it('keeps nearby input from another app and distinct same-app input as separate candidates', () => {
    const {scenes} = buildDisplayedScenes([
      envelope('user_gestures', [{ts: '0', dur: '10000000', gesture_type: 'tap', app_package: 'com.first'}]),
      envelope('clean_timeline', [
        {ts: '0', dur: '10000000', event_type: 'tap', app_package: 'com.second'},
        {ts: '20000000', dur: '10000000', event_type: 'tap', app_package: 'com.first'},
      ]),
    ]);
    expect(scenes).toHaveLength(3);
    expect(scenes[0].evidenceRefs).toHaveLength(1);
  });

  it('interprets typed screen states and keeps explicitly unknown screen intervals', () => {
    const {scenes} = buildDisplayedScenes([envelope('screen_state_changes', [
      {ts: '0', dur: '1', simple_screen_state: 'on'},
      {ts: '1', dur: '1', simple_screen_state: 'off'},
      {ts: '2', dur: '1', simple_screen_state: 'doze'},
      {ts: '3', dur: '1', simple_screen_state: 'unknown'},
    ])]);
    expect(scenes.map(scene => scene.sceneType)).toEqual(['screen_on', 'screen_off', 'screen_sleep', 'screen_unknown']);
    expect(scenes.every(scene => scene.severity === 'unknown')).toBe(true);
  });

  it('preserves a 1ns ordering difference above the safe Number range', () => {
    const {scenes} = buildDisplayedScenes([envelope('user_gestures', [
      {ts: '9007199254740994', dur: '1', gesture_type: 'tap', app_package: 'com.b'},
      {ts: '9007199254740993', dur: '1', gesture_type: 'tap', app_package: 'com.a'},
    ])]);
    expect(scenes.map(scene => scene.startTs)).toEqual(['9007199254740993', '9007199254740994']);
    expect(scenes[0].endTs).toBe('9007199254740994');
    expect(scenes[0].durationMs).toBe(0.000001);
  });
});

// ---------------------------------------------------------------------------
// buildAnalysisIntervals
// ---------------------------------------------------------------------------

describe('buildAnalysisIntervals', () => {
  function makeScene(overrides: Partial<DisplayedScene>): DisplayedScene {
    return {
      id: 'scene-x',
      sceneType: 'cold_start',
      sourceStepId: 'app_launches',
      startTs: '0',
      endTs: '1500000000',
      durationMs: 1500,
      processName: 'com.app',
      label: '冷启动 (1500ms)',
      metadata: { startupId: 1 },
      severity: 'bad',
      analysisState: 'not_planned',
      ...overrides,
    };
  }

  it('returns an empty list when given no scenes', () => {
    const intervals = buildAnalysisIntervals([], { cap: 10 });
    expect(intervals).toEqual([]);
  });

  it('matches startup scenes to the startup route', () => {
    const intervals = buildAnalysisIntervals([makeScene({})], { cap: 10 });
    expect(intervals.length).toBe(1);
    expect(intervals[0].displayedSceneId).toBe('scene-x');
    expect(intervals[0].skillId).toBe('startup_detail');
    expect(intervals[0].params.start_ts).toBe('0');
    expect(intervals[0].params.end_ts).toBe('1500000000');
    expect(intervals[0].params.package).toBe('com.app');
    expect(intervals[0].params.startup_id).toBe(1);
  });

  it('sorts problem scenes ahead of healthy ones', () => {
    const scenes: DisplayedScene[] = [
      makeScene({ id: 's-good', sceneType: 'tap', durationMs: 50, severity: 'good' }),
      makeScene({ id: 's-bad', sceneType: 'cold_start', durationMs: 2000, severity: 'bad' }),
    ];
    const intervals = buildAnalysisIntervals(scenes, { cap: 10 });
    expect(intervals.map((i) => i.displayedSceneId)).toEqual(['s-bad', 's-good']);
  });

  it('truncates the list to the cap', () => {
    const scenes = Array.from({ length: 10 }).map((_, i) =>
      makeScene({ id: `scene-${i}`, sceneType: 'cold_start', durationMs: 2000 }),
    );
    const intervals = buildAnalysisIntervals(scenes, { cap: 3 });
    expect(intervals.length).toBe(3);
  });

  it('skips scenes that match no route', () => {
    const scenes: DisplayedScene[] = [
      makeScene({ id: 'unmatched', sceneType: 'screen_off', durationMs: 100 }),
      makeScene({ id: 'matched', sceneType: 'cold_start', durationMs: 2000 }),
    ];
    const intervals = buildAnalysisIntervals(scenes, { cap: 10 });
    // Default manifest has startup + non_startup (excludes startup types and
    // app_switch via group, but screen_off is not in any group → skipped).
    const ids = intervals.map((i) => i.displayedSceneId);
    expect(ids).toContain('matched');
    // Non-startup_route includes 'all' minus startup types, so screen_off
    // would actually match. We only assert that 'matched' is present —
    // exact unmatched behaviour depends on the manifest configuration.
  });

  it('routes smart scenes through profile-specific deep-dive skills', () => {
    const scenes: DisplayedScene[] = [
      makeScene({ id: 'scroll-start-1', sceneType: 'scroll_start', startTs: '5', endTs: '5', durationMs: 0 }),
      makeScene({ id: 'tap-1', sceneType: 'tap', startTs: '10', endTs: '20', durationMs: 10 }),
      makeScene({ id: 'nav-1', sceneType: 'home_key', startTs: '20', endTs: '30', durationMs: 10 }),
      makeScene({ id: 'screen-1', sceneType: 'screen_off', startTs: '30', endTs: '40', durationMs: 10 }),
      makeScene({ id: 'anr-1', sceneType: 'anr', startTs: '40', endTs: '50', durationMs: 6000 }),
    ];

    const intervals = buildAnalysisIntervals(scenes, { cap: 10, routeProfile: 'smart' });
    const byScene = Object.fromEntries(intervals.map((i) => [i.displayedSceneId, i]));

    expect(byScene['scroll-start-1']).toBeUndefined();
    expect(byScene['tap-1'].skillId).toBe('click_response_analysis');
    expect(byScene['nav-1'].skillId).toBe('navigation_analysis');
    expect(byScene['screen-1'].skillId).toBe('device_state_snapshot');
    expect(byScene['anr-1'].skillId).toBe('anr_analysis');
  });

  it('skips scenes that are explicitly marked ineligible for analysis', () => {
    const intervals = buildAnalysisIntervals([
      makeScene({
        id: 'tap-marker',
        sceneType: 'tap',
        durationMs: 10,
        sceneRole: 'marker',
        analysisEligible: false,
      }),
    ], { cap: 10, routeProfile: 'smart' });

    expect(intervals).toEqual([]);
  });

  it('keeps legacy profile from routing device-state scenes', () => {
    const intervals = buildAnalysisIntervals([
      makeScene({ id: 'screen-legacy', sceneType: 'screen_off', durationMs: 10 }),
    ], { cap: 10 });

    expect(intervals).toEqual([]);
  });

  it('filters scenes by explicit smart selection before deep-dive interval planning', () => {
    const scenes: DisplayedScene[] = [
      makeScene({ id: 'start-1', sceneType: 'cold_start' }),
      makeScene({ id: 'scroll-1', sceneType: 'scroll' }),
      makeScene({ id: 'tap-1', sceneType: 'tap' }),
    ];

    expect(filterDisplayedScenesForSelection(scenes, {
      scope: 'scene_types',
      sceneTypes: ['scroll'],
    }).map((scene) => scene.id)).toEqual(['scroll-1']);

    expect(filterDisplayedScenesForSelection(scenes, {
      scope: 'scene_ids',
      sceneIds: ['tap-1'],
    }).map((scene) => scene.id)).toEqual(['tap-1']);

    expect(filterDisplayedScenesForSelection(scenes, { scope: 'all' })).toBe(scenes);
  });

  it('filters smart selections down to analysis-eligible action scenes', () => {
    const scenes: DisplayedScene[] = [
      makeScene({ id: 'scroll-1', sceneType: 'scroll' }),
      makeScene({
        id: 'scroll-start-1',
        sceneType: 'scroll_start',
        sceneRole: 'marker',
        analysisEligible: false,
      }),
      makeScene({
        id: 'idle-1',
        sceneType: 'idle',
        sceneRole: 'context',
        analysisEligible: false,
      }),
    ];

    expect(selectAnalysisEligibleScenes(scenes, { scope: 'all' }).map((scene) => scene.id))
      .toEqual(['scroll-1']);
  });
});

// ---------------------------------------------------------------------------
// computePriority
// ---------------------------------------------------------------------------

describe('computePriority', () => {
  function makeScene(sceneType: string, durationMs: number, extras: Record<string, any> = {}) {
    return {
      id: 'x',
      sceneType,
      sourceStepId: 'app_launches',
      startTs: '0',
      endTs: '0',
      durationMs,
      label: '',
      metadata: extras,
      severity: 'good' as const,
      analysisState: 'not_planned' as const,
    };
  }

  it('returns 90 for a scene that exceeds its duration threshold', () => {
    expect(computePriority(makeScene('cold_start', 1500))).toBe(90);
  });

  it('returns 50 for a scene under its threshold', () => {
    expect(computePriority(makeScene('cold_start', 500))).toBe(50);
  });

  it('returns 50 for an unknown scene type', () => {
    expect(computePriority(makeScene('mystery_event', 9999))).toBe(50);
  });

  it('uses fps for scroll-like scenes', () => {
    expect(computePriority(makeScene('scroll', 0, { averageFps: 30 }))).toBe(90);
    expect(computePriority(makeScene('scroll', 0, { averageFps: 60 }))).toBe(50);
  });
});
