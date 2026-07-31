import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isTrustedDotfile } from './path-confine.ts';

export const PROJECT_ID_RE = /^prj-[0-9a-f]{16}$/;
export const PROJECT_MARKER = '.gbrain-project.yaml';

export interface ProjectMarker {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly marker_path: string;
}

export function assertProjectId(value: string): string {
  if (!PROJECT_ID_RE.test(value)) {
    throw new Error(`project_id_invalid: expected prj- followed by 16 lowercase hexadecimal characters`);
  }
  return value;
}

export function generateProjectId(): string {
  return `prj-${randomBytes(8).toString('hex')}`;
}

export function deriveProjectIdFromCreationKey(sourceId: string, creationKey: string): string {
  const digest = createHash('sha256')
    .update(sourceId)
    .update('\0')
    .update(creationKey)
    .digest('hex');
  return `prj-${digest.slice(0, 16)}`;
}

export function buildProjectMarker(projectId: string): string {
  return `schema_version: 1\nproject_id: ${assertProjectId(projectId)}\n`;
}

export function readProjectMarker(startDir: string = process.cwd()): ProjectMarker | null {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 50; depth++) {
    const markerPath = join(dir, PROJECT_MARKER);
    try {
      const stat = lstatSync(markerPath);
      if (!isTrustedDotfile(stat)) return null;
      const marker = parseProjectMarker(readFileSync(markerPath, 'utf8'));
      return marker === null ? null : { ...marker, marker_path: markerPath };
    } catch (error) {
      if (!isMissingFileError(error)) return null;
      // Missing marker: continue walking toward the project root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function writeProjectMarker(projectRoot: string, projectId: string): string {
  const root = resolve(projectRoot);
  const markerPath = join(root, PROJECT_MARKER);
  const existing = existsSync(markerPath) ? readProjectMarker(root) : null;
  if (existing !== null && existing.marker_path === markerPath) {
    if (existing.project_id === projectId) return markerPath;
    throw new Error(`project_binding_conflict: ${markerPath} is already bound to ${existing.project_id}`);
  }
  if (existsSync(markerPath)) {
    throw new Error(`project_marker_invalid: refusing to replace ${markerPath}`);
  }
  const tempPath = join(root, `.${PROJECT_MARKER}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, buildProjectMarker(projectId), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    linkSync(tempPath, markerPath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* link or cleanup already completed */ }
  }
  return markerPath;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function normalizeRepositoryRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  const canonical = /^([a-z0-9.-]+)\/([a-z0-9._~/-]+)$/i.exec(trimmed);
  let host: string;
  let path: string;
  if (scp && !trimmed.includes('://')) {
    host = scp[1];
    path = scp[2];
  } else if (canonical) {
    host = canonical[1];
    path = canonical[2];
  } else {
    try {
      const url = new URL(trimmed);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      if (url.password || url.search || url.hash || (url.username && url.protocol !== 'ssh:')) return null;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const normalizedPath = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
  const segments = normalizedPath.split('/');
  if (!host || segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return `${host.toLowerCase()}/${normalizedPath}`;
}

function parseProjectMarker(content: string): Omit<ProjectMarker, 'marker_path'> | null {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 2 || lines[0].trim() !== 'schema_version: 1') return null;
  const match = /^project_id:\s*(\S+)\s*$/.exec(lines[1]);
  if (!match || !PROJECT_ID_RE.test(match[1])) return null;
  return { schema_version: 1, project_id: match[1] };
}
