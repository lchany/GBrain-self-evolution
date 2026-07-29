import { describe, expect, test } from 'bun:test';
import { applyReviewPlan, planReview, type ReviewCoreDeps, type ReviewSourcePage } from '../src/core/review/index.ts';

const REVIEW_DATE = '2026-07-26';

function page(slug: string, frontmatter: string, body = '## 结论\n\n已验证的结论。'): ReviewSourcePage {
  return {
    slug,
    markdown: `---\n${frontmatter}---\n\n# ${slug.split('/').at(-1) ?? 'page'}\n\n${body}\n`,
  };
}

function frontmatter(overrides: { readonly type?: string; readonly status?: string; readonly verification?: string } = {}): string {
  return `type: ${overrides.type ?? 'incident'}
date: 2026-07-26
status: ${overrides.status ?? 'draft'}
sensitivity: internal
verification: ${overrides.verification ?? 'verified'}
applicability:
  - all
non_applicable: []
source_refs:
  - file:<EVIDENCE_POINTER>
migrated_from: null
`;
}

function deps(pages: readonly ReviewSourcePage[], duplicateSlugs: readonly string[] = []): ReviewCoreDeps {
  const bySlug = new Map(pages.map((entry) => [entry.slug, entry]));
  return {
    readPage: async (slug) => bySlug.get(slug) ?? null,
    searchDuplicates: async () => duplicateSlugs.map((slug) => ({ slug, title: slug, score: 1 })),
  };
}

describe('review core planning', () => {
  test('Given an incident draft When keep is planned Then target/review/delete steps are reusable by CLI and Web', async () => {
    // given
    const source = page('inbox/incident-one', frontmatter());

    // when
    const result = await planReview(deps([source]), {
      action: { kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/incident-one', targetType: 'incident' },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
    expect(result.plan?.steps.map((step) => step.kind)).toEqual(['write_target', 'verify_target', 'write_review', 'delete_source']);
    expect(result.plan?.targetPage?.slug).toBe('incidents/incident-one');
    expect(result.plan?.reviewPage.slug).toBe('decisions/reviews/incident-one-review-20260726');
  });

  test('Given a verified reusable draft When promote is confirmed Then promotion plan uses the same result shape', async () => {
    // given
    const source = page('inbox/runbook-one', frontmatter({ type: 'runbook' }));

    // when
    const result = await planReview(deps([source]), {
      action: {
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'runbooks/runbook-one',
        targetType: 'runbook',
        humanConfirmation: true,
      },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
    expect(result.plan?.targetPage?.frontmatter.status).toBe('verified');
    expect(result.plan?.targetPage?.frontmatter.verification).toBe('verified');
  });

  test('Given an existing target When merge is planned Then target is updated and source is deleted only after review steps', async () => {
    // given
    const source = page('inbox/merge-one', frontmatter());
    const target = page('incidents/merge-one', frontmatter({ status: 'reviewed', verification: 'unverified' }));

    // when
    const result = await planReview(deps([source, target]), {
      action: {
        kind: 'merge',
        sourceSlug: source.slug,
        targetSlug: target.slug,
        targetType: 'incident',
        humanConfirmation: true,
      },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
    expect(result.plan?.targetPage?.compiledTruth).toContain('## 合并来源');
    expect(result.plan?.steps.map((step) => step.kind)).toEqual(['write_target', 'verify_target', 'write_review', 'delete_source']);
  });

  test('Given missing non_applicable When promote is planned Then gate fails with stable code', async () => {
    // given
    const source = page('inbox/missing-boundary', frontmatter().replace('non_applicable: []\n', ''));

    // when
    const result = await planReview(deps([source]), {
      action: {
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'knowledge/missing-boundary',
        targetType: 'knowledge',
        humanConfirmation: true,
      },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing_non_applicable');
  });

  test('Given a duplicate target When promote is planned Then gate fails with stable code', async () => {
    // given
    const source = page('inbox/duplicate-one', frontmatter({ type: 'knowledge' }));

    // when
    const result = await planReview(deps([source], ['knowledge/duplicate-one']), {
      action: {
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'knowledge/duplicate-one',
        targetType: 'knowledge',
        humanConfirmation: true,
      },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(false);
    expect(result.code).toBe('duplicate_target');
  });

  test('Given unverified draft When promote is planned Then gate fails with stable code', async () => {
    // given
    const source = page('inbox/unverified-one', frontmatter({ type: 'knowledge', verification: 'unverified' }));

    // when
    const result = await planReview(deps([source]), {
      action: {
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'knowledge/unverified-one',
        targetType: 'knowledge',
        humanConfirmation: true,
      },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unverified_promote');
  });

  test('Given unsafe content When keep is planned Then gate fails with stable code', async () => {
    // given
    const source = page('inbox/unsafe-one', frontmatter(), 'Attention Required! | Cloudflare\n\nCloudflare Ray ID: abc123');

    // when
    const result = await planReview(deps([source]), {
      action: { kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/unsafe-one', targetType: 'incident' },
      reviewDate: REVIEW_DATE,
    });

    // then
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsafe_content');
  });

  test('Given a cleanup draft When cleanup plan is applied Then review is written before source delete', async () => {
    // given
    const source = page('inbox/cleanup-one', frontmatter());
    const planned = await planReview(deps([source]), {
      action: { kind: 'cleanup', sourceSlug: source.slug, reviewNotes: 'handled by reviewer' },
      reviewDate: REVIEW_DATE,
    });
    const calls: string[] = [];
    const applyDeps: ReviewCoreDeps = {
      readPage: async () => null,
      searchDuplicates: async () => [],
      writePage: async (written) => {
        calls.push(`write:${written.slug}`);
        return { ok: true, code: 'written', message: written.slug };
      },
      deletePage: async (slug) => {
        calls.push(`delete:${slug}`);
        return { ok: true, code: 'deleted', message: slug };
      },
    };

    // when
    const applied = planned.plan ? await applyReviewPlan(applyDeps, planned.plan) : null;

    // then
    expect(planned.ok).toBe(true);
    expect(planned.plan?.steps.map((step) => step.kind)).toEqual(['write_review', 'delete_source']);
    expect(applied?.ok).toBe(true);
    expect(applied?.receipts.map((receipt) => receipt.code)).toEqual(['written', 'deleted']);
    expect(calls).toEqual(['write:decisions/reviews/cleanup-one-review-20260726', 'delete:inbox/cleanup-one']);
  });
});
