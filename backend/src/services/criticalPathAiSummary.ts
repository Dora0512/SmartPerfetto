// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {type SDKMessage, type SDKResultSuccess, query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {isolatedSceneModelCallOptions} from '../agent/scene/isolatedSceneModelCall';
import {resolveAgentRuntimeSelection} from '../agentRuntime/runtimeSelection';
import {
  createSdkEnv,
  hasClaudeCredentials,
  loadClaudeConfig,
  resolveRuntimeConfig,
} from '../agentv3/claudeConfig';
import {
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {redactObjectForLLM} from '../utils/llmPrivacy';
import {
  AI_CAPABILITY_ENV_KEY,
  type AiCapabilityPolicyV1,
  getAiCapabilityPolicy,
  isAiFeatureEnabled,
} from './aiCapabilityPolicy';
import type {CriticalPathAnalysis} from './criticalPathAnalyzer';
import {buildDeterministicCriticalPathSummary} from './criticalPathSummary';
import type {ProviderScope} from './providerManager';

// Re-exported so the critical-path route keeps its historical import site while
// the pure summary itself no longer drags the Claude Agent SDK in with it.
export {buildDeterministicCriticalPathSummary};

/** Why the deterministic rule summary was returned instead of a model answer. */
export type CriticalPathAiFallbackReason =
  | 'ai_disabled'
  | 'runtime_not_supported'
  | 'runtime_unavailable'
  | 'credentials_missing'
  | 'client_disconnected'
  | 'timed_out'
  | 'failed'
  | 'empty_response';

export interface CriticalPathAiSummary {
  generated: boolean;
  model?: string;
  summary: string;
  warnings: string[];
  redactionApplied?: boolean;
  /** Set whenever `generated` is false; `warnings` carries the localized explanation. */
  fallbackReason?: CriticalPathAiFallbackReason;
}

export interface CriticalPathAiSummaryOptions {
  /**
   * Provider Manager scope of the caller. The summary follows that scope's
   * active profile exactly like an Agent run, instead of raw process env.
   */
  providerScope?: ProviderScope;
  /** Caller cancellation, e.g. the HTTP client disconnecting. */
  signal?: AbortSignal;
  /** Defaults to the process-wide `SMARTPERFETTO_AI_ENABLED` policy. */
  aiPolicy?: AiCapabilityPolicyV1;
}

type CriticalPathCounterfactual = NonNullable<
  NonNullable<CriticalPathAnalysis['quantification']>['counterfactual']
>;

interface CounterfactualView {
  longestSegmentDurMs: number;
  /** Best-case task duration once the longest external segment is removed. */
  bestCaseDurationMs: number;
  /** The saving that removal can buy at most (a shorter path may take over). */
  maxSavingMs: number;
}

// The pick keeps the deprecated `upperBoundMs` alias and the note out of the
// prompt: the model sees the best-case fields only.
function readCounterfactual(counterfactual: CriticalPathCounterfactual): CounterfactualView {
  const {longestSegmentDurMs, bestCaseDurationMs, maxSavingMs} = counterfactual;
  return {longestSegmentDurMs, bestCaseDurationMs, maxSavingMs};
}

// LLM input hard caps (Codex P1-6) — protect cost and avoid drowning the model
// in segment-level detail.
const HARD_CAPS = {
  segments: 16,
  childSegments: 4,
  binderTxnsPerSeg: 4,
  monitorPerSeg: 4,
  ioPerSeg: 4,
  gcPerSeg: 4,
  cpuPerSeg: 4,
  hypotheses: 3,
  warnings: 8,
  stringMaxLen: 200,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSuccessfulResultMessage(message: SDKMessage): message is SDKResultSuccess {
  return message.type === 'result' && message.subtype === 'success';
}

function clampString<T>(value: T, max: number = HARD_CAPS.stringMaxLen): T {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return (value.slice(0, max - 1) + '…') as unknown as T;
}

// Codex P0-5: extend redaction beyond the generic API-key/path patterns to
// cover Android-specific PII surfaces — package names, binder methods,
// io paths, monitor methods, layer names.
function redactCriticalPathFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactCriticalPathFields(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      // Hypothesis text is built by the product from numeric-only
      // interpolation, and the prompt asks the model to reuse the SQL
      // verbatim; clamping it would cut the SQL mid-predicate.
      if (lk === 'statement' || lk === 'verificationsql' || lk === 'notes') {
        out[k] = v;
        continue;
      }
      // Hash-style obfuscation for sensitive identifiers (keep grouping but
      // not the literal value).
      if (
        lk === 'package_name' ||
        lk === 'packagename' ||
        lk === 'app_package' ||
        lk === 'method_name' ||
        lk === 'methodname' ||
        lk === 'short_blocking_method' ||
        lk === 'short_blocked_method' ||
        lk === 'blocking_method' ||
        lk === 'blocked_method' ||
        lk === 'interface' ||
        lk === 'interfacename' ||
        lk === 'aidl_name' ||
        lk === 'layer_name' ||
        lk === 'layername' ||
        lk === 'io_path' ||
        lk === 'iopath' ||
        lk === 'path'
      ) {
        if (typeof v === 'string' && v.length > 0) {
          out[k] = `<${lk}_${Buffer.from(v).toString('base64').slice(0, 8)}>`;
          continue;
        }
      }
      out[k] = clampString(redactCriticalPathFields(v));
    }
    return out;
  }
  if (typeof value === 'string') {
    return clampString(value);
  }
  return value;
}

interface TrimmedSegment {
  startOffsetMs: number;
  durationMs: number;
  threadName: string | null | undefined;
  processName: string | null | undefined;
  state: string | null | undefined;
  blockedFunction: string | null | undefined;
  cpu: number | null | undefined;
  ioWait: boolean | null | undefined;
  modules: string[];
  reasons: string[];
  semantics?: unknown;
  children?: TrimmedSegment[];
}

function compactAnalysisForLLM(analysis: CriticalPathAnalysis): unknown {
  const trimSegment = (segment: CriticalPathAnalysis['wakeupChain'][number]): TrimmedSegment => ({
    startOffsetMs: segment.startOffsetMs,
    durationMs: segment.durationMs,
    threadName: segment.threadName,
    processName: segment.processName,
    state: segment.state,
    blockedFunction: segment.blockedFunction,
    cpu: segment.cpu,
    ioWait: segment.ioWait,
    modules: segment.modules,
    reasons: segment.reasons.slice(0, 6),
    semantics: segment.semantics
      ? {
          binderTxns: segment.semantics.binderTxns.slice(0, HARD_CAPS.binderTxnsPerSeg).map((txn) => ({
            side: txn.side,
            isSync: txn.isSync,
            isMainThread: txn.isMainThread,
            method: txn.methodName,
            interface: txn.interfaceName,
            durMs: txn.durMs,
          })),
          monitorContention: segment.semantics.monitorContention.slice(0, HARD_CAPS.monitorPerSeg).map((mc) => ({
            method: mc.shortBlockingMethod,
            blockedMethod: mc.shortBlockedMethod,
            blockedThread: mc.blockedThreadName,
            blockingThread: mc.blockingThreadName,
            durMs: mc.durMs,
            isBlockedThreadMain: mc.isBlockedThreadMain,
          })),
          ioSignals: segment.semantics.ioSignals.slice(0, HARD_CAPS.ioPerSeg).map((io) => ({
            source: io.source,
            blockedFunction: io.blockedFunction,
            durMs: io.durMs,
          })),
          gcEvents: segment.semantics.gcEvents.slice(0, HARD_CAPS.gcPerSeg).map((gc) => ({
            type: gc.gcType,
            isMarkCompact: gc.isMarkCompact,
            reclaimedMb: gc.reclaimedMb,
            durMs: gc.durMs,
          })),
          cpuCompetition: segment.semantics.cpuCompetition.slice(0, HARD_CAPS.cpuPerSeg).map((cpu) => ({
            cpu: cpu.cpu,
            competingThread: cpu.competingThread,
            competingState: cpu.competingState,
            competingDurMs: cpu.competingDurMs,
            cpuMaxFreqKhz: cpu.cpuMaxFreqKhz,
          })),
        }
      : undefined,
    children: segment.children
      ? segment.children.slice(0, HARD_CAPS.childSegments).map((child) => trimSegment(child))
      : undefined,
  });

  return {
    available: analysis.available,
    task: analysis.task,
    totalMs: analysis.totalMs,
    blockingMs: analysis.blockingMs,
    selfMs: analysis.selfMs,
    externalBlockingPercentage: analysis.externalBlockingPercentage,
    wakeupChain: analysis.wakeupChain.slice(0, HARD_CAPS.segments).map((segment) => trimSegment(segment)),
    moduleBreakdown: analysis.moduleBreakdown.slice(0, 8),
    ruleAnomalies: analysis.anomalies.slice(0, 8),
    ruleRecommendations: analysis.recommendations.slice(0, 6),
    warnings: analysis.warnings.slice(0, HARD_CAPS.warnings),
    rawRows: analysis.rawRows,
    truncated: analysis.truncated,
    slices: analysis.slices?.slice(0, 6),
    directWaker: analysis.directWaker,
    quantification: analysis.quantification
      ? {
          counterfactual: analysis.quantification.counterfactual
            ? readCounterfactual(analysis.quantification.counterfactual)
            : null,
          frameImpacts: analysis.quantification.frameImpacts.slice(0, 4),
          hypotheses: analysis.quantification.hypotheses.slice(0, HARD_CAPS.hypotheses),
        }
      : undefined,
    semanticSources: analysis.semanticSources,
  };
}

const STRUCTURED_PROMPT_TEMPLATE = `你是 Android Perfetto 调度与渲染性能分析专家。下面是一份针对选中 task 的结构化 critical path 分析事实（已脱敏）。请严格按照以下 5 段输出，每段一个段落，无前置废话。

# 1. 等什么 [evidence_strength]
基于 L1 task state（S/D/R/Running）和 L3 语义信号（binder/monitor/io/gc/cpu_competition）说明这一段在等什么类型的资源。如果信号矛盾或薄弱，标【弱证据】或【证据不足】。

# 2. 谁唤醒 / 为什么 [evidence_strength]
基于 directWaker（kind=irq/swapper/thread）+ wakeupChain 上的递归子链（children）说明：直接唤醒来自哪里，以及该唤醒方在被唤醒前自己当时在做什么。如果是 IRQ/swapper 终止，明确说明无更上游链路可追。

# 3. 链路语义 [evidence_strength]
基于 semantics.binderTxns / monitorContention / ioSignals / gcEvents / cpuCompetition 给出**具体**的语义事件（method 名已 base64 脱敏，请按 ID 引用），并说明每条事件如何叠加形成总等待。

# 4. 量化影响 [evidence_strength]
基于 quantification.counterfactual + frameImpacts：bestCaseDurationMs 是消除最长外部段后任务时长的最好情况，节省至多 maxSavingMs；并说明是否覆盖某帧 deadline。**明确表述这是最好情况估算而非确定预测：其他等待可能成为新瓶颈，实际节省可能更少**。

# 5. 可证伪假设 + SQL [evidence_strength]
基于 quantification.hypotheses 列出最多 3 条假设，每条用一句话陈述 + 注明 strength + 给出 verificationSql（直接复用，不要改字符串）。

规则：
- 每段必须以【强证据】/【弱证据】/【证据不足】开头标注 evidence_strength。
- 禁止编造未在 JSON 中出现的数据。
- 禁止把 base64 脱敏标记还原为可读名字（如 <method_name_xxxx>），保持原样引用。
- 全文中文，专业语气，每段 ≤ 4 句话。

事实 JSON：
{{JSON}}
{{QUESTION_BLOCK}}`;

const STRUCTURED_PROMPT_TEMPLATE_EN = `You are an Android Perfetto scheduling and rendering-performance expert. The following JSON contains redacted, structured facts for a selected task. Return exactly five short sections with no preamble.

# 1. What is it waiting for? [evidence_strength]
Use the L1 task state and L3 semantic signals (binder, monitor, I/O, GC, CPU contention). Mark conflicting or thin signals as [Weak evidence] or [Insufficient evidence].

# 2. Who woke it and why? [evidence_strength]
Use directWaker and recursive wakeupChain children. Explain the direct source and what the waker was doing before the wakeup. State when IRQ or swapper ends the upstream chain.

# 3. Path semantics [evidence_strength]
Use semantics.binderTxns, monitorContention, ioSignals, gcEvents, and cpuCompetition. Reference redacted method IDs unchanged and explain how events combine into total wait time.

# 4. Quantified impact [evidence_strength]
Use quantification.counterfactual and frameImpacts. bestCaseDurationMs is the best-case task duration after removing the longest external segment, and the saving is at most maxSavingMs. Explicitly state that this is a best-case estimate, not a guaranteed prediction: another wait may become the bottleneck, so the real saving can be smaller.

# 5. Falsifiable hypotheses and SQL [evidence_strength]
List at most three hypotheses with strength and reuse verificationSql verbatim.

Rules:
- Begin every section with [Strong evidence], [Weak evidence], or [Insufficient evidence].
- Do not invent facts absent from the JSON.
- Keep redacted markers such as <method_name_xxxx> unchanged.
- Write entirely in English with a professional tone and no more than four sentences per section.

Fact JSON:
{{JSON}}
{{QUESTION_BLOCK}}`;

/** Localized explanation for each deterministic-summary fallback. */
function fallbackWarning(
  reason: CriticalPathAiFallbackReason,
  outputLanguage: OutputLanguage,
  detail = '',
): string {
  switch (reason) {
    case 'ai_disabled':
      return localize(
        outputLanguage,
        `AI 已由 ${AI_CAPABILITY_ENV_KEY} 关闭，已返回规则兜底总结。`,
        `AI is disabled by ${AI_CAPABILITY_ENV_KEY}; a deterministic rule summary was returned.`,
      );
    case 'runtime_not_supported':
      return localize(
        outputLanguage,
        `当前 Provider 使用 ${detail} 运行时，关键路径 AI 总结只支持 Claude Agent SDK，已返回规则兜底总结。`,
        `The active provider uses the ${detail} runtime; the critical-path AI summary supports only the Claude Agent SDK, so a deterministic rule summary was returned.`,
      );
    case 'runtime_unavailable':
      return localize(
        outputLanguage,
        '无法解析当前 AI Provider，已返回规则兜底总结。',
        'The active AI provider could not be resolved; a deterministic rule summary was returned.',
      );
    case 'credentials_missing':
      return localize(
        outputLanguage,
        'AI 模型未配置，已返回规则兜底总结。',
        'No AI model is configured; a deterministic rule summary was returned.',
      );
    case 'client_disconnected':
      return localize(
        outputLanguage,
        '客户端已断开，AI 诊断已取消。',
        'The client disconnected, so the AI diagnosis was cancelled.',
      );
    case 'timed_out':
      return localize(
        outputLanguage,
        'AI 诊断超时，已返回规则兜底总结。',
        'AI diagnosis timed out; a deterministic rule summary was returned.',
      );
    case 'failed':
      return localize(
        outputLanguage,
        `AI 诊断失败，已返回规则兜底总结：${detail}`,
        `AI diagnosis failed; a deterministic rule summary was returned: ${detail}`,
      );
    case 'empty_response':
      return localize(
        outputLanguage,
        'AI 没有返回有效内容，已返回规则兜底总结。',
        'The AI returned no valid content; a deterministic rule summary was returned.',
      );
  }
}

function buildStructuredPrompt(
  analysis: CriticalPathAnalysis,
  question: string | undefined,
  outputLanguage: OutputLanguage,
): {prompt: string; redactionApplied: boolean} {
  const compact = compactAnalysisForLLM(analysis);
  const customRedacted = redactCriticalPathFields(compact);
  const redacted = redactObjectForLLM(customRedacted);

  const promptTemplate =
    outputLanguage === 'en'
      ? STRUCTURED_PROMPT_TEMPLATE_EN
      : STRUCTURED_PROMPT_TEMPLATE;
  const prompt = promptTemplate.replace(
    '{{JSON}}',
    JSON.stringify(redacted.value).slice(0, 32_000)
  ).replace(
    '{{QUESTION_BLOCK}}',
    question
      ? localize(
          outputLanguage,
          `\n\n用户额外问题：${clampString(question, 500)}`,
          `\n\nAdditional user question: ${clampString(question, 500)}`,
        )
      : '',
  );
  return {prompt, redactionApplied: redacted.stats.applied};
}

/**
 * Optional model narrative over the deterministic analysis. Every path that
 * does not produce a model answer returns the deterministic summary with a
 * `fallbackReason` and a localized warning; this function never throws for
 * policy, provider, or model failures.
 */
export async function summarizeCriticalPathWithAi(
  analysis: CriticalPathAnalysis,
  question?: string,
  outputLanguage: OutputLanguage = 'zh-CN',
  options: CriticalPathAiSummaryOptions = {},
): Promise<CriticalPathAiSummary> {
  const fallback = buildDeterministicCriticalPathSummary(
    analysis,
    outputLanguage,
  );
  const degrade = (
    reason: CriticalPathAiFallbackReason,
    extra: Pick<CriticalPathAiSummary, 'model' | 'redactionApplied'> = {},
    detail = '',
  ): CriticalPathAiSummary => ({
    generated: false,
    ...extra,
    summary: fallback,
    warnings: [fallbackWarning(reason, outputLanguage, detail)],
    fallbackReason: reason,
  });

  // The operator switch is checked before any provider or credential lookup:
  // with AI off, no trace-derived text may reach a model.
  const policy = options.aiPolicy ?? getAiCapabilityPolicy();
  if (!isAiFeatureEnabled('critical_path_ai_summary', policy)) {
    return degrade('ai_disabled');
  }
  const {signal, providerScope} = options;
  if (signal?.aborted) {
    return degrade('client_disconnected');
  }

  // Follow the caller's active Provider Manager profile, as an Agent run does.
  let model: string;
  let sdkEnv: ReturnType<typeof createSdkEnv>;
  try {
    const selection = resolveAgentRuntimeSelection(undefined, undefined, providerScope);
    if (selection.kind !== 'claude-agent-sdk') {
      return degrade('runtime_not_supported', {}, selection.kind);
    }
    model = resolveRuntimeConfig(loadClaudeConfig(), undefined, providerScope).model;
    sdkEnv = createSdkEnv(undefined, providerScope);
  } catch (error: unknown) {
    console.warn('[CriticalPathAI] Provider resolution failed:', errorMessage(error));
    return degrade('runtime_unavailable');
  }
  if (!hasClaudeCredentials(sdkEnv)) {
    return degrade('credentials_missing');
  }

  const {prompt, redactionApplied} = buildStructuredPrompt(analysis, question, outputLanguage);
  const attempted = {model, redactionApplied};

  const timeoutMs = Number.parseInt(process.env.CRITICAL_PATH_AI_TIMEOUT_MS || '60000', 10);
  // One controller owns the SDK subprocess; the caller's disconnect and the
  // wall-clock deadline both stop it through the same path.
  const abortController = new AbortController();
  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const stop = () => {
    abortController.abort();
    try {
      stream?.close();
    } catch {
      // ignore
    }
  };
  signal?.addEventListener('abort', stop, {once: true});
  const timer = setTimeout(
    () => {
      timedOut = true;
      stop();
    },
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000
  );

  let result = '';
  try {
    stream = sdkQuery({
      prompt,
      options: {
        ...isolatedSceneModelCallOptions({
          model,
          env: sdkEnv,
          stderr: (data: string) => {
            console.warn(`[CriticalPathAI] SDK stderr: ${data.trimEnd()}`);
          },
        }),
        abortController,
      },
    });
    for await (const message of stream) {
      if (abortController.signal.aborted) break;
      if (isSuccessfulResultMessage(message)) {
        result = message.result || '';
      }
    }
  } catch (error: unknown) {
    if (!abortController.signal.aborted) {
      console.warn('[CriticalPathAI] Model call failed:', error);
      return degrade('failed', attempted, errorMessage(error));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    try {
      stream?.close();
    } catch {
      // ignore
    }
  }

  if (signal?.aborted) return degrade('client_disconnected', attempted);
  if (timedOut) return degrade('timed_out', attempted);
  if (!result.trim()) return degrade('empty_response', attempted);

  return {
    generated: true,
    ...attempted,
    summary: result.trim(),
    warnings: [],
  };
}

// Exported for tests.
export const __INTERNAL__ = {
  redactCriticalPathFields,
  HARD_CAPS,
  STRUCTURED_PROMPT_TEMPLATE,
};
