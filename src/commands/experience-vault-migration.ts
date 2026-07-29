import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { posix } from 'node:path';
import matter from 'gray-matter';

export type LegacyRecordType =
  | 'project'
  | 'incident'
  | 'knowledge'
  | 'runbook'
  | 'decision'
  | 'environment'
  | 'agent-skill';

export interface LegacyRecord {
  readonly relativePath: string;
  readonly rawSha256: string;
  readonly title: string;
  readonly type: LegacyRecordType;
  readonly date: string;
  readonly content: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly counts: Readonly<Record<string, number>>;
}

export interface BuiltLegacyPage {
  readonly slug: string;
  readonly markdown: string;
  readonly rawSha256: string;
  readonly references: {
    readonly resolved: number;
    readonly unresolved: number;
  };
  readonly redactions: Readonly<Record<string, number>>;
}

export interface ExistingLegacyPage {
  readonly slug: string;
  readonly migratedFrom: string;
  readonly rawSha256: string;
}

export interface LegacyReconciliationPlan {
  readonly reuse: readonly ExistingLegacyPage[];
  readonly write: readonly LegacyRecord[];
  readonly deleteAfterVerifiedWrites: readonly string[];
}

export interface LegacyInventory {
  readonly core: readonly LegacyRecord[];
  readonly pending: readonly LegacyRecord[];
}

export type MigrationToolCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const CORE_FAMILIES = new Set(['projects', 'incidents', 'knowledge', 'runbooks']);
const HASH_MARKER = 'legacy-vault-sha256';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function increment(counts: Record<string, number>, category: string, amount: number): void {
  if (amount > 0) counts[category] = (counts[category] ?? 0) + amount;
}

function replaceCounted(
  text: string,
  pattern: RegExp,
  replacement: string,
  category: string,
  counts: Record<string, number>,
): string {
  let matches = 0;
  const replaced = text.replace(pattern, () => {
    matches += 1;
    return replacement;
  });
  increment(counts, category, matches);
  return replaced;
}

export function redactLegacyText(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;

  text = replaceCounted(
    text,
    /```(?:log|console|output|text)\s*\n[\s\S]*?```/gi,
    '[REDACTED_RAW_LOG_BLOCK]',
    'raw_log_block',
    counts,
  );
  text = replaceCounted(
    text,
    /\b(?:authorization\s*:\s*bearer|bearer)\s+[^\s"'`]+/gi,
    '[REDACTED_CREDENTIAL]',
    'credential',
    counts,
  );
  text = replaceCounted(
    text,
    /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s"'`]+/gi,
    '[REDACTED_CREDENTIAL]',
    'credential',
    counts,
  );
  text = replaceCounted(
    text,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_CREDENTIAL]',
    'credential',
    counts,
  );
  text = replaceCounted(
    text,
    /(?<![\w.])(?!(?:127|0)\.)(?!(?:10|192\.168)\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g,
    '[REDACTED_NETWORK_ADDRESS]',
    'network_address',
    counts,
  );
  text = replaceCounted(
    text,
    /(?<![\w])(?:\/(?:home|Users|root|workspace|workspaces|srv|opt|var\/lib)\/[^\s"'`),\]]+)/g,
    '[REDACTED_ABSOLUTE_PATH]',
    'absolute_path',
    counts,
  );

  return { text, counts };
}

export function sanitizeLegacyPath(relativePath: string): string {
  const normalized = posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^(\.\.\/)+/, '');
  const family = normalized.split('/')[0] ?? 'legacy';
  const safeFamily = CORE_FAMILIES.has(family)
    || family === 'share-candidates'
    || family === 'reference-config'
    ? family
    : 'legacy-artifacts';
  const extension = normalized.toLowerCase().endsWith('.md') ? '.md' : '';
  return `${safeFamily}/redacted-${extension ? 'record.md' : 'artifact'}`;
}

export function legacySlug(relativePath: string): string {
  const normalized = posix.normalize(relativePath.replaceAll('\\', '/'));
  const readable = normalized
    .replace(/\.(?:md|markdown)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 220)
    .replace(/-+$/g, '') || 'legacy-record';
  return `legacy-migration/${readable}-${sha256(normalized).slice(0, 10)}`;
}

function pendingSlug(relativePath: string): string {
  return `inbox/legacy-pending-record-${sha256(posix.normalize(relativePath)).slice(0, 10)}`;
}

function archivePointer(commit: string, relativePath: string): string {
  return `legacy-archive:${commit}:${sanitizeLegacyPath(relativePath)}`;
}

function resolveReferencePath(sourcePath: string, reference: string): string {
  const withoutAnchor = reference.split('#', 1)[0] ?? reference;
  return posix.normalize(posix.join(posix.dirname(sourcePath), withoutAnchor));
}

function convertReferences(
  content: string,
  sourcePath: string,
  archiveCommit: string,
  importedPathToSlug: ReadonlyMap<string, string>,
): {
  readonly text: string;
  readonly resolved: number;
  readonly unresolved: number;
} {
  let resolved = 0;
  let unresolved = 0;

  let text = content.replace(
    /\[[^\]]+\]\(([^)]+\.(?:md|markdown))(?:#[^)]*)?\)/gi,
    (_match, rawReference: string) => {
      const target = resolveReferencePath(sourcePath, rawReference);
      const slug = importedPathToSlug.get(target);
      if (slug) {
        resolved += 1;
        return `[[${slug}]]`;
      }
      unresolved += 1;
      return archivePointer(archiveCommit, target);
    },
  );

  text = text.replace(
    /`((?:projects|incidents|knowledge|runbooks|share-candidates|reference-config)\/[^`\s]+)`/gi,
    (_match, rawReference: string) => {
      const target = posix.normalize(rawReference);
      const slug = importedPathToSlug.get(target);
      if (slug) {
        resolved += 1;
        return `[[${slug}]]`;
      }
      unresolved += 1;
      return archivePointer(archiveCommit, target);
    },
  );

  return { text, resolved, unresolved };
}

function migratedFrontmatter(record: LegacyRecord, archiveCommit: string): Record<string, unknown> {
  const sourcePath = sanitizeLegacyPath(record.relativePath);
  return {
    type: record.type,
    date: record.date,
    status: 'migrated-legacy',
    sensitivity: 'internal',
    verification: 'unverified',
    applicability: ['legacy-migration'],
    non_applicable: [],
    source_refs: [archivePointer(archiveCommit, record.relativePath)],
    migrated_from: sourcePath,
  };
}

export function buildLegacyPage(
  record: LegacyRecord,
  options: {
    readonly archiveCommit: string;
    readonly importedPathToSlug: ReadonlyMap<string, string>;
  },
): BuiltLegacyPage {
  const references = convertReferences(
    record.content,
    record.relativePath,
    options.archiveCommit,
    options.importedPathToSlug,
  );
  const redacted = redactLegacyText(references.text);
  const body = [
    `# ${redactLegacyText(record.title).text}`,
    '',
    redacted.text.trim(),
    '',
    `Migration identity: \`${HASH_MARKER}:${record.rawSha256}\``,
    '',
  ].join('\n');

  return {
    slug: legacySlug(record.relativePath),
    markdown: matter.stringify(body, migratedFrontmatter(record, options.archiveCommit)),
    rawSha256: record.rawSha256,
    references: {
      resolved: references.resolved,
      unresolved: references.unresolved,
    },
    redactions: redacted.counts,
  };
}

export function buildPendingDraft(
  record: LegacyRecord,
  archiveCommit: string,
): BuiltLegacyPage {
  const redacted = redactLegacyText(record.content);
  const body = [
    `# ${redactLegacyText(record.title).text}`,
    '',
    redacted.text.trim(),
    '',
    `Migration identity: \`${HASH_MARKER}:${record.rawSha256}\``,
    '',
  ].join('\n');
  const markdown = matter.stringify(body, {
    type: record.type,
    date: record.date,
    status: 'draft',
    sensitivity: 'internal',
    verification: 'unverified',
    applicability: ['pending-human-review'],
    non_applicable: [],
    source_refs: [archivePointer(archiveCommit, record.relativePath)],
    migrated_from: null,
  });
  return {
    slug: pendingSlug(record.relativePath),
    markdown,
    rawSha256: record.rawSha256,
    references: { resolved: 0, unresolved: 0 },
    redactions: redacted.counts,
  };
}

export function planLegacyReconciliation(
  current: readonly LegacyRecord[],
  existing: readonly ExistingLegacyPage[],
): LegacyReconciliationPlan {
  const existingBySlug = new Map(existing.map((page) => [page.slug, page]));
  const currentSlugs = new Set(current.map((record) => legacySlug(record.relativePath)));
  const reuse: ExistingLegacyPage[] = [];
  const write: LegacyRecord[] = [];

  for (const record of current) {
    const expectedSlug = legacySlug(record.relativePath);
    const page = existingBySlug.get(expectedSlug);
    if (page?.rawSha256 === record.rawSha256) reuse.push(page);
    else write.push(record);
  }

  const deleteAfterVerifiedWrites = existing
    .filter((page) => !currentSlugs.has(page.slug))
    .map((page) => page.slug);

  return { reuse, write, deleteAfterVerifiedWrites };
}

function walkMarkdown(root: string, relativeDirectory: string): string[] {
  const absoluteDirectory = posix.join(root, relativeDirectory);
  const results: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results;
    throw error;
  }
  for (const entry of entries) {
    const relativePath = posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) results.push(...walkMarkdown(root, relativePath));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) results.push(relativePath);
  }
  return results.sort();
}

function normalizeDate(value: unknown, relativePath: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const pathDate = relativePath.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (pathDate) return pathDate;
  throw new Error(`legacy record has no valid date: ${sanitizeLegacyPath(relativePath)}`);
}

function normalizeType(value: unknown, relativePath: string): LegacyRecordType {
  const allowed: readonly LegacyRecordType[] = [
    'project',
    'incident',
    'knowledge',
    'runbook',
    'decision',
    'environment',
    'agent-skill',
  ];
  if (typeof value === 'string' && allowed.includes(value as LegacyRecordType)) {
    return value as LegacyRecordType;
  }
  const family = relativePath.split('/')[0];
  const familyType = family === 'projects' ? 'project'
    : family === 'incidents' ? 'incident'
      : family === 'knowledge' ? 'knowledge'
        : family === 'runbooks' ? 'runbook'
          : null;
  if (familyType) return familyType;
  throw new Error(`legacy record has no valid type: ${sanitizeLegacyPath(relativePath)}`);
}

function loadRecord(root: string, relativePath: string): LegacyRecord {
  const raw = readFileSync(posix.join(root, relativePath), 'utf8');
  const parsed = matter(raw);
  const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
    ? parsed.data.title.trim()
    : posix.basename(relativePath).replace(/\.md$/i, '');
  return {
    relativePath,
    rawSha256: sha256(raw),
    title,
    type: normalizeType(parsed.data.type, relativePath),
    date: normalizeDate(parsed.data.date, relativePath),
    content: parsed.content,
  };
}

export function loadLegacyInventory(root: string): LegacyInventory {
  const corePaths = [...CORE_FAMILIES]
    .flatMap((family) => walkMarkdown(root, family))
    .sort();
  const pendingPaths = walkMarkdown(root, 'share-candidates');
  return {
    core: corePaths.map((relativePath) => loadRecord(root, relativePath)),
    pending: pendingPaths.map((relativePath) => loadRecord(root, relativePath)),
  };
}

function pageText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const record = result as Record<string, unknown>;
  const parts = [record.compiled_truth, record.timeline, record.content]
    .filter((value): value is string => typeof value === 'string');
  return parts.join('\n');
}

async function writeAndVerifyPage(
  page: BuiltLegacyPage,
  callTool: MigrationToolCaller,
): Promise<void> {
  await callTool('search', {
    query: page.slug,
    include_prefixes: [page.slug],
    limit: 5,
  });
  await callTool('put_page', { slug: page.slug, content: page.markdown });
  const readBack = await callTool('get_page', { slug: page.slug });
  const slug = typeof readBack === 'object' && readBack !== null
    ? (readBack as Record<string, unknown>).slug
    : undefined;
  if (slug !== page.slug || !pageText(readBack).includes(`${HASH_MARKER}:${page.rawSha256}`)) {
    throw new Error(`round-trip verification failed for ${page.slug}`);
  }
}

export async function applyLegacyPages(options: {
  readonly pages: readonly BuiltLegacyPage[];
  readonly staleSlugs: readonly string[];
  readonly callTool: MigrationToolCaller;
  readonly sampleSize?: number;
}): Promise<{ readonly written: number; readonly verified: number; readonly deleted: number }> {
  const sampleSize = Math.min(
    Math.max(options.sampleSize ?? 8, 0),
    options.pages.length,
  );
  const sample = options.pages.slice(0, sampleSize);
  const remainder = options.pages.slice(sampleSize);
  let verified = 0;

  for (const page of sample) {
    await writeAndVerifyPage(page, options.callTool);
    verified += 1;
  }
  for (const page of remainder) {
    await writeAndVerifyPage(page, options.callTool);
    verified += 1;
  }

  let deleted = 0;
  for (const slug of options.staleSlugs) {
    await options.callTool('delete_page', { slug });
    const readBack = await options.callTool('get_page', { slug, include_deleted: true });
    const deletedAt = typeof readBack === 'object' && readBack !== null
      ? (readBack as Record<string, unknown>).deleted_at
      : undefined;
    if (typeof deletedAt !== 'string' || deletedAt.length === 0) {
      throw new Error(`soft-delete verification failed for ${slug}`);
    }
    deleted += 1;
  }

  return { written: options.pages.length, verified, deleted };
}

export const __testing = {
  HASH_MARKER,
  convertReferences,
  archivePointer,
};
