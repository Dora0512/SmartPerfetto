// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {z} from 'zod';
import {localize, type OutputLanguage, parseOutputLanguage} from '../agentv3/outputLanguage';
import {providerScopeFromRequestContext} from '../agentRuntime/runtimeScopes';
import {summarizeFlamegraphWithAi} from '../services/flamegraphAiSummary';
import {analyzeFlamegraph, getFlamegraphAvailability} from '../services/flamegraphAnalyzer';
import {hasRbacPermission} from '../services/rbac';
import {isTraceProcessorQueryCancelledError} from '../services/traceProcessorCancellation';
import {getTraceProcessorService} from '../services/traceProcessorService';
import {clientDisconnectSignal} from './clientDisconnect';
import {checkTraceId, parseRequestBody, readableTraceContext} from './traceRouteGuards';

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

function requestLanguage(req: express.Request): OutputLanguage {
  return parseOutputLanguage(req.header('accept-language') || process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
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
  if (!checkTraceId(res, traceId, language)) return;

  try {
    if (!(await readableTraceContext(req, res, traceId, language))) return;
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
  if (!checkTraceId(res, traceId, language)) return;
  // Validate before touching the trace: a bad request must not load a processor.
  const body = parseRequestBody(res, AnalyzeBodySchema, req.body, language);
  if (!body) return;
  const {includeAi, question, ...analyzeOptions} = body;

  try {
    const requestContext = await readableTraceContext(req, res, traceId, language);
    if (!requestContext) return;
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
            providerScope: providerScopeFromRequestContext(requestContext),
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
