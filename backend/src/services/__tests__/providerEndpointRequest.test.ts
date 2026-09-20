// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  assertProviderEndpointPolicy,
  PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST_ENV,
  requestProviderEndpoint,
} from '../providerManager/providerEndpointRequest';

describe('enterprise provider endpoint policy', () => {
  const enterprise = {SMARTPERFETTO_ENTERPRISE: 'true'} as NodeJS.ProcessEnv;

  it('accepts public HTTPS and rejects private, mixed, or plain HTTP endpoints', () => {
    expect(() => assertProviderEndpointPolicy(
      new URL('https://api.example.com/v1'),
      ['8.8.8.8'],
      enterprise,
    )).not.toThrow();
    expect(() => assertProviderEndpointPolicy(
      new URL('https://api.example.com/v1'),
      ['8.8.8.8', '127.0.0.1'],
      enterprise,
    )).toThrow(/private|mixed/);
    expect(() => assertProviderEndpointPolicy(
      new URL('http://api.example.com/v1'),
      ['8.8.8.8'],
      enterprise,
    )).toThrow(/public HTTPS/);
  });

  it('requires an exact deployment-level origin allowlist for private endpoints', () => {
    const env = {
      ...enterprise,
      [PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST_ENV]: 'http://ollama.internal:11434',
    } as NodeJS.ProcessEnv;
    expect(() => assertProviderEndpointPolicy(
      new URL('http://ollama.internal:11434/api/tags'),
      ['10.0.0.8'],
      env,
    )).not.toThrow();
    expect(() => assertProviderEndpointPolicy(
      new URL('http://ollama.internal:11435/api/tags'),
      ['10.0.0.8'],
      env,
    )).toThrow(/exact origin|PRIVATE_ENDPOINT_ALLOWLIST/i);
  });

  it('preserves local-provider compatibility outside enterprise mode', () => {
    expect(() => assertProviderEndpointPolicy(
      new URL('http://127.0.0.1:11434/api/tags'),
      ['127.0.0.1'],
      {} as NodeJS.ProcessEnv,
    )).not.toThrow();
  });

  it('rejects an already-aborted request before DNS or socket creation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestProviderEndpoint(
        'https://provider.invalid/v1/models',
        {method: 'GET', headers: {}, signal: controller.signal},
        100,
      ),
    ).rejects.toMatchObject({name: 'AbortError'});
  });
});
