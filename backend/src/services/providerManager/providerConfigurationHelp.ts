// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';

export type ProviderConfigurationSurface = 'runtime' | 'web' | 'cli';

/** Recovery instructions for the surface that detected the failure; never inspect or expose credentials. */
export function providerConfigurationHelp(
  language: OutputLanguage,
  surface: ProviderConfigurationSurface = 'runtime',
): string {
  if (surface === 'web') {
    return localize(
      language,
      '优先打开当前后端的网页：AI Assistant 设置 → Providers，编辑当前供应商的 API Key/Token、对应 API 地址和模型（Bedrock/Vertex 使用各自的云认证配置），保存、测试连接并激活。该操作只修改当前后端使用的 Provider store；CLI 默认使用独立 store，只有两者显式使用同一个 SMARTPERFETTO_BACKEND_DATA_DIR 时才会同步生效。\n\n' +
        '也可修改当前运行方式的配置文件：源码 Web 后端用 backend/.env；Docker 用仓库根目录 .env；免安装包用启动器提示的用户数据目录中的 env，或 SMARTPERFETTO_ENV_FILE 指定的文件。修改后重启对应后端或容器；已激活的当前 Web Provider 优先于该进程的配置文件，改用文件配置前先停用它。切换配置后新建分析会话。',
      'First open the Web UI for the current backend: AI Assistant Settings → Providers. Edit the current provider\'s API Key/Token, API URL, and model (use the respective cloud authentication fields for Bedrock/Vertex), then save, test the connection, and activate it. This changes only the Provider store used by the current backend. The CLI uses a separate store by default; the change also applies there only when both explicitly use the same SMARTPERFETTO_BACKEND_DATA_DIR.\n\n' +
        'Alternatively, edit the configuration file for this run mode: source Web backends use backend/.env; Docker uses the repository-root .env; portable packages use the env file in the user data directory shown by the launcher, or the file specified by SMARTPERFETTO_ENV_FILE. Restart the backend or container after file changes. An active Provider in the current Web backend takes priority over that process\'s configuration file; deactivate it before switching to file configuration. Start a new analysis session after switching configuration.',
    );
  }

  if (surface === 'cli') {
    return localize(
      language,
      'CLI 先运行 `smp doctor --format text` 和 `smp provider list` 检查当前实例。若当前 CLI Provider store 已有 active profile，用 `smp provider test <providerId>` 测试；否则运行 `smp config init`，编辑输出的 env 文件（默认 ~/.smartperfetto/env，也可用 --session-dir、SMARTPERFETTO_HOME 或 --env-file 指定位置），再用 `smp provider test system` 验证。CLI 当前不提供 provider add/edit/activate 命令。\n\n' +
        'CLI 默认 Provider store 是 <CLI home>/runtime/data/providers.json（默认 ~/.smartperfetto/runtime/data/providers.json），源码 Web 后端默认是 backend/data/providers.json，两者不共享。只有 CLI 与当前 Web 后端显式使用同一个 SMARTPERFETTO_BACKEND_DATA_DIR 时，才优先在该网页的 AI Assistant 设置 → Providers 修改并让 CLI 使用同一结果。按供应商填写认证、地址和模型字段，修改文件后重启 CLI，切换配置后新建分析会话。',
      'First run `smp doctor --format text` and `smp provider list` to inspect the current CLI instance. If its Provider store already has an active profile, test it with `smp provider test <providerId>`. Otherwise run `smp config init`, edit the printed env file (by default ~/.smartperfetto/env; use --session-dir, SMARTPERFETTO_HOME, or --env-file to choose another location), then verify with `smp provider test system`. The CLI does not currently provide provider add/edit/activate commands.\n\n' +
        'The CLI Provider store defaults to <CLI home>/runtime/data/providers.json (normally ~/.smartperfetto/runtime/data/providers.json), while a source Web backend defaults to backend/data/providers.json; they are not shared. Only when the CLI and current Web backend explicitly use the same SMARTPERFETTO_BACKEND_DATA_DIR should you prefer editing AI Assistant Settings → Providers in that Web UI and expect the CLI to use the same result. Set the provider-specific authentication, URL, and model fields, restart the CLI after file changes, and start a new analysis session after switching configuration.',
    );
  }

  return localize(
    language,
    '请使用当前运行实例对应的配置入口。Web 后端优先在 AI Assistant 设置 → Providers 中保存、测试并激活 Provider；CLI 先用 `smp doctor --format text`、`smp provider list` 和 `smp provider test system` 检查当前实例，首次配置用 `smp config init` 创建 env 文件。\n\n' +
      'Web 与 CLI 默认使用不同 Provider store：源码 Web 后端默认是 backend/data/providers.json，CLI 默认是 <CLI home>/runtime/data/providers.json（通常为 ~/.smartperfetto/runtime/data/providers.json）。只有两者显式使用同一个 SMARTPERFETTO_BACKEND_DATA_DIR 时才共享网页 Provider 修改。文件配置路径分别为：源码 Web 后端 backend/.env、Docker 仓库根目录 .env、CLI 默认 ~/.smartperfetto/env（可用 --session-dir、SMARTPERFETTO_HOME 或 --env-file 修改）、免安装包启动器提示的用户数据目录中的 env 或 SMARTPERFETTO_ENV_FILE。按供应商填写认证、地址和模型字段，修改后重启对应进程，切换配置后新建分析会话。',
    'Use the configuration entry point for the process that reported the failure. For a Web backend, first save, test, and activate the provider under AI Assistant Settings → Providers. For the CLI, inspect the current instance with `smp doctor --format text`, `smp provider list`, and `smp provider test system`; use `smp config init` to create an env file for first-time setup.\n\n' +
      'Web and CLI use different Provider stores by default: a source Web backend defaults to backend/data/providers.json, while the CLI defaults to <CLI home>/runtime/data/providers.json (normally ~/.smartperfetto/runtime/data/providers.json). They share Web Provider changes only when both explicitly use the same SMARTPERFETTO_BACKEND_DATA_DIR. File configuration paths are backend/.env for a source Web backend, the repository-root .env for Docker, ~/.smartperfetto/env for the CLI (overridden by --session-dir, SMARTPERFETTO_HOME, or --env-file), and the launcher-reported user-data env or SMARTPERFETTO_ENV_FILE for portable packages. Set the provider-specific authentication, URL, and model fields, restart the affected process, and start a new analysis session after switching configuration.',
  );
}
