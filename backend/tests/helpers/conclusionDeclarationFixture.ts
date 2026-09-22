// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {renderConclusionContractSidecar, type ConclusionContract} from '../../src/agent/core/conclusionContract';

/** The one valid shape every runtime's declaration test starts from. */
export const CLAIM_SEMANTICS = Object.freeze({schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell',
  polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain',
  scope: {population: 'cited_rows'}} as const);

export function declaredClaim(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {id, kind: 'numeric', text: `${id} holds.`, references: [], semantics: CLAIM_SEMANTICS, ...overrides};
}

/** A candidate whose body carries one declaration; an unknown population makes the parser reject it. */
export function declaredCandidateWithClaims(body: string, claims: readonly unknown[]): string {
  return `${body}\n${renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: [...claims]} as unknown as ConclusionContract)}`;
}

export function candidateWithPopulation(body: string, population: string, id = 'claim-a'): string {
  return declaredCandidateWithClaims(body, [declaredClaim(id, {semantics: {...CLAIM_SEMANTICS, scope: {population}}})]);
}
