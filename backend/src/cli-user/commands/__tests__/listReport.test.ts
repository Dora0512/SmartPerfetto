// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runListCommand } from '../list';
import { runReportCommand, runReportExportCommand } from '../report';
import {runShowCommand} from '../show';
import { computePaths, sessionPaths } from '../../io/paths';
import {
  writeConfig,
  writeConclusion,
  writeJsonFile,
  writeReportHtml,
  writeTurnMarkdown,
  writeTurnReportHtml,
} from '../../io/sessionStore';
import type { CliSessionConfig } from '../../types';
import {
  buildCliAnalysisEvidenceBundle,
  latestCliAnalysisEvidencePath,
  turnCliAnalysisEvidencePath,
} from '../../services/analysisResultPresentation';

describe('CLI list/report command messages', () => {
  const originalCwd = process.cwd();
  let tmpDir: string;
  let sessionDir: string;
  let envFile: string;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-messages-'));
    sessionDir = path.join(tmpDir, 'home');
    envFile = path.join(tmpDir, 'empty.env');
    fs.writeFileSync(envFile, '', 'utf-8');
  });

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('empty list recommends the formal run command', async () => {
    const exitCode = await runListCommand({
      envFile,
      sessionDir,
      json: false,
      noColor: true,
    });

    expect(exitCode).toBe(0);
    const message = String(consoleLogSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('smp run <trace> "question"');
    expect(message).not.toContain('smp -f');
  });

  test('missing report recommends valid follow-up commands', async () => {
    const sessionId = 'session-without-report';
    const paths = computePaths(sessionDir);
    writeConfig(sessionPaths(paths, sessionId), makeConfig(sessionId));

    const exitCode = await runReportCommand({
      envFile,
      sessionDir,
      sessionId,
      open: false,
    });

    expect(exitCode).toBe(1);
    const output = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(`smp ask ${sessionId} "retry report generation"`);
    expect(output).toContain('smp run <trace> "question"');
    expect(output).not.toContain('smp -f');
    expect(output).not.toContain('smp resume');
  });

  test('report --turn prints the immutable per-turn HTML snapshot', async () => {
    const sessionId = 'session-with-turn-report';
    const paths = computePaths(sessionDir);
    const sp = sessionPaths(paths, sessionId);
    writeConfig(sp, makeConfig(sessionId));
    writeReportHtml(sp, '<html>latest</html>');
    const turnReport = writeTurnReportHtml(sp, 1, '<html>turn 1</html>');

    const exitCode = await runReportCommand({
      envFile,
      sessionDir,
      sessionId,
      open: false,
      turn: 1,
    });

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(turnReport);
  });

  test('show and markdown exports render every matching evidence detail once', async () => {
    const sessionId = 'session-with-evidence';
    const paths = computePaths(sessionDir);
    const sp = sessionPaths(paths, sessionId);
    const config = {...makeConfig(sessionId), turnCount: 2};
    const conclusion = 'latest conclusion';
    const turnMarkdown = '# Turn 2\n\n## Conclusion\n\nlatest conclusion\n';
    writeConfig(sp, config);
    writeConclusion(sp, conclusion);
    writeTurnMarkdown(sp, 1, '# Turn 1\n\nolder body\n');
    writeTurnMarkdown(sp, 2, turnMarkdown);
    const result = evidenceResult(sessionId);
    const bundle = buildCliAnalysisEvidenceBundle({
      sessionId,
      turn: 2,
      conclusion,
      turnMarkdown,
      result,
      sourceProvenance: {
        sourceUseDecision: result.sourceUseDecision!,
        sourceClaimBindings: result.conclusionContract!.sourceClaimBindings!,
      },
    });
    writeJsonFile(sp, turnCliAnalysisEvidencePath(sp, 2), bundle);
    writeJsonFile(sp, latestCliAnalysisEvidencePath(sp), bundle);

    expect(await runShowCommand({envFile, sessionDir, sessionId, open: false})).toBe(0);
    const showOutput = consoleLogSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(showOutput.match(/## Evidence details|## 证据详情/g)).toHaveLength(1);
    expect(showOutput).toContain('issue-9');
    expect(showOutput).toContain('source-binding-21');
    expect(showOutput).toContain('declared-ref');

    const latestOut = path.join(tmpDir, 'latest.md');
    expect(await runReportExportCommand({envFile, sessionDir, sessionId, format: 'md', out: latestOut})).toBe(0);
    const latest = fs.readFileSync(latestOut, 'utf8');
    expect(latest.match(/## Evidence details|## 证据详情/g)).toHaveLength(1);
    expect(latest).toContain('issue-9');
    expect(latest).toContain('source-binding-21');

    const turnOut = path.join(tmpDir, 'turn.md');
    expect(await runReportExportCommand({envFile, sessionDir, sessionId, turn: 2, format: 'md', out: turnOut})).toBe(0);
    const turn = fs.readFileSync(turnOut, 'utf8');
    expect(turn.match(/## Evidence details|## 证据详情/g)).toHaveLength(1);
    expect(turn).toContain('issue-9');
    expect(turn).toContain('source-binding-21');
  });

  test('keeps conclusions visible but rejects malformed or cross-turn evidence', async () => {
    const sessionId = 'session-with-invalid-evidence';
    const paths = computePaths(sessionDir);
    const sp = sessionPaths(paths, sessionId);
    const config = {...makeConfig(sessionId), turnCount: 2};
    const conclusion = 'safe conclusion remains visible';
    const turnMarkdown = '# Turn 2\n\nsafe turn body\n';
    writeConfig(sp, config);
    writeConclusion(sp, conclusion);
    writeTurnMarkdown(sp, 2, turnMarkdown);
    fs.writeFileSync(latestCliAnalysisEvidencePath(sp), '{bad json', 'utf8');
    writeJsonFile(sp, turnCliAnalysisEvidencePath(sp, 2), buildCliAnalysisEvidenceBundle({
      sessionId,
      turn: 1,
      conclusion,
      turnMarkdown,
      result: evidenceResult(sessionId),
    }));
    writeJsonFile(sp, `${path.join(sp.turnsDir, '001')}.claim-verification.json`, {
      status: 'failed', issues: [{message: 'OTHER_TURN_CANARY'}],
    });

    expect(await runShowCommand({envFile, sessionDir, sessionId, open: false})).toBe(0);
    const showOutput = consoleLogSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(showOutput).toContain(conclusion);
    expect(showOutput).toMatch(/不可用|unavailable/);
    expect(showOutput).not.toContain('OTHER_TURN_CANARY');

    const turnOut = path.join(tmpDir, 'invalid-turn.md');
    expect(await runReportExportCommand({envFile, sessionDir, sessionId, turn: 2, format: 'md', out: turnOut})).toBe(0);
    const exported = fs.readFileSync(turnOut, 'utf8');
    expect(exported).toContain('safe turn body');
    expect(exported).toMatch(/不可用|unavailable/);
    expect(exported).not.toContain('OTHER_TURN_CANARY');
  });

  test('legacy markdown export reads only the selected turn sidecars', async () => {
    const sessionId = 'legacy-evidence-session';
    const paths = computePaths(sessionDir);
    const sp = sessionPaths(paths, sessionId);
    writeConfig(sp, {...makeConfig(sessionId), turnCount: 2});
    writeTurnMarkdown(sp, 2, '# Turn 2\n\nlegacy body\n');
    writeJsonFile(sp, path.join(sp.turnsDir, '001.claim-verification.json'), {
      status: 'failed', issues: [{message: 'OTHER_TURN_CANARY'}],
    });
    const sameTurnVerification = evidenceResult(sessionId).claimVerificationResult;
    sameTurnVerification.issues[0].message = 'SAME_TURN_DETAIL';
    writeJsonFile(sp, path.join(sp.turnsDir, '002.claim-verification.json'), sameTurnVerification);

    const out = path.join(tmpDir, 'legacy-turn.md');
    expect(await runReportExportCommand({envFile, sessionDir, sessionId, turn: 2, format: 'md', out})).toBe(0);
    const exported = fs.readFileSync(out, 'utf8');
    expect(exported).toContain('legacy body');
    expect(exported).toContain('SAME_TURN_DETAIL');
    expect(exported).not.toContain('OTHER_TURN_CANARY');
  });
});

function makeConfig(sessionId: string): CliSessionConfig {
  const now = Date.now();
  return {
    sessionId,
    tracePath: '/tmp/trace.perfetto-trace',
    traceId: 'trace-id',
    createdAt: now,
    lastTurnAt: now,
    turnCount: 1,
  };
}

function evidenceResult(sessionId: string): any {
  const sourceClaimBindings = Array.from({length: 21}, (_, index) => ({
    claimId: `source-binding-${index + 1}`,
    mechanismStatus: 'compatible',
    sourceReferenceIds: [`source-${index + 1}`],
    traceEvidenceRefIds: [`trace-${index + 1}`],
  }));
  return {
    sessionId,
    success: false,
    findings: [],
    hypotheses: [],
    conclusion: 'latest conclusion',
    confidence: 0.5,
    rounds: 1,
    totalDurationMs: 1,
    conclusionContract: {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{id: 'claim-1', text: 'claim', references: [{evidenceRefId: 'declared-ref'}]}],
      bindingEligibility: 'eligible',
      sourceClaimBindings,
      uncertainties: [],
      nextSteps: [],
    },
    claimSupport: [],
    claimVerificationResult: {
      schemaVersion: 'claim_verifier@2',
      status: 'failed',
      policy: 'record_only',
      passed: false,
      checkedClaimCount: 1,
      unsupportedClaimCount: 1,
      claimResults: [{claimId: 'claim-1', status: 'unsupported', referenceCells: [],
        deterministicProof: {kind: 'none', status: 'rejected', reason: 'missing', anchorIds: [], evidenceRefIds: []},
        propositionCoverage: {status: 'none', covered: [], uncovered: ['claim'], reason: 'missing'}}],
      issues: Array.from({length: 9}, (_, index) => ({
        claimId: 'claim-1', severity: 'error', code: `issue-${index + 1}`, message: `issue-${index + 1}`,
      })),
    },
    identityResolutions: [],
    sourceUseDecision: {
      schemaVersion: 'source_use_decision@1',
      codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['app'],
      status: 'corroborated',
      attemptedTools: ['lookup_app_source'],
      queriedCodebaseIds: ['app'],
      usedCodebaseIds: ['app'],
      references: [{id: 'source-1', codebaseId: 'app', filePath: 'Main.kt', lookupKind: 'body'}],
    },
  };
}
