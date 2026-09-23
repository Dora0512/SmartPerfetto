// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {z} from 'zod';
import {requireRequestContext} from '../middleware/auth';
import {localize, type OutputLanguage, parseOutputLanguage} from '../agentv3/outputLanguage';
import {summarizeCriticalPathWithAi} from '../services/criticalPathAiSummary';
import {
  analyzeCriticalPath,
  CriticalPathInputError,
  type CriticalPathAnalyzeOptions,
  type CriticalPathInputErrorCode,
} from '../services/criticalPathAnalyzer';
import {projectCriticalPathAnalysis} from '../services/criticalPathLocalization';
import {sendResourceNotFound} from '../services/resourceOwnership';
import {isSafeTraceId, readTraceMetadataForContext} from '../services/traceMetadataStore';
import {isTraceProcessorQueryCancelledError} from '../services/traceProcessorCancellation';
import {getTraceProcessorService} from '../services/traceProcessorService';
import {clientDisconnectSignal} from './clientDisconnect';

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

function traceNotFound(res: express.Response, language: OutputLanguage, traceId: string) {
  return sendResourceNotFound(
    res,
    localize(language, `未找到 Trace ${traceId}`, `Trace ${traceId} not found`),
    'trace_not_found',
  );
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
  if (!traceId || !isSafeTraceId(traceId)) {
    return res.status(400).json({
      success: false,
      code: 'invalid_trace_id',
      error: localize(outputLanguage, 'traceId 无效', 'traceId is invalid'),
    });
  }

  // Validate before touching the trace: a bad request must not load a trace
  // processor.
  const parsed = AnalyzeBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: 'invalid_request_body',
      error: localize(outputLanguage, '请求体无效', 'Invalid request body'),
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const body = parsed.data;

  try {
    const requestContext = requireRequestContext(req);
    // Same ownership check as the Agent routes: the trace must belong to the
    // caller's workspace and the caller needs trace:read.
    if (!(await readTraceMetadataForContext(traceId, requestContext))) {
      return traceNotFound(res, outputLanguage, traceId);
    }
    const traceProcessorService = getTraceProcessorService();
    if (!(await traceProcessorService.getOrLoadTrace(traceId))) {
      return traceNotFound(res, outputLanguage, traceId);
    }

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
            providerScope: {
              tenantId: requestContext.tenantId,
              workspaceId: requestContext.workspaceId,
              userId: requestContext.userId,
            },
          });
    return res.json({
      success: true,
      analysis: rawAnalysis,
      presentationAnalysis: projectCriticalPathAnalysis(
        rawAnalysis,
        outputLanguage,
      ),
      aiSummary,
    });
  } catch (error: unknown) {
    // The client is gone and the engine stopped because of it: nobody is
    // left to answer.
    if (clientGone.aborted && isTraceProcessorQueryCancelledError(error)) {
      console.info('[CriticalPath] Analysis cancelled: client disconnected');
      return;
    }
    if (error instanceof CriticalPathInputError) {
      return res.status(CRITICAL_PATH_INPUT_ERROR_STATUS[error.code]).json({
        success: false,
        code: error.code,
        error: inputErrorMessage(error.code, outputLanguage),
      });
    }
    console.error('[CriticalPath] Analyze error:', error);
    return res.status(500).json({
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
