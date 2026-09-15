// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {
  buildCandidateProtocolDiagnostic,
  inspectCandidateProtocol,
  sanitizeCandidateProtocolDiagnostic,
  type CandidateProtocolDiagnostic,
} from '../services/canonicalAnalysisResult';
import type {AnalysisCompletion} from '../types/analysisDelivery';
import type {AnalysisTurnIntent} from './analysisTurnIntent';

export const MISSING_NATIVE_DECLARATION = 'missing_declaration' as const;

/** Exact schema guidance is loaded only for an existing invalid-relation correction. */
export function buildRelationProposalRecoveryPromptFragment(
  diagnostic: CandidateProtocolDiagnostic,
  outputLanguage: OutputLanguage,
): string {
  const safe = sanitizeCandidateProtocolDiagnostic(diagnostic);
  if (!safe?.issueCodes.includes('invalid_relation_proposal')) return '';
  return renderRequiredLocalizedStrategyTemplate('prompt-relation-proposal-recovery', outputLanguage, {});
}

export interface NativeDeclarationCompletionRequest {
  readonly reason: typeof MISSING_NATIVE_DECLARATION;
  readonly originalBody: string;
  readonly diagnostic: CandidateProtocolDiagnostic;
}

function projectTurnIntentForDeclarationCompletion(intent: AnalysisTurnIntent) {
  return {
    schemaVersion: 1 as const,
    status: intent.status,
    taskKind: intent.taskKind,
    sceneId: intent.sceneId,
    scope: intent.scope,
    deliverable: intent.deliverable,
    evidenceAccess: intent.evidenceAccess,
  };
}

/**
 * Typed intent decides whether a declaration is required. Prose shape and
 * wording never make that decision; a non-acknowledgement clarification uses
 * a `need_input` declaration with empty claims.
 */
export function requestNativeDeclarationCompletion(input: {
  intent: AnalysisTurnIntent;
  completion: Pick<AnalysisCompletion, 'status'>;
  candidate: string;
  remainingDeliveryTurns: number;
}): NativeDeclarationCompletionRequest | undefined {
  if (input.intent.taskKind === 'acknowledgement' || input.completion.status !== 'completed' ||
      !Number.isSafeInteger(input.remainingDeliveryTurns) || input.remainingDeliveryTurns <= 0) return undefined;
  const inspected = inspectCandidateProtocol(input.candidate);
  if (!inspected.canonicalBody.trim() || inspected.status !== 'absent') return undefined;
  return Object.freeze({
    reason: MISSING_NATIVE_DECLARATION,
    originalBody: input.candidate,
    diagnostic: Object.freeze(buildCandidateProtocolDiagnostic(inspected, 'native', 1)),
  });
}

/** The body alone must fit; no caller may shorten it to make room for a declaration. */
export function nativeDeclarationBodyCanFitOutput(
  body: string,
  outputByteLimit: number | undefined,
): boolean {
  return outputByteLimit === undefined || Number.isSafeInteger(outputByteLimit) && outputByteLimit > 0 &&
    Buffer.byteLength(body, 'utf8') < outputByteLimit;
}

function nativeDeclarationCandidateFitsOutput(candidate: string, outputByteLimit: number | undefined): boolean {
  return outputByteLimit === undefined || Number.isSafeInteger(outputByteLimit) && outputByteLimit > 0 &&
    Buffer.byteLength(candidate, 'utf8') <= outputByteLimit;
}

/** Build the one no-tool completion request with the full native body as data. */
export function buildNativeDeclarationCompletionPrompt(input: {
  request: NativeDeclarationCompletionRequest;
  intent: AnalysisTurnIntent;
  outputLanguage: OutputLanguage;
}): string {
  return renderRequiredLocalizedStrategyTemplate(
    'prompt-native-declaration-completion',
    input.outputLanguage,
    {
      completion_reason: input.request.reason,
      turn_intent: JSON.stringify(projectTurnIntentForDeclarationCompletion(input.intent)),
      original_candidate_json: JSON.stringify({
        schemaVersion: 1,
        kind: 'original_native_candidate',
        body: input.request.originalBody,
      }),
      candidate_protocol_diagnostic: JSON.stringify(
        sanitizeCandidateProtocolDiagnostic(input.request.diagnostic) ?? null,
      ),
    },
  );
}

/**
 * A completion may add only a valid declaration around the same visible body.
 * Internal line endings and all non-edge whitespace remain significant.
 */
export function acceptNativeDeclarationCompletion(input: {
  request: NativeDeclarationCompletionRequest;
  completion: Pick<AnalysisCompletion, 'status'>;
  candidate: string;
  outputByteLimit?: number;
}): string | undefined {
  if (input.completion.status !== 'completed' ||
      !nativeDeclarationCandidateFitsOutput(input.candidate, input.outputByteLimit)) return undefined;
  const original = inspectCandidateProtocol(input.request.originalBody);
  const repaired = inspectCandidateProtocol(input.candidate);
  if (original.status !== 'absent' || repaired.status !== 'valid' ||
      repaired.canonicalBody.trim() !== original.canonicalBody.trim()) return undefined;
  return input.candidate;
}
