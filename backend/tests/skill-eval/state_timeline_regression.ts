/**
 * State Timeline Regression
 *
 * Validates the state_timeline composite skill (V2) across canonical traces:
 * 1) All 4 lanes produce data or gracefully degrade
 * 2) Legacy input lane paths consume the same normalized input facts
 * 3) system_state_lane produces non-overlapping segments (sweep-line)
 * 4) lane_summary source_status matches actual data availability
 * 5) Missing actions remain visible; unsupported fling boundaries are explicit
 */

import { createSkillEvaluator, getTestTracePath, findStepInLayers } from './runner';

type TimelineCase = {
  file: string;
  label: string;
  /** Which input step should run? 'frames' | 'fallback' | 'either' | 'none' */
  expectedInputPath: 'frames' | 'fallback' | 'either' | 'none';
  /** Lanes expected to have real data (not all UNKNOWN/IDLE) */
  expectedLanes: string[];
  /** Lanes expected to be table_missing in lane_summary */
  expectedMissing?: string[];
};

const TRACE_CASES: TimelineCase[] = [
  // ── Launch traces (2) ──
  {
    file: 'lacunh_heavy.pftrace',
    label: '重度启动 — 状态时间线',
    expectedInputPath: 'either',
    expectedLanes: ['system_state_lane'],
  },
  {
    file: 'launch_light.pftrace',
    label: '轻度启动 — 状态时间线',
    expectedInputPath: 'either',
    expectedLanes: ['system_state_lane'],
  },
  // ── Scroll traces (4) ──
  {
    file: 'scroll_Standard-AOSP-App-Without-PreAnimation.pftrace',
    label: '标准滑动 — 状态时间线',
    expectedInputPath: 'either',
    expectedLanes: ['system_state_lane'],
  },
  {
    file: 'scroll-demo-customer-scroll.pftrace',
    label: '客户场景滑动 — 状态时间线',
    expectedInputPath: 'either',
    expectedLanes: ['system_state_lane'],
  },
  {
    file: 'Scroll-Flutter-327-TextureView.pftrace',
    label: 'Flutter TextureView — 状态时间线',
    expectedInputPath: 'either',
    expectedLanes: ['system_state_lane'],
  },
  {
    file: 'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace',
    label: 'Flutter SurfaceView — 状态时间线',
    expectedInputPath: 'either',
    expectedLanes: ['system_state_lane'],
  },
];

const findStep = findStepInLayers;

/** Check that system lane segments don't overlap */
function checkNoOverlap(segments: any[]): string | null {
  if (segments.length < 2) return null;

  // Sort by start_ts
  const sorted = [...segments]
    .filter((s) => s.state !== 'UNKNOWN')
    .sort((a, b) => {
      const aTs = BigInt(a.start_ts || '0');
      const bTs = BigInt(b.start_ts || '0');
      return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
    });

  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = BigInt(sorted[i - 1].end_ts || '0');
    const currStart = BigInt(sorted[i].start_ts || '0');
    if (currStart < prevEnd) {
      return (
        `overlap: segment[${i - 1}] ${sorted[i - 1].state} ends at ${sorted[i - 1].end_ts} ` +
        `but segment[${i}] ${sorted[i].state} starts at ${sorted[i].start_ts}`
      );
    }
  }
  return null;
}

async function runCase(testCase: TimelineCase): Promise<void> {
  const evaluator = createSkillEvaluator('state_timeline');

  try {
    await evaluator.loadTrace(getTestTracePath(testCase.file));
    const result = await evaluator.executeSkill({ trace_id: `state_timeline_${testCase.file}` });

    if (!result.success) {
      throw new Error(`skill execution failed: ${result.error || 'unknown error'}`);
    }

    // ---- 1. Check lane_summary exists and has correct structure ----
    const summary = findStep(result.layers, 'lane_summary');
    if (!summary) throw new Error('lane_summary step missing');
    if (!summary.success) throw new Error(`lane_summary failed: ${summary.error}`);
    if (!Array.isArray(summary.data) || summary.data.length < 4) {
      throw new Error(`lane_summary should have 4 rows, got ${summary.data?.length || 0}`);
    }

    const summaryByLane: Record<string, string> = {};
    for (const row of summary.data) {
      summaryByLane[String(row.lane)] = String(row.source_status || '');
    }

    // Verify table_missing lanes
    for (const lane of testCase.expectedMissing || []) {
      if (summaryByLane[lane] !== 'table_missing') {
        throw new Error(`expected ${lane} to be table_missing, got ${summaryByLane[lane]}`);
      }
    }

    // ---- 2. Check input lane path selection ----
    const framesStep = findStep(result.layers, 'input_state_lane_frames');
    const fallbackStep = findStep(result.layers, 'input_state_lane_fallback');
    const hasFrames = framesStep?.success && Array.isArray(framesStep.data) && framesStep.data.length > 0;
    const hasFallback = fallbackStep?.success && Array.isArray(fallbackStep.data) && fallbackStep.data.length > 0;

    if (testCase.expectedInputPath === 'frames' && !hasFrames) {
      throw new Error('expected input_state_lane_frames but it has no data');
    }
    if (testCase.expectedInputPath === 'fallback' && !hasFallback) {
      throw new Error('expected input_state_lane_fallback but it has no data');
    }
    if (testCase.expectedInputPath === 'none' && (hasFrames || hasFallback)) {
      throw new Error('expected no input lane but one produced data');
    }

    // Mutual exclusivity: at most one should have data
    if (hasFrames && hasFallback) {
      throw new Error('both input_state_lane_frames and _fallback produced data — conditions not mutually exclusive');
    }

    // Verify lane_summary input status matches actual path
    const inputStatus = summaryByLane['input'] || '';
    if (hasFrames && inputStatus !== 'partial') {
      console.warn(`[WARN] input lane used frames but summary says ${inputStatus}`);
    }
    if (hasFallback && inputStatus !== 'partial') {
      console.warn(`[WARN] input lane used fallback but summary says ${inputStatus}`);
    }

    // ---- 3. Check expected lanes have data ----
    for (const stepId of testCase.expectedLanes) {
      const step = findStep(result.layers, stepId);
      if (!step) throw new Error(`expected step ${stepId} missing`);
      if (!step.success) throw new Error(`expected step ${stepId} failed: ${step.error}`);
      const count = Array.isArray(step.data) ? step.data.length : 0;
      if (count === 0) throw new Error(`expected step ${stepId} has 0 rows`);
    }

    // ---- 4. Check system_state_lane for no overlapping segments ----
    const systemStep = findStep(result.layers, 'system_state_lane');
    if (systemStep?.success && Array.isArray(systemStep.data) && systemStep.data.length > 0) {
      const overlapError = checkNoOverlap(systemStep.data);
      if (overlapError) {
        throw new Error(`system_state_lane ${overlapError}`);
      }
    }

    // ---- 5. Check input facts and capability limits ----
    const inputData = hasFrames ? framesStep!.data! : hasFallback ? fallbackStep!.data! : [];
    const coverage = findStep(result.layers, 'input_coverage')?.data?.[0];
    if (!coverage || coverage.source_status !== 'partial') {
      throw new Error('missing input collection/coverage status');
    }
    if (inputData.some((row: any) => row.state === 'IDLE')) {
      throw new Error('acknowledged input delivery absence cannot prove IDLE');
    }
    if (testCase.file === 'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace' &&
        !inputData.some((row: any) => row.state === 'INPUT_UNKNOWN' && row.event_count > 0)) {
      throw new Error('missing-action motion must remain visible as observed input activity');
    }
    if (inputData.some((row: any) => row.state === 'FLING') ||
        coverage.inertial_source_status !== 'inertial_boundary_unavailable') {
      throw new Error('input contacts/frames must not invent a verified fling interval');
    }

    // ---- Summary ----
    const deviceStep = findStep(result.layers, 'device_state_lane') || findStep(result.layers, 'device_state_lane_fallback');
    const appStep = findStep(result.layers, 'app_state_lane') || findStep(result.layers, 'app_state_lane_fallback');
    const inputPath = hasFrames ? 'frames' : hasFallback ? 'fallback' : 'none';
    const flingCount = inputData.filter((s: any) => s.state === 'FLING').length;

    console.log(
      `[PASS] ${testCase.label} | ` +
        `device=${deviceStep?.data?.length || 0}, ` +
        `input=${inputData.length}(${inputPath}), ` +
        `app=${appStep?.data?.length || 0}, ` +
        `system=${systemStep?.data?.length || 0}, ` +
        `flings=${flingCount}, ` +
        `status=${Object.entries(summaryByLane).map(([k, v]) => `${k}:${v}`).join(',')}`,
    );
  } finally {
    await evaluator.cleanup();
  }
}

async function main() {
  const failures: Array<{ trace: string; reason: string }> = [];

  for (const traceCase of TRACE_CASES) {
    try {
      await runCase(traceCase);
    } catch (error: any) {
      const reason = error?.message || String(error);
      failures.push({ trace: traceCase.file, reason });
      console.error(`[FAIL] ${traceCase.label} (${traceCase.file}) -> ${reason}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nState timeline regression failed:');
    for (const f of failures) {
      console.error(`- ${f.trace}: ${f.reason}`);
    }
    process.exit(1);
  }

  console.log('\nState timeline regression passed for all 6 traces.');
}

main().catch((error) => {
  console.error('[state_timeline_regression] fatal:', error);
  process.exit(1);
});
