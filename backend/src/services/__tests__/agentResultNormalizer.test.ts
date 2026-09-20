// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  deriveEvidenceBackedConclusionContractForNarrative,
  deriveConclusionContractForNarrative,
  normalizeNarrativeForContract,
  normalizeNarrativeForClient,
  normalizeResultForReport,
  resolveConclusionOutputModeForTurn,
} from '../agentResultNormalizer';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import {parseConclusionContractDeclaration, type ConclusionContract, type ConclusionContractClaimItem} from '../../agent/core/conclusionContract';
import {ArtifactStore} from '../../agentv3/artifactStore';
import { runClaimVerification } from '../verifier/claimVerificationRunner';
import type { DataEnvelope } from '../../types/dataContract';
import { createDataEnvelope } from '../../types/dataContract';
import { runPreparedAnalysisClaimVerification } from '../evidence/analysisRelationPreparation';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {prepareClaimEvidence} from '../evidence/claimEvidencePreparation';
import {projectSafeSourceProvenance, verifySourceClaimBindings} from '../codebase/sourceClaimVerifier';

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sessionId: 'agent-test',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: '',
    confidence: 0.7,
    rounds: 1,
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('normalizeNarrativeForClient', () => {
  test('returns empty string unchanged', () => {
    expect(normalizeNarrativeForClient('')).toBe('');
    expect(normalizeNarrativeForClient('   ')).toBe('   ');
  });

  test('strips evidence ids (internal sanitization)', () => {
    // Sample an evidence-id-shaped token — the sanitizer should remove it.
    const input = 'The jank event (ev_deadbeef1234) was at frame 12.';
    const out = normalizeNarrativeForClient(input);
    expect(out).not.toContain('ev_deadbeef1234');
  });

  test('returns raw when narrative is non-conclusion text', () => {
    const raw = 'just a plain string with no special markers';
    expect(normalizeNarrativeForClient(raw)).toBe(raw);
  });

  test('preserves a complete final report when it contains legacy section labels', () => {
    const report = [
      '# 双 Trace 对比分析报告',
      '',
      '## 综合结论',
      '',
      '- com.example.launch.aosp.heavy 的冷启动 TTID 为 1912ms。',
      '- com.example.androidappdemo 的冷启动 TTID 为 1339ms。',
      '',
      '结论: 两条 trace 的启动耗时存在明显差异',
      '证据链: C1: 两条 trace 都已完成启动事件采集',
      '不确定性: 暂无',
      '下一步: 对比主线程热点',
    ].join('\n');

    const out = normalizeNarrativeForClient(report);

    expect(out).toContain('## 综合结论');
    expect(out).toContain('com.example.launch.aosp.heavy');
    expect(out).toContain('com.example.androidappdemo');
  });

  test('tolerates non-string-coerced inputs', () => {
    expect(normalizeNarrativeForClient(null as unknown as string)).toBe('');
    expect(normalizeNarrativeForClient(undefined as unknown as string)).toBe('');
  });
});

describe('deriveConclusionContractForNarrative', () => {
  const narrativeWithEvClaim = [
    '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
    '',
    '## 逐句数据引用（结构化来源）',
    '- Q1 / C1: 帧耗时 45.6ms',
    '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
  ].join('\n');

  test('keeps evidence ids available for contract parsing before display sanitization', () => {
    const display = normalizeNarrativeForClient(narrativeWithEvClaim);
    expect(display).not.toContain('ev_deadbeef1234');

    const contractSource = normalizeNarrativeForContract(narrativeWithEvClaim);
    expect(contractSource).toContain('ev_deadbeef1234');

    const contract = deriveConclusionContractForNarrative(narrativeWithEvClaim);
    expect(contract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
    expect(contract?.claims?.[0]?.references?.[0]?.sourceRef).toBe('表 1');
  });
});

describe('deriveEvidenceBackedConclusionContractForNarrative', () => {
  describe('original claim fidelity', () => {
    const envelope = createDataEnvelope(
      {columns: ['ttid_ms'], rows: [[1912]]},
      {type: 'skill_result', source: 'startup_analysis', title: '启动概览',
        skillId: 'startup_analysis', stepId: 'get_startups', executionStatus: 'observed',
        evidenceRefId: 'data:startup-original', traceId: 'trace-original', traceSide: 'current'},
    );
    const originalContract = (claims: NonNullable<ConclusionContract['claims']>): ConclusionContract & {claims: NonNullable<ConclusionContract['claims']>} => ({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: '启动耗时待核验'}],
      clusters: [], evidenceChain: [], claims, uncertainties: [], nextSteps: [],
    });

    const numericClaim = (id: string, value: number, text = `TTID=${value}ms`): ConclusionContractClaimItem => {
      const reference = {evidenceRefId: 'data:startup-original', rowIndex: 0, column: 'ttid_ms', value};
      return {id, text, kind: 'numeric', references: [reference],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'eq', value, unit: 'ms'}}};
    };
    const parsedOriginal = (claims: NonNullable<ConclusionContract['claims']>): ConclusionContract => {
      const parsed = parseConclusionContractDeclaration(originalContract(claims));
      expect(parsed.issues).toEqual([]);
      if (!parsed.contract) throw new Error('Expected a valid fixture declaration');
      return parsed.contract;
    };
    const verifyCaptured = async (conclusionContract: ConclusionContract | null | undefined) => {
      const store = new ArtifactStore();
      store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
        ttid_ms: {unit: 'ms', origin: {kind: 'skill_literal', skillId: 'startup_analysis',
          stepId: 'get_startups', definitionFingerprint: 'startup-original-fixture'}},
      }), {meta: envelope.meta, display: envelope.display});
      const preparedEvidence = await prepareClaimEvidence({conclusionContract,
        evidenceReadView: store.createEvidenceReadView({ownerKey: 'original-claims',
          allowedTraces: [{traceId: 'trace-original', traceSide: 'current'}]})});
      return runPreparedAnalysisClaimVerification({conclusionContract, dataEnvelopes: [envelope], preparedEvidence});
    };

    test('keeps a contradicted claim failed when unrelated prose contains the true evidence value', async () => {
      const original = parsedOriginal([numericClaim('wrong-ttid', 9999)]);
      const normalized = deriveEvidenceBackedConclusionContractForNarrative(
        '启动概览：TTID=9999ms，事件计数1912次。', [envelope], {existingContract: original},
      );
      const verified = await verifyCaptured(normalized);

      expect(normalized).toBe(original);
      expect(normalized?.claims).toEqual(original.claims);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults[0].claimId).toBe('wrong-ttid');
      expect(verified.claimVerificationResult.claimResults[0]).toMatchObject({status: 'unsupported',
        referenceCells: [{status: 'value_mismatch'}],
        deterministicProof: {status: 'rejected', reason: 'numeric_operator_rejected'}});
    });

    test('preserves mixed supported, contradicted and unreferenced claims through repeated normalization', async () => {
      const original = parsedOriginal([
        numericClaim('supported', 1912),
        numericClaim('contradicted', 9999),
        {id: 'no-reference', text: 'The delay may come from initialization.', kind: 'inference', references: []},
      ]);
      const result = makeResult({conclusion: '启动概览：TTID=9999ms，事件计数1912次。', conclusionContract: original});
      const once = normalizeResultForReport(result, {dataEnvelopes: [envelope]});
      const twice = normalizeResultForReport(once, {dataEnvelopes: [envelope]});
      const verified = await verifyCaptured(twice.conclusionContract);

      expect(twice.conclusionContract?.claims).toEqual(original.claims);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults.map(claim => claim.claimId))
        .toEqual(['supported', 'contradicted', 'no-reference']);
      expect(verified.claimVerificationResult.claimResults).toMatchObject([
        {status: 'partial', deterministicProof: {status: 'proved'}, propositionCoverage: {status: 'complete'}},
        {status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]},
        {status: 'inference', referenceCells: []},
      ]);
    });

    test('reads typed JSON before display conversion can discard causal kind or relation references', () => {
      const original = originalContract([{
        id: 'cause', text: 'No evidence yet proves that initialization caused the delay.', kind: 'causal',
        relationRefs: ['relation-candidate'],
        references: [{evidenceRefId: 'data:startup-original', rowIndex: 0, column: 'ttid_ms', value: 1912}],
      }]);
      const parsed = deriveConclusionContractForNarrative(JSON.stringify(original));
      expect(parsed?.claims).toEqual(original.claims.map(claim => ({...claim, conclusionId: 'C1'})));
    });

    test('retains explicit JSON claims whose references are absent, malformed or relation-only', () => {
      const raw = originalContract([
        {id: 'missing', text: 'Initialization may be slow.', kind: 'inference', references: []},
        {id: 'relation-only', text: 'The dependency blocks initialization.', kind: 'causal', references: [], relationRefs: ['relation-1']},
        {id: 'malformed', text: 'TTID=9999ms', kind: 'numeric', references: [{}]},
      ]);
      const parsed = deriveConclusionContractForNarrative(JSON.stringify(raw));
      expect(parsed?.claims?.map(claim => ({id: claim.id, text: claim.text, kind: claim.kind})))
        .toEqual(raw.claims!.map(claim => ({id: claim.id, text: claim.text, kind: claim.kind})));
      expect(parsed?.claims?.[1].relationRefs).toEqual(['relation-1']);
      expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult.passed).toBe(false);
    });

    test('retains explicit Markdown claims without references as unverified statements', () => {
      const parsed = deriveConclusionContractForNarrative([
        '## 逐句数据引用（结构化来源）',
        '- Q-missing / C1: 初始化耗时尚未得到证据支持。',
      ].join('\n'));
      expect(parsed?.claims).toEqual([{id: 'Q-missing', conclusionId: 'C1', text: '初始化耗时尚未得到证据支持。', references: []}]);
      expect(runClaimVerification({conclusionContract: parsed}).claimVerificationResult.passed).toBe(false);
    });

    test('does not create claims merely because narrative and evidence contain the same number', () => {
      const normalized = deriveEvidenceBackedConclusionContractForNarrative('事件计数1912次。', [envelope]);
      expect(normalized?.claims ?? []).toEqual([]);
      const verified = runClaimVerification({conclusionContract: normalized, dataEnvelopes: [envelope]});
      expect(verified.claimVerificationResult).toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0});
    });

    test('does not silently truncate explicitly supplied claims before verification', async () => {
      const claims = Array.from({length: 51}, (_, index) => numericClaim(
        `Q${index + 1}`, index === 50 ? 9999 : 1912, `TTID observation ${index + 1}`,
      ));
      const parsed = deriveConclusionContractForNarrative(JSON.stringify(originalContract(claims)));
      expect(parsed?.claims).toHaveLength(51);
      expect(parsed?.claims?.map(({id, references, semantics}) => ({id, references, semantics})))
        .toEqual(claims.map(({id, references, semantics}) => ({id, references, semantics})));
      const verified = await verifyCaptured(parsed);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults).toHaveLength(51);
      expect(verified.claimVerificationResult.claimResults.slice(0, 50).every(claim =>
        claim.status === 'partial' && claim.deterministicProof?.status === 'proved')).toBe(true);
      expect(verified.claimVerificationResult.claimResults[50]).toMatchObject({claimId: 'Q51',
        status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]});
    });

    test.each([{}, {id: 'empty', references: []}, {text: '   ', references: []}])(
      'does not fabricate a statement for an empty claim entry: %j',
      entry => {
        const parsed = deriveConclusionContractForNarrative(JSON.stringify({
          ...originalContract([]), claims: [entry],
        }));
        expect(parsed?.claims ?? []).toEqual([]);
        expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult)
          .toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0});
      },
    );
  });

  test('keeps rich reports without explicit claims unverified despite matching evidence', () => {
    const envelopes: DataEnvelope[] = [
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'startup_analysis',
          skillId: 'startup_analysis',
          stepId: 'get_startups',
          evidenceRefId: 'data:skill:startup_analysis:get_startups:current:abc',
          artifactId: 'art-2',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 1,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '检测到的启动事件',
        },
        data: {
          columns: ['package', 'startup_type', 'dur_ms', 'ttid_ms'],
          rows: [['com.example.launch.aosp.heavy', 'cold', 1339, 1912]],
        },
      },
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'startup_detail',
          skillId: 'startup_detail',
          stepId: 'actionable_hotspots',
          evidenceRefId: 'data:skill:startup_detail:actionable_hotspots:current:def',
          artifactId: 'art-30',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 2,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '可操作热点',
        },
        data: {
          columns: ['slice_name', 'self_ms', 'self_percent'],
          rows: [
            ['ChaosTask', 456, 34.1],
            ['LoadSimulator_ActivityInit', 249.8, 18.7],
          ],
        },
      },
    ];
    const report = [
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '冷启动 TTID=1912ms，dur=1339ms，主因是 ChaosTask self=456ms 和 LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 关键证据链',
      '',
      '- 启动事件与热点表均已采集。',
    ].join('\n');

    const contract = deriveEvidenceBackedConclusionContractForNarrative(report, envelopes, {
      mode: 'initial_report',
      sceneId: 'startup',
    });
    expect(contract?.claims ?? []).toEqual([]);
    expect(contract?.metadata?.derivedFromNarrativeEvidenceMatch).not.toBe(true);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('not_checked');
    expect(verification.checkedClaimCount).toBe(0);
  });

  test('does not derive numeric claims from numbers embedded inside larger tokens', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_detail',
        skillId: 'startup_detail',
        stepId: 'counts',
        evidenceRefId: 'data:skill:startup_detail:counts:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '计数表',
      },
      data: {
        columns: ['slice_name', 'small_count'],
        rows: [['ChaosTask', 3]],
      },
    }];
    const report = '# 启动性能分析报告\n\n## 综合结论\n\nChaosTask self=1339ms，未提到 small_count。';

    const contract = deriveEvidenceBackedConclusionContractForNarrative(report, envelopes);

    expect(contract?.claims?.some(claim =>
      claim.references.some(ref => ref.column === 'small_count' && ref.value === 3),
    )).not.toBe(true);
  });

  test('preserves producer evidence chain and metadata without deriving replacement claims', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_analysis',
        skillId: 'startup_analysis',
        stepId: 'startup_overview',
        evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'overview',
        format: 'table',
        title: '启动概览',
      },
      data: {
        columns: ['package', 'startup_type', 'ttid_ms'],
        rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
      },
    }];
    const parsed: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusions: [{ rank: 1, statement: '旧结论' }],
      clusters: [],
      evidenceChain: [{ conclusionId: 'C1', text: 'legacy provider evidence chain' }],
      uncertainties: [],
      nextSteps: [],
      metadata: {
        claimDerivation: 'explicit_model_contract',
        claimVerificationScope: 'explicit_claims',
      },
    };

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是 cold 启动，TTID=1912ms。',
      envelopes,
      { existingContract: parsed },
    );

    expect(contract).toBe(parsed);
    expect(contract?.claims ?? []).toEqual([]);
    expect(contract?.evidenceChain).toEqual(parsed.evidenceChain);
    expect(contract?.metadata).toEqual(parsed.metadata);
  });

  test('preserves unresolvable references rather than replacing claims with matching data', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'scrolling_analysis:jank_type_stats',
        skillId: 'scrolling_analysis',
        stepId: 'jank_type_stats',
        evidenceRefId: 'data:skill:scrolling_analysis:jank_type_stats:current:abc',
        artifactId: 'art-6',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '掉帧类型分布',
      },
      data: {
        columns: ['jank_type', 'count', 'real_jank_count', 'false_positive'],
        rows: [['App Deadline Missed', 6, 6, 0]],
      },
    }];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'Q1',
        text: 'App Deadline Missed 有 6 帧',
        kind: 'numeric',
        references: [{
          evidenceRefId: 'missing-artifact',
          sourceRef: 'jank_type_stats',
          rowIndex: 0,
          column: 'count',
          value: 6,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
    } as any;

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      '# 滑动性能分析报告\n\n## 概览\n\nApp Deadline Missed 有 6 帧，real_jank_count=6，false_positive=0。',
      envelopes,
      { existingContract: parsed },
    );

    expect(contract).toBe(parsed);
    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.passed).toBe(false);
  });

  test('preserves conflicting artifact references for the verifier to reject', () => {
    const envelopes: DataEnvelope[] = [
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'scrolling_analysis:performance_summary',
          skillId: 'scrolling_analysis',
          stepId: 'performance_summary',
          evidenceRefId: 'data:skill:scrolling_analysis:performance_summary:current:abc',
          artifactId: 'art-4',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 1,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '滑动性能概览',
        },
        data: {
          columns: ['total_frames', 'perceived_jank_frames', 'jank_rate'],
          rows: [[347, 7, 2.02]],
        },
      },
      {
        meta: {
          type: 'skill_result',
          version: '2.0.0',
          source: 'scrolling_analysis:batch_frame_root_cause',
          skillId: 'scrolling_analysis',
          stepId: 'batch_frame_root_cause',
          evidenceRefId: 'data:skill:scrolling_analysis:batch_frame_root_cause:current:def',
          artifactId: 'art-9',
          traceId: 'trace-1',
          traceSide: 'current',
          timestamp: 2,
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '掉帧列表',
        },
        data: {
          columns: ['dur_ms', 'vsync_missed'],
          rows: [[18.66, 2], [62.73, 7]],
        },
      },
    ];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [
        {
          id: 'Q1',
          text: '总帧数 347，真实掉帧 7 帧，掉帧率 2.02%',
          kind: 'numeric',
          references: [
            { evidenceRefId: 'data:art-4', sourceRef: '滑动性能概览', rowIndex: 0, column: 'total_frames', value: 347 },
          ],
        },
        {
          id: 'Q2',
          text: '最长帧 62.73ms，最长连续丢帧 7 VSync',
          kind: 'numeric',
          references: [
            { evidenceRefId: 'data:art-14', sourceRef: '掉帧列表', rowIndex: 1, column: 'dur_ms', value: 62.73 },
          ],
        },
      ],
      uncertainties: [],
      nextSteps: [],
    } as any;

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      [
        '# 滑动性能分析报告',
        '',
        '## 概览',
        '',
        '总帧数 347，真实掉帧 7 帧，掉帧率 2.02%。最长帧 62.73ms，最长连续丢帧 7 VSync。',
      ].join('\n'),
      envelopes,
      { existingContract: parsed },
    );

    expect(contract).toBe(parsed);
    expect(contract?.claims).toEqual(parsed.claims);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.passed).toBe(false);
  });

  test('does not invent cell expectations for row-only identity claims', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'process_identity_resolver',
        skillId: 'process_identity_resolver',
        stepId: 'current',
        evidenceRefId: 'data:skill:process_identity_resolver:current:identity',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
        identityStatus: 'verified',
        identityRefId: 'identity:trace-1:current:process:885',
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '进程身份候选',
      },
      data: {
        columns: ['process_name', 'package_name', 'pid', 'upid', 'confidence_score'],
        rows: [['com.example.wechatfriendforcustomscroller', 'com.example.wechatfriendforcustomscroller', 13534, 885, 100]],
      },
    }];
    const parsed: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'C2',
        text: '主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885',
        kind: 'identity',
        references: [{
          evidenceRefId: 'data:skill:process_identity_resolver:current:identity',
          sourceRef: '进程身份候选',
          rowIndex: 0,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
    };

    const contract = deriveEvidenceBackedConclusionContractForNarrative(
      '这个 trace 的主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885。',
      envelopes,
      { existingContract: parsed, mode: 'focused_answer' },
    );

    expect(contract).toBe(parsed);
    expect(contract?.claims).toEqual(parsed.claims);

    const verification = runClaimVerification({
      conclusionContract: contract,
      dataEnvelopes: envelopes,
      policy: 'record_only',
    }).claimVerificationResult;
    expect(verification.status).toBe('not_checked');
  });
});

describe('normalizeResultForReport', () => {
  const answerIntent: NonNullable<AnalysisResult['turnIntent']> = {
    schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-current',
    taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
    deliverable: 'answer', evidenceAccess: 'existing_only',
  };

  test('uses typed deliverable rather than budget or turn ordinal', () => {
    expect(resolveConclusionOutputModeForTurn({
      existingMode: 'initial_report',
      turnIntent: answerIntent,
      runSequence: 2,
      requestedAnalysisMode: 'auto',
    })).toBe('focused_answer');
    expect(resolveConclusionOutputModeForTurn({
      existingMode: 'focused_answer',
      turnIntent: answerIntent,
      runSequence: 2,
      requestedAnalysisMode: 'full',
    })).toBe('focused_answer');
    expect(resolveConclusionOutputModeForTurn({
      existingMode: 'focused_answer',
      turnIntent: {...answerIntent, deliverable: 'report'},
      runSequence: 1,
      requestedAnalysisMode: 'auto',
    })).toBe('initial_report');
    expect(resolveConclusionOutputModeForTurn({
      existingMode: 'need_input',
      runSequence: 2,
      requestedAnalysisMode: 'auto',
    })).toBe('need_input');
    expect(resolveConclusionOutputModeForTurn({
      existingMode: 'initial_report', runSequence: 20, requestedAnalysisMode: 'fast',
    })).toBe('initial_report');
  });

  test('normalizes a one-provider-round continuation as a focused answer', () => {
    const r = makeResult({
      conclusion: '上一轮证据显示主线程先应减少同步 UI 工作。',
      rounds: 1,
      conclusionContract: {mode: 'initial_report'} as any,
    });
    const out = normalizeResultForReport(r, {
      turnIntent: answerIntent,
      runSequence: 2,
      requestedAnalysisMode: 'auto',
    });
    expect(out.conclusionContract?.mode).toBe('focused_answer');
  });

  test('does not use result metadata as the current server turn intent', () => {
    const r = makeResult({conclusion: 'plain answer', conclusionContract: {mode: 'initial_report'} as any,
      turnIntent: answerIntent});
    expect(normalizeResultForReport(r).conclusionContract?.mode).toBe('initial_report');
    expect(normalizeResultForReport(r, {turnIntent: answerIntent}).conclusionContract?.mode).toBe('focused_answer');
  });

  test.each(['body', 'contract'] as const)('invalidates bound verdicts when normalization changes the %s', changed => {
    const r = makeResult({conclusion: changed === 'body' ? 'Measured frame (ev_deadbeef1234).' : 'Measured frame.',
      conclusionContract: {mode: 'initial_report'} as any});
    const candidate = {candidateRef: 'candidate-a', runId: 'run-a', attemptId: 'attempt-a',
      conclusionFingerprint: analysisDeliveryFingerprint(r.conclusion)};
    r.completion = {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'};
    r.reportAssessment = {schemaVersion: 1, status: 'checked', binding: {...candidate,
      conclusionContractFingerprint: analysisDeliveryFingerprint(r.conclusionContract), evidenceFingerprint: 'evidence',
      intentFingerprint: 'intent', registryFingerprint: 'registry', requirementsFingerprint: 'requirements'}, requirements: []};
    r.deliveryAssurance = {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'passed',
      source: 'passed', identity: 'passed', report: 'passed'};
    const before = structuredClone(r);
    const out = normalizeResultForReport(r, changed === 'contract' ? {turnIntent: answerIntent} : {});
    expect(out.reportAssessment).toBeUndefined();
    expect(out.deliveryAssurance).toBeUndefined();
    if (changed === 'body') expect(out.completion).toBeUndefined();
    else expect(out.completion).toBe(r.completion);
    expect(r).toEqual(before);
    expect(normalizeResultForReport(r, {entry: 'historical_restore', turnIntent: answerIntent})).toBe(r);
  });

  test('returns input identity when nothing would change', () => {
    const r = makeResult({ conclusion: 'plain text', conclusionContract: { mode: 'focused_answer' } as any });
    const out = normalizeResultForReport(r);
    // Identity check — callers rely on this to skip downstream work.
    expect(out).toBe(r);
  });

  test('strips evidence ids from conclusion', () => {
    const r = makeResult({ conclusion: 'Frame regression at (ev_aaaaaaaaaaaa).' });
    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_aaaaaaaaaaaa');
  });

  test('derives a conclusionContract when missing', () => {
    const r = makeResult({ conclusion: 'Some analysis summary.', conclusionContract: undefined, rounds: 2 });
    const out = normalizeResultForReport(r);
    // Either gets a contract (if derivable from this text) or stays undefined;
    // what matters is that the call doesn't throw and the shape is preserved.
    expect(typeof out.conclusion).toBe('string');
    expect(out.rounds).toBe(2);
  });

  test('preserves existing conclusionContract', () => {
    const contract = { mode: 'initial_report' } as any;
    const r = makeResult({ conclusion: 'text', conclusionContract: contract });
    const out = normalizeResultForReport(r);
    expect(out.conclusionContract).toBe(contract);
  });

  test.each(['lookup-1', 'model-controlled-id'] as const)(
    'canonicalizes source provenance and safely handles binding ID %s', bindingId => {
    const r = makeResult({
      conclusion: 'compact chat narrative',
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [{rank: 1, statement: 'Foo.run is compatible with the trace'}],
        clusters: [],
        evidenceChain: [],
        claims: [{
          id: 'claim-1',
          text: 'Foo.run is compatible with the trace',
          references: [{evidenceRefId: 'data:trace-1'}],
        }],
        sourceUseDecision: {
          schemaVersion: 'source_use_decision@1',
          codeAwareMode: 'provider_send',
          selectedCodebaseIds: ['app-source'],
          status: 'corroborated',
          attemptedTools: ['read_codebase_file'],
          queriedCodebaseIds: ['app-source'],
          usedCodebaseIds: ['app-source'],
          references: [{
            id: 'model-controlled-id',
            referenceId: 'lookup-1',
            codebaseId: 'app-source',
            filePath: 'src/main/Foo.kt',
            lookupKind: 'body',
            snippet: 'raw-source-canary',
          } as any],
        },
        sourceReferences: [{
          id: 'model-controlled-id',
          referenceId: 'lookup-1',
          codebaseId: 'app-source',
          filePath: 'src/main/Foo.kt',
          lookupKind: 'body',
          text: 'raw-source-canary',
        } as any],
        sourceClaimBindings: [{
          claimId: 'claim-1',
          mechanismStatus: 'compatible',
          sourceReferenceIds: [bindingId],
          traceEvidenceRefIds: ['data:trace-1'],
          reason: 'raw-source-canary',
        }],
        uncertainties: [],
        nextSteps: [],
      },
    });
    r.sourceUseDecision = r.conclusionContract!.sourceUseDecision;
    r.sourceReferences = r.conclusionContract!.sourceReferences;

    const out = normalizeResultForReport(r);

    expect(out.conclusion).toBe('compact chat narrative');
    expect(out.conclusionContract?.sourceReferences?.[0]?.id).toMatch(/^source-ref-v1-/);
    expect(JSON.stringify(out.conclusionContract)).not.toContain('raw-source-canary');
    const verified = verifySourceClaimBindings({conclusionContract: out.conclusionContract,
      actualSourceUseDecision: out.sourceUseDecision,
      matchedTraceEvidenceRefIdsByClaimId: {'claim-1': ['data:trace-1']}});
    const safe = projectSafeSourceProvenance({conclusionContract: out.conclusionContract,
      actualSourceUseDecision: out.sourceUseDecision});
    expect(JSON.stringify(safe)).not.toContain('model-controlled-id');
    expect(JSON.stringify(safe)).not.toContain('raw-source-canary');
    if (bindingId === 'lookup-1') {
      expect(JSON.stringify(out.conclusionContract)).not.toContain('model-controlled-id');
      expect(verified.status).toBe('passed');
      expect(safe?.sourceClaimBindings[0]?.sourceReferenceIds).toEqual([safe?.sourceUseDecision.references[0].id]);
    } else {
      // Keep the invalid declaration until verification can diagnose it; never
      // resolve a model-created alias or publish it as accepted provenance.
      expect(out.conclusionContract?.sourceClaimBindings?.[0]?.sourceReferenceIds).toEqual([bindingId]);
      expect(verified.status).toBe('failed');
      expect(verified.issues).toContainEqual(expect.objectContaining({code: 'source_reference_not_returned'}));
      expect(verified.bindings).toEqual([]);
      expect(safe?.sourceClaimBindings).toEqual([]);
    }
  });

  test('derives claim provenance from unsanitized narrative while returning sanitized display text', () => {
    const r = makeResult({
      conclusion: [
        '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
        '',
        '## 逐句数据引用（结构化来源）',
        '- Q1 / C1: 帧耗时 45.6ms',
        '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
      ].join('\n'),
    });

    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_deadbeef1234');
    expect(out.conclusionContract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
  });

  test('does not turn CLI/report evidence observations into producer claims', () => {
    const envelopes: DataEnvelope[] = [{
      meta: {
        type: 'skill_result',
        version: '2.0.0',
        source: 'startup_analysis',
        skillId: 'startup_analysis',
        stepId: 'startup_overview',
        evidenceRefId: 'data:skill:startup_analysis:startup_overview:current:abc',
        traceId: 'trace-1',
        traceSide: 'current',
        timestamp: 1,
      },
      display: {
        layer: 'overview',
        format: 'table',
        title: '启动概览',
      },
      data: {
        columns: ['package', 'startup_type', 'ttid_ms'],
        rows: [['com.example.launch.aosp.heavy', 'cold', 1912]],
      },
    }];
    const r = makeResult({
      conclusion: '# 启动性能分析报告\n\n## 综合结论\n\ncom.example.launch.aosp.heavy 是冷启动，TTID=1912ms。',
      conclusionContract: undefined,
    });

    const out = normalizeResultForReport(r, { dataEnvelopes: envelopes });

    expect(out.conclusionContract?.claims ?? []).toEqual([]);
    expect(out.conclusionContract?.metadata?.derivedFromNarrativeEvidenceMatch).not.toBe(true);
    expect(runClaimVerification({conclusionContract: out.conclusionContract, dataEnvelopes: envelopes})
      .claimVerificationResult.status).toBe('not_checked');
  });

  test('preserves sidecar metadata while normalizing report text', () => {
    const receipt = {
      schemaVersion: 1,
      runId: 'run-1',
      sessionId: 'agent-test',
      traceId: 'trace-1',
      mode: 'auto',
      resolvedMode: 'full',
      providerId: null,
      generatedAt: 1,
      traceEvidence: {
        sqlCount: 0,
        skillCount: 0,
        dataEnvelopeCount: 0,
        artifactCount: 0,
        evidenceRefCount: 0,
      },
      nonEvidenceContext: {
        frontendPrequeryCount: 0,
        memoryHintCount: 0,
        conversationContextCount: 0,
        strategyHintCount: 0,
      },
      claimAudit: {
        totalClaims: 0,
        verifiedClaims: 0,
        unsupportedClaims: 0,
        uncertainClaims: 0,
      },
      qualityGates: {
        finalReportContract: 'not_applicable',
        claimVerification: 'not_applicable',
        identityResolution: 'not_applicable',
      },
      outputs: {},
    } as const;
    const r = makeResult({
      conclusion: '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
      analysisReceipt: receipt,
      uiActionProposals: [
        {
          schemaVersion: 1,
          id: 'ui-navigate_timeline-1',
          kind: 'navigate_timeline',
          title: '跳到帧',
          reason: '来自证据表',
          source: { evidenceRefId: 'ev_deadbeef1234' },
          payload: { ts: '123456789' },
          requiresConfirmation: true,
        },
      ],
    });

    const out = normalizeResultForReport(r);

    expect(out.conclusion).not.toContain('ev_deadbeef1234');
    expect(out.analysisReceipt).toBe(receipt);
    expect(out.uiActionProposals).toBe(r.uiActionProposals);
  });
});
