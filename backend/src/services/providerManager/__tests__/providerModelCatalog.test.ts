// SPDX-License-Identifier: AGPL-3.0-or-later

import {jest} from '@jest/globals';
import {
  mergeModelOptions,
  ProviderModelCatalogService,
} from '../providerModelCatalog';
import type {
  ProviderConfig,
  ProviderScope,
  ProviderTemplate,
} from '../types';

const scope: ProviderScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};

function provider(
  input: Partial<ProviderConfig> & Pick<ProviderConfig, 'type'>,
): ProviderConfig {
  return {
    id: 'provider-a',
    name: 'Provider A',
    isActive: false,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    models: {primary: 'primary', light: 'light'},
    connection: {},
    category: input.type === 'custom' ? 'custom' : 'official',
    ...input,
  };
}

function template(
  type: ProviderConfig['type'],
  defaultConnection: ProviderTemplate['defaultConnection'] = {},
): ProviderTemplate {
  return {
    type,
    displayName: type,
    requiredFields: [],
    defaultModels: {primary: 'primary', light: 'light'},
    availableModels: [
      {id: 'primary', name: 'Primary', tier: 'primary'},
      {id: 'light', name: 'Light', tier: 'light'},
    ],
    defaultConnection,
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn(async () => JSON.stringify(body)),
    cancelBody: jest.fn(),
  };
}

describe('ProviderModelCatalogService', () => {
  it('discovers OpenAI-compatible model IDs with the configured bearer credential', async () => {
    const request = jest.fn(async () => response({
      data: [
        {id: 'deepseek-flash'},
        {id: 'deepseek-v4-pro'},
        {id: 'deepseek-flash'},
        {id: 'text-embedding-3-large'},
        {id: 'bad model id'},
      ],
    }));
    const service = new ProviderModelCatalogService({request});
    const config = provider({
      type: 'deepseek',
      connection: {
        apiKey: 'deepseek-secret',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
      },
    });

    const result = await service.discover(config, template('deepseek'), scope);

    expect(result?.models).toEqual([
      {id: 'deepseek-flash', name: 'deepseek-flash', tier: 'light'},
      {id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', tier: 'primary'},
    ]);
    expect(request).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: {Authorization: 'Bearer deepseek-secret'},
      }),
      2500,
    );
  });

  it('uses the Anthropic model endpoint and x-api-key contract', async () => {
    const request = jest.fn(async () => response({data: [{id: 'claude-sonnet-5'}]}));
    const service = new ProviderModelCatalogService({request});
    const config = provider({
      type: 'anthropic',
      connection: {claudeApiKey: 'anthropic-secret'},
    });

    await service.discover(config, template('anthropic'), scope);

    expect(request).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': 'anthropic-secret',
        },
      }),
      2500,
    );
  });

  it('discovers installed Ollama tags without requiring a credential', async () => {
    const request = jest.fn(async () => response({
      models: [{name: 'qwen3:30b'}, {model: 'deepseek-r1:14b'}],
    }));
    const service = new ProviderModelCatalogService({request});
    const config = provider({
      type: 'ollama',
      connection: {openaiBaseUrl: 'http://127.0.0.1:11434/v1'},
    });

    const result = await service.discover(config, template('ollama'), scope);

    expect(result?.models.map(model => model.id)).toEqual([
      'qwen3:30b',
      'deepseek-r1:14b',
    ]);
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({headers: {}}),
      2500,
    );
  });

  it('filters non-analysis products from the official OpenAI catalog', async () => {
    const request = jest.fn(async () => response({
      data: [
        {id: 'gpt-5.6-sol'},
        {id: 'text-embedding-3-large'},
        {id: 'bge-reranker-v2'},
        {id: 'BAAI/bge-m3'},
        {id: 'intfloat/e5-large-v2'},
        {id: 'Alibaba-NLP/gte-Qwen2-7B-instruct'},
        {id: 'vidore/colpali-v1.3'},
        {id: 'safety-classifier'},
        {id: 'gpt-realtime-2'},
        {id: 'gpt-image-2'},
        {id: 'unrelated-gateway-product'},
      ],
    }));
    const service = new ProviderModelCatalogService({request});
    const config = provider({
      type: 'openai',
      connection: {openaiApiKey: 'openai-secret'},
    });

    const result = await service.discover(config, template('openai'), scope);

    expect(result?.models).toEqual([
      {id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', tier: 'primary'},
    ]);
  });

  it('filters vendor-qualified embedding and reranking families from gateway catalogs', async () => {
    const request = jest.fn(async () => response({
      data: [
        {id: 'Qwen/Qwen3.7-Plus'},
        {id: 'BAAI/bge-m3'},
        {id: 'intfloat/e5-large-v2'},
        {id: 'Alibaba-NLP/gte-Qwen2-7B-instruct'},
        {id: 'vidore/colpali-v1.3'},
      ],
    }));
    const service = new ProviderModelCatalogService({request});
    const config = provider({
      type: 'siliconflow',
      connection: {
        apiKey: 'gateway-secret',
        openaiBaseUrl: 'https://api.siliconflow.cn/v1',
      },
    });

    const result = await service.discover(
      config,
      template('siliconflow'),
      scope,
    );

    expect(result?.models).toEqual([
      {id: 'Qwen/Qwen3.7-Plus', name: 'Qwen/Qwen3.7-Plus', tier: 'primary'},
    ]);
  });

  it('reuses a scoped cache and invalidates it when provider configuration changes', async () => {
    let now = 1000;
    const request = jest.fn(async () => response({data: [{id: 'gpt-model-live'}]}));
    const service = new ProviderModelCatalogService({
      request,
      now: () => now,
      ttlMs: 100,
    });
    const config = provider({
      type: 'openai',
      connection: {openaiApiKey: 'first-secret'},
    });

    expect((await service.discover(config, template('openai'), scope))?.cached).toBe(false);
    expect((await service.discover(config, template('openai'), scope))?.cached).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    const rotated = {
      ...config,
      updatedAt: '2026-09-20T01:00:00.000Z',
      connection: {openaiApiKey: 'second-secret'},
    };
    await service.discover(rotated, template('openai'), scope);
    expect(request).toHaveBeenCalledTimes(2);

    now += 101;
    await service.discover(rotated, template('openai'), scope);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('negative-caches an unavailable catalog instead of repeating the timeout path', async () => {
    const request = jest.fn(async () => response({}, 503));
    const service = new ProviderModelCatalogService({request});
    const config = provider({
      type: 'openai',
      connection: {openaiApiKey: 'openai-secret'},
    });

    await expect(
      service.discover(config, template('openai'), scope),
    ).rejects.toThrow('HTTP 503');
    await expect(
      service.discover(config, template('openai'), scope),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('serves stale success immediately while a failed refresh enters retry backoff', async () => {
    let now = 1000;
    const request = jest
      .fn<() => Promise<ReturnType<typeof response>>>()
      .mockResolvedValueOnce(response({data: [{id: 'gpt-model-live'}]}))
      .mockResolvedValueOnce(response({}, 503));
    const service = new ProviderModelCatalogService({
      request,
      now: () => now,
      ttlMs: 100,
    });
    const config = provider({
      type: 'openai',
      connection: {openaiApiKey: 'openai-secret'},
    });

    await service.discover(config, template('openai'), scope);
    now += 101;
    const stale = await service.discover(config, template('openai'), scope);
    expect(stale).toMatchObject({cached: true});
    await new Promise(resolve => setImmediate(resolve));
    expect(request).toHaveBeenCalledTimes(2);

    const backedOff = await service.discover(config, template('openai'), scope);
    expect(backedOff).toMatchObject({cached: true});
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('merges scoped live options without deleting curated static choices', () => {
    expect(mergeModelOptions(template('deepseek').availableModels, [
      {id: 'light', name: 'duplicate', tier: 'light' as const},
      {id: 'deepseek-flash', name: 'deepseek-flash', tier: 'light' as const},
    ])).toEqual([
      {id: 'primary', name: 'Primary', tier: 'primary'},
      {id: 'light', name: 'Light', tier: 'light'},
      {id: 'deepseek-flash', name: 'deepseek-flash', tier: 'light'},
    ]);
  });

  it('does not attempt discovery for providers without a catalog contract', async () => {
    const request = jest.fn(async () => response({}, 503));
    const service = new ProviderModelCatalogService({request});

    await expect(
      service.discover(provider({type: 'bedrock'}), template('bedrock'), scope),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
