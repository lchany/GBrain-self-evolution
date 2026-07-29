import { describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import {
  buildLegacyPage,
  buildPendingDraft,
  legacySlug,
  planLegacyReconciliation,
  redactLegacyText,
  sanitizeLegacyPath,
  type ExistingLegacyPage,
  type LegacyRecord,
} from '../src/commands/experience-vault-migration.ts';

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
  test('derives a stable strict slug from the source path without exposing identifiers', () => {
    const first = legacySlug('projects/customer-acme-employee-12345.md');
    const second = legacySlug('projects/customer-acme-employee-12345.md');

    expect(first).toBe(second);
    expect(first).toMatch(/^legacy-migration\/[a-z0-9-]+-[a-f0-9]{10}$/);
    expect(first).not.toContain('acme');
    expect(first).not.toContain('12345');
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
      `legacy-archive:${ARCHIVE_COMMIT}:reference-config/redacted-artifact`,
    );
    expect(parsed.data.migrated_from).toBe('knowledge/redacted-record.md');
    expect(parsed.data.source_refs).toEqual([
      `legacy-archive:${ARCHIVE_COMMIT}:knowledge/redacted-record.md`,
    ]);
    expect(page.references).toEqual({ resolved: 1, unresolved: 1 });
  });

  test('builds strict migrated and pending-draft frontmatter', () => {
    const migrated = matter(buildLegacyPage(record(), {
      archiveCommit: ARCHIVE_COMMIT,
      importedPathToSlug: new Map(),
    }).markdown);
    const pending = matter(buildPendingDraft(record({
      relativePath: 'share-candidates/pending-note.md',
      type: 'runbook',
    }), ARCHIVE_COMMIT).markdown);

    expect(migrated.data).toMatchObject({
      type: 'knowledge',
      status: 'migrated-legacy',
      sensitivity: 'internal',
      verification: 'unverified',
      applicability: 'legacy-migration',
      non_applicable: [],
      migrated_from: 'knowledge/redacted-record.md',
    });
    expect(pending.data).toMatchObject({
      type: 'runbook',
      status: 'draft',
      sensitivity: 'internal',
      verification: 'unverified',
      applicability: 'pending-human-review',
      non_applicable: [],
      migrated_from: null,
    });
    expect(buildPendingDraft(record({
      relativePath: 'share-candidates/pending-note.md',
    }), ARCHIVE_COMMIT).slug).toMatch(/^inbox\/legacy-[a-z0-9-]+-[a-f0-9]{10}$/);
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
        slug: legacySlug('knowledge/safe-retry.md'),
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
      legacySlug('knowledge/safe-retry.md'),
    ]);
    expect(plan.write.map((item) => item.relativePath)).toEqual([
      'incidents/changed.md',
      'runbooks/renamed.md',
    ]);
    expect(plan.deleteAfterVerifiedWrites.sort()).toEqual([
      legacySlug('projects/stale.md'),
      legacySlug('runbooks/old-name.md'),
    ].sort());
  });
});
