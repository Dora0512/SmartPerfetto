// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisOptions } from '../agent/core/orchestratorTypes';
import type { ProviderScope } from '../services/providerManager';
import type { KnowledgeScope } from '../services/scopedKnowledgeStore';

export function providerScopeFromAnalysisOptions(options: AnalysisOptions): ProviderScope | undefined {
  if (!options.tenantId || !options.workspaceId) return undefined;
  return {
    tenantId: options.tenantId,
    workspaceId: options.workspaceId,
    userId: options.userId,
  };
}

export function knowledgeScopeFromAnalysisOptions(options: AnalysisOptions): KnowledgeScope | undefined {
  if (!options.tenantId || !options.workspaceId) return undefined;
  return {
    tenantId: options.tenantId,
    workspaceId: options.workspaceId,
    userId: options.userId,
    sourceRunId: options.runId,
  };
}

/** The Provider Manager scope of an HTTP caller, the same one an Agent run of theirs uses. */
export function providerScopeFromRequestContext(
  context: {tenantId: string; workspaceId: string; userId: string},
): ProviderScope {
  return {tenantId: context.tenantId, workspaceId: context.workspaceId, userId: context.userId};
}
