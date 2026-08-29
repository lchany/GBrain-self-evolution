import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureCandidate, Sensitivity, SuggestedType, Verification } from './gbrain-capture-candidate.ts';
import { assertInboxSlug, assertSafeCandidate } from './gbrain-capture-candidate.ts';

export interface OfflineCaptureRecord {
  readonly schema_version: 1;
  readonly queued_at: string;
  readonly reason: string;
  readonly candidate: CaptureCandidate;
}

export function offlineDir(cwd: string): string {
  return join(cwd, '.omo', 'gbrain-capture', 'offline');
}

export function writeOfflineCandidate(cwd: string, candidate: CaptureCandidate, reason: string, now: Date): string {
  const dir = offlineDir(cwd);
  mkdirSync(dir, { recursive: true });
  const digest = createHash('sha256').update(JSON.stringify(candidate)).digest('hex').slice(0, 8);
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const tail = candidate.slug.slice('inbox/'.length);
  const filePath = join(dir, `${stamp}-${tail}-${digest}.json`);
  const record: OfflineCaptureRecord = {
    schema_version: 1,
    queued_at: now.toISOString(),
    reason,
    candidate,
  };
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function listOfflineCandidateFiles(cwd: string): readonly string[] {
  const dir = offlineDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

export function readOfflineCandidate(filePath: string): OfflineCaptureRecord {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  const record = parseRecord(parsed);
  assertSafeCandidate(record.candidate);
  return record;
}

export function removeOfflineCandidate(filePath: string): void {
  rmSync(filePath, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): OfflineCaptureRecord {
  if (!isRecord(value)) throw new Error('offline capture record must be an object');
  if (value.schema_version !== 1) throw new Error('unsupported offline capture schema_version');
  if (typeof value.queued_at !== 'string') throw new Error('offline capture queued_at is required');
  if (typeof value.reason !== 'string') throw new Error('offline capture reason is required');
  const candidate = parseCandidate(value.candidate);
  return { schema_version: 1, queued_at: value.queued_at, reason: value.reason, candidate };
}

function parseCandidate(value: unknown): CaptureCandidate {
  if (!isRecord(value)) throw new Error('offline capture candidate must be an object');
  const evidence = value.evidence_refs;
  if (!Array.isArray(evidence) || !evidence.every((ref) => typeof ref === 'string')) {
    throw new Error('offline capture evidence_refs must be strings');
  }
  if (value.schema_version !== 1) throw new Error('unsupported candidate schema_version');
  if (typeof value.title !== 'string') throw new Error('candidate title is required');
  if (typeof value.summary !== 'string') throw new Error('candidate summary is required');
  if (typeof value.created_at !== 'string') throw new Error('candidate created_at is required');
  if (typeof value.slug !== 'string') throw new Error('candidate slug is required');
  const base = {
    schema_version: 1 as const,
    title: value.title,
    suggested_type: value.suggested_type as SuggestedType,
    summary: value.summary,
    evidence_refs: evidence,
    requested_verification: value.requested_verification as Verification,
    verification: 'unverified' as const,
    sensitivity: value.sensitivity as Sensitivity,
    created_at: value.created_at,
    slug: assertInboxSlug(value.slug),
  };
  return typeof value.project_id === 'string' ? { ...base, project_id: value.project_id } : base;
}
