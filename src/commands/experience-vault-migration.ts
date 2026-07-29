import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { posix } from 'node:path';
import matter from 'gray-matter';
import { scrubPii } from '../core/eval-capture-scrub.ts';

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
    /^(?:\s*(?:export\s+)?[A-Z_][A-Z0-9_]{1,}=).+$/gm,
    '[REDACTED_ENV_ASSIGNMENT]',
    'environment_assignment',
    counts,
  );
  text = replaceCounted(
    text,
    /\b(?:export\s+)?[A-Z_][A-Z0-9_]{1,}=[^\s`]+/g,
    '[REDACTED_ENV_ASSIGNMENT]',
    'environment_assignment',
    counts,
  );
  text = replaceCounted(
    text,
    /```(?:log|console|output)\s*\n[\s\S]*?```/gi,
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
    /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|github_pat_[A-Za-z0-9_]+|xox[A-Za-z0-9_-]+|gbrain_[A-Za-z0-9_-]{8,})\b/gi,
    '[REDACTED_CREDENTIAL]',
    'credential',
    counts,
  );
  text = replaceCounted(
    text,
    /\bprj_[a-f0-9]{8,}\b/gi,
    '[REDACTED_OPAQUE_IDENTIFIER]',
    'opaque_identifier',
    counts,
  );
  text = replaceCounted(
    text,
    /(?:^|\n)\s*(?:HTTP\/\d(?:\.\d)?\s+\d{3}|(?:access_token|refresh_token|id_token|client_secret|authorization)\s*[:=]).*$/gim,
    '\n[REDACTED_RAW_AUTH_RESPONSE]',
    'raw_auth_response',
    counts,
  );
  text = replaceCounted(
    text,
    /(?<![\w.])(?!127\.)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g,
    '[REDACTED_NETWORK_ADDRESS]',
    'network_address',
    counts,
  );
  text = replaceCounted(
    text,
    /(?<![\w:])(?!(?:::1)\b)(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{0,4}(?![\w:])/g,
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
  text = replaceCounted(
    text,
    /\b(?:raw transcript|full transcript|raw tool output|full tool output)\b|^\s*(?:Assistant|User|System|Tool|assistant_message|user_message|system_message|tool_result)\s*:.*$/gim,
    '[REDACTED_RAW_TRANSCRIPT_MARKER]',
    'raw_transcript_marker',
    counts,
  );
  text = replaceCounted(
    text,
    /^(?:\s*(?:\[[^\]\n]{1,40}\]|\d{4}-\d{2}-\d{2}[T ][^\n]{0,40}|(?:INFO|WARN|ERROR|DEBUG|TRACE)\b|(?:stdout|stderr)>|\+\s|\$\s).{20,}|\s*(?:at\s+\S+\s+\(|File "[^"]+", line \d+|Traceback \(most recent call last\)|Caused by:|Error: ).{10,})$/gim,
    '[REDACTED_LOG_LINE]',
    'raw_log_line',
    counts,
  );
  const piiScrubbed = scrubPii(text);
  if (piiScrubbed !== text) increment(counts, 'personal_identifier', 1);
  text = piiScrubbed;

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
  const fingerprint = sha256(normalized).slice(0, 16);
  return `${safeFamily}/redacted-${extension ? `record-${fingerprint}.md` : `artifact-${fingerprint}`}`;
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
    readonly slug?: string;
  },
): BuiltLegacyPage {
  const references = convertReferences(
    record.content,
    record.relativePath,
    options.archiveCommit,
    options.importedPathToSlug,
  );
  const redacted = redactLegacyText(references.text);
  const redactedTitle = redactLegacyText(record.title);
  const redactions: Record<string, number> = { ...redacted.counts };
  for (const [category, count] of Object.entries(redactedTitle.counts)) {
    increment(redactions, category, count);
  }
  const body = [
    `# ${redactedTitle.text}`,
    '',
    redacted.text.trim(),
    '',
    `Migration identity: \`${HASH_MARKER}:${record.rawSha256}\``,
    '',
  ].join('\n');

  return {
    slug: options.slug ?? legacySlug(record.relativePath),
    markdown: matter.stringify(body, migratedFrontmatter(record, options.archiveCommit)),
    rawSha256: record.rawSha256,
    references: {
      resolved: references.resolved,
      unresolved: references.unresolved,
    },
    redactions,
  };
}

export function buildPendingDraft(
  record: LegacyRecord,
  archiveCommit: string,
): BuiltLegacyPage {
  const redacted = redactLegacyText(record.content);
  const redactedTitle = redactLegacyText(record.title);
  const redactions: Record<string, number> = { ...redacted.counts };
  for (const [category, count] of Object.entries(redactedTitle.counts)) {
    increment(redactions, category, count);
  }
  const body = [
    `# ${redactedTitle.text}`,
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
    redactions,
  };
}

export function planLegacyReconciliation(
  current: readonly LegacyRecord[],
  existing: readonly ExistingLegacyPage[],
): LegacyReconciliationPlan {
  const claimedExistingSlugs = new Set<string>();
  const reuse: ExistingLegacyPage[] = [];
  const write: LegacyRecord[] = [];

  for (const record of current) {
    const page = matchExistingLegacyPage(record, existing);
    if (page) claimedExistingSlugs.add(page.slug);
    if (page?.rawSha256 === record.rawSha256) reuse.push(page);
    else write.push(record);
  }

  const deleteAfterVerifiedWrites = existing
    .filter((page) => !claimedExistingSlugs.has(page.slug))
    .map((page) => page.slug);

  return { reuse, write, deleteAfterVerifiedWrites };
}

export function matchExistingLegacyPage(
  record: LegacyRecord,
  existing: readonly ExistingLegacyPage[],
): ExistingLegacyPage | undefined {
  const expectedSlug = legacySlug(record.relativePath);
  const sanitizedPath = sanitizeLegacyPath(record.relativePath);
  return existing.find((candidate) => {
    return candidate.migratedFrom === record.relativePath
      || candidate.migratedFrom === sanitizedPath;
  }) ?? existing.find((candidate) => candidate.slug === expectedSlug);
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

function unquoteLegacyScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseLegacyRecord(raw: string): {
  readonly data: Record<string, string>;
  readonly content: string;
} {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { data: {}, content: raw };
  }
  const closing = /\r?\n---\r?\n/g;
  closing.lastIndex = raw.startsWith('---\r\n') ? 5 : 4;
  const match = closing.exec(raw);
  if (!match) return { data: {}, content: raw };
  const header = raw.slice(raw.indexOf('\n') + 1, match.index);
  const data: Record<string, string> = {};
  for (const key of ['type', 'date', 'title']) {
    const field = header.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'))?.[1];
    if (field !== undefined && !(key in data)) data[key] = unquoteLegacyScalar(field);
  }
  return {
    data,
    content: raw.slice(match.index + match[0].length),
  };
}

function loadRecord(root: string, relativePath: string): LegacyRecord {
  const raw = readFileSync(posix.join(root, relativePath), 'utf8');
  const parsed = parseLegacyRecord(raw);
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

function sameField(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateLegacyPageReadBack(
  expected: BuiltLegacyPage,
  readBack: unknown,
): string | null {
  if (typeof readBack !== 'object' || readBack === null) {
    return 'read-back result is not an object';
  }
  const actual = readBack as Record<string, unknown>;
  if (actual.slug !== expected.slug) return 'slug does not match';
  if (actual.deleted_at !== undefined && actual.deleted_at !== null) {
    return 'deleted_at is still set';
  }
  if (!pageText(actual).includes(`${HASH_MARKER}:${expected.rawSha256}`)) {
    return 'legacy-vault-sha256 does not match';
  }

  const expectedFrontmatter = matter(expected.markdown).data as Record<string, unknown>;
  const actualFrontmatter = typeof actual.frontmatter === 'object'
    && actual.frontmatter !== null
    ? actual.frontmatter as Record<string, unknown>
    : null;
  if (!actualFrontmatter) return 'frontmatter is missing';

  for (const field of [
    'status',
    'sensitivity',
    'verification',
    'applicability',
    'non_applicable',
    'source_refs',
    'migrated_from',
  ]) {
    if (!sameField(actualFrontmatter[field], expectedFrontmatter[field])) {
      return `${field} does not match`;
    }
  }
  if (actual.type !== expectedFrontmatter.type) {
    return 'top-level type does not match';
  }
  return null;
}

export function selectPermanentMigrationReport(input: {
  readonly generated: BuiltLegacyPage;
  readonly archiveCommit: string;
  readonly existingReadBack?: unknown;
}): {
  readonly pageToWrite: BuiltLegacyPage | null;
  readonly expectedRawSha256: string;
} {
  if (input.existingReadBack === undefined) {
    return {
      pageToWrite: input.generated,
      expectedRawSha256: input.generated.rawSha256,
    };
  }
  if (typeof input.existingReadBack !== 'object' || input.existingReadBack === null) {
    throw new Error('permanent migration report read-back is not an object');
  }
  const actual = input.existingReadBack as Record<string, unknown>;
  if (actual.slug !== input.generated.slug) {
    throw new Error('permanent migration report slug does not match');
  }
  if (actual.deleted_at !== undefined && actual.deleted_at !== null) {
    throw new Error('permanent migration report is soft-deleted');
  }
  const frontmatter = typeof actual.frontmatter === 'object' && actual.frontmatter !== null
    ? actual.frontmatter as Record<string, unknown>
    : null;
  const requiredFrontmatter: Record<string, unknown> = {
    status: 'draft',
    sensitivity: 'internal',
    verification: 'unverified',
    applicability: ['migration-cutover-report'],
    non_applicable: [],
    source_refs: [`legacy-archive:${input.archiveCommit}:migration-summary`],
    migrated_from: null,
  };
  if (!frontmatter) throw new Error('permanent migration report frontmatter is missing');
  if (actual.type !== 'project') {
    throw new Error('permanent migration report type does not match');
  }
  for (const [field, expected] of Object.entries(requiredFrontmatter)) {
    if (!sameField(frontmatter[field], expected)) {
      throw new Error(`permanent migration report ${field} does not match`);
    }
  }
  const text = pageText(actual);
  if (!text.includes(`Archive commit: \`${input.archiveCommit}\``)) {
    throw new Error('permanent migration report archive commit does not match');
  }
  const existingHash = text.match(new RegExp(`${HASH_MARKER}:([a-f0-9]{64})`))?.[1];
  if (!existingHash) {
    throw new Error('permanent migration report identity hash is missing');
  }
  return { pageToWrite: null, expectedRawSha256: existingHash };
}

async function writeAndVerifyPage(
  page: BuiltLegacyPage,
  callTool: MigrationToolCaller,
  retryDelayMs: number,
): Promise<void> {
  await callTool('search', {
    query: page.slug,
    include_prefixes: [page.slug],
    limit: 5,
  });
  const writeResult = await callTool('put_page', { slug: page.slug, content: page.markdown });
  if (typeof writeResult === 'object' && writeResult !== null) {
    const resultSlug = (writeResult as Record<string, unknown>).slug;
    if (typeof resultSlug === 'string' && resultSlug !== page.slug) {
      throw new Error(`put_page returned a different slug for ${page.slug}: ${resultSlug}`);
    }
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const readBack = await callTool('get_page', { slug: page.slug });
      const mismatch = validateLegacyPageReadBack(page, readBack);
      if (mismatch === null) return;
      lastError = new Error(mismatch);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 8 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`round-trip verification failed for ${page.slug}${detail}`);
}

export async function applyLegacyPages(options: {
  readonly pages: readonly BuiltLegacyPage[];
  readonly staleSlugs: readonly string[];
  readonly callTool: MigrationToolCaller;
  readonly sampleSize?: number;
  readonly retryDelayMs?: number;
}): Promise<{ readonly written: number; readonly verified: number; readonly deleted: number }> {
  const sampleSize = Math.min(
    Math.max(options.sampleSize ?? 8, 0),
    options.pages.length,
  );
  const sample = options.pages.slice(0, sampleSize);
  const remainder = options.pages.slice(sampleSize);
  const retryDelayMs = Math.max(options.retryDelayMs ?? 250, 0);
  let verified = 0;

  for (const page of sample) {
    await writeAndVerifyPage(page, options.callTool, retryDelayMs);
    verified += 1;
  }
  for (const page of remainder) {
    await writeAndVerifyPage(page, options.callTool, retryDelayMs);
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
