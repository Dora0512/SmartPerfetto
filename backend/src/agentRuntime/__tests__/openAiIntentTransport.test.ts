// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {runOpenAiIntentTransport, type OpenAiIntentTransportInput} from '../engines/openai/openAiIntentTransport';

interface ResponseMessageFixture {
  type: 'message';
  role: 'assistant';
  status: string;
  phase?: 'commentary' | 'final_answer';
  content: Array<{type: 'output_text'; text: string} | {type: 'refusal'; refusal: string}>;
}

function fixture(protocol: 'chat_completions' | 'responses') {
  const chatMessage = {role: 'assistant', content: '{}'};
  const chatChoice: {finish_reason: string | null | undefined; message: typeof chatMessage} = {
    finish_reason: 'stop', message: chatMessage,
  };
  const responseMessage: ResponseMessageFixture = {
    type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: '{}'}],
  };
  const responseBody: {
    model: string; status: string | undefined; error: unknown; incomplete_details: unknown;
    output: Array<ResponseMessageFixture | {type: 'function_call'; name: string}>;
  } = {
    model: 'actual-model', status: 'completed', error: null, incomplete_details: null, output: [responseMessage],
  };
  const output: Record<string, unknown> = protocol === 'chat_completions'
    ? {model: 'actual-model', choices: [chatChoice]} : responseBody;
  const response = {ok: true, status: 200, json: jest.fn<() => Promise<unknown>>().mockResolvedValue(output)};
  const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response as unknown as Response);
  const input: OpenAiIntentTransportInput = {
    prompt: 'current question', systemPrompt: 'assembled classifier contract',
    deadlineMs: Date.now() + 50, outputByteLimit: 1024, maxOutputTokens: 2048,
    config: {protocol, baseURL: 'https://pinned.example/custom/v1', apiKey: 'SECRET_API_CANARY', lightModel: 'gpt-5.6-mini'},
    fetchImpl,
  };
  return {input, output, response, fetchImpl, chatChoice, chatMessage, responseBody, responseMessage};
}

describe('OpenAI native intent transport', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  it.each(['responses', 'chat_completions'] as const)('disables official DeepSeek thinking only for explicit %s classification', async protocol => {
    for (const purpose of [undefined, 'classification'] as const) {
      const {input, fetchImpl} = fixture(protocol);
      input.config.baseURL = 'https://api.deepseek.com/v1';
      input.config.lightModel = 'deepseek-v4-flash';
      input.purpose = purpose;
      const deadline = input.deadlineMs;
      expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, request] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe(`https://api.deepseek.com/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      const body = JSON.parse(request!.body as string);
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(2048);
      expect(input.deadlineMs).toBe(deadline);
      if (purpose === 'classification') expect(body[protocol === 'responses' ? 'reasoning' : 'thinking'])
        .toEqual(protocol === 'responses' ? {effort: 'none'} : {type: 'disabled'});
      else {expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning');}
      expect(body).not.toHaveProperty(protocol === 'responses' ? 'thinking' : 'reasoning');
    }
  });

  it.each(['responses', 'chat_completions'] as const)('requests official DeepSeek JSON mode only for %s final semantics', async protocol => {
    const {input, fetchImpl} = fixture(protocol);
    input.config.baseURL = 'https://api.deepseek.com/v1';
    input.config.lightModel = 'arbitrary-provider-model';
    input.purpose = 'final_semantic';
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    if (protocol === 'responses') {
      expect(body.text).toEqual({format: {type: 'json_object'}});
      expect(body).not.toHaveProperty('response_format');
    } else {
      expect(body.response_format).toEqual({type: 'json_object'});
      expect(body).not.toHaveProperty('text');
    }
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning');
  });

  it.each(['https://api.deepseek.com:8443/v1', 'http://api.deepseek.com/v1',
    'https://api.deepseek.com.evil.test/v1', 'https://gateway.example/api.deepseek.com/v1'])(
    'does not add purpose options through unrecognized endpoint %s', baseURL => {
      return Promise.all((['responses', 'chat_completions'] as const).flatMap(protocol =>
        (['classification', 'final_semantic'] as const).map(async purpose => {
        const {input, fetchImpl} = fixture(protocol);
        input.config.baseURL = baseURL; input.config.lightModel = 'deepseek-v4-flash'; input.purpose = purpose;
        expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
        const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
        expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning');
        expect(body).not.toHaveProperty('response_format'); expect(body).not.toHaveProperty('text');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      })));
    },
  );

  it.each(['semantic', 'analysis', '', null, 1])('rejects unknown explicit purpose %s without dispatch', purpose => {
    const {input, fetchImpl} = fixture('chat_completions');
    (input as {purpose?: unknown}).purpose = purpose;
    return expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_configuration'})
      .then(() => expect(fetchImpl).not.toHaveBeenCalled());
  });

  it('keeps a truncated official classification unavailable without increasing the cap or retrying', async () => {
    const {input, chatChoice, fetchImpl} = fixture('chat_completions');
    input.config.baseURL = 'https://api.deepseek.com/v1'; input.config.lightModel = 'deepseek-v4-flash'; input.purpose = 'classification';
    chatChoice.finish_reason = 'length';
    expect(await runOpenAiIntentTransport(input)).toEqual({status: 'unavailable', reason: 'incomplete_output'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toMatchObject({thinking: {type: 'disabled'}, max_tokens: 2048});
  });

  it.each(['responses', 'chat_completions'] as const)('pins endpoint/auth/model for one %s request without history or retries', async protocol => {
    const {input, fetchImpl} = fixture(protocol);
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({
      status: 'ok', text: '{}', actualModel: 'actual-model', finishReason: protocol === 'responses' ? 'completed' : 'stop',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, rawRequest] = fetchImpl.mock.calls[0];
    const request = rawRequest!;
    expect(String(url)).toBe(`https://pinned.example/custom/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
    expect(request.headers).toEqual({'Content-Type': 'application/json', Authorization: 'Bearer SECRET_API_CANARY'});
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(request.body as string);
    expect(body.model).toBe(input.config.lightModel);
    if (protocol === 'responses') {
      expect(body).toEqual({
        model: input.config.lightModel, instructions: input.systemPrompt,
        input: [{role: 'user', content: input.prompt}], tools: [], store: false, max_output_tokens: 2048,
      });
    } else {
      expect(body).toEqual({
        model: input.config.lightModel,
        messages: [{role: 'system', content: input.systemPrompt}, {role: 'user', content: input.prompt}],
        temperature: 0, max_completion_tokens: 2048,
      });
    }
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).not.toHaveProperty('conversation');
  });

  it.each(['responses', 'chat_completions'] as const)('omits the provider output-token field for %s when no explicit cap is supplied', async protocol => {
    const {input, fetchImpl} = fixture(protocol);
    delete (input as Partial<OpenAiIntentTransportInput>).maxOutputTokens;
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.model).toBe(input.config.lightModel);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8192', null])('rejects an explicitly invalid output-token limit %s before dispatch', async value => {
    const {input, fetchImpl} = fixture('chat_completions');
    input.maxOutputTokens = value as number;
    expect(await runOpenAiIntentTransport(input)).toEqual({status: 'unavailable', reason: 'invalid_configuration'});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the existing Chat Completions token compatibility for a gateway model', async () => {
    const {input, fetchImpl} = fixture('chat_completions');
    input.config.lightModel = 'deepseek-chat';
    await runOpenAiIntentTransport(input);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it.each(['length', 'content_filter', 'tool_calls', 'end_turn', null, undefined])('rejects Chat Completions finish %s even with complete-looking JSON', async finish => {
    const {input, chatChoice, fetchImpl} = fixture('chat_completions');
    chatChoice.finish_reason = finish;
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'unavailable'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {tool_calls: [{id: 'call-1', function: {name: 'unexpected'}}]},
    {function_call: {name: 'legacy-tool'}},
    {refusal: 'REFUSAL_CANARY'},
  ])('rejects tool or refusal fields next to successful Chat Completions text %#', async fields => {
    const {input, chatMessage} = fixture('chat_completions');
    Object.assign(chatMessage, fields);
    const result = await runOpenAiIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(result).not.toHaveProperty('text');
  });

  it.each(['incomplete', 'failed', 'in_progress', undefined])('rejects Responses status %s without escalating output budget', async status => {
    const {input, responseBody, fetchImpl} = fixture('responses');
    responseBody.status = status;
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'unavailable'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'incomplete', 'tool', 'refusal', 'message-incomplete', 'commentary-refusal'])('rejects Responses %s mixed with final text', async kind => {
    const {input, responseBody, responseMessage} = fixture('responses');
    if (kind === 'error') responseBody.error = {message: 'SECRET_ERROR_CANARY'};
    if (kind === 'incomplete') responseBody.incomplete_details = {reason: 'max_output_tokens'};
    if (kind === 'tool') responseBody.output.push({type: 'function_call', name: 'unexpected'});
    if (kind === 'refusal') responseMessage.content.push({type: 'refusal', refusal: 'REFUSAL_CANARY'});
    if (kind === 'message-incomplete') responseMessage.status = 'incomplete';
    if (kind === 'commentary-refusal') responseBody.output.push({
      type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
      content: [{type: 'refusal', refusal: 'REFUSAL_CANARY'}],
    });
    const result = await runOpenAiIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(result).not.toHaveProperty('text');
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_CANARY');
  });

  it('ignores explicit Responses commentary and never uses output_text as a validation bypass', async () => {
    const {input, output, responseBody} = fixture('responses');
    output.output_text = 'TOP_LEVEL_CANARY';
    responseBody.output.unshift({
      type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
      content: [{type: 'output_text', text: 'DRAFT_CANARY'}],
    });
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok', text: '{}'});
    responseBody.output = [];
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
  });

  it.each(['responses', 'chat_completions'] as const)('keeps %s actualModel absent when the provider does not report it', async protocol => {
    const {input, output} = fixture(protocol);
    delete output.model;
    const result = await runOpenAiIntentTransport(input);
    expect(result).toMatchObject({status: 'ok'});
    expect(result).not.toHaveProperty('actualModel');
  });

  it.each(['responses', 'chat_completions'] as const)('propagates parent cancellation before a late %s response body is read', async protocol => {
    const {input, response, fetchImpl} = fixture(protocol);
    let resolveFetch!: (value: Response) => void;
    fetchImpl.mockReturnValue(new Promise(resolve => {resolveFetch = resolve;}));
    const controller = new AbortController();
    const pending = runOpenAiIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError', message: 'Intent classification cancelled'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('SECRET_PARENT_CANARY'));
    await rejected;
    resolveFetch(response as unknown as Response);
    await jest.advanceTimersByTimeAsync(0);
    expect(response.json).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1]!.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['responses', 'chat_completions'] as const)('covers %s response parsing with the same deadline and byte budget', async protocol => {
    const {input, output, response, fetchImpl, chatMessage, responseMessage} = fixture(protocol);
    let resolveJson!: (value: unknown) => void;
    response.json.mockReturnValueOnce(new Promise(resolve => {resolveJson = resolve;}));
    const pending = runOpenAiIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveJson(output);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (protocol === 'responses') responseMessage.content = [{type: 'output_text', text: '中文'}];
    else chatMessage.content = '中文';
    await expect(runOpenAiIntentTransport({...input, deadlineMs: Date.now() + 50, outputByteLimit: 5}))
      .resolves.toEqual({status: 'unavailable', reason: 'output_limit'});
  });

  it('does not read HTTP error bodies or return thrown provider secrets', async () => {
    const {input, response, fetchImpl} = fixture('responses');
    response.ok = false;
    response.json.mockRejectedValue(new Error('SECRET_HTTP_BODY_CANARY'));
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
    expect(response.json).not.toHaveBeenCalled();
    fetchImpl.mockRejectedValueOnce(new Error('SECRET_FETCH_CANARY'));
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
  });
});
