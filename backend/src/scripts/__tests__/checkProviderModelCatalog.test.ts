// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  compareModelIds,
  resolveCatalogCheckStatus,
} from '../checkProviderModelCatalog';

describe('checkProviderModelCatalog', () => {
  it('separates new candidates from credential-specific visibility', () => {
    expect(
      compareModelIds(
        ['deepseek-v4-pro', 'deepseek-v4-flash'],
        ['deepseek-v4-pro', 'deepseek-flash'],
      ),
    ).toEqual({
      newCandidates: ['deepseek-flash'],
      notVisibleWithCredential: ['deepseek-v4-flash'],
    });
  });

  it('deduplicates both catalog sides before comparison', () => {
    expect(compareModelIds(['a', 'a'], ['a', 'a'])).toEqual({
      newCandidates: [],
      notVisibleWithCredential: [],
    });
  });

  it('reports real drift even when another provider is unavailable', () => {
    expect(
      resolveCatalogCheckStatus({checked: 1, drift: 1, unavailable: 1}),
    ).toBe('drift');
    expect(
      resolveCatalogCheckStatus({checked: 1, drift: 0, unavailable: 1}),
    ).toBe('unavailable');
  });
});
