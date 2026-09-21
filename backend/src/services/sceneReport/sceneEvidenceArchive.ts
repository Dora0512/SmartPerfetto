// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash, randomUUID} from 'crypto';
import {constants, promises as fs} from 'fs';
import path from 'path';
import {TextDecoder} from 'util';
import type {SceneTimelineAssessment} from '../../agent/scene/sceneTimelineContract';
import {isSceneTimelineHistoricalAssessment} from './sceneTimelineHistoricalSchema';

export interface SceneArchiveCacheIdentity {
  traceContentHash: string | null;
  requestedRange: {startNs: string; endNs: string};
  schemaVersion: string;
  ruleVersion: string;
  producerFingerprint: string;
  traceProcessorFingerprint: string;
  outputLanguage: 'en' | 'zh-CN';
}
export interface SceneEvidenceArchiveLimits {
  maxShardBytes: number; maxReportBytes: number; maxOwnerBytes: number;
  maxReportsPerOwner: number; maxShardsPerReport: number; maxManifestBytes: number; ttlMs: number;
}
export const DEFAULT_SCENE_ARCHIVE_LIMITS: Readonly<SceneEvidenceArchiveLimits> = Object.freeze({
  maxShardBytes: 262_144, maxReportBytes: 33_554_432, maxOwnerBytes: 268_435_456,
  maxReportsPerOwner: 64, maxShardsPerReport: 256, maxManifestBytes: 131_072, ttlMs: 604_800_000,
});
interface ArchiveShard {kind: 'report' | 'assessment'; index: number; filename: string; byteSize: number; sha256: string}
export interface SceneEvidenceArchiveManifest {
  schemaVersion: 'scene_evidence_archive@3';
  ownerPartition: string; reportId: string; traceId: string;
  createdAt: number; expiresAt: number; payloadBytes: number;
  cacheIdentity: SceneArchiveCacheIdentity;
  providerProvenance?: {providerId?: string | null; model?: string; runtime?: string};
  shards: ArchiveShard[];
}
export interface SceneEvidenceArchiveRef {
  schemaVersion: 'scene_evidence_archive_ref@1'; reportId: string; ownerPartition: string;
  manifestSha256: string; byteSize: number; expiresAt: number;
}
export interface SceneEvidenceArchiveInput {
  ownerKey: string; traceId: string; reportId: string; report: unknown; assessment: SceneTimelineAssessment;
  cacheIdentity: SceneArchiveCacheIdentity;
  providerProvenance?: SceneEvidenceArchiveManifest['providerProvenance'];
}
export interface ArchivedSceneEvidence {
  /** Historical JSON only. Deserialization never issues execution witnesses or publication authority. */
  report: unknown; assessment: SceneTimelineAssessment; manifest: SceneEvidenceArchiveManifest;
}
type AssertCurrent = () => void | Promise<void>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const ns = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const fail = (code: string): never => {throw new Error(code);};
function identityValid(value: unknown): value is SceneArchiveCacheIdentity {
  return record(value) && (value.traceContentHash === null || digest(value.traceContentHash)) &&
    record(value.requestedRange) && ns(value.requestedRange.startNs) && ns(value.requestedRange.endNs) &&
    BigInt(value.requestedRange.startNs) <= BigInt(value.requestedRange.endNs) &&
    ['schemaVersion', 'ruleVersion', 'producerFingerprint', 'traceProcessorFingerprint'].every(key => text(value[key])) &&
    ['en', 'zh-CN'].includes(String(value.outputLanguage));
}

/**
 * Immutable, bounded history archive. Use one instance/process per private root.
 * Owner queues cover reservation, temporary files and commit; a manifest is the
 * only commit marker. This class does not authorize publication or restore proof.
 */
export class SceneEvidenceArchive {
  readonly limits: Readonly<SceneEvidenceArchiveLimits>;
  private readonly root: string;
  private realRoot?: string;
  private initialization?: Promise<void>;
  private readonly ownerQueues = new Map<string, Promise<void>>();
  private readonly reservations = new Map<string, number>();
  private readonly deletedTraces = new Set<string>();
  private readonly tombstoneQueues = new Map<string, Promise<void>>();

  constructor(rootDir: string, limits: Partial<SceneEvidenceArchiveLimits> = {}) {
    if (!rootDir.trim()) fail('scene_archive_invalid_root');
    this.root = path.resolve(rootDir);
    this.limits = Object.freeze({...DEFAULT_SCENE_ARCHIVE_LIMITS, ...limits});
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0) ||
        this.limits.maxShardBytes > this.limits.maxReportBytes || this.limits.maxReportBytes > this.limits.maxOwnerBytes) {
      fail('scene_archive_invalid_limits');
    }
  }
  private partition(ownerKey: string): string {
    if (!text(ownerKey) || !ownerKey.trim()) fail('scene_archive_invalid_owner');
    return hash(ownerKey);
  }
  private reportKey(reportId: string): string {
    if (!text(reportId) || !/^[A-Za-z0-9_-]{1,256}$/.test(reportId)) fail('scene_archive_invalid_report_id');
    return hash(reportId);
  }
  private traceKey(traceId: string): string {
    if (!text(traceId) || !traceId.trim()) fail('scene_archive_invalid_trace_id');
    return hash(traceId);
  }
  private async directory(directory: string, create = false): Promise<void> {
    if (create) await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('scene_archive_unsafe_directory');
  }
  private async assertRoot(): Promise<void> {
    await this.directory(this.root);
    if (await fs.realpath(this.root) !== this.realRoot) fail('scene_archive_root_changed');
    await this.directory(path.join(this.root, 'owners'));
    await this.directory(path.join(this.root, 'tombstones'));
  }
  private ready(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      await this.directory(this.root, true);
      this.realRoot = await fs.realpath(this.root);
      await this.directory(path.join(this.root, 'owners'), true);
      await this.directory(path.join(this.root, 'tombstones'), true);
      await this.reapAll(Date.now());
      // No writer passes ready() until this startup-only orphan sweep finishes.
      for (const filename of await fs.readdir(path.join(this.root, 'tombstones'))) {
        if (filename.startsWith('.pending-')) await fs.unlink(path.join(this.root, 'tombstones', filename)).catch(() => undefined);
      }
    })();
    return this.initialization;
  }
  private enqueue<T>(partition: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.ownerQueues.get(partition) || Promise.resolve()).then(operation);
    const tail = next.then(() => undefined, () => undefined);
    this.ownerQueues.set(partition, tail);
    void tail.then(() => {if (this.ownerQueues.get(partition) === tail) this.ownerQueues.delete(partition);});
    return next;
  }
  private async readFile(filename: string, maxBytes: number): Promise<Buffer> {
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('scene_archive_unsafe_file');
      const content = await handle.readFile();
      if (content.length !== stat.size || content.length > maxBytes) fail('scene_archive_file_changed');
      return content;
    } finally {await handle.close();}
  }
  private async writeFile(filename: string, data: Buffer): Promise<void> {
    const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {await handle.writeFile(data); await handle.sync();} finally {await handle.close();}
  }
  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {await handle.sync();} finally {await handle.close();}
  }
  private async traceDeleted(traceId: string): Promise<boolean> {
    const key = this.traceKey(traceId);
    if (this.deletedTraces.has(key)) return true;
    try {
      // Any tombstone, including a corrupt marker, fails closed. Never follow it.
      await fs.lstat(path.join(this.root, 'tombstones', `${key}.json`));
      this.deletedTraces.add(key);
      return true;
    } catch (error) {if (isMissing(error)) return false; throw error;}
  }
  private async assertSaveCurrent(traceId: string, assertCurrent: AssertCurrent): Promise<void> {
    await assertCurrent();
    await this.assertRoot();
    if (await this.traceDeleted(traceId)) fail('scene_archive_trace_deleted');
  }
  private async removeEntry(filename: string): Promise<void> {
    // fs.rm removes a symlink itself, never its target. Parents are checked by callers.
    await fs.rm(filename, {recursive: true, force: true});
  }

  async save(input: SceneEvidenceArchiveInput, assertCurrent: AssertCurrent): Promise<SceneEvidenceArchiveRef> {
    const {traceId, reportId} = input;
    const partition = this.partition(input.ownerKey), reportKey = this.reportKey(reportId);
    this.traceKey(traceId);
    if (!identityValid(input.cacheIdentity) || !isSceneTimelineHistoricalAssessment(input.assessment, {
      traceId, ownerPartition: partition, requestedRange: input.cacheIdentity.requestedRange, maxBytes: this.limits.maxReportBytes,
    })) fail('scene_archive_invalid_payload');
    // Snapshot caller-owned objects before the first await.
    const report = Buffer.from(JSON.stringify(input.report) ?? fail('scene_archive_invalid_report'));
    const assessment = Buffer.from(JSON.stringify(input.assessment));
    const cacheIdentity: SceneArchiveCacheIdentity = JSON.parse(JSON.stringify(input.cacheIdentity));
    const providerProvenance = input.providerProvenance === undefined ? undefined : JSON.parse(JSON.stringify(input.providerProvenance));
    if (report.length + assessment.length > this.limits.maxReportBytes) fail('scene_archive_report_quota');
    await this.ready();
    return this.enqueue(partition, async () => {
      await this.assertSaveCurrent(traceId, assertCurrent);
      const ownerDir = path.join(this.root, 'owners', partition);
      await this.directory(ownerDir, true);
      await this.reapOwner(partition, Date.now());
      const destination = path.join(ownerDir, reportKey);
      try {await fs.lstat(destination); fail('scene_archive_report_exists');} catch (error) {if (!isMissing(error)) throw error;}
      const shards: ArchiveShard[] = [], buffers: Buffer[] = [];
      for (const [kind, data] of [['report', report], ['assessment', assessment]] as const) {
        for (let start = 0, index = 0; start < data.length; start += this.limits.maxShardBytes, index++) {
          const chunk = data.subarray(start, start + this.limits.maxShardBytes);
          shards.push({kind, index, filename: `${kind}-${index}.part`, byteSize: chunk.length, sha256: hash(chunk)});
          buffers.push(chunk);
        }
      }
      if (shards.length > this.limits.maxShardsPerReport) fail('scene_archive_shard_quota');
      const createdAt = Date.now(), expiresAt = createdAt + this.limits.ttlMs;
      if (!Number.isSafeInteger(expiresAt)) fail('scene_archive_invalid_expiry');
      const manifest: SceneEvidenceArchiveManifest = {schemaVersion: 'scene_evidence_archive@3', ownerPartition: partition,
        reportId, traceId, createdAt, expiresAt,
        payloadBytes: report.length + assessment.length, cacheIdentity, ...(providerProvenance ? {providerProvenance} : {}), shards};
      const manifestSha256 = hash(JSON.stringify(manifest));
      const manifestBytes = Buffer.from(JSON.stringify({manifest, sha256: manifestSha256}));
      const byteSize = manifest.payloadBytes + manifestBytes.length;
      if (manifestBytes.length > this.limits.maxManifestBytes || byteSize > this.limits.maxReportBytes) fail('scene_archive_report_quota');
      const usage = await this.ownerUsage(ownerDir);
      if (usage.count >= this.limits.maxReportsPerOwner ||
          usage.bytes + (this.reservations.get(partition) || 0) + byteSize > this.limits.maxOwnerBytes) fail('scene_archive_owner_quota');
      this.reservations.set(partition, byteSize);
      const pending = path.join(ownerDir, `.pending-${reportKey}-${randomUUID()}`);
      let committed = false;
      try {
        await fs.mkdir(pending, {mode: 0o700});
        for (let index = 0; index < shards.length; index++) {
          await this.assertSaveCurrent(traceId, assertCurrent);
          await this.writeFile(path.join(pending, shards[index].filename), buffers[index]);
        }
        await this.assertSaveCurrent(traceId, assertCurrent);
        await this.writeFile(path.join(pending, 'manifest.json'), manifestBytes);
        await this.syncDirectory(pending);
        await this.assertSaveCurrent(traceId, assertCurrent);
        await fs.rename(pending, destination);
        committed = true;
        await this.syncDirectory(ownerDir);
        await this.assertSaveCurrent(traceId, assertCurrent);
        return Object.freeze({schemaVersion: 'scene_evidence_archive_ref@1', reportId,
          ownerPartition: partition, manifestSha256, byteSize, expiresAt});
      } catch (error) {
        if (committed) {
          // Remove the commit marker first, even if reaping the data subsequently fails.
          await fs.unlink(path.join(destination, 'manifest.json')).catch(() => undefined);
          await this.removeEntry(destination).catch(() => undefined);
        }
        await this.removeEntry(pending).catch(() => undefined);
        throw error;
      } finally {this.reservations.delete(partition);}
    });
  }

  private validManifest(value: unknown, partition: string, reportKey: string, now: number): value is SceneEvidenceArchiveManifest {
    if (!record(value) || value.schemaVersion !== 'scene_evidence_archive@3' || value.ownerPartition !== partition ||
        !text(value.reportId) || hash(value.reportId) !== reportKey || !text(value.traceId) ||
        !integer(value.createdAt) || !integer(value.expiresAt) || value.expiresAt <= now || value.expiresAt <= value.createdAt ||
        value.expiresAt - value.createdAt > this.limits.ttlMs || !integer(value.payloadBytes) ||
        value.payloadBytes > this.limits.maxReportBytes || !identityValid(value.cacheIdentity) ||
        !Array.isArray(value.shards) || value.shards.length < 2 || value.shards.length > this.limits.maxShardsPerReport) return false;
    const indices = {report: 0, assessment: 0};
    let bytes = 0;
    for (const shard of value.shards) {
      if (!record(shard) || (shard.kind !== 'report' && shard.kind !== 'assessment') ||
          shard.index !== indices[shard.kind]++ || shard.filename !== `${shard.kind}-${shard.index}.part` ||
          !integer(shard.byteSize) || shard.byteSize === 0 || shard.byteSize > this.limits.maxShardBytes || !digest(shard.sha256)) return false;
      bytes += shard.byteSize;
    }
    return indices.report > 0 && indices.assessment > 0 && bytes === value.payloadBytes;
  }
  private async readCommitted(partition: string, reportKey: string, now: number): Promise<ArchivedSceneEvidence | null> {
    try {
      await this.assertRoot();
      const ownerDir = path.join(this.root, 'owners', partition), directory = path.join(ownerDir, reportKey);
      await this.directory(ownerDir); await this.directory(directory);
      const bytes = await this.readFile(path.join(directory, 'manifest.json'), this.limits.maxManifestBytes);
      const envelope: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (!record(envelope) || !digest(envelope.sha256) || hash(JSON.stringify(envelope.manifest)) !== envelope.sha256 ||
          !this.validManifest(envelope.manifest, partition, reportKey, now)) return null;
      const manifest = envelope.manifest;
      if (manifest.payloadBytes + bytes.length > this.limits.maxReportBytes || await this.traceDeleted(manifest.traceId)) return null;
      const chunks: Record<'report' | 'assessment', Buffer[]> = {report: [], assessment: []};
      for (const shard of manifest.shards) {
        const chunk = await this.readFile(path.join(directory, shard.filename), this.limits.maxShardBytes);
        if (chunk.length !== shard.byteSize || hash(chunk) !== shard.sha256) return null;
        chunks[shard.kind].push(chunk);
      }
      const decode = (value: Buffer[]) => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(value)));
      const report: unknown = decode(chunks.report), assessment: unknown = decode(chunks.assessment);
      if (!isSceneTimelineHistoricalAssessment(assessment, {traceId: manifest.traceId, ownerPartition: partition,
        requestedRange: manifest.cacheIdentity.requestedRange, maxBytes: this.limits.maxReportBytes}) ||
          await this.traceDeleted(manifest.traceId)) return null;
      return {report, assessment, manifest};
    } catch {return null;}
  }
  async load(ownerKey: string, reportId: string): Promise<ArchivedSceneEvidence | null> {
    const partition = this.partition(ownerKey), reportKey = this.reportKey(reportId);
    try {await this.ready(); return await this.readCommitted(partition, reportKey, Date.now());} catch {return null;}
  }
  async deleteReport(ownerKey: string, reportId: string): Promise<void> {
    const partition = this.partition(ownerKey), key = this.reportKey(reportId);
    await this.ready();
    await this.enqueue(partition, async () => {
      await this.assertRoot();
      const ownerDir = path.join(this.root, 'owners', partition);
      try {await this.directory(ownerDir);} catch (error) {if (isMissing(error)) return; throw error;}
      await this.removeEntry(path.join(ownerDir, key));
    });
  }
  markTraceDeleted(traceId: string): void {this.deletedTraces.add(this.traceKey(traceId));}
  async invalidateTrace({traceId}: {traceId: string; tenantId?: string; workspaceId?: string}): Promise<void> {
    this.markTraceDeleted(traceId);
    const key = this.traceKey(traceId);
    const next = (this.tombstoneQueues.get(key) || Promise.resolve()).then(async () => {
      await this.ready(); await this.assertRoot();
      const directory = path.join(this.root, 'tombstones'), pending = path.join(directory, `.pending-${key}-${randomUUID()}`);
      try {
        await this.writeFile(pending, Buffer.from(JSON.stringify({schemaVersion: 'scene_trace_deleted@1', traceId, deletedAt: Date.now()})));
        await fs.rename(pending, path.join(directory, `${key}.json`));
        await this.syncDirectory(directory);
      } finally {await fs.unlink(pending).catch(() => undefined);}
      await this.reapAll(Date.now());
    });
    const tail = next.then(() => undefined, () => undefined);
    this.tombstoneQueues.set(key, tail);
    void tail.then(() => {if (this.tombstoneQueues.get(key) === tail) this.tombstoneQueues.delete(key);});
    return next;
  }
  private async ownerUsage(ownerDir: string): Promise<{bytes: number; count: number}> {
    let bytes = 0, count = 0;
    for (const entry of await fs.readdir(ownerDir, {withFileTypes: true})) {
      const entryPath = path.join(ownerDir, entry.name), info = await fs.lstat(entryPath);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('scene_archive_unsafe_owner_entry');
      count++;
      for (const child of await fs.readdir(entryPath)) {
        const stat = await fs.lstat(path.join(entryPath, child));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('scene_archive_unsafe_file');
        bytes += stat.size;
      }
    }
    return {bytes, count};
  }
  private async reapOwner(partition: string, now: number): Promise<void> {
    const ownerDir = path.join(this.root, 'owners', partition);
    await this.directory(ownerDir);
    for (const entry of await fs.readdir(ownerDir, {withFileTypes: true})) {
      const directory = path.join(ownerDir, entry.name);
      if (!digest(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {await this.removeEntry(directory); continue;}
      const loaded = await this.readCommitted(partition, entry.name, now);
      if (!loaded) {await this.removeEntry(directory); continue;}
      const retained = new Set(['manifest.json', ...loaded.manifest.shards.map(shard => shard.filename)]);
      for (const filename of await fs.readdir(directory)) if (!retained.has(filename)) await this.removeEntry(path.join(directory, filename));
    }
  }
  private async reapAll(now: number): Promise<void> {
    await this.assertRoot();
    for (const entry of await fs.readdir(path.join(this.root, 'owners'), {withFileTypes: true})) {
      if (!digest(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        await this.removeEntry(path.join(this.root, 'owners', entry.name)); continue;
      }
      await this.enqueue(entry.name, () => this.reapOwner(entry.name, now));
    }
  }
  async cleanupExpired(now = Date.now()): Promise<void> {
    if (!integer(now)) fail('scene_archive_invalid_time');
    await this.ready(); await this.reapAll(now);
  }
}
