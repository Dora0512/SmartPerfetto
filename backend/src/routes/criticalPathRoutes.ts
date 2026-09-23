// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {z} from 'zod';
import {localize, type OutputLanguage, parseOutputLanguage} from '../agentv3/outputLanguage';
import {providerScopeFromRequestContext} from '../agentRuntime/runtimeScopes';
import {summarizeCriticalPathWithAi} from '../services/criticalPathAiSummary';
import {analyzeCriticalPath, CriticalPathInputError, type CriticalPathAnalyzeOptions} from '../services/criticalPathAnalyzer';
import {renderCriticalPathAnalysis} from '../services/criticalPathLocalization';
import {hasRbacPermission} from '../services/rbac';
import {isTraceProcessorQueryCancelledError} from '../services/traceProcessorCancellation';
import {getTraceProcessorService} from '../services/traceProcessorService';
import type {
  CriticalPathAnalyzeRequest,
  CriticalPathAnalyzeResponse,
  CriticalPathErrorResponse,
  CriticalPathInputErrorCode,
} from '../types/criticalPathContract';
import {clientDisconnectSignal} from './clientDisconnect';
import {checkTraceId, parseRequestBody, readableTraceContext} from './traceRouteGuards';

const router = express.Router();

// Codex P1-5: this route does NOT pass through agentRoutes' explicit whitelist,
// so input validation has to live here. zod gives us a clamped, schema-checked
// option object — anything not declared here silently never reaches the runtime.
const intLike = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/, 'must be an integer string'),
]);

const AnalyzeBodySchema = z.object({
  threadStateId: intLike.optional(),
  utid: intLike.optional(),
  startTs: intLike.optional(),
  dur: intLike.optional(),
  endTs: intLike.optional(),
  maxSegments: z.number().int().min(20).max(1000).optional(),
  recursionDepth: z.number().int().min(0).max(2).optional(),
  recursionEnabled: z.boolean().optional(),
  segmentBudget: z.number().int().min(4).max(32).optional(),
  includeAi: z.boolean().optional(),
  question: z.string().max(500).optional(),
  outputLanguage: z.enum(['zh-CN', 'en']).optional(),
});

/** True only when two types accept exactly the same values. */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The schema is what the route accepts; the contract is what the frontend is
// told it may send. A field added to one and not the other is a type error.
const bodyMatchesContract: SameType<z.infer<typeof AnalyzeBodySchema>, CriticalPathAnalyzeRequest> = true;
void bodyMatchesContract;

/**
 * Caller-input failures the engine reports. They become 4xx bodies carrying
 * the code; every other failure stays an opaque 500.
 */
// `satisfies` makes a code the engine adds without a status here a type error.
const CRITICAL_PATH_INPUT_ERROR_STATUS = {
  invalid_thread_state_id: 400,
  thread_state_not_found: 404,
  missing_selector: 400,
  non_positive_duration: 400,
  invalid_integer: 400,
  invalid_name: 400,
} satisfies Record<CriticalPathInputErrorCode, 400 | 404>;

function inputErrorMessage(code: CriticalPathInputErrorCode, language: OutputLanguage): string {
  switch (code) {
    case 'invalid_thread_state_id':
      return localize(language, 'threadStateId 无效', 'threadStateId is invalid');
    case 'thread_state_not_found':
      return localize(
        language,
        '该 Trace 中找不到选中的 thread_state',
        'The selected thread_state was not found in this trace',
      );
    case 'missing_selector':
      return localize(
        language,
        '必须提供 threadStateId，或同时提供 utid、startTs 和 dur',
        'Provide threadStateId, or utid together with startTs and dur',
      );
    case 'non_positive_duration':
      return localize(language, '选中 task 的时长必须大于 0', 'The selected task duration must be positive');
    case 'invalid_integer':
      return localize(language, '数值参数必须是整数', 'Numeric parameters must be integers');
    case 'invalid_name':
      return localize(
        language,
        '名称不能含控制字符，且最多 200 个字符',
        'Names must contain no control characters and be at most 200 characters',
      );
  }
}

function sendError(res: express.Response, status: number, body: CriticalPathErrorResponse): express.Response {
  return res.status(status).json(body);
}

router.post('/:traceId/analyze', async (req, res) => {
  const outputLanguage = parseOutputLanguage(
    req.body?.outputLanguage ||
    req.header('accept-language') ||
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
  );
  // Attach before the first await: a disconnect during trace load or the
  // engine run must still cancel the model call that follows.
  const clientGone = clientDisconnectSignal(res);

  const {traceId} = req.params;
  if (!checkTraceId(res, traceId, outputLanguage)) return;
  // Validate before touching the trace: a bad request must not load a trace
  // processor.
  const body = parseRequestBody(res, AnalyzeBodySchema, req.body, outputLanguage);
  if (!body) return;

  try {
    const requestContext = await readableTraceContext(req, res, traceId, outputLanguage);
    if (!requestContext) return;
    const traceProcessorService = getTraceProcessorService();

    const analyzeOptions: CriticalPathAnalyzeOptions = {
      threadStateId: body.threadStateId,
      utid: body.utid,
      startTs: body.startTs,
      dur: body.dur,
      endTs: body.endTs,
      maxSegments: body.maxSegments,
      recursionDepth: body.recursionDepth,
      recursionEnabled: body.recursionEnabled,
      segmentBudget: body.segmentBudget,
      signal: clientGone,
    };
    const rawAnalysis = await analyzeCriticalPath(traceProcessorService, traceId, analyzeOptions);
    const aiSummary =
      body.includeAi === false
        ? undefined
        : await summarizeCriticalPathWithAi(rawAnalysis, body.question, outputLanguage, {
            signal: clientGone,
            // Reading the trace is not enough to spend the workspace's model:
            // the summary needs the same permission as an Agent run.
            aiPermitted: hasRbacPermission(requestContext, 'agent:run'),
            providerScope: providerScopeFromRequestContext(requestContext),
          });
    const response: CriticalPathAnalyzeResponse = {
      success: true,
      analysis: rawAnalysis,
      presentationAnalysis: renderCriticalPathAnalysis(rawAnalysis, outputLanguage),
      ...(aiSummary ? {aiSummary} : {}),
    };
    return res.json(response);
  } catch (error: unknown) {
    // The client is gone and the engine stopped because of it: nobody is
    // left to answer.
    if (clientGone.aborted && isTraceProcessorQueryCancelledError(error)) {
      console.info('[CriticalPath] Analysis cancelled: client disconnected');
      return;
    }
    if (error instanceof CriticalPathInputError) {
      return sendError(res, CRITICAL_PATH_INPUT_ERROR_STATUS[error.code], {
        success: false,
        code: error.code,
        error: inputErrorMessage(error.code, outputLanguage),
      });
    }
    console.error('[CriticalPath] Analyze error:', error);
    return sendError(res, 500, {
      success: false,
      code: 'critical_path_failed',
      error: localize(
        outputLanguage,
        '关键路径分析失败',
        'Critical path analysis failed',
      ),
    });
  }
});

export default router;
