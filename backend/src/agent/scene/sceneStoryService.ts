// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneStoryService — the entry point for the Scene Story pipeline.
 *
 * Keeps the legacy deterministic/Smart pipeline and adapts finalized v3 scene
 * investigations. V3 acquisition and terminal publication belong to the shared
 * analysis runner; its archive adapter below emits no events or session status.
 *
 * Legacy stages:
 *
 *   Stage 1  scene_reconstruction skill (no LLM)
 *   Stage 2  per-interval Agent deep-dive via SceneAnalysisJobRunner
 *   Stage 3  Haiku cross-scene narrative summary
 *   Stage 4  SceneReport persistence (currently kept on the in-memory session)
 *
 * SSE event flow uses the new scene_story_* event names. The legacy
 * track_data event is also emitted once after Stage 1 so the existing
 * frontend keeps painting timelines until story_controller migrates to
 * the new event names.
 *
 * Cancel semantics:
 *  - cancel() flips a runner-level flag immediately
 *  - queued jobs transition to 'cancelled'
 *  - running jobs keep executing (SkillExecutor has no abort) but their
 *    results land as 'dropped' rather than 'completed'
 *  - waitForAllDone() resolves once nothing is in flight
 *  - the service then finalises with a partial SceneReport and emits a
 *    terminal event so the SSE stream can close cleanly
 */

import { uuidv4 } from '../../utils/uuid';
import {acceptFinalizedSceneTimeline, loadFinalizedSceneReport, projectSceneTimelineReport,
  type AcceptFinalizedTimelineInput, type FinalizedTimelineReport, type SceneTimelineArchive} from './sceneTimelineReportAdapter';
import type {SceneTimelineReport, SceneTimelineReportView} from './types';
import { SkillExecutor } from '../../services/skillEngine/skillExecutor';
import { SkillExecutionResult } from '../../services/skillEngine/types';
import { DataEnvelope } from '../../types/dataContract';
import { StreamingUpdate } from '../types';
import { sceneStoryConfig } from '../../config';
import { ownersMatch, type ResourceOwnerFields } from '../../services/resourceOwnership';
import { runWithSmartTraceSqlSemaphore } from '../../services/traceProcessor/sqlSemaphore';
import type { SceneJobArtifactStore } from '../../services/sceneReport/sceneJobArtifactStore';
import { estimateSceneStoryCost, type CostEstimate } from './sceneCostEstimator';
import type { SceneRouteProfile } from '../config/domainManifest';
import type { SmartCancelToken } from './smartCancelBridge';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../../agentv3/outputLanguage';
import {
  projectDisplayedScene,
  projectSceneVerification,
} from './scenePresentation';
import {
  buildAnalysisIntervals,
  selectAnalysisEligibleScenes,
} from './sceneIntervalBuilder';
import {
  JobRunnerEvent,
  SceneAnalysisJobRunner,
} from './sceneAnalysisJobRunner';
import { SceneStage1Runner } from './sceneStage1Runner';
import { runSceneStage1Verifier } from './sceneStage1Verifier';
import {
  runStage3Summary,
  type Stage3LocalizedSummaries,
} from './sceneStage3Summarizer';
import type { SceneReportStore } from '../../services/sceneReport/sceneReportStore';
import type { SceneReportMemoryCache } from '../../services/sceneReport/sceneReportMemoryCache';
import {
  AnalysisInterval,
  DisplayedScene,
  DisplayedSceneAnalysisState,
  SceneAnalysisJob,
  SceneAnalysisSelection,
  SceneReconstructionVerification,
  SceneInsight,
  SceneReport,
} from './types';

const LEGACY_SMART_SELECTION_PREVIEW_SUMMARY =
  '场景盘点已完成，等待用户选择智能分析深钻范围。';

function isSelectionPreviewReport(report: SceneReport): boolean {
  return report.phase === 'selection_preview' || (
    report.jobs.length === 0 &&
    report.summary === LEGACY_SMART_SELECTION_PREVIEW_SUMMARY
  );
}

function projectedReportSummary(
  report: SceneReport,
  outputLanguage: OutputLanguage,
): string | null {
  if (isSelectionPreviewReport(report)) {
    return localize(
      outputLanguage,
      LEGACY_SMART_SELECTION_PREVIEW_SUMMARY,
      'Scene inventory complete; awaiting a deep-dive selection.',
    );
  }
  const localizedSummary = report.summaries?.[outputLanguage];
  if (localizedSummary) return localizedSummary;
  if (!report.summary) return null;
  return outputLanguage === 'zh-CN'
    ? report.summary
    : `Scene analysis completed for ${report.displayedScenes.length} ${report.displayedScenes.length === 1 ? 'scene' : 'scenes'}.`;
}

/** Locale-specific presentation copy over a language-neutral cached report. */
export function projectSceneReport(
  report: SceneReport,
  outputLanguage: OutputLanguage,
): SceneReport {
  if (report.generatedBy.pipelineVersion === 'v3') {
    if (!report.sceneTimeline) throw new Error('scene_report_canonical_missing');
    return projectSceneTimelineReport(report as SceneTimelineReport | SceneTimelineReportView, outputLanguage);
  }
  return {
    ...report,
    summary: projectedReportSummary(report, outputLanguage),
    insights: report.insights.map(insight =>
      insight.title === 'scene_story_summary'
        ? {...insight, body: projectedReportSummary(report, outputLanguage) ?? insight.body}
        : insight),
    displayedScenes: report.displayedScenes.map(scene =>
      projectDisplayedScene(scene, outputLanguage)),
    sceneVerification: projectSceneVerification(
      report.sceneVerification,
      outputLanguage,
    ),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal session shape sceneStoryService cares about. Concrete sessions
 * (SceneReconstructSession) extend this with many more fields, but we
 * intentionally only touch the ones we own.
 */
export interface SceneStorySession {
  sessionId: string;
  status: string;
  lastActivityAt: number;
  createdAt: number;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  scenes?: any[];
  trackEvents?: any[];
  error?: string;
  /** Set by sceneStoryService once Stage 4 finishes. */
  sceneStoryReport?: SceneReport;
}

export interface SceneStoryServiceDeps {
  /** Canonical v3 report/assessment archive; never shared with the v2 cache. */
  evidenceArchive?: SceneTimelineArchive;
  /** Per-session SSE broadcast (sessionId, update) → void. */
  broadcast: (sessionId: string, update: StreamingUpdate, runId?: string) => void;
  /** Session lookup. */
  getSession: (sessionId: string) => SceneStorySession | undefined;
  /** Return false when a late run no longer owns the parent session. */
  isRunCurrent?: (sessionId: string, runId?: string) => boolean;
  /** Wraps the static SkillExecutor.toDataEnvelopes for unit testability. */
  toEnvelopes?: (result: SkillExecutionResult, traceId: string) => DataEnvelope[];

  /** Disk cache for file-backed traces (sha256 → SceneReport, 7d TTL). */
  reportStore: SceneReportStore;
  /** Process-memory weak cache for external-RPC traces (no content hash). */
  memoryCache: SceneReportMemoryCache;
  /** Out-of-band storage for omitted Smart job rows. */
  jobArtifactStore?: SceneJobArtifactStore;
  /**
   * Compute the trace's content hash. Returns null when the trace has no
   * file backing it (external RPC). DI'd so tests can stub without a real
   * TraceProcessorService.
   */
  computeHash: (traceId: string) => Promise<string | null>;
  /**
   * Probe the trace duration in seconds for the preview endpoint. Returns 0
   * on any failure; callers feed that into the cost estimator which clamps
   * to MIN_EXPECTED_SCENES.
   */
  probeDuration: (traceId: string) => Promise<number>;
}

export interface SceneStoryStartArgs {
  sessionId: string;
  runId?: string;
  traceId: string;
  owner?: ResourceOwnerFields;
  /** Per-request SkillExecutor — must already have its registry loaded. */
  skillExecutor: SkillExecutor;
  options?: SceneStoryStartOptions;
}

export interface SceneStoryStartOptions {
  /** Presentation language for SSE projection; never stored in cache identity. */
  outputLanguage?: OutputLanguage;
  /** Override the analysis cap; defaults to a heuristic based on trace length. */
  analysisCap?: number;
  /** Skip cache lookup and run a fresh pipeline. */
  forceRefresh?: boolean;
  /** Route profile for Stage 2 route selection and cache isolation. */
  routeProfile?: SceneRouteProfile;
  /** Stop after Stage 1 and wait for the user to choose a Smart deep-dive scope. */
  previewOnly?: boolean;
  /** Optional Stage 2 scope chosen by the user. Defaults to all detected scenes. */
  selection?: SceneAnalysisSelection;
  /** Optional parent-session cancellation signal used by Smart Analysis Mode. */
  cancelToken?: SmartCancelToken;
  /** Optional LLM double-check for ambiguous Smart Stage1 scene reconstruction. */
  verifyWithLlm?: boolean;
}

/**
 * Result of `previewOnly`. When `cached` is set the front-end can short-cut
 * to "show me this report" without ever firing /scene-reconstruct.
 */
export interface SceneStoryPreviewResult {
  estimate: CostEstimate;
  cached: SceneReport | null;
  traceDurationSec: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SceneStoryService {
  private readonly runners: Map<string, SceneAnalysisJobRunner> = new Map();
  private readonly inProgress: Set<string> = new Set();
  private readonly toEnvelopes: (result: SkillExecutionResult, traceId: string) => DataEnvelope[];
  private readonly memoryReportById: Map<string, SceneReport> = new Map();

  /**
   * Concurrent-request dedupe: while a pipeline for an owner-scoped
   * `traceHash` is running, peer requests for the same owner + hash await the
   * in-flight promise instead of starting a duplicate pipeline. RPC traces
   * have no hash key, so duplicate concurrent requests there fall through and
   * run their own pipeline (rare and harmless).
   */
  private readonly pendingByHash: Map<string, Promise<SceneReport>> = new Map();

  constructor(private readonly deps: SceneStoryServiceDeps) {
    this.toEnvelopes = deps.toEnvelopes ?? ((result, traceId) => SkillExecutor.toDataEnvelopes(result, undefined, {
      traceId,
      traceSide: 'current',
    }));
  }

  /** Pure product adapter: the caller retains session and terminal publication ownership. */
  async acceptFinalizedTimeline(input: AcceptFinalizedTimelineInput): Promise<FinalizedTimelineReport> {
    if (!this.deps.evidenceArchive) throw new Error('scene_evidence_archive_not_configured');
    return acceptFinalizedSceneTimeline(this.deps.evidenceArchive, input);
  }

  /** Historical v3 read. The route must also authorize access to the report's trace. */
  async getFinalizedReport(ownerKey: string, reportId: string): Promise<SceneTimelineReportView | null> {
    if (!this.deps.evidenceArchive) return null;
    return loadFinalizedSceneReport(this.deps.evidenceArchive, ownerKey, reportId);
  }

  private runKey(sessionId: string, runId?: string): string {
    return runId ? `${sessionId}:${runId}` : sessionId;
  }

  private shouldApply(sessionId: string, runId?: string): boolean {
    return this.deps.isRunCurrent?.(sessionId, runId) ?? true;
  }

  private broadcast(sessionId: string, update: StreamingUpdate, runId?: string): void {
    if (!this.shouldApply(sessionId, runId)) return;
    this.deps.broadcast(sessionId, update, runId);
  }

  /**
   * Run the full Scene Story pipeline for a session. Resolves when the
   * pipeline reaches a terminal state (completed / failed / cancelled).
   *
   * Errors thrown inside the pipeline are caught and surfaced via SSE so
   * the caller does not need its own try/catch (the route handler still
   * wraps it for safety).
   */
  async start(args: SceneStoryStartArgs): Promise<SceneReport | null> {
    const { sessionId, runId, traceId, skillExecutor, options } = args;
    const runKey = this.runKey(sessionId, runId);
    const forceRefresh = options?.forceRefresh ?? false;
    const routeProfile = options?.routeProfile ?? 'legacy';
    const previewOnly = options?.previewOnly === true;
    const selection = options?.selection ?? { scope: 'all' as const };
    const outputLanguage = options?.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
    const cacheableByHash = !previewOnly && selection.scope === 'all';
    const session = this.deps.getSession(sessionId);
    if (!session) {
      throw new Error(`SceneStoryService.start: session ${sessionId} not found`);
    }
    if (this.inProgress.has(runKey)) {
      throw new Error(`SceneStoryService.start: session ${sessionId} run ${runId ?? 'default'} is already running`);
    }

    this.inProgress.add(runKey);
    if (this.shouldApply(sessionId, runId)) {
      session.status = 'running';
      session.lastActivityAt = Date.now();
    }

    let scenes: DisplayedScene[] = [];
    let intervals: AnalysisInterval[] = [];
    let sceneVerification: SceneReconstructionVerification | undefined;
    let runner: SceneAnalysisJobRunner | undefined;
    let traceDurationSec = 0;
    let pipelineError: Error | undefined;
    let traceHash: string | null = null;
    let pendingKeyToDelete: string | null = null;
    let resolvePending: ((r: SceneReport) => void) | undefined;
    let rejectPending: ((err: unknown) => void) | undefined;

    try {
      // ── Cache check ─────────────────────────────────────────────────────
      // Done before any expensive work so a returning user gets a sub-second
      // response on the same trace. Hashing reads the file (~5-10s for 1GB);
      // RPC traces skip the hash and check the memory cache by traceId.
      traceHash = await this.deps.computeHash(traceId);
      options?.cancelToken?.throwIfAborted();

      if (cacheableByHash && !forceRefresh) {
        // Disk (by hash) or memory (by traceId) cache lookup.
        const cached = await this.lookupCachedReport(traceHash, traceId, routeProfile, args.owner);
        if (cached) {
          this.emitCachedReport(sessionId, session, cached, runId, outputLanguage);
          return cached;
        }
      }

      // 3) In-flight pipeline dedupe — only file-backed traces have a hash
      // key, so concurrent RPC requests fall through and run independently.
      const pendingKey = traceHash
        ? buildOwnerScopedCacheKey(traceHash, routeProfile, args.owner)
        : null;
      if (cacheableByHash && pendingKey && !forceRefresh) {
        const inFlight = this.pendingByHash.get(pendingKey);
        if (inFlight) {
          const shared = await inFlight;
          this.emitCachedReport(sessionId, session, shared, runId, outputLanguage);
          return shared;
        }
        // Register a deferred promise so peer requests can wait on us.
        const pending = new Promise<SceneReport>((res, rej) => {
          resolvePending = res;
          rejectPending = rej;
        });
        this.pendingByHash.set(pendingKey, pending);
        pendingKeyToDelete = pendingKey;
        // Swallow unhandled-rejection — peer awaiters that come and go later
        // will see the rejection through their own await.
        pending.catch(() => undefined);
      }

      this.broadcast(sessionId, {
        type: 'progress',
        content: {
          phase: 'detecting',
          message: localize(outputLanguage, '场景检测中', 'Detecting scenes'),
        },
        timestamp: Date.now(),
      }, runId);

      // ── Stage 1: scene_reconstruction skill ──────────────────────────────
      // We also capture each envelope into a local array so the finalised
      // SceneReport can persist them for cache-hit replay; without this,
      // re-opening a cached trace would lose the lane-overlay state.
      options?.cancelToken?.throwIfAborted();
      const stage1Envelopes: DataEnvelope[] = [];
      const stage1 = await new SceneStage1Runner({
        execute: (skillId, tid, params) => skillExecutor.execute(skillId, tid, params),
        toEnvelopes: this.toEnvelopes,
      }).run(traceId, (env) => {
        stage1Envelopes.push(env);
        // Forward each envelope as a `data` SSE event so the existing
        // track_overlay frontend code keeps populating state lanes.
        this.broadcast(sessionId, {
          type: 'data',
          content: env,
          timestamp: Date.now(),
        }, runId);
      });

      scenes = stage1.scenes;
      traceDurationSec = stage1.traceDurationSec;
      sceneVerification = await runSceneStage1Verifier({
        scenes,
        traceDurationSec,
        traceBounds: stage1.traceBounds,
        inputCoverage: stage1.inputCoverage,
        enableLlm: routeProfile === 'smart' && options?.verifyWithLlm === true,
      });
      options?.cancelToken?.throwIfAborted();
      const cap = args.options?.analysisCap ??
        estimateSceneStoryCost({ traceDurationSec }).expectedScenes;
      const candidateIntervals = buildAnalysisIntervals(scenes, { cap, routeProfile });
      const selectedScenes = previewOnly
        ? []
        : selectAnalysisEligibleScenes(scenes, selection);
      intervals = previewOnly
        ? []
        : buildAnalysisIntervals(selectedScenes, { cap, routeProfile });
      if (routeProfile === 'smart') {
        this.broadcast(sessionId, {
          type: 'scene_story_smart_eta_refined',
          content: {
            etaSec: estimateSmartEtaSec(previewOnly ? candidateIntervals.length : intervals.length),
            etaConfidence: 'medium',
            expectedDeepDives: previewOnly ? candidateIntervals.length : intervals.length,
            selectionMode: previewOnly ? 'selection_required' : selection.scope,
            selectedSceneCount: selectedScenes.length,
          },
          timestamp: Date.now(),
        }, runId);
      }

      // Mark which scenes were selected for analysis.
      const selectedSceneIds = new Set(intervals.map((i) => i.displayedSceneId));
      for (const scene of scenes) {
        if (selectedSceneIds.has(scene.id)) {
          scene.analysisState = 'queued';
        }
      }

      // Sync to legacy session.scenes / session.trackEvents so the legacy
      // frontend that listens to `track_data` keeps working until C5 lands.
      const presentedScenes = scenes.map(scene =>
        projectDisplayedScene(scene, outputLanguage));
      if (this.shouldApply(sessionId, runId)) {
        session.scenes = presentedScenes.map(toLegacySceneShape);
        session.trackEvents = presentedScenes.map(toLegacyTrackEventShape);
      }

      this.broadcast(sessionId, {
        type: 'scene_story_detected',
        content: {
          scenes: presentedScenes,
          analysisIntervals: intervals.length,
          candidateIntervals: candidateIntervals.length,
          sceneVerification: projectSceneVerification(
            sceneVerification,
            outputLanguage,
          ),
          previewOnly,
        },
        timestamp: Date.now(),
      }, runId);

      // Legacy `track_data` event for the rollout period.
      this.broadcast(sessionId, {
        type: 'track_data',
        content: { tracks: session.trackEvents, scenes: session.scenes },
        timestamp: Date.now(),
      }, runId);

      if (previewOnly) {
        const previewReport = this.finalizeSelectionPreview({
          sessionId,
          runId,
          traceId,
          session,
          scenes,
          traceDurationSec,
          traceHash,
          stage1Envelopes,
          routeProfile,
          candidateIntervalCount: candidateIntervals.length,
          sceneVerification,
          outputLanguage,
        });
        return previewReport;
      }

      // Skip Stage 2 entirely if nothing matched a route.
      if (intervals.length === 0) {
        options?.cancelToken?.throwIfAborted();
        const emptyReport = await this.finalize({
          sessionId,
          runId,
          traceId,
          session,
          scenes,
          jobs: [],
          summary: null,
          cancelled: false,
          traceDurationSec,
          traceHash,
          stage1Envelopes,
          routeProfile,
          cacheableByHash,
          sceneVerification,
          outputLanguage,
        });
        resolvePending?.(emptyReport);
        return emptyReport;
      }

      // ── Stage 2: per-interval Agent deep-dive ────────────────────────────
      options?.cancelToken?.throwIfAborted();
      runner = new SceneAnalysisJobRunner({
        concurrency: sceneStoryConfig.analysisConcurrency,
        maxRetries: sceneStoryConfig.jobMaxRetries,
        traceId,
        analysisId: sessionId,
        skillExecutor,
        runExecution: routeProfile === 'smart'
          ? (fn) => runWithSmartTraceSqlSemaphore(traceId, fn)
          : undefined,
        toDataEnvelopes: routeProfile === 'smart'
          ? (result, tid) => this.toEnvelopes(result as SkillExecutionResult, tid)
          : undefined,
        onEvent: (event) => this.handleJobEvent(sessionId, runId, scenes, event),
      });
      this.runners.set(runKey, runner);

      runner.enqueue(intervals);
      await runner.waitForAllDone();

      const jobs = runner.getJobs();
      const cancelled = runner.isCancelled();
      options?.cancelToken?.throwIfAborted();

      // ── Stage 3: cross-scene narrative summary ──────────────────────────
      let summary: string | null = null;
      let summaries: Stage3LocalizedSummaries | undefined;
      if (!cancelled) {
        this.broadcast(sessionId, {
          type: 'progress',
          content: {
            phase: 'summarizing',
            message: localize(
              outputLanguage,
              '生成整体叙述',
              'Building the overall narrative',
            ),
          },
          timestamp: Date.now(),
        }, runId);
        options?.cancelToken?.throwIfAborted();
        summaries = await runStage3Summary({ scenes, jobs }) ?? undefined;
        summary = summaries?.['zh-CN'] ?? null;
      }

      // ── Stage 4: finalise + persist ──────────────────────────────────────
      options?.cancelToken?.throwIfAborted();
      const finalReport = await this.finalize({
        sessionId,
        runId,
        traceId,
        session,
        scenes,
        jobs,
        summary,
        summaries,
        cancelled,
        traceDurationSec,
        traceHash,
        stage1Envelopes,
        routeProfile,
        cacheableByHash,
        sceneVerification,
        outputLanguage,
      });
      resolvePending?.(finalReport);
      return finalReport;
    } catch (err) {
      pipelineError = err as Error;
      if (this.shouldApply(sessionId, runId)) {
        session.status = 'failed';
        session.error = pipelineError.message;
        this.broadcast(sessionId, {
          type: 'error',
          content: { message: pipelineError.message },
          timestamp: Date.now(),
        }, runId);
      }
      // Wake any peer requests that were awaiting this hash so they propagate
      // the same failure on their own SSE channels (instead of hanging).
      rejectPending?.(pipelineError);
      return null;
    } finally {
      if (pendingKeyToDelete) this.pendingByHash.delete(pendingKeyToDelete);
      this.runners.delete(runKey);
      this.inProgress.delete(runKey);
    }
  }

  /**
   * Request cancellation of an in-flight scene story run. The pipeline keeps
   * running until its in-flight jobs settle, then transitions to 'cancelled'
   * and emits the terminal events itself — callers do not need to wait.
   *
   * Returns true when a runner was found and cancelled; false otherwise
   * (already settled or never started).
   */
  cancel(sessionId: string, runId?: string): boolean {
    const runner = this.runners.get(this.runKey(sessionId, runId));
    if (!runner) return false;

    runner.cancel();
    // Session-scope cancel — distinct from per-job cancel which uses
    // scope: 'job'. Frontend dispatchers must inspect content.scope.
    this.broadcast(sessionId, {
      type: 'scene_story_cancelled',
      content: { scope: 'session', reason: 'user_requested', sessionId },
      timestamp: Date.now(),
    }, runId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private handleJobEvent(
    sessionId: string,
    runId: string | undefined,
    scenes: DisplayedScene[],
    event: JobRunnerEvent,
  ): void {
    if (!this.shouldApply(sessionId, runId)) return;
    if (event.type !== 'all_done' && 'job' in event && event.job) {
      const job = event.job;
      const scene = scenes.find((s) => s.id === job.interval.displayedSceneId);
      if (scene) {
        scene.analysisState = jobStateToAnalysisState(event.type) ?? scene.analysisState;
        scene.analysisJobId = job.jobId;
      }
    }

    const sseType = mapJobEventToSseType(event.type);
    if (!sseType) return;

    const content: any = {};
    // Mark every job-derived event explicitly so the frontend can tell
    // them apart from the session-level scene_story_cancelled emitted by
    // SceneStoryService.cancel().
    if (sseType === 'scene_story_cancelled') content.scope = 'job';
    if ('job' in event && event.job) {
      content.jobId = event.job.jobId;
      content.displayedSceneId = event.job.interval.displayedSceneId;
      content.skillId = event.job.interval.skillId;
      content.attempt = event.job.attempt;
      content.state = event.job.state;
    }
    if (event.type === 'job_completed' && event.result) {
      content.result = {
        durationMs: event.result.durationMs,
        displayResultCount: event.result.displayResults.length,
      };
    }
    if (event.type === 'job_failed' || event.type === 'job_retrying') {
      content.error = event.error;
    }

    this.broadcast(sessionId, {
      type: sseType,
      content,
      timestamp: Date.now(),
    }, runId);
  }

  private async finalize(args: {
    sessionId: string;
    runId?: string;
    traceId: string;
    session: SceneStorySession;
    scenes: DisplayedScene[];
    jobs: SceneAnalysisJob[];
    summary: string | null;
    summaries?: Stage3LocalizedSummaries;
    cancelled: boolean;
    traceDurationSec: number;
    /** sha256 of trace content; null for external RPC traces. */
    traceHash: string | null;
    /** Stage1 envelopes captured during the cold run, for cache-hit replay. */
    stage1Envelopes: DataEnvelope[];
    routeProfile: SceneRouteProfile;
    cacheableByHash: boolean;
    sceneVerification?: SceneReconstructionVerification;
    outputLanguage: OutputLanguage;
  }): Promise<SceneReport> {
    const jobs = args.routeProfile === 'smart'
      ? await attachSmartJobArtifactRefs({
        traceId: args.traceId,
        jobs: args.jobs,
        artifactStore: this.deps.jobArtifactStore,
      })
      : args.jobs;

    const report = buildSceneReport({
      analysisId: args.sessionId,
      traceId: args.traceId,
      tenantId: args.session.tenantId,
      workspaceId: args.session.workspaceId,
      userId: args.session.userId,
      createdAt: args.session.createdAt,
      scenes: args.scenes,
      jobs,
      summary: args.summary,
      summaries: args.summaries,
      cancelled: args.cancelled,
      traceDurationSec: args.traceDurationSec,
      traceHash: args.traceHash,
      stage1Envelopes: args.stage1Envelopes,
      routeProfile: args.routeProfile,
      sceneVerification: args.sceneVerification,
      phase: 'analyzed',
    });

    if (!this.shouldApply(args.sessionId, args.runId)) {
      return report;
    }

    if (this.shouldApply(args.sessionId, args.runId)) {
      args.session.sceneStoryReport = report;
      args.session.status = args.cancelled ? 'cancelled' : 'completed';
      args.session.lastActivityAt = Date.now();
    }

    // Persist BEFORE broadcasting scene_story_report_ready so any client
    // that immediately calls GET /scene-reconstruct/report/:id is guaranteed
    // to find the report rather than racing the disk write.
    await this.persistReport(report, args.traceId, args.routeProfile, {
      indexByHash: args.cacheableByHash,
    });

    this.broadcast(args.sessionId, {
      type: 'scene_story_report_ready',
      content: {
        reportId: report.reportId,
        partial: report.partialReport,
        summary: projectedReportSummary(report, args.outputLanguage),
        sceneCount: report.displayedScenes.length,
        jobCount: report.jobs.length,
      },
      timestamp: Date.now(),
    }, args.runId);

    // Final progress event so the legacy frontend has a clean terminal signal.
    this.broadcast(args.sessionId, {
      type: 'progress',
      content: {
        phase: args.cancelled ? 'cancelled' : 'completed',
        message: args.cancelled
          ? localize(args.outputLanguage, '场景还原已取消', 'Scene reconstruction cancelled')
          : localize(args.outputLanguage, '场景还原完成', 'Scene reconstruction completed'),
      },
      timestamp: Date.now(),
    }, args.runId);

    return report;
  }

  private finalizeSelectionPreview(args: {
    sessionId: string;
    runId?: string;
    traceId: string;
    session: SceneStorySession;
    scenes: DisplayedScene[];
    traceDurationSec: number;
    traceHash: string | null;
    stage1Envelopes: DataEnvelope[];
    routeProfile: SceneRouteProfile;
    candidateIntervalCount: number;
    sceneVerification?: SceneReconstructionVerification;
    outputLanguage: OutputLanguage;
  }): SceneReport {
    const report = buildSceneReport({
      analysisId: args.sessionId,
      traceId: args.traceId,
      tenantId: args.session.tenantId,
      workspaceId: args.session.workspaceId,
      userId: args.session.userId,
      createdAt: args.session.createdAt,
      scenes: args.scenes,
      jobs: [],
      summary: null,
      cancelled: false,
      traceDurationSec: args.traceDurationSec,
      traceHash: args.traceHash,
      stage1Envelopes: args.stage1Envelopes,
      routeProfile: args.routeProfile,
      sceneVerification: args.sceneVerification,
      phase: 'selection_preview',
    });

    if (!this.shouldApply(args.sessionId, args.runId)) {
      return report;
    }

    if (this.shouldApply(args.sessionId, args.runId)) {
      args.session.sceneStoryReport = report;
      args.session.status = 'completed';
      args.session.lastActivityAt = Date.now();
    }
    this.memoryReportById.set(report.reportId, report);

    this.broadcast(args.sessionId, {
      type: 'scene_story_selection_ready',
      content: {
        sceneCount: report.displayedScenes.length,
        candidateIntervalCount: args.candidateIntervalCount,
        sceneTypeCounts: countSceneTypes(report.displayedScenes),
        reportId: report.reportId,
        sceneVerification: projectSceneVerification(
          report.sceneVerification,
          args.outputLanguage,
        ),
      },
      timestamp: Date.now(),
    }, args.runId);

    this.broadcast(args.sessionId, {
      type: 'progress',
      content: {
        phase: 'selection_ready',
        message: localize(
          args.outputLanguage,
          '场景盘点完成，请选择智能分析范围',
          'Scene inventory complete. Choose a deep-dive scope.',
        ),
      },
      timestamp: Date.now(),
    }, args.runId);

    return report;
  }

  /**
   * Persist a finalised SceneReport to whichever cache layer matches the
   * trace's origin. File-backed traces go into the disk store with the
   * configured TTL; external RPC traces fall into the in-memory LRU keyed
   * by traceId.
   *
   * Errors propagate. The contract that `scene_story_report_ready` only
   * fires after a successful persist depends on this — silently swallowing
   * a save failure would let peer requests get a `reportId` they can't
   * subsequently load via `GET /scene-reconstruct/report/:id`.
   */
  private async persistReport(
    report: SceneReport,
    traceId: string,
    routeProfile: SceneRouteProfile,
    options: { indexByHash?: boolean } = {},
  ): Promise<void> {
    if (report.traceOrigin === 'file' && report.traceHash) {
      await this.deps.reportStore.save(report, routeProfile, {
        indexByHash: options.indexByHash !== false,
      });
      this.memoryReportById.set(report.reportId, report);
    } else {
      if (options.indexByHash !== false) {
        this.deps.memoryCache.set(traceId, report, routeProfile);
      }
      this.memoryReportById.set(report.reportId, report);
    }
  }

  /**
   * Replay a cached SceneReport on a new session's SSE channel. Used by both
   * the disk-cache and memory-cache hit paths and by peer-request dedupe
   * after awaiting a sibling pipeline.
   *
   * The emitted event sequence collapses Stage 1/2/3 into a single
   * scene_story_report_ready terminal:
   *   progress {phase:'cached'}
   *   → scene_story_detected
   *   → track_data (legacy)
   *   → scene_story_report_ready
   *   → progress {phase:'completed'}
   *
   * Frontend story_controller already treats scene_story_report_ready as
   * terminal, so this fast path renders correctly without any extra
   * frontend changes.
   */
  private emitCachedReport(
    sessionId: string,
    session: SceneStorySession,
    report: SceneReport,
    runId?: string,
    outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
  ): void {
    const now = Date.now();
    const presentedScenes = report.displayedScenes.map(scene =>
      projectDisplayedScene(scene, outputLanguage));
    if (this.shouldApply(sessionId, runId)) {
      session.sceneStoryReport = report;
      session.scenes = presentedScenes.map(toLegacySceneShape);
      session.trackEvents = presentedScenes.map(toLegacyTrackEventShape);
      session.status = 'completed';
      session.lastActivityAt = now;
    }

    this.broadcast(sessionId, {
      type: 'progress',
      content: {
        phase: 'cached',
        message: localize(
          outputLanguage,
          '已命中缓存，加载历史报告',
          'Loading the cached scene report',
        ),
      },
      timestamp: now,
    }, runId);

    // Replay Stage1 DataEnvelopes so lane overlays / state-timeline tracks
    // render the same way they would on a cold run. Without this, cache hits
    // would show the scene list but no lane overlays.
    for (const env of report.cachedDataEnvelopes) {
      this.broadcast(sessionId, {
        type: 'data',
        content: env,
        timestamp: now,
      }, runId);
    }

    this.broadcast(sessionId, {
      type: 'scene_story_detected',
      content: {
        scenes: presentedScenes,
        analysisIntervals: report.jobs.length,
        sceneVerification: projectSceneVerification(
          report.sceneVerification,
          outputLanguage,
        ),
        previewOnly: isSelectionPreviewReport(report),
      },
      timestamp: now,
    }, runId);

    // Legacy track_data so the existing track_overlay code keeps painting
    // lanes for cache hits as well.
    this.broadcast(sessionId, {
      type: 'track_data',
      content: { tracks: session.trackEvents, scenes: session.scenes },
      timestamp: now,
    }, runId);

    this.broadcast(sessionId, {
      type: 'scene_story_report_ready',
      content: {
        reportId: report.reportId,
        partial: report.partialReport,
        summary: projectedReportSummary(report, outputLanguage),
        sceneCount: report.displayedScenes.length,
        jobCount: report.jobs.length,
        cached: true,
      },
      timestamp: now,
    }, runId);

    this.broadcast(sessionId, {
      type: 'progress',
      content: {
        phase: 'completed',
        message: localize(
          outputLanguage,
          '场景还原完成（缓存）',
          'Scene reconstruction completed (cached)',
        ),
      },
      timestamp: now,
    }, runId);
  }

  // -------------------------------------------------------------------------
  // Public preview / report endpoints
  // -------------------------------------------------------------------------

  /**
   * Cheap preview for the /scene-reconstruct/preview endpoint. Computes the
   * trace's content hash, checks both cache layers, and falls through to a
   * formula-based ETA + USD estimate. Never starts the heavy pipeline.
   *
   * Latency profile:
   *   - cached + file-backed: hash + index lookup (~10s for 1GB; <100ms for small)
   *   - cached + RPC: O(1) Map lookup
   *   - cold:        hash + trace_bounds SQL probe (~50ms)
   */
  async previewOnly(args: {
    traceId: string;
    owner?: ResourceOwnerFields;
    routeProfile?: SceneRouteProfile;
  }): Promise<SceneStoryPreviewResult> {
    const { traceId, owner } = args;
    const routeProfile = args.routeProfile ?? 'legacy';

    // Hash and probe are independent — run in parallel. Hash dominates for
    // large files (5-10s for 1GB), probe is ~50ms. Parallelising cuts cold
    // preview latency from `hash + probe` to `max(hash, probe)`.
    const [hash, probedDurationSec] = await Promise.all([
      this.deps.computeHash(traceId),
      this.deps.probeDuration(traceId),
    ]);

    const cached = await this.lookupCachedReport(hash, traceId, routeProfile, owner);
    if (cached) {
      const dur = cached.traceMeta.durationSec;
      return {
        estimate: estimateSceneStoryCost({ traceDurationSec: dur }),
        cached,
        traceDurationSec: dur,
      };
    }

    return {
      estimate: estimateSceneStoryCost({ traceDurationSec: probedDurationSec }),
      cached: null,
      traceDurationSec: probedDurationSec,
    };
  }

  /**
   * GET /scene-reconstruct/report/:reportId — direct lookup by reportId.
   * Returns null if the report has been evicted (TTL expired) or never
   * existed; the route handler maps null to a 404.
   */
  async getReport(reportId: string): Promise<SceneReport | null> {
    const persisted = await this.deps.reportStore.loadById(reportId);
    if (persisted) return persisted;
    const memory = this.memoryReportById.get(reportId) ?? null;
    if (memory && memory.expiresAt !== null && memory.expiresAt < Date.now()) {
      this.memoryReportById.delete(reportId);
      return null;
    }
    return memory;
  }

  /**
   * Unified cache lookup: file-backed traces go via the disk store by hash;
   * external RPC traces go via the in-memory LRU by traceId. Used by both
   * start() (cache check) and previewOnly() so the lookup strategy is
   * defined in exactly one place.
   */
  private async lookupCachedReport(
    hash: string | null,
    traceId: string,
    routeProfile: SceneRouteProfile,
    owner?: ResourceOwnerFields,
  ): Promise<SceneReport | null> {
    const report = hash
      ? await this.deps.reportStore.loadByHash(hash, routeProfile)
      : this.deps.memoryCache.get(traceId, routeProfile) ?? null;
    if (!report) return null;
    return owner ? (ownersMatch(report, owner) ? report : null) : report;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOwnerScopedCacheKey(
  hash: string,
  routeProfile: SceneRouteProfile,
  owner?: ResourceOwnerFields,
): string {
  if (!owner) return `${hash}:${routeProfile}:legacy-owner`;
  return `${hash}:${routeProfile}:${owner.tenantId || ''}:${owner.workspaceId || ''}:${owner.userId || owner.ownerUserId || ''}`;
}

function countSceneTypes(scenes: DisplayedScene[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const scene of scenes) {
    counts[scene.sceneType] = (counts[scene.sceneType] || 0) + 1;
  }
  return counts;
}

function jobStateToAnalysisState(
  jobEventType: JobRunnerEvent['type'],
): DisplayedSceneAnalysisState | null {
  switch (jobEventType) {
    case 'job_queued':    return 'queued';
    case 'job_started':   return 'running';
    case 'job_completed': return 'completed';
    case 'job_failed':    return 'failed';
    case 'job_cancelled': return 'cancelled';
    case 'job_dropped':   return 'dropped';
    default: return null;
  }
}

function mapJobEventToSseType(
  type: JobRunnerEvent['type'],
): StreamingUpdate['type'] | null {
  switch (type) {
    case 'job_queued':    return 'scene_story_queued';
    case 'job_started':   return 'scene_story_started';
    case 'job_retrying':  return 'scene_story_retrying';
    case 'job_completed': return 'scene_story_completed';
    case 'job_failed':    return 'scene_story_failed';
    case 'job_cancelled': return 'scene_story_cancelled';
    case 'job_dropped':   return 'scene_story_dropped';
    default: return null;
  }
}

async function attachSmartJobArtifactRefs(args: {
  traceId: string;
  jobs: SceneAnalysisJob[];
  artifactStore?: SceneJobArtifactStore;
}): Promise<SceneAnalysisJob[]> {
  if (!args.artifactStore) return args.jobs;

  const out: SceneAnalysisJob[] = [];
  for (const job of args.jobs) {
    const result = job.result;
    const projection = result?.projection;
    if (
      !result ||
      !projection ||
      projection.omittedRowCount <= 0 ||
      projection.artifactRef
    ) {
      out.push(job);
      continue;
    }

    const artifactRef = await args.artifactStore.save({
      traceId: args.traceId,
      jobId: job.jobId,
      displayedSceneId: result.displayedSceneId,
      skillId: result.skillId,
      displayResults: result.displayResults,
      dataEnvelopes: result.dataEnvelopes,
      createdAt: Date.now(),
    });

    out.push({
      ...job,
      result: {
        ...result,
        projection: {
          ...projection,
          artifactRef,
        },
      },
    });
  }

  return out;
}

function buildSceneReport(args: {
  analysisId: string;
  traceId: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  createdAt: number;
  scenes: DisplayedScene[];
  jobs: SceneAnalysisJob[];
  summary: string | null;
  summaries?: Stage3LocalizedSummaries;
  cancelled: boolean;
  traceDurationSec: number;
  /** sha256 of trace content; null for external RPC traces. */
  traceHash: string | null;
  /** Stage1 envelopes captured during cold run, persisted for cache replay. */
  stage1Envelopes: DataEnvelope[];
  routeProfile: SceneRouteProfile;
  sceneVerification?: SceneReconstructionVerification;
  phase?: SceneReport['phase'];
}): SceneReport {
  const failedCount = args.jobs.filter((j) => j.state === 'failed').length;
  const partial = args.cancelled || failedCount > 0 ||
    args.sceneVerification?.status === 'needs_review' || args.sceneVerification?.status === 'failed';
  const totalDurationMs = Date.now() - args.createdAt;

  const insights: SceneInsight[] = [];
  if (args.summary && args.scenes.length > 0) {
    insights.push({
      title: 'scene_story_summary',
      body: args.summary,
      relatedDisplayedSceneIds: args.scenes.map((s) => s.id),
    });
  }

  // Hash presence is the source of truth for the trace's origin: a file
  // we can read deterministically (and hence cache by content) vs an
  // ephemeral external RPC connection that resets when the backend
  // restarts.
  const isFileBacked = args.traceHash !== null;
  const traceOrigin: SceneReport['traceOrigin'] = isFileBacked ? 'file' : 'external_rpc';
  const cachePolicy: SceneReport['cachePolicy'] = isFileBacked
    ? 'disk_7d'
    : 'memory_session';
  const expiresAt: number | null = isFileBacked
    ? Date.now() + sceneStoryConfig.reportTtlMs
    : null;

  return {
    reportId: uuidv4(),
    tenantId: args.tenantId,
    workspaceId: args.workspaceId,
    userId: args.userId,
    traceHash: args.traceHash,
    traceId: args.traceId,
    traceOrigin,
    cachePolicy,
    expiresAt,
    createdAt: args.createdAt,
    phase: args.phase,
    traceMeta: { durationSec: args.traceDurationSec },
    displayedScenes: args.scenes,
    sceneVerification: args.sceneVerification,
    cachedDataEnvelopes: args.stage1Envelopes,
    jobs: args.routeProfile === 'smart'
      ? args.jobs.map(sanitizeSmartReportJob)
      : args.jobs,
    summary: args.summary,
    summaries: args.summaries,
    insights,
    partialReport: partial,
    totalDurationMs,
    generatedBy: {
      runtime: 'claude-sdk',
      pipelineVersion: 'v2',
    },
  };
}

function sanitizeSmartReportJob(job: SceneAnalysisJob): SceneAnalysisJob {
  if (!job.result) return job;
  return {
    ...job,
    result: {
      ...job.result,
      displayResults: [],
      dataEnvelopes: [],
    },
  };
}

function estimateSmartEtaSec(intervalCount: number): number {
  if (intervalCount <= 0) return 3;
  return Math.max(10, Math.ceil(intervalCount * 12));
}

// ---------------------------------------------------------------------------
// Legacy session shape conversion
// ---------------------------------------------------------------------------

/**
 * Convert a DisplayedScene to the loose shape that legacy frontend code
 * expects on session.scenes (uses `type` and `appPackage` field names).
 * The frontend's session.scenes is `any[]`, so a structural shim is enough.
 */
function toLegacySceneShape(scene: DisplayedScene): Record<string, any> {
  return {
    id: scene.id,
    type: scene.sceneType,
    sceneType: scene.sceneType,
    sourceStepId: scene.sourceStepId,
    startTs: scene.startTs,
    endTs: scene.endTs,
    durationMs: scene.durationMs,
    appPackage: scene.processName,
    metadata: scene.metadata,
    severity: scene.severity,
  };
}

function toLegacyTrackEventShape(scene: DisplayedScene): Record<string, any> {
  return {
    id: scene.id,
    type: scene.sceneType,
    label: scene.label,
    startTs: scene.startTs,
    endTs: scene.endTs,
    durationMs: scene.durationMs,
    processName: scene.processName,
  };
}
