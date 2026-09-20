// SPDX-License-Identifier: AGPL-3.0-or-later

import {promises as fs} from 'fs';
import {officialTemplates} from '../services/providerManager/templates';
import {ProviderModelCatalogService} from '../services/providerManager/providerModelCatalog';
import type {
  ProviderConfig,
  ProviderScope,
  ProviderTemplate,
  ProviderType,
} from '../services/providerManager/types';

interface CatalogCheckSpec {
  type: ProviderType;
  credentialEnv: string;
}

const CHECK_SPECS: CatalogCheckSpec[] = [
  {type: 'anthropic', credentialEnv: 'ANTHROPIC_API_KEY'},
  {type: 'deepseek', credentialEnv: 'DEEPSEEK_API_KEY'},
  {type: 'glm', credentialEnv: 'GLM_API_KEY'},
  {type: 'qwen', credentialEnv: 'DASHSCOPE_API_KEY'},
  {type: 'qwen_coding', credentialEnv: 'DASHSCOPE_CODING_API_KEY'},
  {type: 'kimi_code', credentialEnv: 'KIMI_CODE_API_KEY'},
  {type: 'kimi', credentialEnv: 'MOONSHOT_API_KEY'},
  {type: 'doubao', credentialEnv: 'ARK_API_KEY'},
  {type: 'minimax', credentialEnv: 'MINIMAX_API_KEY'},
  {type: 'xiaomi', credentialEnv: 'XIAOMI_MIMO_API_KEY'},
  {type: 'tencent_token_plan', credentialEnv: 'TENCENT_TOKEN_PLAN_API_KEY'},
  {type: 'tencent_coding_plan', credentialEnv: 'TENCENT_CODING_PLAN_API_KEY'},
  {type: 'hunyuan', credentialEnv: 'HUNYUAN_API_KEY'},
  {type: 'qianfan', credentialEnv: 'QIANFAN_API_KEY'},
  {type: 'stepfun', credentialEnv: 'STEPFUN_API_KEY'},
  {type: 'siliconflow', credentialEnv: 'SILICONFLOW_API_KEY'},
  {type: 'huawei', credentialEnv: 'HUAWEI_MODELARTS_API_KEY'},
  {type: 'openai', credentialEnv: 'OPENAI_API_KEY'},
];

export interface ModelCatalogDelta {
  newCandidates: string[];
  notVisibleWithCredential: string[];
}

export function resolveCatalogCheckStatus(input: {
  checked: number;
  drift: number;
  unavailable: number;
}): 'current' | 'drift' | 'unavailable' {
  if (input.drift > 0) return 'drift';
  if (input.checked === 0 || input.unavailable > 0) return 'unavailable';
  return 'current';
}

export function compareModelIds(
  presetIds: readonly string[],
  liveIds: readonly string[],
): ModelCatalogDelta {
  const preset = new Set(presetIds);
  const live = new Set(liveIds);
  return {
    newCandidates: [...live].filter(id => !preset.has(id)).sort(),
    notVisibleWithCredential: [...preset].filter(id => !live.has(id)).sort(),
  };
}

function providerForCheck(
  template: ProviderTemplate,
  apiKey: string,
): ProviderConfig {
  const connection = {...(template.defaultConnection ?? {})};
  if (template.type === 'anthropic') {
    connection.claudeApiKey = apiKey;
  } else if (template.type === 'openai') {
    connection.openaiApiKey = apiKey;
  } else {
    connection.apiKey = apiKey;
  }
  return {
    id: `catalog-check-${template.type}`,
    name: `${template.displayName} catalog check`,
    category: 'official',
    type: template.type,
    isActive: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    models: {...template.defaultModels},
    connection,
  };
}

function outputPath(args: readonly string[]): string | undefined {
  const index = args.indexOf('--output');
  if (index < 0) return undefined;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error('--output requires a path');
  return value;
}

async function main(): Promise<void> {
  const scope: ProviderScope = {
    tenantId: 'catalog-check',
    workspaceId: 'catalog-check',
    userId: 'catalog-check',
  };
  const service = new ProviderModelCatalogService({ttlMs: 0});
  const checked: Array<{
    type: ProviderType;
    delta: ModelCatalogDelta;
  }> = [];
  const unavailable: Array<{type: ProviderType; error: string}> = [];
  const skipped: ProviderType[] = [];

  for (const spec of CHECK_SPECS) {
    const apiKey = process.env[spec.credentialEnv]?.trim();
    if (!apiKey) {
      skipped.push(spec.type);
      continue;
    }
    const template = officialTemplates.find(item => item.type === spec.type);
    if (!template) continue;
    try {
      const catalog = await service.discover(
        providerForCheck(template, apiKey),
        template,
        scope,
      );
      if (!catalog) {
        unavailable.push({type: spec.type, error: 'catalog discovery is unsupported'});
        continue;
      }
      checked.push({
        type: spec.type,
        delta: compareModelIds(
          template.availableModels.map(model => model.id),
          catalog.models.map(model => model.id),
        ),
      });
    } catch (error) {
      unavailable.push({
        type: spec.type,
        error: error instanceof Error ? error.message : 'catalog request failed',
      });
    }
  }

  const drift = checked.filter(
    result => result.delta.newCandidates.length > 0,
  );
  const status = resolveCatalogCheckStatus({
    checked: checked.length,
    drift: drift.length,
    unavailable: unavailable.length,
  });
  const lines = [
    '# Provider model catalog check',
    '',
    `Status: ${status}`,
    `Checked: ${checked.map(item => item.type).join(', ') || 'none'}`,
    `Skipped (credential unavailable): ${skipped.join(', ') || 'none'}`,
  ];
  for (const item of drift) {
    lines.push('', `## ${item.type}`);
    lines.push(
      `- New review candidates: ${item.delta.newCandidates.join(', ') || 'none'}`,
    );
  }
  const visibilityObservations = checked.filter(
    result => result.delta.notVisibleWithCredential.length > 0,
  );
  for (const item of visibilityObservations) {
    lines.push('', `## ${item.type} credential visibility`);
    lines.push(
      `- Preset IDs not visible to this credential: ${item.delta.notVisibleWithCredential.join(', ')}`,
      '- This is account, plan, region, or gateway evidence only; it is not retirement evidence.',
    );
  }
  for (const item of unavailable) {
    lines.push('', `## ${item.type} unavailable`, `- ${item.error}`);
  }
  lines.push(
    '',
    'Live catalogs identify review candidates only. They do not authorize automatic preset edits or establish that an unseen preset was retired.',
  );
  const report = `${lines.join('\n')}\n`;
  const target = outputPath(process.argv.slice(2));
  if (target) await fs.writeFile(target, report, 'utf8');
  process.stdout.write(report);
  process.exitCode = status === 'current' ? 0 : status === 'drift' ? 2 : 1;
}

if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'catalog check failed'}\n`,
    );
    process.exitCode = 1;
  });
}
