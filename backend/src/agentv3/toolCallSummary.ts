// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Build a one-line digest of an MCP tool's `input` object so plan-adherence
 * checks can confirm the *right* call was made, not just any call with the
 * right tool name. Two `invoke_skill` calls targeting different skills
 * should be distinguishable in the tool log.
 *
 * Phase 0.5 of the v2.1 context-engineering refactor introduces this; Phase
 * 0.6 changes `PlanPhase.expectedCalls` to a structured `{tool, skillId?,
 * paramsPredicate?}` matcher that consumes `skillId` / `inputSummary`.
 */

import { createHash } from 'crypto';

function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 8);
}

export interface ToolCallSummary {
  inputSummary?: string;
  skillId?: string;
  paramsHash?: string;
}

/**
 * Resolve a structured digest for an MCP tool call. `toolName` must be the
 * short form (without the `mcp__smartperfetto__` prefix).
 *
 * Tools with well-known input shapes get structural summaries. Values are
 * never copied into the summary: summaries are persisted in plan history and
 * a lookup query, SQL literal, note, or hypothesis may contain private text.
 */
export function summarizeToolCallInput(toolName: string, input: unknown): ToolCallSummary {
  if (input == null || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  const paramsHash = hashInput(input);

  switch (toolName) {
    case 'execute_sql': {
      const sql = typeof obj.sql === 'string' ? obj.sql : '';
      return { inputSummary: sql ? 'sql' : undefined, paramsHash };
    }
    case 'invoke_skill':
    case 'compare_skill': {
      const skillId = typeof obj.skillId === 'string' ? obj.skillId : undefined;
      const params = obj.params && typeof obj.params === 'object'
        ? obj.params as Record<string, unknown>
        : {};
      const currentParams = obj.currentParams && typeof obj.currentParams === 'object'
        ? obj.currentParams as Record<string, unknown>
        : {};
      const referenceParams = obj.referenceParams && typeof obj.referenceParams === 'object'
        ? obj.referenceParams as Record<string, unknown>
        : {};
      const paramKeys = [
        ...Object.keys(params).sort(),
        ...Object.keys(currentParams).sort().map(key => `current.${key}`),
        ...Object.keys(referenceParams).sort().map(key => `reference.${key}`),
      ].join(',');
      const inputSummary = skillId
        ? (paramKeys ? `${skillId}(${paramKeys})` : skillId)
        : undefined;
      return { skillId, inputSummary, paramsHash };
    }
    case 'analyze_wait_chain': {
      // Two wait-chain calls on different threads or windows must not read as
      // the same plan step, so this one keeps the selector, like fetch_artifact
      // keeps its artifact id.
      // `main_thread` is part of the selector, not a fallback for having no
      // names: `{process_name, main_thread: true}` and `{process_name}` address
      // different threads, and dropping it made them one plan step.
      const selector = [obj.process_name, obj.thread_name]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (obj.main_thread === true) selector.push('main_thread');
      const target = selector.join('/')
        || (obj.utid != null ? `utid:${obj.utid}` : '')
        || (obj.thread_state_id != null ? `thread_state:${obj.thread_state_id}` : '')
        || '?';
      const window = obj.start_ts != null && obj.end_ts != null
        ? ` @ ${obj.start_ts}..${obj.end_ts}`
        : '';
      return { inputSummary: `${target}${window}`, paramsHash };
    }
    case 'fetch_artifact': {
      const id = obj.artifactId ?? obj.id ?? '?';
      const detail = obj.detail ?? obj.level ?? '?';
      return { inputSummary: `${id}@${detail}`, paramsHash };
    }
    default: {
      const keys = Object.keys(obj).sort();
      return {
        inputSummary: keys.length > 0 ? `${toolName}(${keys.join(',')})` : toolName,
        paramsHash,
      };
    }
  }
}
