// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {resolveAgentRuntimeSelection} from '../../agentRuntime/runtimeSelection';
import {createSdkEnv, hasClaudeCredentials, resolveRuntimeConfig} from '../../agentv3/claudeConfig';
import {AI_CAPABILITY_ENV_KEY, resolveAiCapabilityPolicy} from '../aiCapabilityPolicy';
import {
  isolatedClaudeOneShotOptions,
  resolveOneShotModelRoute,
  runIsolatedClaudeOneShot,
} from '../oneShotModelCall';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('../../agentRuntime/runtimeSelection', () => ({
  resolveAgentRuntimeSelection: jest.fn(),
}));

jest.mock('../../agentv3/claudeConfig', () => ({
  createSdkEnv: jest.fn(),
  hasClaudeCredentials: jest.fn(),
  loadClaudeConfig: jest.fn(() => ({model: 'env-model', lightModel: 'env-light'})),
  resolveRuntimeConfig: jest.fn(),
  getSdkBinaryOption: jest.fn(() => ({pathToClaudeCodeExecutable: '/bin/claude'})),
  resolveClaudeSdkPermissionOptions: jest.fn(() => ({permissionMode: 'dontAsk'})),
}));

const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const mockSelection = resolveAgentRuntimeSelection as unknown as jest.Mock<(...args: any[]) => any>;
const mockCreateSdkEnv = createSdkEnv as unknown as jest.Mock<(...args: any[]) => any>;
const mockHasCredentials = hasClaudeCredentials as unknown as jest.Mock<(...args: any[]) => any>;
const mockRuntimeConfig = resolveRuntimeConfig as unknown as jest.Mock<(...args: any[]) => any>;

const SCOPE = {tenantId: 't', workspaceId: 'w', userId: 'u'};

function stream(messages: unknown[]) {
  const close = jest.fn();
  return {
    close,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

/** A stream that waits until the SDK's abort controller fires, then throws like the SDK does. */
function hangingStream(params: any) {
  const abort: AbortController = params.options.abortController;
  return {
    close: jest.fn(),
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), {once: true}));
      throw new Error('Claude Code process aborted by user');
    },
  };
}

function baseInput() {
  return {prompt: 'p', tier: 'main' as const, timeoutMs: 5_000, logLabel: 'Test', providerScope: SCOPE};
}

describe('resolveOneShotModelRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks the AI gate before any provider lookup', () => {
    const route = resolveOneShotModelRoute({
      feature: 'flamegraph_ai_summary',
      aiPolicy: resolveAiCapabilityPolicy({[AI_CAPABILITY_ENV_KEY]: 'false'}),
      logLabel: 'Test',
    });

    expect(route).toEqual({kind: 'unavailable', reason: 'ai_disabled'});
    expect(mockSelection).not.toHaveBeenCalled();
  });

  it('returns the runtime of the caller scope, and runtime_unavailable when it cannot be resolved', () => {
    const aiPolicy = resolveAiCapabilityPolicy({[AI_CAPABILITY_ENV_KEY]: 'true'});
    mockSelection.mockReturnValueOnce({kind: 'openai-agents-sdk', source: 'provider'});
    expect(resolveOneShotModelRoute({
      feature: 'comparison_ai_conclusion', providerId: 'p1', providerScope: SCOPE, aiPolicy, logLabel: 'Test',
    })).toEqual({kind: 'runtime', runtime: 'openai-agents-sdk'});
    expect(mockSelection).toHaveBeenCalledWith('p1', undefined, SCOPE);

    mockSelection.mockImplementationOnce(() => {
      throw new Error('provider p2 not found');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveOneShotModelRoute({
      feature: 'comparison_ai_conclusion', providerId: 'p2', aiPolicy, logLabel: 'Test',
    })).toEqual({kind: 'unavailable', reason: 'runtime_unavailable'});
    warn.mockRestore();
  });
});

describe('isolatedClaudeOneShotOptions', () => {
  it('detaches the call from tools, skills, plugins, MCP servers, settings and transcripts', () => {
    const options = isolatedClaudeOneShotOptions({model: 'm', env: {}, stderr: () => undefined});

    expect(options).toMatchObject({
      model: 'm',
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      pathToClaudeCodeExecutable: '/bin/claude',
    });
    expect(options).not.toHaveProperty('resume');
  });
});

describe('runIsolatedClaudeOneShot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockRuntimeConfig.mockReturnValue({model: 'main-model', lightModel: 'light-model', cwd: '/tmp/cwd'});
    mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockHasCredentials.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers with the result text of the selected tier in the caller scope', async () => {
    mockQuery.mockImplementation(() => stream([{type: 'result', subtype: 'success', result: '  answer  '}]));

    const main = await runIsolatedClaudeOneShot(baseInput());
    const light = await runIsolatedClaudeOneShot({...baseInput(), tier: 'light', effort: 'low'});

    expect(main).toEqual({ok: true, text: 'answer', model: 'main-model'});
    expect(light).toEqual({ok: true, text: 'answer', model: 'light-model'});
    expect(mockCreateSdkEnv).toHaveBeenCalledWith(undefined, SCOPE);
    const lightOptions = mockQuery.mock.calls[1][0].options;
    expect(lightOptions).toMatchObject({model: 'light-model', effort: 'low', cwd: '/tmp/cwd', env: {ANTHROPIC_API_KEY: 'profile-key'}});
    expect(lightOptions.abortController).toBeInstanceOf(AbortController);
  });

  it('checks credentials in the resolved profile env and never starts the SDK without them', async () => {
    mockHasCredentials.mockReturnValue(false);

    const result = await runIsolatedClaudeOneShot(baseInput());

    expect(result).toEqual({ok: false, reason: 'credentials_missing', model: 'main-model'});
    expect(mockHasCredentials).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reports runtime_unavailable when the profile cannot be resolved', async () => {
    mockRuntimeConfig.mockImplementation(() => {
      throw new Error('provider deleted');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runIsolatedClaudeOneShot(baseInput());
    warn.mockRestore();

    expect(result).toEqual({ok: false, reason: 'runtime_unavailable'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats a tool call in a tool-less call as a failure and closes the stream', async () => {
    const toolStream = stream([
      {type: 'assistant', message: {content: [{type: 'tool_use', name: 'Bash', input: {}}]}},
      {type: 'result', subtype: 'success', result: 'should not be used'},
    ]);
    mockQuery.mockReturnValue(toolStream);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runIsolatedClaudeOneShot(baseInput());
    warn.mockRestore();

    expect(result).toEqual({ok: false, reason: 'failed', model: 'main-model'});
    expect(toolStream.close).toHaveBeenCalled();
  });

  it('treats a refusal or an error result as a failure', async () => {
    mockQuery.mockImplementationOnce(() => stream([{type: 'result', subtype: 'success', result: 'x', stop_reason: 'refusal'}]));
    mockQuery.mockImplementationOnce(() => stream([{type: 'result', subtype: 'error_during_execution', is_error: true}]));

    expect(await runIsolatedClaudeOneShot(baseInput())).toMatchObject({ok: false, reason: 'failed'});
    expect(await runIsolatedClaudeOneShot(baseInput())).toMatchObject({ok: false, reason: 'failed'});
  });

  it('reports an empty answer as empty_response', async () => {
    mockQuery.mockImplementation(() => stream([{type: 'result', subtype: 'success', result: '   '}]));

    expect(await runIsolatedClaudeOneShot(baseInput())).toEqual({ok: false, reason: 'empty_response', model: 'main-model'});
  });

  it('keeps the raw SDK error in the log and returns only the reason', async () => {
    mockQuery.mockImplementation(() => ({
      close: jest.fn(),
      async *[Symbol.asyncIterator]() {
        throw new Error('401 invalid x-api-key sk-secret');
      },
    }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runIsolatedClaudeOneShot(baseInput());

    expect(result).toEqual({ok: false, reason: 'failed', model: 'main-model'});
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never starts the SDK for an already cancelled caller', async () => {
    const caller = new AbortController();
    caller.abort();

    expect(await runIsolatedClaudeOneShot({...baseInput(), signal: caller.signal}))
      .toEqual({ok: false, reason: 'client_disconnected'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('aborts the SDK subprocess when the caller cancels mid-call', async () => {
    let sdkAbort: AbortController | undefined;
    mockQuery.mockImplementation((params: any) => {
      sdkAbort = params.options.abortController;
      return hangingStream(params);
    });
    const caller = new AbortController();

    const pending = runIsolatedClaudeOneShot({...baseInput(), signal: caller.signal});
    await new Promise((resolve) => setImmediate(resolve));
    expect(sdkAbort?.signal.aborted).toBe(false);
    caller.abort();

    expect(await pending).toEqual({ok: false, reason: 'client_disconnected', model: 'main-model'});
    expect(sdkAbort?.signal.aborted).toBe(true);
  });

  it('aborts the SDK subprocess at the deadline', async () => {
    let sdkAbort: AbortController | undefined;
    mockQuery.mockImplementation((params: any) => {
      sdkAbort = params.options.abortController;
      return hangingStream(params);
    });

    const result = await runIsolatedClaudeOneShot({...baseInput(), timeoutMs: 20});

    expect(result).toEqual({ok: false, reason: 'timed_out', model: 'main-model'});
    expect(sdkAbort?.signal.aborted).toBe(true);
  });
});
