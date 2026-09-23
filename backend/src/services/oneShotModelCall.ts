// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// One isolated, one-shot model call for the product's auxiliary summaries
// (critical-path, comparison conclusion, flamegraph). Each of them used to
// build its own SDK call with a different subset of the safeguards; this module
// owns them all:
//   - the AI capability gate, checked before any provider lookup;
//   - Provider Manager runtime selection for the caller's scope;
//   - credentials checked in the resolved profile env, never raw process env;
//   - SDK options detached from user settings, tools, skills, plugins, MCP
//     servers and resumable transcripts (the classifier transport's options);
//   - one AbortController for caller cancellation and the wall-clock deadline,
//     `close()` on every exit, and a tool-use or refusal reply treated as a
//     failed call.
// Raw SDK error text goes to the log only; callers get a reason code.

import {query as sdkQuery, type Options} from '@anthropic-ai/claude-agent-sdk';
import {resolveAgentRuntimeSelection} from '../agentRuntime/runtimeSelection';
import type {ResolvedAgentRuntimeKind} from '../agentRuntime/runtimeSelection';
import {
  createSdkEnv,
  getSdkBinaryOption,
  hasClaudeCredentials,
  loadClaudeConfig,
  resolveClaudeSdkPermissionOptions,
  resolveRuntimeConfig,
  type EffortLevel,
} from '../agentv3/claudeConfig';
import {
  type AiCapabilityFeature,
  type AiCapabilityPolicyV1,
  getAiCapabilityPolicy,
  isAiFeatureEnabled,
} from './aiCapabilityPolicy';
import type {ProviderScope} from './providerManager';

/** Why a one-shot call produced no model answer. */
export type OneShotFallbackReason =
  | 'ai_disabled'
  | 'permission_denied'
  | 'runtime_not_supported'
  | 'runtime_unavailable'
  | 'credentials_missing'
  | 'client_disconnected'
  | 'timed_out'
  | 'failed'
  | 'empty_response';

export type OneShotModelRoute =
  | {kind: 'unavailable'; reason: 'ai_disabled' | 'runtime_unavailable'}
  | {kind: 'runtime'; runtime: ResolvedAgentRuntimeKind};

/**
 * The AI gate, then the runtime the caller's active provider selects. Never
 * throws: a provider that cannot be resolved is `runtime_unavailable`.
 */
export function resolveOneShotModelRoute(input: {
  feature: AiCapabilityFeature;
  providerId?: string | null;
  providerScope?: ProviderScope;
  aiPolicy?: AiCapabilityPolicyV1;
  logLabel: string;
}): OneShotModelRoute {
  if (!isAiFeatureEnabled(input.feature, input.aiPolicy ?? getAiCapabilityPolicy())) {
    return {kind: 'unavailable', reason: 'ai_disabled'};
  }
  try {
    const selection = resolveAgentRuntimeSelection(input.providerId, undefined, input.providerScope);
    return {kind: 'runtime', runtime: selection.kind};
  } catch (error: unknown) {
    console.warn(`[${input.logLabel}] Provider resolution failed:`, error instanceof Error ? error.message : error);
    return {kind: 'unavailable', reason: 'runtime_unavailable'};
  }
}

/**
 * SDK options for a one-shot call over untrusted, trace-derived text: one turn,
 * no tools, skills, plugins or MCP servers, no user settings, nothing persisted.
 */
export function isolatedClaudeOneShotOptions(input: {
  model: string;
  env: Record<string, string | undefined>;
  stderr: (data: string) => void;
  cwd?: string;
  effort?: EffortLevel;
  abortController?: AbortController;
}): Options {
  return {
    ...getSdkBinaryOption(input.env),
    model: input.model,
    ...(input.cwd ? {cwd: input.cwd} : {}),
    ...(input.effort ? {effort: input.effort} : {}),
    env: input.env,
    maxTurns: 1,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    plugins: [],
    persistSession: false,
    ...resolveClaudeSdkPermissionOptions(),
    ...(input.abortController ? {abortController: input.abortController} : {}),
    stderr: input.stderr,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** A tool call or permission denial inside a call that was given no tools. */
function hasToolUse(message: Record<string, unknown>): boolean {
  const content = object(message.message)?.content;
  const isToolBlock = (value: unknown) => {
    const type = object(value)?.type;
    return type === 'tool_use' || type === 'tool_result';
  };
  return (Array.isArray(content) && content.some(isToolBlock))
    || (Array.isArray(message.permission_denials) && message.permission_denials.length > 0)
    || (message.type === 'system' && message.subtype === 'permission_denied')
    || (message.type === 'result' && message.stop_reason === 'tool_use');
}

export type OneShotClaudeResult =
  | {ok: true; text: string; model: string}
  | {ok: false; reason: OneShotFallbackReason; model?: string};

export interface OneShotClaudeInput {
  prompt: string;
  /** `light` uses the profile's light model and falls back to the main one. */
  tier: 'main' | 'light';
  effort?: EffortLevel;
  timeoutMs: number;
  signal?: AbortSignal;
  logLabel: string;
  providerId?: string | null;
  providerScope?: ProviderScope;
}

/**
 * One isolated Claude call in the caller's provider scope. Never throws for
 * provider, model or cancellation failures; the reason says what happened.
 */
export async function runIsolatedClaudeOneShot(input: OneShotClaudeInput): Promise<OneShotClaudeResult> {
  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected'};
  let model: string;
  let cwd: string | undefined;
  let env: Record<string, string | undefined>;
  try {
    const config = resolveRuntimeConfig(loadClaudeConfig(), input.providerId, input.providerScope);
    model = input.tier === 'light' ? (config.lightModel || config.model) : config.model;
    cwd = config.cwd;
    env = createSdkEnv(input.providerId, input.providerScope);
  } catch (error: unknown) {
    console.warn(`[${input.logLabel}] Provider resolution failed:`, error instanceof Error ? error.message : error);
    return {ok: false, reason: 'runtime_unavailable'};
  }
  if (!hasClaudeCredentials(env)) return {ok: false, reason: 'credentials_missing', model};

  // One controller owns the SDK subprocess; the caller's cancellation and the
  // deadline both stop it through the same path.
  const abortController = new AbortController();
  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const stop = (): void => {
    abortController.abort();
    try {
      stream?.close();
    } catch {
      // ignore
    }
  };
  input.signal?.addEventListener('abort', stop, {once: true});
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 60_000);

  let text = '';
  let failed = false;
  try {
    stream = sdkQuery({
      prompt: input.prompt,
      options: isolatedClaudeOneShotOptions({
        model,
        env,
        cwd,
        effort: input.effort,
        abortController,
        stderr: (data: string) => console.warn(`[${input.logLabel}] SDK stderr: ${data.trimEnd()}`),
      }),
    });
    for await (const entry of stream) {
      if (abortController.signal.aborted) break;
      const message = object(entry);
      if (!message) continue;
      if (hasToolUse(message)) {
        console.warn(`[${input.logLabel}] Model attempted a tool call in a tool-less one-shot call`);
        failed = true;
        break;
      }
      if (message.type === 'system'
        && (message.subtype === 'model_refusal_fallback' || message.subtype === 'model_refusal_no_fallback')) {
        failed = true;
        break;
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error === true || message.stop_reason === 'refusal') {
          failed = true;
          break;
        }
        text = typeof message.result === 'string' ? message.result : '';
      }
    }
  } catch (error: unknown) {
    if (!abortController.signal.aborted) {
      console.warn(`[${input.logLabel}] Model call failed:`, error);
      failed = true;
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', stop);
    try {
      stream?.close();
    } catch {
      // ignore
    }
  }

  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected', model};
  if (timedOut) return {ok: false, reason: 'timed_out', model};
  if (failed) return {ok: false, reason: 'failed', model};
  if (!text.trim()) return {ok: false, reason: 'empty_response', model};
  return {ok: true, text: text.trim(), model};
}
