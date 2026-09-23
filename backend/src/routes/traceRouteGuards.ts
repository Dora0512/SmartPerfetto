// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The request checks the trace-analysis routes (critical path, flamegraph)
// share, in the order they run: a safe trace id, a valid body, then trace
// ownership, all before any trace processor is loaded. Each answers the coded,
// localized error itself.

import type express from 'express';
import type {z} from 'zod';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {requireRequestContext, type RequestContext} from '../middleware/auth';
import {sendResourceNotFound} from '../services/resourceOwnership';
import {isSafeTraceId, readTraceMetadataForContext} from '../services/traceMetadataStore';
import {getTraceProcessorService} from '../services/traceProcessorService';

/** False after answering 400 `invalid_trace_id`. */
export function checkTraceId(res: express.Response, traceId: string | undefined, language: OutputLanguage): traceId is string {
  if (traceId && isSafeTraceId(traceId)) return true;
  res.status(400).json({
    success: false,
    code: 'invalid_trace_id',
    error: localize(language, 'traceId 无效', 'traceId is invalid'),
  });
  return false;
}

/** The parsed body, or undefined after answering 400 `invalid_request_body` with the failing fields. */
export function parseRequestBody<S extends z.ZodTypeAny>(
  res: express.Response,
  schema: S,
  body: unknown,
  language: OutputLanguage,
): z.infer<S> | undefined {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  res.status(400).json({
    success: false,
    code: 'invalid_request_body',
    error: localize(language, '请求体无效', 'Invalid request body'),
    issues: parsed.error.issues.map((issue) => ({path: issue.path.join('.'), message: issue.message})),
  });
  return undefined;
}

/**
 * The caller's context when the trace is theirs (workspace and `trace:read`,
 * like the Agent routes) and loads; undefined after answering 404
 * `trace_not_found`.
 */
export async function readableTraceContext(
  req: express.Request,
  res: express.Response,
  traceId: string,
  language: OutputLanguage,
): Promise<RequestContext | undefined> {
  const requestContext = requireRequestContext(req);
  if (
    (await readTraceMetadataForContext(traceId, requestContext))
    && (await getTraceProcessorService().getOrLoadTrace(traceId))
  ) {
    return requestContext;
  }
  sendResourceNotFound(
    res,
    localize(language, `未找到 Trace ${traceId}`, `Trace ${traceId} not found`),
    'trace_not_found',
  );
  return undefined;
}
