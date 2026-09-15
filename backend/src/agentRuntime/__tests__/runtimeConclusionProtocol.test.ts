// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {
  acceptNativeDeclarationCompletion,
  buildNativeDeclarationCompletionPrompt,
  buildRelationProposalRecoveryPromptFragment,
  nativeDeclarationBodyCanFitOutput,
  requestNativeDeclarationCompletion,
} from '../runtimeConclusionProtocol';
import {buildCandidateProtocolDiagnostic, inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';

const intent = (taskKind: AnalysisTurnIntent['taskKind']): AnalysisTurnIntent => ({
  schemaVersion: 1,
  status: 'resolved',
  source: 'semantic',
  registryFingerprint: 'registry',
  taskKind,
  sceneId: 'general',
  scope: 'bounded_question',
  recommendedComplexity: taskKind === 'acknowledgement' ? 'quick' : 'full',
  deliverable: 'answer',
  evidenceAccess: taskKind === 'acknowledgement' ? 'existing_only' : 'read_new',
});

const declaration = (mode: 'focused_answer' | 'need_input' = 'focused_answer') =>
  renderConclusionContractSidecar({
    schemaVersion: 'conclusion_contract_v1',
    mode,
    conclusions: [],
    clusters: [],
    evidenceChain: [],
    claims: [],
    relationProposals: [],
    uncertainties: [],
    nextSteps: [],
  });

describe('runtime native declaration completion', () => {
  it.each(['en', 'zh-CN'] as const)('loads exact relation schema only for a sanitized invalid relation in %s', outputLanguage => {
    const invalid = renderConclusionContractSidecar({...JSON.parse(JSON.stringify({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
    })), relationProposals: [{PRIVATE_RELATION_KEY_CANARY: 'PRIVATE_RELATION_VALUE_CANARY'}]} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(invalid), 'native', 1);
    const fragment = buildRelationProposalRecoveryPromptFragment(diagnostic, outputLanguage);
    expect(fragment).toContain('proofBindings');
    expect(fragment).toContain('endpointColumn');
    expect(fragment).toContain('current_minus_reference');
    expect(fragment).toContain('proposal:[A-Za-z0-9]');
    expect(fragment).toContain(outputLanguage === 'en' ? 'cannot be null' : '不能是 null');
    expect(fragment).not.toContain('PRIVATE_RELATION_');

    const absent = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('ordinary answer'), 'native', 1);
    expect(buildRelationProposalRecoveryPromptFragment(absent, outputLanguage)).toBe('');
    expect(buildRelationProposalRecoveryPromptFragment({...diagnostic,
      relationProposalDiagnostics: [{scope: 'item', ordinal: 25, reason: 'invalid_id'}]} as any, outputLanguage)).toBe('');
  });

  it.each(['fact', 'investigation', 'comparison'] as const)(
    'requests one completion for a completed undeclared %s candidate', taskKind => {
      expect(requestNativeDeclarationCompletion({
        intent: intent(taskKind), completion: {status: 'completed'}, candidate: 'Answer', remainingDeliveryTurns: 1,
      })).toMatchObject({reason: 'missing_declaration', originalBody: 'Answer', diagnostic: {status: 'absent'}});
    },
  );

  it('exempts typed acknowledgements and rejects ineligible candidates without reading prose intent', () => {
    for (const input of [
      {intent: intent('acknowledgement'), completion: {status: 'completed' as const}, candidate: '42 ms', remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'incomplete' as const}, candidate: 'Answer', remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'completed' as const}, candidate: '', remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'completed' as const}, candidate: `Answer\n${declaration()}`, remainingDeliveryTurns: 1},
      {intent: intent('fact'), completion: {status: 'completed' as const}, candidate: 'Answer', remainingDeliveryTurns: 0},
    ]) expect(requestNativeDeclarationCompletion(input)).toBeUndefined();
  });

  it('carries the complete >8 KiB multilingual body in the dedicated prompt', () => {
    const body = `开头🙂\n${'中English🙂'.repeat(1300)}\n结尾`;
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
    const request = requestNativeDeclarationCompletion({
      intent: intent('investigation'), completion: {status: 'completed'}, candidate: body, remainingDeliveryTurns: 1,
    })!;
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: intent('investigation'), outputLanguage: 'zh-CN'});
    const encoded = JSON.stringify({schemaVersion: 1, kind: 'original_native_candidate', body});
    expect(prompt).toContain(encoded);
    expect(prompt).toContain('missing_declaration');
    expect(prompt).not.toContain('[omitted: byte budget]');
  });

  it('projects only closed turn-scope fields and excludes classifier prose and receipts', () => {
    const classified = {...intent('investigation'), reason: 'UNTRUSTED_CLASSIFIER_REASON',
      actualModel: 'private-model', finishReason: 'stop'};
    const request = requestNativeDeclarationCompletion({
      intent: classified, completion: {status: 'completed'}, candidate: 'Answer', remainingDeliveryTurns: 1,
    })!;
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent: classified, outputLanguage: 'en'});
    expect(prompt).toContain(JSON.stringify({schemaVersion: 1, status: 'resolved', taskKind: 'investigation',
      sceneId: 'general', scope: 'bounded_question', deliverable: 'answer', evidenceAccess: 'read_new'}));
    expect(prompt).not.toContain('UNTRUSTED_CLASSIFIER_REASON');
    expect(prompt).not.toContain('private-model');
    expect(prompt).not.toContain('registry');
  });

  it('accepts a valid full candidate with an unchanged body, including need_input', () => {
    for (const mode of ['focused_answer', 'need_input'] as const) {
      const originalBody = mode === 'need_input' ? 'Which trace should I inspect?' : 'Measured value: 42 ms.';
      const request = requestNativeDeclarationCompletion({
        intent: intent('investigation'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
      })!;
      const candidate = `${originalBody}\n${declaration(mode)}`;
      expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate})).toBe(candidate);
    }
  });

  it.each([
    ['middle edit', 'Measured value: 43 ms.\n'],
    ['line-ending edit', 'first\nsecond\n'],
    ['truncated body', 'Measured value:'],
    ['absent declaration', 'Measured value: 42 ms.'],
  ])('rejects %s', (_name, repairedBody) => {
    const originalBody = _name === 'line-ending edit' ? 'first\r\nsecond\r\n' : 'Measured value: 42 ms.';
    const request = requestNativeDeclarationCompletion({
      intent: intent('investigation'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
    })!;
    const candidate = _name === 'absent declaration' ? repairedBody : `${repairedBody}${declaration()}`;
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate})).toBeUndefined();
  });

  it('rejects invalid, failed and incomplete repairs', () => {
    const request = requestNativeDeclarationCompletion({
      intent: intent('fact'), completion: {status: 'completed'}, candidate: 'Answer', remainingDeliveryTurns: 1,
    })!;
    const invalid = 'Answer\n<!-- smartperfetto:conclusion-contract@1\n```json\nnull\n```\n-->';
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate: invalid})).toBeUndefined();
    for (const status of ['incomplete', 'failed', 'cancelled', 'unknown'] as const) {
      expect(acceptNativeDeclarationCompletion({request, completion: {status}, candidate: `Answer\n${declaration()}`})).toBeUndefined();
    }
  });

  it('checks existing output limits without truncating the body', () => {
    expect(nativeDeclarationBodyCanFitOutput('中文', 7)).toBe(true);
    expect(nativeDeclarationBodyCanFitOutput('中文', 6)).toBe(false);
    expect(nativeDeclarationBodyCanFitOutput('any length', undefined)).toBe(true);
    expect(nativeDeclarationBodyCanFitOutput('body', 0)).toBe(false);
  });

  it('accepts the exact output cap and rejects the same complete candidate one byte over it', () => {
    const originalBody = 'x'.repeat(100);
    const request = requestNativeDeclarationCompletion({
      intent: intent('fact'), completion: {status: 'completed'}, candidate: originalBody, remainingDeliveryTurns: 1,
    })!;
    const candidate = `${originalBody}\n${declaration()}`;
    const candidateBytes = Buffer.byteLength(candidate, 'utf8');
    expect(nativeDeclarationBodyCanFitOutput(originalBody, candidateBytes)).toBe(true);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate,
      outputByteLimit: candidateBytes})).toBe(candidate);
    expect(acceptNativeDeclarationCompletion({request, completion: {status: 'completed'}, candidate,
      outputByteLimit: candidateBytes - 1}))
      .toBeUndefined();
  });
});
