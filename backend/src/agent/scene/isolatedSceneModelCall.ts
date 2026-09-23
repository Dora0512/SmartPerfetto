// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isolatedClaudeOneShotOptions} from '../../services/oneShotModelCall';

/**
 * Scene verification/summarization consumes trace-derived text as untrusted
 * model input. Keep these one-shot calls detached from user settings, tools,
 * skills, plugins, MCP servers, and resumable SDK transcripts: the shared
 * one-shot options every auxiliary model call uses.
 */
export function isolatedSceneModelCallOptions(input: {
  model: string;
  env: NodeJS.ProcessEnv;
  stderr: (data: string) => void;
}): Record<string, unknown> {
  return {...isolatedClaudeOneShotOptions({model: input.model, env: input.env, stderr: input.stderr})};
}
