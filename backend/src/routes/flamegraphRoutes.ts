// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {z} from 'zod';
import {requireRequestContext} from '../middleware/auth';
import {localize, type OutputLanguage, parseOutputLanguage} from '../agentv3/outputLanguage';
import {summarizeFlamegraphWithAi} from '../services/flamegraphAiSummary';
import {analyzeFlamegraph, getFlamegraphAvailability} from '../services/flamegraphAnalyzer';
import {hasRbacPermission} from '../services/rbac';
import {sendResourceNotFound} from '../services/resourceOwnership';
import {isSafeTraceId, readTraceMetadataForContext} from '../services/traceMetadataStore';
import {isTraceProcessorQueryCancelledError} from '../services/traceProcessorCancellation';
import {getTraceProcessorService} from '../services/traceProcessorService';
import {clientDisconnectSignal} from './clientDisconnect';

const router = express.Router();

// Integers only in the number form: String(1e21) is exponent notation, which
// the analyzer would reject as a non-numeric timestamp.
const timestampLike = z.union([
  z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a numeric timestamp'),
]);

// Declared fields only; anything else is dropped before the analyzer. The
// analyzer clamps node and sample limits to its own bounds.
const AnalyzeBodySchema = z.object({
  startTs: timestampLike.optional(),
  endTs: timestampLike.optional(),
  packageName: z.string().max(200).optional(),
  threadName: z.string().max(200).optional(),
  sampleSource: z.string().max(200).optional(),
  maxNodes: z.number().int().positive().optional(),
  minSampleCount: z.number().int().positive().optional(),
  includeAi: z.boolean().optional(),
  question: z.string().max(500).optional(),
});

type TraceAccess =
  | {ok: true; requestContext: ReturnType<typeof requireRequestContext>}
  | {ok: false};

function requestLanguage(req: express.Request): OutputLanguage {
  return parseOutputLanguage(req.header('accept-language') || process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
}

function rejectUnsafeTraceId(res: express.Response, language: OutputLanguage): express.Response {
  return res.status(400).json({
    success: false,
    code: 'invalid_trace_id',
    error: localize(language, 'traceId 无效', 'traceId is invalid'),
  });
}

/**
 * The same ownership check as the Agent and critical-path routes: the trace
 * must be readable by the caller's context before a processor is loaded.
 * Answers 404 itself when it is not.
 */
async function authorizeTrace(
  req: express.Request,
  res: express.Response,
  traceId: string,
  language: OutputLanguage,
): Promise<TraceAccess> {
  const requestContext = requireRequestContext(req);
  const notFound = (): TraceAccess => {
    sendResourceNotFound(
      res,
      localize(language, `未找到 Trace ${traceId}`, `Trace ${traceId} not found`),
      'trace_not_found',
    );
    return {ok: false};
  };
  if (!(await readTraceMetadataForContext(traceId, requestContext))) return notFound();
  if (!(await getTraceProcessorService().getOrLoadTrace(traceId))) return notFound();
  return {ok: true, requestContext};
}

function sendFailure(res: express.Response, language: OutputLanguage): express.Response {
  return res.status(500).json({
    success: false,
    code: 'flamegraph_failed',
    error: localize(language, '火焰图分析失败', 'Flamegraph analysis failed'),
  });
}

router.get('/:traceId/availability', async (req, res) => {
  const language = requestLanguage(req);
  const clientGone = clientDisconnectSignal(res);
  const {traceId} = req.params;
  if (!traceId || !isSafeTraceId(traceId)) return rejectUnsafeTraceId(res, language);

  try {
    const access = await authorizeTrace(req, res, traceId, language);
    if (!access.ok) return;
    const availability = await getFlamegraphAvailability(getTraceProcessorService(), traceId, {signal: clientGone});
    return res.json({success: true, ...availability});
  } catch (error: unknown) {
    if (clientGone.aborted && isTraceProcessorQueryCancelledError(error)) return;
    console.error('[Flamegraph] Availability error:', error);
    return sendFailure(res, language);
  }
});

router.post('/:traceId/analyze', async (req, res) => {
  const language = requestLanguage(req);
  // Attach before the first await so a disconnect during trace load still
  // cancels the queries and the model call that follow.
  const clientGone = clientDisconnectSignal(res);
  const {traceId} = req.params;
  if (!traceId || !isSafeTraceId(traceId)) return rejectUnsafeTraceId(res, language);

  // Validate before touching the trace: a bad request must not load a processor.
  const parsed = AnalyzeBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: 'invalid_request_body',
      error: localize(language, '请求体无效', 'Invalid request body'),
      issues: parsed.error.issues.map((issue) => ({path: issue.path.join('.'), message: issue.message})),
    });
  }
  const {includeAi, question, ...analyzeOptions} = parsed.data;

  try {
    const access = await authorizeTrace(req, res, traceId, language);
    if (!access.ok) return;
    const {requestContext} = access;
    const analysis = await analyzeFlamegraph(getTraceProcessorService(), traceId, analyzeOptions, {
      signal: clientGone,
    });
    const aiSummary =
      includeAi === false
        ? undefined
        : await summarizeFlamegraphWithAi(analysis, question, {
            signal: clientGone,
            // Reading the trace is not enough to spend the workspace's model.
            aiPermitted: hasRbacPermission(requestContext, 'agent:run'),
            providerScope: {
              tenantId: requestContext.tenantId,
              workspaceId: requestContext.workspaceId,
              userId: requestContext.userId,
            },
          });
    return res.json({success: true, analysis, aiSummary});
  } catch (error: unknown) {
    if (clientGone.aborted && isTraceProcessorQueryCancelledError(error)) {
      console.info('[Flamegraph] Analysis cancelled: client disconnected');
      return;
    }
    console.error('[Flamegraph] Analyze error:', error);
    return sendFailure(res, language);
  }
});

export default router;
