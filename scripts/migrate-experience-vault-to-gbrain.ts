#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import matter from 'gray-matter';
import {
  applyLegacyPages,
  buildLegacyPage,
  buildPendingDraft,
  legacySlug,
  loadLegacyInventory,
  matchExistingLegacyPage,
  planLegacyReconciliation,
  selectLegacyPagesForWrite,
  selectPermanentMigrationReport,
  validateLegacyPageReadBack,
  type BuiltLegacyPage,
  type ExistingLegacyPage,
  type MigrationToolCaller,
} from '../src/commands/experience-vault-migration.ts';
import { unpackToolResult } from '../src/core/mcp-client.ts';
import { validatePutPageWrite } from '../src/core/put-page-validation.ts';

interface Options {
  readonly vaultRoot: string;
  readonly archiveCommit: string;
  readonly apply: boolean;
  readonly sampleSize: number;
}

interface ListedPage {
  readonly slug: string;
}

function parseArgs(argv: readonly string[]): Options {
  let vaultRoot = '';
  let archiveCommit = '';
  let apply = false;
  let sampleSize = 8;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vault-root') vaultRoot = argv[++index] ?? '';
    else if (arg === '--archive-commit') archiveCommit = argv[++index] ?? '';
    else if (arg === '--sample-size') sampleSize = Number(argv[++index]);
    else if (arg === '--apply') apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!vaultRoot) throw new Error('--vault-root is required');
  if (!/^[a-f0-9]{40}$/.test(archiveCommit)) {
    throw new Error('--archive-commit must be a full lowercase Git SHA');
  }
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 20) {
    throw new Error('--sample-size must be an integer from 1 through 20');
  }
  return { vaultRoot, archiveCommit, apply, sampleSize };
}

function assertArchiveBaseline(options: Options): void {
  const result = spawnSync('git', ['-C', options.vaultRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.stdout.trim() !== options.archiveCommit) {
    throw new Error('vault HEAD does not match the requested archive commit');
  }
  const remote = spawnSync(
    'git',
    ['-C', options.vaultRoot, 'remote', 'get-url', 'origin'],
    { encoding: 'utf8' },
  );
  if (
    remote.status !== 0
    || ![
      'https://github.com/lchany/agent-evolutionism.git',
      'git@github.com:lchany/agent-evolutionism.git',
    ].includes(remote.stdout.trim())
  ) {
    throw new Error('vault origin does not match the approved archive repository');
  }
  for (const args of [
    ['-C', options.vaultRoot, 'diff', '--quiet'],
    ['-C', options.vaultRoot, 'diff', '--cached', '--quiet'],
  ]) {
    const check = spawnSync('git', args);
    if (check.status !== 0) throw new Error('tracked vault content changed after archival');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function listAllLegacyPages(callTool: MigrationToolCaller): Promise<ListedPage[]> {
  const pages: ListedPage[] = [];
  for (let offset = 0; ; offset += 100) {
    const result = await callTool('list_pages', {
      include_prefixes: ['legacy-migration/'],
      limit: 100,
      offset,
      sort: 'slug',
    });
    if (!isRecord(result) || !Array.isArray(result.items)) {
      throw new Error('list_pages returned an unexpected result');
    }
    for (const item of result.items) {
      if (isRecord(item) && typeof item.slug === 'string') pages.push({ slug: item.slug });
    }
    if (result.has_more !== true) break;
  }
  return pages;
}

function pageText(page: Record<string, unknown>): string {
  return [page.compiled_truth, page.timeline, page.content]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

async function loadExistingManagedPages(
  listed: readonly ListedPage[],
  callTool: MigrationToolCaller,
): Promise<{
  readonly managed: ExistingLegacyPage[];
  readonly readBackBySlug: ReadonlyMap<string, unknown>;
}> {
  const managed: ExistingLegacyPage[] = [];
  const readBackBySlug = new Map<string, unknown>();
  for (const [index, item] of listed.entries()) {
    const page = await callTool('get_page', { slug: item.slug });
    readBackBySlug.set(item.slug, page);
    if (!isRecord(page)) throw new Error('get_page returned an unexpected result');
    const rawSha256 = pageText(page).match(/legacy-vault-sha256:([a-f0-9]{64})/)?.[1];
    const frontmatter = isRecord(page.frontmatter) ? page.frontmatter : {};
    if (rawSha256 && typeof frontmatter.migrated_from === 'string') {
      managed.push({
        slug: item.slug,
        migratedFrom: frontmatter.migrated_from,
        rawSha256,
      });
    }
    if ((index + 1) % 25 === 0) console.error(`[migration] inspected ${index + 1}/${listed.length}`);
  }
  return { managed, readBackBySlug };
}

async function loadPageIfExists(
  slug: string,
  callTool: MigrationToolCaller,
): Promise<unknown | undefined> {
  const result = await callTool('list_pages', {
    include_prefixes: [slug],
    limit: 10,
    offset: 0,
    sort: 'slug',
  });
  if (!isRecord(result) || !Array.isArray(result.items)) {
    throw new Error('list_pages returned an unexpected result');
  }
  const exact = result.items.find((item) => isRecord(item) && item.slug === slug);
  return exact ? callTool('get_page', { slug }) : undefined;
}

function mergeCounts(
  target: Record<string, number>,
  source: Readonly<Record<string, number>>,
): void {
  for (const [category, count] of Object.entries(source)) {
    target[category] = (target[category] ?? 0) + count;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildReportPage(input: {
  readonly archiveCommit: string;
  readonly coreCount: number;
  readonly pendingCount: number;
  readonly reusedCount: number;
  readonly writeCount: number;
  readonly staleCount: number;
  readonly redactions: Readonly<Record<string, number>>;
  readonly resolvedReferences: number;
  readonly unresolvedReferences: number;
}): BuiltLegacyPage {
  const slug = `inbox/legacy-migration-cutover-report-${input.archiveCommit.slice(0, 10)}`;
  const summary = [
    '# Legacy experience migration cutover report',
    '',
    `Archive commit: \`${input.archiveCommit}\``,
    '',
    `Core records: ${input.coreCount}`,
    `Pending candidates: ${input.pendingCount}`,
    `Reused exact records: ${input.reusedCount}`,
    `Records written or updated: ${input.writeCount}`,
    `Stale records scheduled for soft deletion: ${input.staleCount}`,
    `Resolved references: ${input.resolvedReferences}`,
    `Sanitized archive references: ${input.unresolvedReferences}`,
    '',
    'Redaction categories:',
    ...Object.entries(input.redactions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `- ${category}: ${count}`),
    '',
    'Validation: local strict schema, MCP write, round-trip read, and soft-delete checks.',
    '',
  ].join('\n');
  const reportHash = sha256(summary);
  const body = `${summary}\nMigration identity: \`legacy-vault-sha256:${reportHash}\`\n`;
  return {
    slug,
    markdown: matter.stringify(body, {
      type: 'project',
      date: new Date().toISOString().slice(0, 10),
      status: 'draft',
      sensitivity: 'internal',
      verification: 'unverified',
      applicability: ['migration-cutover-report'],
      non_applicable: [],
      source_refs: [`legacy-archive:${input.archiveCommit}:migration-summary`],
      migrated_from: null,
    }),
    rawSha256: reportHash,
    references: { resolved: 0, unresolved: 0 },
    redactions: {},
  };
}

async function verifyFinalSet(
  pages: readonly BuiltLegacyPage[],
  callTool: MigrationToolCaller,
): Promise<void> {
  for (const [index, expected] of pages.entries()) {
    const page = await callTool('get_page', { slug: expected.slug });
    const mismatch = validateLegacyPageReadBack(expected, page);
    if (mismatch !== null) {
      throw new Error(`final verification failed for ${expected.slug}: ${mismatch}`);
    }
    if ((index + 1) % 25 === 0) console.error(`[migration] verified ${index + 1}/${pages.length}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertArchiveBaseline(options);
  const mcpUrl = process.env.GBRAIN_MIGRATION_MCP_URL;
  if (!mcpUrl) throw new Error('GBRAIN_MIGRATION_MCP_URL is required');
  const parsedUrl = new URL(mcpUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('GBRAIN_MIGRATION_MCP_URL must use HTTP or HTTPS');
  }
  if (
    parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
    || parsedUrl.pathname !== '/mcp'
  ) {
    throw new Error('GBRAIN_MIGRATION_MCP_URL must be a credential-free /mcp URL');
  }

  const inventory = loadLegacyInventory(options.vaultRoot);

  const transport = new StreamableHTTPClientTransport(parsedUrl);
  const client = new Client(
    { name: 'gbrain-experience-vault-migration', version: '1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  const callTool: MigrationToolCaller = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const message = Array.isArray(result.content)
        ? result.content
          .filter((item): item is { type: 'text'; text: string } => {
            return item.type === 'text' && typeof item.text === 'string';
          })
          .map((item) => item.text)
          .join('\n')
        : 'unknown MCP error';
      throw new Error(`${name} failed: ${message}`);
    }
    return unpackToolResult(result);
  };

  try {
    const listed = await listAllLegacyPages(callTool);
    const existingPages = await loadExistingManagedPages(listed, callTool);
    const existing = existingPages.managed;
    const plan = planLegacyReconciliation(inventory.core, existing);
    const pathToSlug = new Map(inventory.core.map((record) => {
      const existingPage = matchExistingLegacyPage(record, existing);
      return [record.relativePath, existingPage?.slug ?? legacySlug(record.relativePath)];
    }));
    const allCorePages = inventory.core.map((record) => buildLegacyPage(record, {
      archiveCommit: options.archiveCommit,
      importedPathToSlug: pathToSlug,
      slug: pathToSlug.get(record.relativePath),
    }));
    const pendingPages = inventory.pending.map((record) => {
      return buildPendingDraft(record, options.archiveCommit);
    });
    const pendingWritePages: BuiltLegacyPage[] = [];
    for (const page of pendingPages) {
      const existingPending = await loadPageIfExists(page.slug, callTool);
      if (
        existingPending === undefined
        || validateLegacyPageReadBack(page, existingPending) !== null
      ) {
        pendingWritePages.push(page);
      }
    }
    const redactions: Record<string, number> = {};
    let resolvedReferences = 0;
    let unresolvedReferences = 0;
    for (const page of [...allCorePages, ...pendingPages]) {
      mergeCounts(redactions, page.redactions);
      resolvedReferences += page.references.resolved;
      unresolvedReferences += page.references.unresolved;
      const localValidation = validatePutPageWrite(page.slug, page.markdown, {
        strictSchema: true,
      });
      if (!localValidation.ok) {
        throw new Error(`local validation failed: ${localValidation.message}`);
      }
    }
    const writeByPath = new Set(plan.write.map((record) => record.relativePath));
    const writePages = selectLegacyPagesForWrite({
      records: inventory.core,
      pages: allCorePages,
      plannedWritePaths: writeByPath,
      existingReadBackBySlug: existingPages.readBackBySlug,
    });
    const reportPage = buildReportPage({
      archiveCommit: options.archiveCommit,
      coreCount: inventory.core.length,
      pendingCount: inventory.pending.length,
      reusedCount: inventory.core.length - writePages.length,
      writeCount: writePages.length,
      staleCount: plan.deleteAfterVerifiedWrites.length,
      redactions,
      resolvedReferences,
      unresolvedReferences,
    });
    const validation = validatePutPageWrite(reportPage.slug, reportPage.markdown, {
      strictSchema: true,
    });
    if (!validation.ok) throw new Error(`report validation failed: ${validation.message}`);
    const existingReport = await loadPageIfExists(reportPage.slug, callTool);
    const permanentReport = selectPermanentMigrationReport({
      generated: reportPage,
      archiveCommit: options.archiveCommit,
      existingReadBack: existingReport,
    });

    const summary = {
      mode: options.apply ? 'apply' : 'dry-run',
      archive_commit: options.archiveCommit,
      core_records: inventory.core.length,
      pending_candidates: inventory.pending.length,
      existing_legacy_pages: listed.length,
      managed_existing_pages: existing.length,
      source_identity_matches: plan.reuse.length,
      exact_reuse: inventory.core.length - writePages.length,
      writes_or_updates: writePages.length,
      pending_writes: pendingWritePages.length,
      stale_soft_deletes: plan.deleteAfterVerifiedWrites.length,
      redactions,
      references: { resolved: resolvedReferences, unresolved: unresolvedReferences },
      local_validation: 'passed',
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!options.apply) return;

    const pagesToWrite = [
      ...writePages,
      ...pendingWritePages,
      ...(permanentReport.pageToWrite ? [permanentReport.pageToWrite] : []),
    ];
    const applied = await applyLegacyPages({
      pages: pagesToWrite,
      staleSlugs: plan.deleteAfterVerifiedWrites,
      callTool,
      sampleSize: options.sampleSize,
    });
    await verifyFinalSet(allCorePages, callTool);
    await verifyFinalSet(pendingPages, callTool);
    const finalReportReadBack = await callTool('get_page', { slug: reportPage.slug });
    const finalPermanentReport = selectPermanentMigrationReport({
      generated: reportPage,
      archiveCommit: options.archiveCommit,
      existingReadBack: finalReportReadBack,
    });
    if (finalPermanentReport.expectedRawSha256 !== permanentReport.expectedRawSha256) {
      throw new Error('permanent migration report identity changed during apply');
    }
    const retrieval = await callTool('search', {
      query: 'Migration identity',
      include_prefixes: ['legacy-migration/'],
      status: 'migrated-legacy',
      limit: 10,
    });
    if (!isRecord(retrieval) || !Array.isArray(retrieval.results) || retrieval.results.length === 0) {
      throw new Error('final retrieval probe returned no migrated records');
    }
    console.log(JSON.stringify({
      ...summary,
      apply_result: applied,
      final_verified_pages: allCorePages.length + pendingPages.length + 1,
      retrieval_probe: 'passed',
      observation_ends_on: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
    }, null, 2));
  } finally {
    await client.close();
  }
}

await main();
