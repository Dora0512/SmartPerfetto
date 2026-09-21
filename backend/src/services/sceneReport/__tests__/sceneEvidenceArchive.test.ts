// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash} from 'crypto';
import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {SceneEvidenceArchive, type SceneEvidenceArchiveInput, type SceneEvidenceArchiveLimits} from '../sceneEvidenceArchive';
import {assertIssuedSceneSnapshot} from '../../../agent/scene/sceneRunContext';
import {evidenceCaptureHash} from '../../evidence/evidenceCapture';
import {assessSceneScanCoverage} from '../../../agent/scene/sceneScanCoverage';
import {buildSceneCoveragePlan, snapshotSceneCoverageRegistry} from '../../../agent/scene/sceneCoveragePlan';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../../agentv3/strategyLoader';
import yaml from 'js-yaml';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const limits: SceneEvidenceArchiveLimits = {maxShardBytes: 256, maxReportBytes: 16_384, maxOwnerBytes: 65_536,
  maxReportsPerOwner: 4, maxShardsPerReport: 64, maxManifestBytes: 8192, ttlMs: 60_000};
const current = () => undefined;
function input(overrides: Partial<SceneEvidenceArchiveInput> = {}): SceneEvidenceArchiveInput {
  const traceId = overrides.traceId || 'trace-one', reportId = overrides.reportId || 'report-one';
  return {ownerKey: 'tenant/workspace/user', traceId, reportId,
    report: {reportId, traceId, generatedBy: {pipelineVersion: 'v3'}, summary: '触摸后的设备状态 😀'.repeat(30)},
    assessment: {schemaVersion: 'scene_timeline@1', runId: 'run-one', sessionId: 'session-one', traceId,
      revision: 1, segments: [], unresolved: [], diagnostics: [], status: 'partial',
      coverage: {status: 'unknown', captureStatus: 'unknown', reason: 'not_recorded', sources: []}},
    cacheIdentity: {traceContentHash: 'a'.repeat(64), requestedRange: {startNs: '0', endNs: '100'},
      schemaVersion: 'v3', ruleVersion: 'scene@1', producerFingerprint: 'producer@1',
      traceProcessorFingerprint: 'tp@1', outputLanguage: 'zh-CN'}, ...overrides};
}
function detailedInput(): SceneEvidenceArchiveInput {
  const sample = input();
  sample.assessment.segments = [{segment: {id: 'segment-one', startNs: '0', endNs: '10',
    object: {kind: 'upid', key: '42'}, userAction: 'touch', deviceState: 'unknown', appResponse: 'frames',
    evidenceRefs: [{artifactId: 'artifact-one', rowIndex: 0}],
    boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: 'ts'}, end: {source: 'inferred'}}, dependencies: [], supersedes: []},
    contentFingerprint: 'content-one', dependencyFingerprint: 'dependency-one', issuedRevision: 1,
    referencesResolved: true, semanticStatus: 'unverified', checks: [{predicate: 'story.semantic', status: 'unknown'}],
    evidence: [{captureId: 'capture-one', originalRowIndex: 0, referenceIndex: 0, fingerprint: 'row-one',
      source: {originRunId: sample.assessment.runId, artifactId: 'artifact-one'}, row: {ts: '0'}, fields: {}}], diagnostics: []}];
  return sample;
}
function scannedInput(): SceneEvidenceArchiveInput {
  const sample = detailedInput(), {assessment} = sample;
  assessment.scanCoverage = {revision: 1, requestedWindow: {startNs: '0', endNs: '100'}, maxUnionWindows: 2048, diagnostics: [],
    receipts: [{recordId: 'scan-one', captureId: 'summary-one', resultCaptureId: 'result-one', originRunId: assessment.runId,
      traceId: assessment.traceId, traceSide: 'current', skillId: 'scene', stepId: 'coverage', resultStepId: 'events',
      sourceToolCallId: 'tool-one', definitionFingerprint: 'definition-one', selectedSqlHash: 'summary-sql', resultSqlHash: 'result-sql',
      domain: 'input', source: 'all', window: {start: '0', end: '100'}, totalRows: '1', returnedRows: '1',
      scanStatus: 'complete', captureStatus: 'unknown', issues: []}]};
  assessment.coverage = {status: 'partial', captureStatus: 'unknown', reason: 'capture_completeness_unproven',
    sources: [{domain: 'input', source: 'all', skillId: 'scene', resultStepId: 'events', definitionFingerprint: 'definition-one',
      scanStatus: 'complete', windows: [{startNs: '0', endNs: '100'}], issues: []}]};
  return sample;
}
describe('SceneEvidenceArchive', () => {
  let dir: string, archive: SceneEvidenceArchive;
  const ownerDir = (owner = 'tenant/workspace/user') => path.join(dir, 'owners', hash(owner));
  const reportDir = (owner = 'tenant/workspace/user', reportId = 'report-one') => path.join(ownerDir(owner), hash(reportId));
  beforeEach(async () => {dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-archive-')); archive = new SceneEvidenceArchive(dir, limits);});
  afterEach(async () => {jest.restoreAllMocks(); await fs.rm(dir, {recursive: true, force: true});});

  it('reads legacy scanned history unchanged without filling a current coverage policy', async () => {
    const sample = scannedInput();
    // The old source projection grouped these summaries together; migration must preserve that result.
    sample.assessment.scanCoverage!.receipts = [...sample.assessment.scanCoverage!.receipts,
      {...sample.assessment.scanCoverage!.receipts[0], recordId: 'legacy-other-summary', captureId: 'legacy-other-capture', stepId: 'other-summary'}];
    await archive.save(sample, current);
    const loaded = await archive.load(sample.ownerKey, sample.reportId);
    expect(loaded!.assessment).toEqual(sample.assessment);
    expect(loaded!.assessment.scanCoverage!.plan).toBeUndefined();
    expect(loaded!.assessment.coverage.targets).toBeUndefined();
  });

  it('archives a fixed complete query denominator without promoting capture or restoring live authority', async () => {
    const sample = scannedInput(), scan = sample.assessment.scanCoverage!;
    const body = {profileId: 'scene_reconstruction', profileVersion: 1, policyFingerprint: 'policy', registryFingerprint: 'registry', strategyRegistryFingerprint: 'strategies',
      targets: [{id: 'input', domain: 'input', source: 'all', producer: {skillId: 'scene', summaryStepId: 'coverage',
        resultStepId: 'events', definitionFingerprint: 'definition-one'}}]};
    scan.plan = {...body, fingerprint: evidenceCaptureHash(body)};
    sample.assessment.coverage = assessSceneScanCoverage(scan);
    expect(sample.assessment.coverage.status).toBe('complete');
    await archive.save(sample, current);
    const loaded = await archive.load(sample.ownerKey, sample.reportId);
    expect(loaded!.assessment.coverage).toEqual(sample.assessment.coverage);
    expect(loaded!.assessment.coverage.captureStatus).toBe('unknown');
    expect(() => assertIssuedSceneSnapshot(loaded!.assessment, {runId: 'run-one', sessionId: 'session-one',
      traceId: 'trace-one', ownerKey: sample.ownerKey})).toThrow('unissued_scene_snapshot');
    const tampered = JSON.parse(JSON.stringify(sample));
    tampered.assessment.scanCoverage.plan.targets.push({id: 'device', domain: 'device', source: 'all', bindingIssue: 'unavailable'});
    const {fingerprint: _old, ...changed} = tampered.assessment.scanCoverage.plan;
    tampered.assessment.scanCoverage.plan.fingerprint = evidenceCaptureHash(changed);
    await expect(archive.save({...tampered, reportId: 'tampered'}, current)).rejects.toThrow('invalid_payload');
  });

  it('retains required targets without receipts as unknown historical ranges', async () => {
    const sample = scannedInput(), scan = sample.assessment.scanCoverage!;
    const body = {profileId: 'scene_reconstruction', profileVersion: 1, policyFingerprint: 'policy', registryFingerprint: 'registry', strategyRegistryFingerprint: 'strategies',
      targets: [{id: 'input_device_state', domain: 'device', source: 'all', bindingIssue: 'scene_coverage_producer_unconfigured'}]};
    scan.plan = {...body, fingerprint: evidenceCaptureHash(body)};
    sample.assessment.coverage = assessSceneScanCoverage(scan);
    await archive.save(sample, current);
    const loaded = await archive.load(sample.ownerKey, sample.reportId);
    expect(loaded!.assessment.coverage.targets![0]).toMatchObject({scanStatus: 'unknown',
      unscannedWindows: [{startNs: '0', endNs: '100'}], captureUnknownWindows: [{startNs: '0', endNs: '100'}]});
  });

  it('roundtrips the actual required policy when response producers are absent without collapsing its denominator', async () => {
    // Exercise production limits for the full policy; tiny-shard quota fixtures are tested separately.
    const policyArchive = new SceneEvidenceArchive(dir);
    const policy = yaml.load(await fs.readFile(path.resolve(__dirname, '../../../../strategies/scene-coverage-policy.yaml'), 'utf8'));
    const strategies = buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(), overlayGeneration: 'archive-test'});
    const registry = snapshotSceneCoverageRegistry({getAllSkills: () => [], getFragmentCache: () => new Map()}, strategies, 'scene_reconstruction');
    const sample = scannedInput(), scan = sample.assessment.scanCoverage!;
    scan.plan = buildSceneCoveragePlan(policy, registry);
    sample.assessment.coverage = assessSceneScanCoverage(scan);
    const response = scan.plan.targets.find(target => target.id === 'response_markers')!;
    expect(response.requestedProducer!.skillId).toBe('scene_response_markers');
    expect(response.producer).toBeUndefined();
    await policyArchive.save(sample, current);
    const loaded = await policyArchive.load(sample.ownerKey, sample.reportId);
    expect(loaded!.assessment.coverage).toEqual(sample.assessment.coverage);
    expect(loaded!.assessment.coverage.targets!.every(target => target.scanStatus === 'unknown')).toBe(true);
  });

  it('commits sharded v3 history, exact UTF-8 and one TTL authority, with no live proof restoration', async () => {
    const original = input(), ref = await archive.save(original, current);
    const loaded = await archive.load(original.ownerKey, original.reportId);
    expect(loaded?.report).toEqual(original.report);
    expect(loaded?.assessment).toEqual(original.assessment);
    expect(loaded?.manifest.expiresAt).toBe(ref.expiresAt);
    expect(loaded!.manifest.shards.length).toBeGreaterThan(2);
    expect(loaded!.manifest.shards.every(shard => shard.byteSize <= limits.maxShardBytes)).toBe(true);
    expect(() => assertIssuedSceneSnapshot(loaded!.assessment, {ownerKey: original.ownerKey,
      traceId: original.traceId, runId: 'run-one', sessionId: 'session-one'})).toThrow('unissued_scene_snapshot');
    const files = await fs.readdir(reportDir());
    expect(files.sort()).toEqual(['manifest.json', ...loaded!.manifest.shards.map(shard => shard.filename)].sort());
    const size = (await Promise.all(files.map(file => fs.stat(path.join(reportDir(), file))))).reduce((sum, stat) => sum + stat.size, 0);
    expect(ref.byteSize).toBe(size);
  });
  it('partitions identical report IDs by owner and denies a cross-owner read or delete', async () => {
    await archive.save(input(), current);
    expect(await archive.load('other-owner', 'report-one')).toBeNull();
    await archive.deleteReport('other-owner', 'report-one');
    expect(await archive.load(input().ownerKey, 'report-one')).not.toBeNull();
    await archive.save(input({ownerKey: 'other-owner', report: {summary: 'Other'}}), current);
    expect((await archive.load('other-owner', 'report-one'))?.report).toEqual({summary: 'Other'});
  });
  it('rejects traversal identifiers and an owner-directory symlink without writing its target', async () => {
    await expect(archive.save(input({reportId: '../escape'}), current)).rejects.toThrow('invalid_report_id');
    await archive.cleanupExpired();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-external-'));
    try {
      await fs.symlink(external, ownerDir());
      await expect(archive.save(input(), current)).rejects.toThrow('unsafe_directory');
      expect(await fs.readdir(external)).toEqual([]);
    } finally {await fs.rm(external, {recursive: true, force: true});}
  });
  it.each(['checksum', 'missing', 'symlink', 'hardlink', 'manifest_checksum', 'manifest_path', 'manifest_schema'])('fails closed on %s with no memory fallback', async corruption => {
    await archive.save(input(), current);
    const target = path.join(reportDir(), 'report-0.part');
    if (corruption === 'checksum') {const bytes = await fs.readFile(target); bytes[0] ^= 1; await fs.writeFile(target, bytes);}
    if (corruption === 'missing') await fs.unlink(target);
    if (corruption === 'symlink') {await fs.unlink(target); await fs.symlink(path.join(reportDir(), 'assessment-0.part'), target);}
    if (corruption === 'hardlink') {await fs.unlink(target); await fs.link(path.join(reportDir(), 'assessment-0.part'), target);}
    if (corruption.startsWith('manifest')) {
      const location = path.join(reportDir(), 'manifest.json');
      const envelope = JSON.parse(await fs.readFile(location, 'utf8'));
      if (corruption === 'manifest_checksum') envelope.sha256 = 'b'.repeat(64);
      else {
        if (corruption === 'manifest_path') envelope.manifest.shards[0].filename = '../outside';
        else envelope.manifest.schemaVersion = 'scene_evidence_archive@2';
        envelope.sha256 = hash(JSON.stringify(envelope.manifest));
      }
      await fs.writeFile(location, JSON.stringify(envelope));
    }
    expect(await archive.load(input().ownerKey, 'report-one')).toBeNull();
  });
  it('checks report and shard quotas before temporary allocation', async () => {
    const small = new SceneEvidenceArchive(dir, {...limits, maxReportBytes: 1024});
    await expect(small.save(input(), current)).rejects.toThrow('report_quota');
    const fewShards = new SceneEvidenceArchive(dir, {...limits, maxShardsPerReport: 2});
    await expect(fewShards.save(input(), current)).rejects.toThrow('shard_quota');
    expect(await fs.readdir(ownerDir())).toEqual([]);
  });
  it('serializes owner reservations so simultaneous saves cannot exceed count quota', async () => {
    archive = new SceneEvidenceArchive(dir, {...limits, maxReportsPerOwner: 1});
    const results = await Promise.allSettled([archive.save(input(), current), archive.save(input({reportId: 'report-two'}), current)]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await fs.readdir(ownerDir())).toHaveLength(1);
  });
  it('counts actual manifest and shard bytes toward owner quota', async () => {
    const ref = await archive.save(input(), current);
    archive = new SceneEvidenceArchive(dir, {...limits, maxOwnerBytes: ref.byteSize * 2 - 1,
      maxReportBytes: ref.byteSize * 2 - 1});
    await expect(archive.save(input({reportId: 'report-two'}), current)).rejects.toThrow('owner_quota');
    expect(await fs.readdir(ownerDir())).toHaveLength(1);
  });
  it('cleans partial writes after authority failure and permits the next queued save', async () => {
    let checks = 0;
    await expect(archive.save(input(), () => {if (++checks === 3) throw new Error('revoked');})).rejects.toThrow('revoked');
    expect(await fs.readdir(ownerDir())).toEqual([]);
    await expect(archive.save(input(), current)).resolves.toMatchObject({reportId: 'report-one'});
  });
  it('reaps a failed shard write and releases the reserved owner budget', async () => {
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename).endsWith('report-1.part')) throw Object.assign(new Error('disk_full'), {code: 'ENOSPC'});
      return open(filename, flags, mode);
    });
    await expect(archive.save(input(), current)).rejects.toThrow('disk_full');
    expect(await archive.load(input().ownerKey, 'report-one')).toBeNull();
    expect(await fs.readdir(ownerDir())).toEqual([]);
    jest.restoreAllMocks();
    await expect(archive.save(input(), current)).resolves.toMatchObject({reportId: 'report-one'});
  });
  it('never returns a dangling reference when the post-commit authority check fails', async () => {
    const rename = fs.rename.bind(fs); let committed = false;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {await rename(from, to); committed = true;});
    await expect(archive.save(input(), () => {if (committed) throw new Error('revoked_after_commit');})).rejects.toThrow('revoked_after_commit');
    expect(await archive.load(input().ownerKey, 'report-one')).toBeNull();
    expect(await fs.readdir(ownerDir())).toEqual([]);
  });
  it('cleans startup orphans but preserves every valid manifest reference', async () => {
    await archive.save(input(), current);
    await fs.mkdir(path.join(ownerDir(), '.pending-interrupted'));
    await fs.writeFile(path.join(ownerDir(), '.pending-interrupted', 'unused.part'), 'orphan');
    await fs.mkdir(path.join(ownerDir(), 'f'.repeat(64)));
    await fs.writeFile(path.join(reportDir(), 'orphan.part'), 'not referenced');
    const restarted = new SceneEvidenceArchive(dir, limits);
    expect(await restarted.load(input().ownerKey, 'report-one')).not.toBeNull();
    expect(await fs.readdir(ownerDir())).toEqual([hash('report-one')]);
    expect(await fs.readdir(reportDir())).not.toContain('orphan.part');
  });
  it('expires both reads and physical artifacts', async () => {
    const ref = await archive.save(input(), current);
    jest.spyOn(Date, 'now').mockReturnValue(ref.expiresAt);
    expect(await archive.load(input().ownerKey, 'report-one')).toBeNull();
    await archive.cleanupExpired(ref.expiresAt);
    expect(await fs.readdir(ownerDir())).toEqual([]);
  });
  it('durably invalidates a trace across all owners and across restart while preserving other traces', async () => {
    await archive.save(input(), current);
    await archive.save(input({ownerKey: 'other-owner'}), current);
    await archive.save(input({traceId: 'other-trace', reportId: 'other-report'}), current);
    await archive.invalidateTrace({traceId: 'trace-one'});
    const restarted = new SceneEvidenceArchive(dir, limits);
    expect(await restarted.load(input().ownerKey, 'report-one')).toBeNull();
    expect(await restarted.load('other-owner', 'report-one')).toBeNull();
    expect(await restarted.load(input().ownerKey, 'other-report')).not.toBeNull();
    await expect(restarted.save(input(), current)).rejects.toThrow('trace_deleted');
    expect(await fs.readdir(path.join(dir, 'tombstones'))).toEqual([`${hash('trace-one')}.json`]);
  });
  it('blocks synchronous deletion racing the final rename and reaps the committed directory', async () => {
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to) === reportDir()) archive.markTraceDeleted('trace-one');
    });
    await expect(archive.save(input(), current)).rejects.toThrow('trace_deleted');
    await archive.invalidateTrace({traceId: 'trace-one'});
    expect(await fs.readdir(ownerDir())).toEqual([]);
    expect(await new SceneEvidenceArchive(dir, limits).load(input().ownerKey, 'report-one')).toBeNull();
  });
  it('keeps concurrent tombstone writes and owner cleanup from deleting active temporary markers', async () => {
    await archive.save(input(), current);
    await archive.save(input({traceId: 'second-trace', reportId: 'second-report'}), current);
    await Promise.all([archive.invalidateTrace({traceId: 'trace-one'}), archive.invalidateTrace({traceId: 'second-trace'}), archive.cleanupExpired()]);
    expect((await fs.readdir(path.join(dir, 'tombstones'))).sort()).toEqual(
      [`${hash('trace-one')}.json`, `${hash('second-trace')}.json`].sort());
    expect(await fs.readdir(ownerDir())).toEqual([]);
  });
  it('rejects malformed cache identities and assessment trace mismatches', async () => {
    const sample = input(); sample.cacheIdentity.requestedRange = {startNs: '100', endNs: '1'};
    await expect(archive.save(sample, current)).rejects.toThrow('invalid_payload');
    await expect(archive.save({...input(), assessment: {...input().assessment, traceId: 'wrong-trace'}}, current)).rejects.toThrow('invalid_payload');
  });
  it('snapshots caller-owned identities and payloads before asynchronous work', async () => {
    const sample = input(), saved = archive.save(sample, current);
    sample.traceId = 'changed-trace'; sample.reportId = 'changed-report'; sample.ownerKey = 'changed-owner';
    sample.cacheIdentity.ruleVersion = 'changed';
    const ref = await saved;
    expect(ref.reportId).toBe('report-one');
    const loaded = await archive.load('tenant/workspace/user', 'report-one');
    expect(loaded?.manifest.traceId).toBe('trace-one');
    expect(loaded?.manifest.cacheIdentity.ruleVersion).toBe('scene@1');
  });
  it('preserves valid detailed history without adding defaults or changing its fingerprints', async () => {
    const sample = detailedInput();
    await archive.save(sample, current);
    expect((await archive.load(sample.ownerKey, sample.reportId))?.assessment).toEqual(sample.assessment);
  });
  it('preserves consistent scan history while capture and story remain unverified', async () => {
    const sample = scannedInput();
    await archive.save(sample, current);
    expect((await archive.load(sample.ownerKey, sample.reportId))?.assessment).toEqual(sample.assessment);
  });
  it.each([
    ['cross-run receipt', (value: any) => {value.scanCoverage.receipts[0].originRunId = 'other-run';}],
    ['cross-trace receipt', (value: any) => {value.scanCoverage.receipts[0].traceId = 'other-trace';}],
    ['reference-side receipt', (value: any) => {value.scanCoverage.receipts[0].traceSide = 'reference';}],
    ['verified receipt', (value: any) => {value.scanCoverage.receipts[0].scanStatus = 'verified';}],
    ['invalid receipt count', (value: any) => {value.scanCoverage.receipts[0].totalRows = '1.0';}],
    ['false complete receipt', (value: any) => {value.scanCoverage.receipts[0].returnedRows = '0';}],
    ['unbound requested window', (value: any) => {value.scanCoverage.requestedWindow.endNs = '99';}],
    ['invented complete source', (value: any) => {value.scanCoverage.receipts[0].scanStatus = 'partial';}],
    ['scan receipt quota', (value: any) => {value.scanCoverage.receipts = Array.from({length: 2049}, () => value.scanCoverage.receipts[0]);}],
  ] as Array<[string, (value: any) => void]>)('rejects malformed %s', async (_label, mutate) => {
    const sample = scannedInput(); mutate(sample.assessment);
    await expect(archive.save(sample, current)).rejects.toThrow('invalid_payload');
  });
  const malformed: Array<[string, (value: any) => void]> = [
    ['empty segment', value => {value.segments = [{}];}],
    ['verified story', value => {value.segments[0].semanticStatus = 'verified';}],
    ['invalid finite status', value => {value.segments[0].checks[0].status = 'verified';}],
    ['semantic finite promotion', value => {value.segments[0].checks[0].status = 'passed';}],
    ['unsupported finite predicate', value => {value.segments[0].checks[0].predicate = 'invented.proof';}],
    ['missing segment defaults', value => {delete value.segments[0].segment.dependencies;}],
    ['trimmed segment identity', value => {value.segments[0].segment.id = ' segment-one ';}],
    ['out-of-int64 timestamp', value => {value.segments[0].segment.endNs = '9223372036854775808';}],
    ['cross-run excerpt', value => {value.segments[0].evidence[0].source.originRunId = 'different-run';}],
    ['unsupported evidence field', value => {value.segments[0].evidence[0].fields.ts = {origin: {kind: 'model', definitionFingerprint: 'fake'}};}],
    ['unknown evidence reference', value => {value.segments[0].evidence[0].referenceIndex = 2;}],
    ['illegal coverage status', value => {value.coverage.status = 'complete';}],
    ['illegal capture status', value => {value.coverage.captureStatus = 'complete';}],
    ['source without receipts', value => {value.coverage = {status: 'partial', captureStatus: 'unknown', reason: 'fake',
      sources: [{domain: 'input', source: 'all', skillId: 'scene', resultStepId: 'events', definitionFingerprint: 'def',
        scanStatus: 'complete', windows: [{startNs: '0', endNs: '100'}], issues: []}]};}],
    ['cross-owner identity', value => {value.ownerKey = 'different-owner';}],
    ['unknown assessment field', value => {value.liveWitness = {}; }],
    ['segment quota', value => {value.segments = Array.from({length: 2001}, () => value.segments[0]);}],
    ['non-JSON evidence number', value => {value.segments[0].evidence[0].row.invalid = Number.NaN;}],
  ];
  it.each(malformed)('rejects malformed %s before saving', async (_label, mutate) => {
    const sample = detailedInput(); mutate(sample.assessment);
    await expect(archive.save(sample, current)).rejects.toThrow('invalid_payload');
  });
  it.each(malformed.slice(0, 16))('rejects checksum-consistent malformed %s on load', async (_label, mutate) => {
    const sample = detailedInput(); await archive.save(sample, current);
    const filename = path.join(reportDir(), 'manifest.json');
    const envelope = JSON.parse(await fs.readFile(filename, 'utf8'));
    const old = envelope.manifest.shards.filter((shard: any) => shard.kind === 'assessment');
    const value = JSON.parse(Buffer.concat(await Promise.all(old.map((shard: any) => fs.readFile(path.join(reportDir(), shard.filename))))).toString('utf8'));
    mutate(value);
    const bytes = Buffer.from(JSON.stringify(value)), shards: any[] = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += limits.maxShardBytes, index++) {
      const chunk = bytes.subarray(offset, offset + limits.maxShardBytes), part = `assessment-${index}.part`;
      await fs.writeFile(path.join(reportDir(), part), chunk);
      shards.push({kind: 'assessment', index, filename: part, byteSize: chunk.length,
        sha256: createHash('sha256').update(chunk).digest('hex')});
    }
    envelope.manifest.shards = [...envelope.manifest.shards.filter((shard: any) => shard.kind === 'report'), ...shards];
    envelope.manifest.payloadBytes = envelope.manifest.shards.reduce((sum: number, shard: any) => sum + shard.byteSize, 0);
    envelope.sha256 = hash(JSON.stringify(envelope.manifest));
    await fs.writeFile(filename, JSON.stringify(envelope));
    expect(await archive.load(sample.ownerKey, sample.reportId)).toBeNull();
  });
});
