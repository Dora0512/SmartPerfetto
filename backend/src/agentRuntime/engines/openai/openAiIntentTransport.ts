// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OpenAIAgentConfig} from './openAiConfig';
import {
  buildOpenAIChatCompletionsTokenLimit,
  buildOpenAITextRequestPurposeOptions,
  readOpenAIChatCompletionsOutput,
  type OpenAITextRequestPurpose,
} from '../../../services/providerManager/openAiChatCompletionsCompat';
import {
  intentTransportTextResult,
  runIntentTransport,
  type IntentTransportInput,
  type IntentTransportResult,
} from '../../intentTransport';

export interface OpenAiIntentTransportInput extends IntentTransportInput {
  config: Pick<OpenAIAgentConfig, 'baseURL' | 'apiKey' | 'lightModel' | 'protocol'>;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  purpose?: OpenAITextRequestPurpose;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function chatResult(body: Record<string, unknown>, input: OpenAiIntentTransportInput): IntentTransportResult {
  if (!Array.isArray(body.choices) || body.choices.length !== 1) {
    return {status: 'unavailable', reason: 'invalid_response'};
  }
  const message = object(object(body.choices[0])?.message);
  if (!message || (message.role !== undefined && message.role !== 'assistant')) {
    return {status: 'unavailable', reason: 'invalid_response'};
  }
  if ((message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))
    || message.function_call != null) {
    return {status: 'unavailable', reason: 'tool_use'};
  }
  if (message.refusal != null && message.refusal !== '') {
    return {status: 'unavailable', reason: 'invalid_response'};
  }
  const output = readOpenAIChatCompletionsOutput(body);
  if (output.finishReason !== 'stop') {
    return {status: 'unavailable', reason: output.finishReason === 'length' ? 'incomplete_output' : 'invalid_response'};
  }
  return intentTransportTextResult(output.text, input, {
    ...(typeof body.model === 'string' ? {actualModel: body.model} : {}),
    finishReason: output.finishReason,
  });
}

function responsesResult(body: Record<string, unknown>, input: OpenAiIntentTransportInput): IntentTransportResult {
  if (body.status !== 'completed' || body.incomplete_details != null || !Array.isArray(body.output)) {
    return {status: 'unavailable', reason: body.status === 'incomplete' ? 'incomplete_output' : 'invalid_response'};
  }
  const text: string[] = [];
  for (const rawItem of body.output) {
    const item = object(rawItem);
    if (!item) return {status: 'unavailable', reason: 'invalid_response'};
    if (item.type === 'reasoning') {
      if (item.status !== undefined && item.status !== 'completed') {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      continue;
    }
    if (item.type !== 'message') return {status: 'unavailable', reason: 'tool_use'};
    if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    if (item.phase !== undefined && item.phase !== null && item.phase !== 'commentary' && item.phase !== 'final_answer') {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    for (const rawPart of item.content) {
      const part = object(rawPart);
      if (part?.type !== 'output_text' || typeof part.text !== 'string') {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      if (item.phase !== 'commentary') text.push(part.text);
    }
  }
  return intentTransportTextResult(text.join(''), input, {
    ...(typeof body.model === 'string' ? {actualModel: body.model} : {}),
    finishReason: body.status,
  });
}

/** One request in the pinned native protocol; truncation never starts another call. */
export function runOpenAiIntentTransport(input: OpenAiIntentTransportInput) {
  return runIntentTransport(input, async scope => {
    const {config} = input;
    if (!config.baseURL || !config.lightModel?.trim()
      || (input.purpose !== undefined && input.purpose !== 'classification' && input.purpose !== 'final_semantic')
      || (input.maxOutputTokens !== undefined
        && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0))
      || (config.protocol !== 'chat_completions' && config.protocol !== 'responses')) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const endpoint = config.protocol === 'responses' ? 'responses' : 'chat/completions';
    const url = new URL(endpoint, config.baseURL.replace(/\/?$/, '/'));
    const purposeOptions = buildOpenAITextRequestPurposeOptions({requestUrl: url, protocol: config.protocol, purpose: input.purpose});
    const body = config.protocol === 'responses' ? {
      model: config.lightModel,
      instructions: input.systemPrompt,
      input: [{role: 'user', content: input.prompt}],
      tools: [], store: false,
      ...purposeOptions,
      ...(input.maxOutputTokens !== undefined ? {max_output_tokens: input.maxOutputTokens} : {}),
    } : {
      model: config.lightModel,
      messages: [{role: 'system', content: input.systemPrompt}, {role: 'user', content: input.prompt}],
      temperature: 0,
      ...purposeOptions,
      ...(input.maxOutputTokens !== undefined
        ? buildOpenAIChatCompletionsTokenLimit(config.lightModel, input.maxOutputTokens) : {}),
    };
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST', signal: scope.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? {Authorization: `Bearer ${config.apiKey}`} : {}),
      },
      body: JSON.stringify(body),
    });
    scope.throwIfInactive();
    if (!response.ok) return {status: 'unavailable', reason: 'provider_error'};
    const output = object(await response.json());
    scope.throwIfInactive();
    if (!output || output.error != null) return {status: 'unavailable', reason: 'provider_error'};
    return config.protocol === 'responses' ? responsesResult(output, input) : chatResult(output, input);
  });
}
