// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {EventEmitter} from 'events';
import express from 'express';
import request from 'supertest';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import criticalPathRoutes from '../criticalPathRoutes';
import {clientDisconnectSignal} from '../clientDisconnect';
import {resolveAgentRuntimeSelection} from '../../agentRuntime/runtimeSelection';
import {createSdkEnv, hasClaudeCredentials} from '../../agentv3/claudeConfig';
import {AI_CAPABILITY_ENV_KEY} from '../../services/aiCapabilityPolicy';
import {summarizeCriticalPathWithAi} from '../../services/criticalPathAiSummary';
import {CriticalPathInputError, analyzeCriticalPath, type CriticalPathAnalysis} from '../../services/criticalPathAnalyzer';
import {readTraceMetadataForContext} from '../../services/traceMetadataStore';
import {getTraceProcessorService} from '../../services/traceProcessorService';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('../../agentRuntime/runtimeSelection', () => ({
  resolveAgentRuntimeSelection: jest.fn(),
}));

jest.mock('../../agentv3/claudeConfig', () => ({
  createSdkEnv: jest.fn(),
  hasClaudeCredentials: jest.fn(),
  loadClaudeConfig: jest.fn(() => ({model: 'env-model'})),
  resolveRuntimeConfig: jest.fn(() => ({model: 'profile-model'})),
  getSdkBinaryOption: jest.fn(() => ({})),
}));

jest.mock('../../services/criticalPathAnalyzer', () => ({
  ...(jest.requireActual('../../services/criticalPathAnalyzer') as object),
  analyzeCriticalPath: jest.fn(),
}));

jest.mock('../../services/traceMetadataStore', () => ({
  ...(jest.requireActual('../../services/traceMetadataStore') as object),
  readTraceMetadataForContext: jest.fn(),
}));

jest.mock('../../services/traceProcessorService', () => ({
  getTraceProcessorService: jest.fn(),
}));

const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const mockSelection = resolveAgentRuntimeSelection as unknown as jest.Mock<(...args: any[]) => any>;
const mockCreateSdkEnv = createSdkEnv as unknown as jest.Mock<(...args: any[]) => any>;
const mockHasClaudeCredentials = hasClaudeCredentials as unknown as jest.Mock<(...args: any[]) => any>;
const mockAnalyze = analyzeCriticalPath as unknown as jest.Mock<(...args: any[]) => any>;
const mockReadMetadata = readTraceMetadataForContext as unknown as jest.Mock<(...args: any[]) => any>;
const mockGetTraceProcessorService = getTraceProcessorService as unknown as jest.Mock<(...args: any[]) => any>;
const mockGetOrLoadTrace = jest.fn<(...args: any[]) => any>();

const REQUEST_CONTEXT = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'dev',
  roles: ['org_admin'],
  scopes: ['*'],
  requestId: 'req-test',
};
const PROVIDER_SCOPE = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.requestContext = REQUEST_CONTEXT;
    next();
  });
  app.use('/api/critical-path', criticalPathRoutes);
  return app;
}

function analysisFixture(): CriticalPathAnalysis {
  return {
    available: true,
    task: {
      threadStateId: 1,
      utid: 10,
      startTs: 1_000,
      dur: 50_000_000,
      durationMs: 50,
      processName: 'com.example',
      threadName: 'main',
      state: 'S',
    },
    totalMs: 50,
    blockingMs: 40,
    selfMs: 10,
    externalBlockingPercentage: 80,
    wakeupChain: [],
    moduleBreakdown: [],
    anomalies: [],
    summary: '选中 task 的外部等待占比较高。',
    recommendations: [],
    warnings: [],
    rawRows: 1,
    truncated: false,
    quantification: {
      counterfactual: {
        longestSegmentKey: '10|1000|30001000',
        longestSegmentDurMs: 30,
        bestCaseDurationMs: 20,
        maxSavingMs: 30,
        upperBoundMs: 20,
        note: '',
      },
      frameImpacts: [],
      hypotheses: [],
      warnings: [],
    },
  } as unknown as CriticalPathAnalysis;
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), {code});
}

function sdkStream(result: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {type: 'result', subtype: 'success', result};
    },
    close: jest.fn(),
  };
}

const VALID_BODY = {threadStateId: 42, outputLanguage: 'en'};

describe('POST /api/critical-path/:traceId/analyze', () => {
  const savedAiEnabled = process.env[AI_CAPABILITY_ENV_KEY];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[AI_CAPABILITY_ENV_KEY];
    mockGetOrLoadTrace.mockResolvedValue({id: 'trace-1'});
    mockGetTraceProcessorService.mockReturnValue({getOrLoadTrace: mockGetOrLoadTrace});
    mockReadMetadata.mockResolvedValue({id: 'trace-1'});
    mockAnalyze.mockResolvedValue(analysisFixture());
    mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'provider'});
    mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockHasClaudeCredentials.mockReturnValue(true);
    mockQuery.mockImplementation(() => sdkStream('## model summary'));
  });

  afterEach(() => {
    if (savedAiEnabled === undefined) delete process.env[AI_CAPABILITY_ENV_KEY];
    else process.env[AI_CAPABILITY_ENV_KEY] = savedAiEnabled;
  });

  it('degrades to the deterministic summary with a warning when AI is disabled', async () => {
    process.env[AI_CAPABILITY_ENV_KEY] = 'false';

    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'ai_disabled'});
    expect(res.body.aiSummary.warnings[0]).toContain('SMARTPERFETTO_AI_ENABLED');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSelection).not.toHaveBeenCalled();
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
  });

  it('describes the counterfactual as a best case with a bounded saving', async () => {
    process.env[AI_CAPABILITY_ENV_KEY] = 'false';

    const en = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);
    const zh = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({threadStateId: 42, outputLanguage: 'zh-CN'});

    expect(en.body.aiSummary.summary).toContain('best-case task duration of 20.00 ms');
    expect(en.body.aiSummary.summary).toContain('a saving of at most 30.00 ms');
    expect(en.body.aiSummary.summary).not.toMatch(/upper bound/i);
    expect(zh.body.aiSummary.summary).toContain('任务时长最好可降至 20.00 ms');
    expect(zh.body.aiSummary.summary).toContain('至多节省 30.00 ms');
    expect(zh.body.aiSummary.summary).not.toContain('上界');
  });

  it('rejects an invalid body with a coded 400 before loading any trace', async () => {
    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({threadStateId: 'not-a-number', maxSegments: 5});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'invalid_request_body'});
    expect(res.body.issues.map((issue: {path: string}) => issue.path))
      .toEqual(expect.arrayContaining(['threadStateId', 'maxSegments']));
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockGetTraceProcessorService).not.toHaveBeenCalled();
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects an unsafe trace id with a coded 400', async () => {
    const res = await request(makeApp())
      .post('/api/critical-path/..%2Fsecret/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'invalid_trace_id'});
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('returns trace_not_found when the trace is not readable by the caller', async () => {
    mockReadMetadata.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({success: false, code: 'trace_not_found'});
    expect(mockReadMetadata).toHaveBeenCalledWith('trace-1', REQUEST_CONTEXT);
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('maps an unknown thread_state to a coded 404', async () => {
    mockAnalyze.mockRejectedValue(new CriticalPathInputError('thread_state_not_found', 'thread_state 42 not found'));

    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      code: 'thread_state_not_found',
      error: 'The selected thread_state was not found in this trace',
    });
  });

  it('maps other engine input errors to a coded 400', async () => {
    mockAnalyze.mockRejectedValue(new CriticalPathInputError('missing_selector', 'threadStateId or utid/startTs/dur is required'));

    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({outputLanguage: 'en'});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'missing_selector'});
  });

  it('keeps unexpected failures opaque, including coded non-engine errors', async () => {
    for (const error of [
      new Error('SQL failed near /Users/someone/secret.trace'),
      codedError('ENOENT: /Users/someone/secret.trace', 'ENOENT'),
    ]) {
      mockAnalyze.mockRejectedValueOnce(error);
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await request(makeApp())
        .post('/api/critical-path/trace-1/analyze')
        .send(VALID_BODY);
      consoleError.mockRestore();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        code: 'critical_path_failed',
        error: 'Critical path analysis failed',
      });
    }
  });

  it('runs the Claude summary in the isolated one-shot SDK configuration', async () => {
    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toMatchObject({
      generated: true,
      model: 'profile-model',
      summary: '## model summary',
    });
    expect(mockSelection).toHaveBeenCalledWith(undefined, undefined, PROVIDER_SCOPE);
    expect(mockCreateSdkEnv).toHaveBeenCalledWith(undefined, PROVIDER_SCOPE);
    expect(mockHasClaudeCredentials).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const {prompt, options} = mockQuery.mock.calls[0][0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    // The model reads the counterfactual through its best-case fields only.
    expect(prompt).toContain('"bestCaseDurationMs":20');
    expect(prompt).toContain('"maxSavingMs":30');
    expect(prompt).not.toContain('upperBoundMs');
    expect(options).toMatchObject({
      model: 'profile-model',
      maxTurns: 1,
      settingSources: [],
      tools: [],
      persistSession: false,
      env: {ANTHROPIC_API_KEY: 'profile-key'},
    });
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('resume');
  });

  it('returns the deterministic summary when the active runtime is not Claude', async () => {
    mockSelection.mockReturnValue({kind: 'openai-agents-sdk', source: 'provider'});

    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'runtime_not_supported'});
    expect(res.body.aiSummary.warnings[0]).toContain('openai-agents-sdk');
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('checks credentials in the resolved profile env, not the process env', async () => {
    mockHasClaudeCredentials.mockReturnValue(false);

    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'credentials_missing'});
    expect(mockHasClaudeCredentials).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('omits the AI summary when includeAi is false', async () => {
    const res = await request(makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({...VALID_BODY, includeAi: false});

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('summarizeCriticalPathWithAi cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'default'});
    mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'env-key'});
    mockHasClaudeCredentials.mockReturnValue(true);
  });

  it('never starts a model call for an already disconnected client', async () => {
    const caller = new AbortController();
    caller.abort();

    const summary = await summarizeCriticalPathWithAi(analysisFixture(), undefined, 'en', {
      signal: caller.signal,
    });

    expect(summary).toMatchObject({generated: false, fallbackReason: 'client_disconnected'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('aborts the SDK subprocess when the client disconnects mid-call', async () => {
    const caller = new AbortController();
    let sdkAbort: AbortController | undefined;
    mockQuery.mockImplementation((params: any) => {
      sdkAbort = params.options.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            sdkAbort!.signal.addEventListener('abort', () => resolve(), {once: true});
          });
          throw new Error('aborted by caller');
        },
        close: jest.fn(),
      };
    });

    const pending = summarizeCriticalPathWithAi(analysisFixture(), undefined, 'en', {
      signal: caller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sdkAbort?.signal.aborted).toBe(false);
    caller.abort();
    const summary = await pending;

    expect(sdkAbort?.signal.aborted).toBe(true);
    expect(summary).toMatchObject({generated: false, fallbackReason: 'client_disconnected'});
  });
});

describe('clientDisconnectSignal', () => {
  function fakeResponse(writableEnded: boolean) {
    return Object.assign(new EventEmitter(), {writableEnded});
  }

  it('aborts when the response closes before it was fully written', () => {
    const res = fakeResponse(false);
    const signal = clientDisconnectSignal(res);
    res.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('does not abort on the close that follows a completed response', () => {
    const res = fakeResponse(true);
    const signal = clientDisconnectSignal(res);
    res.emit('close');
    expect(signal.aborted).toBe(false);
  });
});
