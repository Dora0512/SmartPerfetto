// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isPlainObject} from '../../../utils/llmJson';

/**
 * A tool call, tool result or permission denial in a Claude Agent SDK message.
 * One-shot calls are given no tools, so any of these means the answer cannot
 * be trusted as a plain model reply. Covers the assistant message content,
 * streamed `content_block_start` blocks and the SDK's result-side markers.
 */
export function claudeMessageHasToolUse(message: Record<string, unknown>): boolean {
  const inner = message.message;
  const content = isPlainObject(inner) ? inner.content : undefined;
  const event = isPlainObject(message.event) ? message.event : undefined;
  const isToolBlock = (value: unknown) =>
    isPlainObject(value) && (value.type === 'tool_use' || value.type === 'tool_result');
  return (Array.isArray(content) && content.some(isToolBlock))
    || (event?.type === 'content_block_start' && isToolBlock(event.content_block))
    || message.tool_use_result !== undefined
    || message.deferred_tool_use != null
    || (Array.isArray(message.permission_denials) && message.permission_denials.length > 0)
    || (message.type === 'system' && message.subtype === 'permission_denied');
}
