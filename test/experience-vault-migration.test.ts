import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  applyLegacyPages,
  buildLegacyPage,
  buildPendingDraft,
  legacySlug,
  loadLegacyInventory,
  planLegacyReconciliation,
  redactLegacyText,
  sanitizeLegacyPath,
  selectPermanentMigrationReport,
  validateLegacyPageReadBack,
  type ExistingLegacyPage,
  type BuiltLegacyPage,
  type LegacyRecord,
} from '../src/commands/experience-vault-migration.ts';
import { validatePutPageWrite } from '../src/core/put-page-validation.ts';

const ARCHIVE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function record(overrides: Partial<LegacyRecord> = {}): LegacyRecord {
  return {
    relativePath: 'knowledge/safe-retry.md',
    rawSha256: 'a'.repeat(64),
    title: 'Safe retry',
    type: 'knowledge',
    date: '2026-07-29',
    content: 'Retry only after checking the failure fingerprint.',
    ...overrides,
  };
}

describe('Experience Vault migration mapping', () => {
  test('derives a stable strict slug from the source path', () => {
    const first = legacySlug('projects/customer-acme-employee-12345.md');
    const second = legacySlug('projects/customer-acme-employee-12345.md');

    expect(first).toBe(second);
    expect(first).toMatch(/^legacy-migration\/[a-z0-9-]+-[a-f0-9]{10}$/);
  });

  test('redacts credentials, public addresses, sensitive paths, and raw log blocks', () => {
    const input = [
      'password: correct-horse-battery-staple',
      'Authorization: Bearer example-sensitive-token',
      'endpoint: http://203.0.113.10:3131/mcp',
      'config: /home/alice/private/client.env',
      '```log',
      '2026-07-29T00:00:00Z ERROR request-id=customer-123 failed',
      '2026-07-29T00:00:01Z ERROR request-id=customer-124 failed',
      '```',
    ].join('\n');

    const result = redactLegacyText(input);

    expect(result.text).not.toContain('correct-horse');
    expect(result.text).not.toContain('example-sensitive-token');
    expect(result.text).not.toContain('203.0.113.10');
    expect(result.text).not.toContain('/home/alice');
    expect(result.text).not.toContain('customer-123');
    expect(result.text).toContain('[REDACTED_CREDENTIAL]');
    expect(result.text).toContain('[REDACTED_NETWORK_ADDRESS]');
    expect(result.text).toContain('[REDACTED_ABSOLUTE_PATH]');
    expect(result.text).toContain('[REDACTED_RAW_LOG_BLOCK]');
    expect(result.counts).toEqual({
      credential: 2,
      network_address: 1,
      absolute_path: 1,
      raw_log_block: 1,
    });
  });

  test('redacts server-forbidden PII, environment assignments, and transcript markers', () => {
    const input = [
      'Contact operator@example.test before retrying.',
      'GBRAIN_EXAMPLE_TOKEN=example-value',
      'Run `SAFE_FLAG=1 command`.',
      'HTTP/1.1 401 Unauthorized',
      'Raw tool output follows.',
      'User: pasted operational output',
      'token shape sk-example12345678',
      'project identity prj_deadbeef1234',
    ].join('\n');

    const result = redactLegacyText(input);

    expect(result.text).not.toContain('operator@example.test');
    expect(result.text).not.toContain('GBRAIN_EXAMPLE_TOKEN=example-value');
    expect(result.text).not.toMatch(/raw tool output/i);
    expect(result.text).not.toContain('User: pasted');
    expect(result.text).not.toContain('sk-example12345678');
    expect(result.text).not.toContain('prj_deadbeef1234');
    expect(result.counts.personal_identifier).toBe(1);
    expect(result.text).not.toContain('SAFE_FLAG=1');
    expect(result.text).not.toContain('HTTP/1.1 401');
    expect(result.counts.environment_assignment).toBe(2);
    expect(result.counts.raw_auth_response).toBe(1);
    expect(result.counts.raw_transcript_marker).toBe(2);
    expect(result.counts.credential).toBe(1);
    expect(result.counts.opaque_identifier).toBe(1);
  });

  test('sanitizes provenance and converts exact imported references only', () => {
    const target = 'runbooks/retry-safely.md';
    const targetSlug = legacySlug(target);
    const page = buildLegacyPage(
      record({
        content: [
          'Follow [the retry runbook](../runbooks/retry-safely.md).',
          'See `reference-config/private-client.sh` for the excluded setup.',
        ].join('\n'),
      }),
      {
        archiveCommit: ARCHIVE_COMMIT,
        importedPathToSlug: new Map([[target, targetSlug]]),
      },
    );
    const parsed = matter(page.markdown);

    expect(parsed.content).toContain(`[[${targetSlug}]]`);
    expect(parsed.content).toContain(
      `legacy-archive:${ARCHIVE_COMMIT}:${sanitizeLegacyPath('reference-config/private-client.sh')}`,
    );
    expect(parsed.data.migrated_from).toBe(sanitizeLegacyPath('knowledge/safe-retry.md'));
    expect(parsed.data.source_refs).toEqual([
      `legacy-archive:${ARCHIVE_COMMIT}:${sanitizeLegacyPath('knowledge/safe-retry.md')}`,
    ]);
    expect(page.references).toEqual({ resolved: 1, unresolved: 1 });
  });

  test('builds strict migrated and pending-draft frontmatter', () => {
    const migratedBuilt = buildLegacyPage(record(), {
      archiveCommit: ARCHIVE_COMMIT,
      importedPathToSlug: new Map(),
    });
    const pendingBuilt = buildPendingDraft(record({
      relativePath: 'share-candidates/pending-note.md',
      type: 'runbook',
    }), ARCHIVE_COMMIT);
    const migrated = matter(migratedBuilt.markdown);
    const pending = matter(pendingBuilt.markdown);

    expect(migrated.data).toMatchObject({
      type: 'knowledge',
      status: 'migrated-legacy',
      sensitivity: 'internal',
      verification: 'unverified',
      applicability: ['legacy-migration'],
      non_applicable: [],
      migrated_from: sanitizeLegacyPath('knowledge/safe-retry.md'),
    });
    expect(pending.data).toMatchObject({
      type: 'runbook',
      status: 'draft',
      sensitivity: 'internal',
      verification: 'unverified',
      applicability: ['pending-human-review'],
      non_applicable: [],
      migrated_from: null,
    });
    expect(buildPendingDraft(record({
      relativePath: 'share-candidates/pending-note.md',
    }), ARCHIVE_COMMIT).slug).toMatch(/^inbox\/legacy-[a-z0-9-]+-[a-f0-9]{10}$/);
    expect(validatePutPageWrite(legacySlug(record().relativePath), migratedBuilt.markdown, {
      strictSchema: true,
    })).toEqual({ ok: true });
    expect(validatePutPageWrite(
      pendingBuilt.slug,
      pendingBuilt.markdown,
      { strictSchema: true },
    )).toEqual({ ok: true });
  });

  test('verifies all migration identity and lifecycle fields on read-back', () => {
    const built = buildLegacyPage(record(), {
      archiveCommit: ARCHIVE_COMMIT,
      importedPathToSlug: new Map(),
    });
    const expected = matter(built.markdown);
    const readBack = {
      slug: built.slug,
      type: expected.data.type,
      compiled_truth: expected.content,
      frontmatter: expected.data,
      deleted_at: null,
    };

    expect(validateLegacyPageReadBack(built, readBack)).toBeNull();
    expect(validateLegacyPageReadBack(built, {
      ...readBack,
      frontmatter: { ...expected.data, status: 'draft' },
    })).toMatch(/status/);
    expect(validateLegacyPageReadBack(built, {
      ...readBack,
      frontmatter: { ...expected.data, source_refs: ['legacy-archive:wrong'] },
    })).toMatch(/source_refs/);
  });

  test('reuses a valid permanent report instead of overwriting first-run statistics', () => {
    const firstRun: BuiltLegacyPage = {
      slug: `inbox/legacy-migration-cutover-report-${ARCHIVE_COMMIT.slice(0, 10)}`,
      markdown: matter.stringify([
        '# Legacy experience migration cutover report',
        '',
        `Archive commit: \`${ARCHIVE_COMMIT}\``,
        '',
        'Records written or updated: 73',
        '',
        `Migration identity: \`legacy-vault-sha256:${'1'.repeat(64)}\``,
        '',
      ].join('\n'), {
        type: 'project',
        status: 'draft',
        sensitivity: 'internal',
        verification: 'unverified',
        applicability: ['migration-cutover-report'],
        non_applicable: [],
        source_refs: [`legacy-archive:${ARCHIVE_COMMIT}:migration-summary`],
        migrated_from: null,
      }),
      rawSha256: '1'.repeat(64),
      references: { resolved: 0, unresolved: 0 },
      redactions: {},
    };
    const retryGenerated: BuiltLegacyPage = {
      ...firstRun,
      markdown: firstRun.markdown.replace(
        'Records written or updated: 73',
        'Records written or updated: 0',
      ),
      rawSha256: '2'.repeat(64),
    };
    const parsed = matter(firstRun.markdown);
    const existingReadBack = {
      slug: firstRun.slug,
      type: parsed.data.type,
      compiled_truth: parsed.content,
      frontmatter: parsed.data,
      deleted_at: null,
    };

    expect(selectPermanentMigrationReport({
      generated: retryGenerated,
      archiveCommit: ARCHIVE_COMMIT,
      existingReadBack,
    })).toEqual({
      pageToWrite: null,
      expectedRawSha256: '1'.repeat(64),
    });
  });

  test('reconciles by path and hash and delays stale deletes until writes verify', () => {
    const current = [
      record(),
      record({
        relativePath: 'incidents/changed.md',
        rawSha256: 'b'.repeat(64),
        type: 'incident',
      }),
      record({
        relativePath: 'runbooks/renamed.md',
        rawSha256: 'c'.repeat(64),
        type: 'runbook',
      }),
    ];
    const existing: ExistingLegacyPage[] = [
      {
        slug: 'legacy-migration/historical-safe-retry-1111111111',
        migratedFrom: sanitizeLegacyPath('knowledge/safe-retry.md'),
        rawSha256: 'a'.repeat(64),
      },
      {
        slug: legacySlug('incidents/changed.md'),
        migratedFrom: sanitizeLegacyPath('incidents/changed.md'),
        rawSha256: '0'.repeat(64),
      },
      {
        slug: legacySlug('runbooks/old-name.md'),
        migratedFrom: sanitizeLegacyPath('runbooks/old-name.md'),
        rawSha256: 'c'.repeat(64),
      },
      {
        slug: legacySlug('projects/stale.md'),
        migratedFrom: sanitizeLegacyPath('projects/stale.md'),
        rawSha256: 'd'.repeat(64),
      },
    ];

    const plan = planLegacyReconciliation(current, existing);

    expect(plan.reuse.map((item) => item.slug)).toEqual([
      'legacy-migration/historical-safe-retry-1111111111',
    ]);
    expect(plan.write.map((item) => item.relativePath)).toEqual([
      'incidents/changed.md',
      'runbooks/renamed.md',
    ]);
    expect([...plan.deleteAfterVerifiedWrites].sort()).toEqual([
      legacySlug('projects/stale.md'),
      legacySlug('runbooks/old-name.md'),
    ].sort());
  });

  test('loads only the four core families plus nested share candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-inventory-'));
    try {
      for (const directory of ['projects', 'incidents', 'knowledge', 'runbooks']) {
        mkdirSync(join(root, directory), { recursive: true });
      }
      mkdirSync(join(root, 'share-candidates', 'project-safe', 'knowledge'), { recursive: true });
      mkdirSync(join(root, 'reference-config'), { recursive: true });
      const markdown = (type: string, title: string) => matter.stringify('Reusable conclusion.\n', {
        type,
        date: '2026-07-29',
        title,
      });
      writeFileSync(join(root, 'knowledge', 'safe.md'), markdown('knowledge', 'Safe knowledge'));
      writeFileSync(
        join(root, 'share-candidates', 'project-safe', 'knowledge', 'pending.md'),
        markdown('knowledge', 'Pending knowledge'),
      );
      writeFileSync(join(root, 'reference-config', 'excluded.md'), markdown('knowledge', 'Excluded'));

      const inventory = loadLegacyInventory(root);

      expect(inventory.core.map((item) => item.relativePath)).toEqual(['knowledge/safe.md']);
      expect(inventory.pending.map((item) => item.relativePath)).toEqual([
        'share-candidates/project-safe/knowledge/pending.md',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loads legacy frontmatter with duplicate non-essential keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-duplicate-frontmatter-'));
    try {
      mkdirSync(join(root, 'knowledge'), { recursive: true });
      writeFileSync(join(root, 'knowledge', 'duplicate.md'), [
        '---',
        'type: knowledge',
        'date: 2026-07-29',
        'title: "Duplicate legacy metadata"',
        'source_incidents: []',
        'source_incidents: [incidents/example.md]',
        '---',
        '',
        'The durable body must still migrate.',
        '',
      ].join('\n'));

      const inventory = loadLegacyInventory(root);

      expect(inventory.core).toHaveLength(1);
      expect(inventory.core[0]).toMatchObject({
        type: 'knowledge',
        date: '2026-07-29',
        title: 'Duplicate legacy metadata',
        content: '\nThe durable body must still migrate.\n',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes and verifies every page before deleting stale pages', async () => {
    const pages: BuiltLegacyPage[] = [
      buildLegacyPage(record(), { archiveCommit: ARCHIVE_COMMIT, importedPathToSlug: new Map() }),
      buildLegacyPage(record({
        relativePath: 'runbooks/safe.md',
        rawSha256: 'b'.repeat(64),
        type: 'runbook',
      }), { archiveCommit: ARCHIVE_COMMIT, importedPathToSlug: new Map() }),
    ];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bySlug = new Map(pages.map((page) => [page.slug, page]));
    const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, args });
      if (name === 'search') return { items: [] };
      if (name === 'put_page') return { slug: args.slug };
      if (name === 'get_page') {
        if (args.include_deleted) return { slug: args.slug, deleted_at: '2026-07-29T00:00:00Z' };
        const page = bySlug.get(String(args.slug));
        return {
          slug: args.slug,
          compiled_truth: `<!-- legacy-vault-sha256:${page?.rawSha256} -->`,
        };
      }
      if (name === 'delete_page') return { ok: true };
      throw new Error(`unexpected tool: ${name}`);
    };

    const report = await applyLegacyPages({
      pages,
      staleSlugs: ['legacy-migration/stale-record-0000000000'],
      callTool,
      sampleSize: 1,
      retryDelayMs: 0,
    });

    expect(report).toEqual({ written: 2, verified: 2, deleted: 1 });
    const lastPut = calls.map((call) => call.name).lastIndexOf('put_page');
    const firstDelete = calls.findIndex((call) => call.name === 'delete_page');
    expect(firstDelete).toBeGreaterThan(lastPut);
    expect(calls.filter((call) => call.name === 'search')).toHaveLength(2);
  });

  test('does not delete stale pages when any round-trip verification fails', async () => {
    const page = buildLegacyPage(record(), {
      archiveCommit: ARCHIVE_COMMIT,
      importedPathToSlug: new Map(),
    });
    const calls: string[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push(name);
      if (name === 'search') return { items: [] };
      if (name === 'put_page') return { slug: args.slug };
      if (name === 'get_page') return { slug: args.slug, compiled_truth: 'wrong hash' };
      throw new Error(`unexpected tool: ${name}`);
    };

    await expect(applyLegacyPages({
      pages: [page],
      staleSlugs: ['legacy-migration/stale-record-0000000000'],
      callTool,
      sampleSize: 1,
      retryDelayMs: 0,
    })).rejects.toThrow(/round-trip verification failed/);
    expect(calls).not.toContain('delete_page');
  });

  test('retries bounded get_page visibility checks without repeating put_page', async () => {
    const page = buildLegacyPage(record(), {
      archiveCommit: ARCHIVE_COMMIT,
      importedPathToSlug: new Map(),
    });
    let reads = 0;
    const calls: string[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push(name);
      if (name === 'search') return { items: [] };
      if (name === 'put_page') return { slug: args.slug };
      if (name === 'get_page') {
        reads += 1;
        if (reads === 1) throw new Error('page_not_found');
        return {
          slug: args.slug,
          compiled_truth: `legacy-vault-sha256:${page.rawSha256}`,
        };
      }
      throw new Error(`unexpected tool: ${name}`);
    };

    await expect(applyLegacyPages({
      pages: [page],
      staleSlugs: [],
      callTool,
      sampleSize: 1,
      retryDelayMs: 0,
    })).resolves.toEqual({ written: 1, verified: 1, deleted: 0 });
    expect(calls.filter((name) => name === 'put_page')).toHaveLength(1);
    expect(calls.filter((name) => name === 'get_page')).toHaveLength(2);
  });
});
