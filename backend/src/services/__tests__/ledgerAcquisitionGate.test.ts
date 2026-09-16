// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import type {AnalysisInvestigationRequirement} from '../../types/analysisInvestigation';
import type {InvestigationEvidenceRecord, InvestigationEvidenceSnapshot} from '../evidence/investigationEvidenceLedger';
import {investigationEvidenceFingerprint} from '../evidence/investigationEvidenceLedger';
import {assessLedgerAcquisition, evaluateEvidenceCondition} from '../finalInvestigationContractGate';

function record(overrides: Partial<InvestigationEvidenceRecord> & Pick<InvestigationEvidenceRecord, 'metricId'>):
  InvestigationEvidenceRecord {
  return {
    recordId: `${overrides.metricId}:0:0`, captureId: 'capture', rowIndex: 0, skillId: 'skill', stepId: 'step',
    definitionFingerprint: 'definition', selectedSqlHash: 'sql', traceId: 'trace', traceSide: 'current',
    origin: 'current_run', domain: 'frame_production', status: 'observed',
    window: {start: 100, end: 200}, value: 1, ...overrides,
  };
}

function ledger(records: InvestigationEvidenceRecord[], issues: string[] = []): InvestigationEvidenceSnapshot {
  const body: Omit<InvestigationEvidenceSnapshot, 'fingerprint'> = {
    schemaVersion: 'investigation_evidence@1', ownerKey: 'run', currentRunId: 'run',
    records, issues, complete: issues.length === 0,
  };
  return {...body, fingerprint: investigationEvidenceFingerprint(body)};
}

const backpressure: AnalysisInvestigationRequirement = {
  id: 'scrolling_buffer_backpressure', domain: 'dependency_chain', required: true,
  description: 'Decompose the producer/consumer boundary.',
  condition: {kind: 'evidence', description: 'Buffer Stuffing dominates.',
    metricId: 'render.frame.buffer_stuffing.rate', operator: 'gt', value: 50},
  evidenceMetrics: ['render.buffer.dequeue.wait.duration'],
};

const stuffing = (value: number, status: InvestigationEvidenceRecord['status'] = 'observed') =>
  record({metricId: 'render.frame.buffer_stuffing.rate', value, status});
const dequeue = () => record({metricId: 'render.buffer.dequeue.wait.duration', value: 4.96});

describe('evaluateEvidenceCondition', () => {
  it('reads the threshold off observed records only', () => {
    expect(evaluateEvidenceCondition(backpressure.condition as never, ledger([stuffing(65.17)])))
      .toEqual({met: true, observed: 65.17});
    expect(evaluateEvidenceCondition(backpressure.condition as never, ledger([stuffing(12)])))
      .toEqual({met: false, observed: 12});
  });

  // A capture the product could not complete says nothing about the mechanism.
  it('ignores non-observed records', () => {
    expect(evaluateEvidenceCondition(backpressure.condition as never, ledger([stuffing(65.17, 'unknown')])))
      .toEqual({met: null, observed: null});
  });

  // An absent metric is unknown, never "not in play" — otherwise a scene that
  // never emitted the metric would silently read as cleared.
  it('returns unknown when the metric was never emitted', () => {
    expect(evaluateEvidenceCondition(backpressure.condition as never, ledger([])))
      .toEqual({met: null, observed: null});
    expect(evaluateEvidenceCondition(backpressure.condition as never, undefined))
      .toEqual({met: null, observed: null});
  });
});

describe('assessLedgerAcquisition', () => {
  // The Round 62 shape: stuffing dominates, nothing measured the buffer path.
  it('reports evidence_absent when the condition fires and no declared metric was acquired', () => {
    const [row] = assessLedgerAcquisition([backpressure], ledger([stuffing(65.17)]));
    expect(row.applicability).toBe('applicable');
    expect(row.status).toBe('evidence_absent');
    expect(row.observedMetrics).toEqual([]);
    expect(row.condition).toMatchObject({met: true, observed: 65.17});
  });

  it('reports observed once the declared metric is acquired', () => {
    const [row] = assessLedgerAcquisition([backpressure], ledger([stuffing(65.17), dequeue()]));
    expect(row.status).toBe('observed');
    expect(row.observedMetrics).toEqual(['render.buffer.dequeue.wait.duration']);
  });

  // Ordinary scrolling must not carry the obligation, or the signal becomes noise.
  it('stays not_applicable when stuffing is not dominant', () => {
    const [row] = assessLedgerAcquisition([backpressure], ledger([stuffing(12)]));
    expect(row.applicability).toBe('not_applicable');
    expect(row.status).toBe('not_applicable');
  });

  it('does not claim coverage when the ledger truncated records', () => {
    const [row] = assessLedgerAcquisition([backpressure],
      ledger([stuffing(65.17), dequeue()], ['ledger_metric_budget_exhausted']));
    expect(row.status).toBe('partial');
  });

  // A requirement with no declared metrics has nothing to acquire; it must not
  // masquerade as satisfied coverage.
  it('marks requirements without declared metrics as not_declared', () => {
    const [row] = assessLedgerAcquisition(
      [{id: 'scrolling_dependencies', domain: 'dependency_chain', required: true, description: 'Connect the chain.'}],
      ledger([stuffing(65.17)]));
    expect(row.status).toBe('not_declared');
    expect(row.applicability).toBe('applicable');
  });

  it('is unknown when the condition metric is missing', () => {
    const [row] = assessLedgerAcquisition([backpressure], ledger([dequeue()]));
    expect(row.applicability).toBe('unknown');
    expect(row.status).toBe('unknown');
  });
});
