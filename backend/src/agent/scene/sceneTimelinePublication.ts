// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {OutputLanguage} from '../../agentv3/outputLanguage';
import {freezeEvidenceValue} from '../../services/evidence/evidenceCapture';
import type {SceneScope, SceneTimelineAssessment} from './sceneTimelineContract';

declare const publicationBrand: unique symbol;
export interface SceneTimelinePublication {readonly [publicationBrand]: true}
export interface ScenePublicationData {
  scope: SceneScope;
  assessment: SceneTimelineAssessment;
  summary: string;
  outputLanguage: OutputLanguage;
  totalDurationMs: number;
  registryFingerprint?: string;
  providerId?: string | null;
  runtimeKind?: string;
}
const publications = new WeakMap<object, Readonly<ScenePublicationData>>();

/** Called only by product finalization after all output guards. Never returned in JSON. */
export function issueSceneTimelinePublication(data: ScenePublicationData): SceneTimelinePublication {
  if (data.assessment.runId !== data.scope.runId || data.assessment.sessionId !== data.scope.sessionId ||
      data.assessment.traceId !== data.scope.traceId) throw new Error('scene_publication_identity_mismatch');
  const token = Object.freeze({}) as SceneTimelinePublication;
  publications.set(token, freezeEvidenceValue(structuredClone(data)));
  return token;
}

export function consumeSceneTimelinePublication(token: SceneTimelinePublication, expected: SceneScope): Readonly<ScenePublicationData> {
  const value = publications.get(token);
  if (!value || (['runId', 'sessionId', 'traceId', 'ownerKey'] as const).some(key => value.scope[key] !== expected[key])) {
    throw new Error('unissued_scene_publication');
  }
  publications.delete(token);
  return value;
}
