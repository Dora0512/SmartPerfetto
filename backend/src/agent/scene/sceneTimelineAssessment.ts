// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {freezeEvidenceValue} from '../../services/evidence/evidenceCapture';
import {assertIssuedSceneSnapshot} from './sceneRunContext';
import {assessSceneScanCoverage} from './sceneScanCoverage';
import type {SceneScope, SceneTimelineSnapshot, SceneTimelineAssessment} from './sceneTimelineContract';

/** Product finalization only. No acquisition, restoration or semantic promotion. */
export function assessSceneTimeline(snapshot: SceneTimelineSnapshot, expected: SceneScope): SceneTimelineAssessment {
  assertIssuedSceneSnapshot(snapshot, expected);
  const coverage = assessSceneScanCoverage(snapshot.scanCoverage);
  return freezeEvidenceValue({...snapshot, status: 'partial', coverage,
    diagnostics: [...snapshot.diagnostics, ...(snapshot.scanCoverage?.diagnostics || []),
      ...(coverage.status === 'unknown' ? [{code: 'scan_coverage_not_registered'}] : []),
      ...(!snapshot.segments.length ? [{code: 'no_scene_candidates'}] : [])]});
}
