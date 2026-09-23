// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {parseAnalysisTurnIntentDecision, type AnalysisTurnIntentDecision} from '../../agentRuntime/analysisTurnIntent';
import {buildComplexityClassifierInput} from '../queryComplexityContext';
import {buildAnalysisTurnIntentPrompt} from '../queryComplexityPrompt';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes, loadPromptTemplate} from '../strategyLoader';

const definitions = getRegisteredScenes();
const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions, overlayGeneration: 'scene-declaration-test'});
const decision: AnalysisTurnIntentDecision = {
  schemaVersion: 1, taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'existing_only',
};

describe('real strategy registry and native intent declaration contract', () => {
  it.each(definitions)('validates the registered $scene declaration without interpreting query keywords', definition => {
    const declared = {...decision, sceneId: definition.scene};
    expect(parseAnalysisTurnIntentDecision(JSON.stringify(declared), registry)).toEqual(
      definition.strategyKind === 'contract_only' ? undefined : declared);
  });

  it('rejects undeclared scene IDs without restricting the compatibility string type', () => {
    expect(parseAnalysisTurnIntentDecision(JSON.stringify({...decision, sceneId: 'unregistered.scene.fixture'}), registry))
      .toBeUndefined();
  });

  it('passes real registered scene descriptions and capabilities into the semantic request catalog', () => {
    const context = buildComplexityClassifierInput({
      query: 'Do not use words in this question as a scene oracle.', sceneType: 'general',
      hasReferenceTrace: true, previousTurns: [],
    });
    const template = loadPromptTemplate('prompt-analysis-turn-intent');
    expect(template).toBeDefined();
    const prompt = buildAnalysisTurnIntentPrompt({context, strategyRegistry: registry,
      template: template!, decisionSchema: {schemaVersion: 1}});
    const catalog = definitions.filter(definition => definition.strategyKind !== 'contract_only')
      .sort((left, right) => left.scene.localeCompare(right.scene))
      .map(definition => ({id: definition.scene,
        ...(definition.classificationDescription ? {description: definition.classificationDescription} : {}),
        // Lexical anchors, bounded per scene: what a scene is called, next to
        // what it means.
        ...(definition.keywords.length ? {keywords: definition.keywords.slice(0, 8)} : {}),
        capabilities: definition.requiredCapabilities}));
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.some(entry => 'keywords' in entry)).toBe(true);
    expect(prompt).toContain(JSON.stringify(catalog));
    expect(prompt).toContain(JSON.stringify(context.query));
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
