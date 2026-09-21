// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import type {
  DisplayedScene,
  SceneReconstructionVerification,
} from './types';
import {loadStrategyRegistry} from '../../agentv3/strategyLoader';

interface ScenePresentationRegistry {
  version: number;
  scenes: Record<string, Record<OutputLanguage, string>>;
}

function sceneLabels(): ScenePresentationRegistry['scenes'] {
  const registry = loadStrategyRegistry<ScenePresentationRegistry>('scene-presentation');
  if (!registry || registry.version !== 1 || !registry.scenes) {
    throw new Error('Required scene presentation registry is missing or invalid');
  }
  return registry.scenes;
}

export function isKnownSceneType(sceneType: string): boolean {
  return Object.prototype.hasOwnProperty.call(sceneLabels(), sceneType);
}

export function displaySceneType(
  sceneType: string,
  outputLanguage: OutputLanguage,
): string {
  return sceneLabels()[sceneType]?.[outputLanguage] ?? sceneType;
}

export function projectDisplayedScene(
  scene: DisplayedScene,
  outputLanguage: OutputLanguage,
): DisplayedScene {
  const duration = Number.isFinite(scene.durationMs)
    ? `${Math.max(0, Math.round(scene.durationMs))}ms`
    : '0ms';
  const jankCount = Number(scene.metadata?.jankCount);
  const label = scene.sceneType === 'jank_region' && Number.isFinite(jankCount)
    ? localize(
        outputLanguage,
        `${displaySceneType(scene.sceneType, outputLanguage)} (${jankCount} 帧掉帧)`,
        `${displaySceneType(scene.sceneType, outputLanguage)} (${jankCount} janky frames)`,
      )
    : `${displaySceneType(scene.sceneType, outputLanguage)} (${duration})`;
  return {
    ...scene,
    label,
    conflicts: scene.conflicts?.map(conflict => ({
      ...conflict,
      message: outputLanguage === 'en'
        ? englishConflictMessage(conflict.type)
        : conflict.message,
    })),
  };
}

function englishConflictMessage(type: NonNullable<DisplayedScene['conflicts']>[number]['type']): string {
  switch (type) {
    case 'app_mismatch': return 'Scene evidence refers to different apps.';
    case 'type_mismatch': return 'Scene evidence disagrees on the scene type.';
    case 'invalid_timing': return 'Scene evidence contains an invalid time range.';
    case 'duplicate_candidate': return 'Scene evidence contains a duplicate candidate.';
    case 'ambiguous_boundary': return 'Scene boundaries are ambiguous.';
  }
}

export function projectSceneVerification(
  verification: SceneReconstructionVerification | undefined,
  outputLanguage: OutputLanguage,
): SceneReconstructionVerification | undefined {
  if (!verification) return undefined;
  if (outputLanguage === 'zh-CN') return verification;
  return {
    ...verification,
    summary: localize(
      outputLanguage,
      verification.summary,
      verification.scope === 'structure'
        ? `Scene structure check: ${verification.status}; checked ${verification.checkedSceneCount} scenes. Raw evidence and full-trace coverage were not checked.`
        : `Scene verification status: ${verification.status}; checked ${verification.checkedSceneCount} scenes.`,
    ),
    issues: verification.issues.map(issue => ({
      ...issue,
      message: `Scene verification issue: ${issue.type}`,
    })),
    llm: verification.llm
      ? {
          status: verification.llm.status,
          summary: `LLM verification status: ${verification.llm.status}.`,
        }
      : undefined,
  };
}
