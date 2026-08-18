/**
 * Todo 7 — Web UI review routes tests.
 *
 * Covers:
 * - Parity: same fixture through core directly vs through the Web handler
 *   (parseActionBody → planReview) produces identical gate codes.
 * - Promote confirmation: without "PROMOTE <target-slug>" the confirm
 *   endpoint returns 400; with it, it proceeds to planReview.
 * - Credential exposure: response payloads never contain token/secret/bearer.
 * - Route behavior: inbox list, detail, plan, confirm, history with mock engine.
 */

import { describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import {
  mountReviewRoutes,
  parseActionBody,
  buildAction,
  planResultToJson,
  generateReviewTargetSlug,
  pageToReviewSource,
} from '../src/commands/serve-http-review.ts';
import { parseBatchClassificationBody } from '../src/commands/serve-http-review-batch.ts';
import {
  COMMON_REVIEW_ACTIONS,
  RARE_REVIEW_ACTIONS,
  REVIEW_ACTION_CATALOG,
  reviewActionCatalogEntry,
} from '../src/core/review/action-catalog.ts';
import {
  BROWSER_SAFE_HIDDEN_TEXT,
  REVIEW_ERROR_TEXT,
  browserSafeHtml,
  browserSafeReviewError,
  projectBrowserSafeText,
} from '../src/core/review/browser-safe.ts';
import { planReview, type ReviewCoreDeps, type ReviewRecommendationProvider, type ReviewSourcePage } from '../src/core/review/index.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import {
  createLocalWriterSessionFactory,
  localWriterEnvPath,
  type WriterSessionFactory,
} from '../src/commands/gbrain-capture-writer.ts';
import { resolveReviewWriterMcpUrl } from '../src/commands/serve-http.ts';

const REVIEW_DATE = '2026-07-26';

function makePage(slug: string, overrides: Partial<Page> = {}): Page {
  const now = new Date('2026-07-26T12:00:00Z');
  return {
    id: 1,
    slug,
    type: 'incident',
    title: slug.split('/').at(-1) ?? slug,
    compiled_truth: '## 结论\n\n已验证的结论。',
    timeline: '',
    frontmatter: {
      type: 'incident',
      date: '2026-07-26',
      status: 'draft',
      sensitivity: 'internal',
      verification: 'verified',
      applicability: ['all'],
      non_applicable: [],
      source_refs: ['file:<EVIDENCE_POINTER>'],
      migrated_from: null,
    },
    created_at: now,
    updated_at: now,
    source_id: 'default',
    ...overrides,
  };
}

type MockEngineCalls = {
  readonly onGetPage?: (slug: string, sourceId: string | undefined) => void;
  readonly onListPages?: (sourceId: string | undefined) => void;
};

function mockEngine(pages: readonly Page[], calls: MockEngineCalls = {}): BrainEngine {
  const pageKey = (sourceId: string, slug: string) => `${sourceId}\u0000${slug}`;
  const bySourceAndSlug = new Map(pages.map((p) => [pageKey(p.source_id, p.slug), p]));
  return {
    getPage: async (slug: string, options?: { readonly sourceId?: string }) => {
      calls.onGetPage?.(slug, options?.sourceId);
      if (options?.sourceId !== undefined) return bySourceAndSlug.get(pageKey(options.sourceId, slug)) ?? null;
      return pages.find((page) => page.slug === slug) ?? null;
    },
    listPages: async (filters: { readonly slugPrefix?: string; readonly type?: string; readonly limit?: number; readonly sourceId?: string }) => {
      calls.onListPages?.(filters.sourceId);
      let result = pages.filter((p) => !p.deleted_at);
      if (filters.sourceId !== undefined) result = result.filter((p) => p.source_id === filters.sourceId);
      if (filters.slugPrefix) result = result.filter((p) => p.slug.startsWith(filters.slugPrefix!));
      if (filters.type) result = result.filter((p) => p.type === filters.type!);
      if (filters.limit) result = result.slice(0, filters.limit);
      return result;
    },
  } as unknown as BrainEngine;
}

function writerBackedEngine(source: Page, targetSlug: string): { readonly engine: BrainEngine; readonly markTargetWritten: () => void } {
  let targetWritten = false;
  const target = makePage(targetSlug, { type: targetSlug.startsWith('runbooks/') ? 'runbook' : 'incident' });
  return {
    engine: {
      getPage: async (slug: string) => {
        if (slug === source.slug) return source;
        if (slug === targetSlug) return targetWritten ? target : null;
        return null;
      },
      listPages: async () => [source],
    } as unknown as BrainEngine,
    markTargetWritten: () => { targetWritten = true; },
  };
}

function mockDeps(pages: readonly ReviewSourcePage[], duplicateSlugs: readonly string[] = []): ReviewCoreDeps {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  return {
    readPage: async (slug) => bySlug.get(slug) ?? null,
    searchDuplicates: async () => duplicateSlugs.map((slug) => ({ slug, title: slug, score: 1 })),
  };
}

function reviewSourcePage(slug: string, frontmatterText: string, body = '## 结论\n\n已验证的结论。'): ReviewSourcePage {
  return {
    slug,
    markdown: `---\n${frontmatterText}---\n\n# ${slug.split('/').at(-1) ?? 'page'}\n\n${body}\n`,
  };
}

function frontmatterText(overrides: { readonly type?: string; readonly status?: string; readonly verification?: string } = {}): string {
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

type CreateAppOptions = {
  readonly adminOrigin?: URL;
  readonly writerSessionFactory?: WriterSessionFactory;
  readonly reviewSourceId?: string;
  readonly recommendationProvider?: ReviewRecommendationProvider;
};

function createApp(
  engine: BrainEngine,
  writerCaller?: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  options: CreateAppOptions = {},
) {
  const app = express();
  const sessions = new Map<string, number>();
  function requireAdmin(req: Request, _res: Response, next: (err?: unknown) => void) {
    const sid = (req.headers['x-test-session'] as string) ?? 'test-session';
    sessions.set(sid, Date.now() + 999999);
    (req as unknown as Record<string, unknown>).cookies = { gbrain_admin: sid };
    next();
  }
  mountReviewRoutes(app, engine, requireAdmin, {
    writerSessionFactory: options.writerSessionFactory ?? (async () => ({
      callTool: async (name, args) => name === 'whoami'
        ? { source_id: options.reviewSourceId ?? 'default' }
        : (writerCaller ?? (async () => ({ ok: true })))(name, args),
      close: async () => {},
    })),
    adminOrigin: options.adminOrigin,
    issuerUrl: new URL('http://review.test'),
    reviewDate: () => REVIEW_DATE,
    reviewSourceId: options.reviewSourceId,
    recommendationProvider: options.recommendationProvider,
  });
  return app;
}

async function fetchApp(app: express.Express, path: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: unknown; readonly text: string; readonly contentType: string }> {
  const server = app.listen(0);
  const port = (server.address() as { readonly port: number }).port;
  try {
    const headers: Record<string, string> = { 'x-test-session': 'test-session' };
    if (init?.method === 'POST') headers['Origin'] = 'http://review.test';
    Object.assign(headers, init?.headers ?? {});
    if (headers['Origin'] === '__OMIT__') delete headers['Origin'];
    const res = await fetch(`http://localhost:${port}${path}`, {
      ...init,
      headers,
    });
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') && text.length > 0 ? JSON.parse(text) : null;
    return { status: res.status, body, text, contentType };
  } finally {
    server.close();
  }
}

// --- Parity tests ---

describe('review web parity: core gate codes == web handler gate codes', () => {
  test('Given a keep fixture When planned through core vs through web handler Then gate codes are identical', async () => {
    // given
    const source = reviewSourcePage('inbox/parity-keep', frontmatterText());
    const coreDeps = mockDeps([source]);
    const engine = mockEngine([makePage('inbox/parity-keep')]);

    // when: core directly
    const coreResult = await planReview(coreDeps, {
      action: { kind: 'keep', sourceSlug: 'inbox/parity-keep', targetSlug: 'incidents/parity-keep', targetType: 'incident' },
      reviewDate: REVIEW_DATE,
    });

    // when: web handler (parseActionBody → planReview with same deps shape)
    const webAction = parseActionBody({
      kind: 'keep',
      sourceSlug: 'inbox/parity-keep',
      targetSlug: 'incidents/parity-keep',
      targetType: 'incident',
    });
    expect(webAction).not.toBeNull();
    const webDeps: ReviewCoreDeps = {
      readPage: async (slug) => {
        const page = await engine.getPage(slug);
        return page === null ? null : pageToReviewSource(page);
      },
      searchDuplicates: async () => [],
    };
    const webResult = await planReview(webDeps, { action: webAction!, reviewDate: REVIEW_DATE });

    // then: identical gate codes
    expect(coreResult.ok).toBe(webResult.ok);
    expect(coreResult.code).toBe(webResult.code);
    expect(coreResult.gates.map((g) => g.code)).toEqual(webResult.gates.map((g) => g.code));
    expect(coreResult.gates.map((g) => g.ok)).toEqual(webResult.gates.map((g) => g.ok));
  });

  test('Given a promote fixture When planned through core vs web handler Then gate codes are identical', async () => {
    // given
    const source = reviewSourcePage('inbox/parity-promote', frontmatterText({ type: 'runbook' }));
    const coreDeps = mockDeps([source]);
    const engine = mockEngine([makePage('inbox/parity-promote', { type: 'runbook' })]);

    // when
    const coreResult = await planReview(coreDeps, {
      action: { kind: 'promote', sourceSlug: 'inbox/parity-promote', targetSlug: 'runbooks/parity-promote', targetType: 'runbook', humanConfirmation: true },
      reviewDate: REVIEW_DATE,
    });
    const webAction = parseActionBody({
      kind: 'promote',
      sourceSlug: 'inbox/parity-promote',
      targetSlug: 'runbooks/parity-promote',
      targetType: 'runbook',
      humanConfirmation: true,
    });
    const webDeps: ReviewCoreDeps = {
      readPage: async (slug) => {
        const page = await engine.getPage(slug);
        return page === null ? null : pageToReviewSource(page);
      },
      searchDuplicates: async () => [],
    };
    const webResult = await planReview(webDeps, { action: webAction!, reviewDate: REVIEW_DATE });

    // then
    expect(coreResult.ok).toBe(webResult.ok);
    expect(coreResult.code).toBe(webResult.code);
    expect(coreResult.gates.map((g) => g.code)).toEqual(webResult.gates.map((g) => g.code));
  });

  test('Given a duplicate target fixture When planned through core vs web handler Then both fail with duplicate_target', async () => {
    // given
    const source = reviewSourcePage('inbox/parity-dup', frontmatterText({ type: 'knowledge' }));
    const coreDeps = mockDeps([source], ['knowledge/parity-dup']);
    const engine = mockEngine([makePage('inbox/parity-dup', { type: 'knowledge' })]);

    // when
    const coreResult = await planReview(coreDeps, {
      action: { kind: 'promote', sourceSlug: 'inbox/parity-dup', targetSlug: 'knowledge/parity-dup', targetType: 'knowledge', humanConfirmation: true },
      reviewDate: REVIEW_DATE,
    });
    const webAction = parseActionBody({
      kind: 'promote',
      sourceSlug: 'inbox/parity-dup',
      targetSlug: 'knowledge/parity-dup',
      targetType: 'knowledge',
      humanConfirmation: true,
    });
    const webDeps: ReviewCoreDeps = {
      readPage: async (slug) => {
        const page = await engine.getPage(slug);
        return page === null ? null : pageToReviewSource(page);
      },
      searchDuplicates: async () => [{ slug: 'knowledge/parity-dup', title: 'knowledge/parity-dup', score: 1 }],
    };
    const webResult = await planReview(webDeps, { action: webAction!, reviewDate: REVIEW_DATE });

    // then
    expect(coreResult.code).toBe('duplicate_target');
    expect(webResult.code).toBe('duplicate_target');
  });
});

// --- Promote confirmation tests ---

describe('review web promote confirmation', () => {
  test('Given a promote action without confirmation When confirm is called Then returns a fixed confirmation error without projecting the phrase', async () => {
    // given
    const engine = mockEngine([makePage('inbox/promote-test', { type: 'runbook' })]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: 'inbox/promote-test',
        targetSlug: 'runbooks/promote-test',
        targetType: 'runbook',
      }),
    });

    // then
    expect(result.status).toBe(400);
    const body = result.body as Record<string, unknown>;
    expect(body).toEqual({ error: 'confirmation_required', message: '必须输入确认短语后才能执行该操作。' });
  });

  test('Given a promote action with correct confirmation When confirm is called Then proceeds to plan', async () => {
    // given
    const source = makePage('inbox/promote-test', { type: 'runbook' });
    const review = writerBackedEngine(source, 'runbooks/promote-test');
    const app = createApp(review.engine, async (name, args) => {
      if (name === 'put_page' && args.slug === 'runbooks/promote-test') review.markTargetWritten();
      if (name === 'put_page') return { slug: 'ok' };
      if (name === 'delete_page') return { deleted: true };
      return {};
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: 'inbox/promote-test',
        targetSlug: 'runbooks/promote-test',
        targetType: 'runbook',
        confirmation: 'PROMOTE runbooks/promote-test',
      }),
    });

    // then
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.code).toBe('ok');
    expect(body.action).toBe('promote');
    expect(body.target).toBe('runbooks/promote-test');
    expect(body.retrieval_verified).toBe(true);
  });

  test('Given a keep request targeting knowledge When directly planned through the API Then it is normalized to promote and remains confirmation-gated', async () => {
    // given
    const app = createApp(mockEngine([makePage('inbox/keep-knowledge', { type: 'runbook' })]));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'keep',
        sourceSlug: 'inbox/keep-knowledge',
        targetSlug: 'knowledge/keep-knowledge',
        targetType: 'knowledge',
      }),
    });

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: 'promote_confirmation_required' });
  });

  test('Given a keep request targeting a runbook When directly confirmed with PROMOTE Then it applies as promote', async () => {
    // given
    const writes: string[] = [];
    const source = makePage('inbox/keep-runbook', { type: 'runbook' });
    const review = writerBackedEngine(source, 'runbooks/keep-runbook');
    const app = createApp(review.engine, async (name, args) => {
      writes.push(name);
      if (name === 'put_page' && args.slug === 'runbooks/keep-runbook') review.markTargetWritten();
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'keep',
        sourceSlug: source.slug,
        targetSlug: 'runbooks/keep-runbook',
        targetType: 'runbook',
        confirmation: 'PROMOTE runbooks/keep-runbook',
      }),
    });

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, code: 'ok', action: 'promote' });
    expect(writes).toEqual(['put_page', 'put_page', 'delete_page']);
  });
});

// --- Credential exposure tests ---

describe('review web credential exposure', () => {
  test('Given any API response When inspected Then no token/secret/bearer in payload', async () => {
    // given
    const engine = mockEngine([makePage('inbox/cred-test')]);
    const app = createApp(engine);

    // when
    const endpoints = [
      '/admin/api/review/inbox',
      '/admin/api/review/inbox/inbox/cred-test',
      '/admin/api/review/history',
    ];
    for (const path of endpoints) {
      const result = await fetchApp(app, path);
      const text = result.text.toLowerCase();

      // then
      expect(text).not.toContain('bearer');
      expect(text).not.toContain('client_secret');
      expect(text).not.toContain('gbrain_token');
      expect(text).not.toContain('access_token');
    }
  });

  test('Given a plan response When inspected Then no credentials in payload', async () => {
    // given
    const engine = mockEngine([makePage('inbox/plan-cred')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'keep',
        sourceSlug: 'inbox/plan-cred',
        targetSlug: 'incidents/plan-cred',
        targetType: 'incident',
      }),
    });

    // then
    expect(result.status).toBe(200);
    const text = result.text.toLowerCase();
    expect(text).not.toContain('bearer');
    expect(text).not.toContain('client_secret');
    expect(text).not.toContain('access_token');
  });

  test('Given inbox metadata containing browser canaries When the inbox API responds Then every dynamic field is projected safely', async () => {
    // given
    const canaries = ['sk-FAKEFAKE1234', '{"access_token":"raw-auth-response"}', 'FAKE_API_KEY=raw-env'] as const;
    const page = makePage('inbox/inbox-canary', { title: canaries.join(' ') });
    page.frontmatter = { ...page.frontmatter, verification: canaries[0], status: canaries[1] };
    const app = createApp(mockEngine([page]));

    // when
    const result = await fetchApp(app, '/admin/api/review/inbox');

    // then
    expect(result.status).toBe(200);
    for (const canary of canaries) expect(result.text).not.toContain(canary);
  });

  test('Given a history record containing title and source-reference canaries When the history API responds Then it exposes only safe fields', async () => {
    // given
    const canaries = ['sk-FAKEFAKE1234', 'Bearer FAKEFAKE1234567890'] as const;
    const page = makePage('decisions/reviews/history-canary', { type: 'decision', title: canaries[0] });
    page.frontmatter = { ...page.frontmatter, source_refs: [canaries[1]] };
    const app = createApp(mockEngine([page]));

    // when
    const result = await fetchApp(app, '/admin/api/review/history');

    // then
    expect(result.status).toBe(200);
    expect(result.text).not.toContain(canaries[0]);
    expect(result.text).not.toContain(canaries[1]);
    expect(result.body).toMatchObject({ reviews: [{ slug: 'decisions/reviews/history-canary' }] });
  });

  test('Given inbox or history lookup failures When their APIs respond Then they return the fixed review error without exception text', async () => {
    // given
    const engine = {
      listPages: async () => { throw new Error('INTERNAL_BROWSER_BOUNDARY_CANARY'); },
    } as unknown as BrainEngine;
    const app = createApp(engine);

    // when
    const inbox = await fetchApp(app, '/admin/api/review/inbox');
    const history = await fetchApp(app, '/admin/api/review/history');

    // then
    for (const result of [inbox, history]) {
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
      expect(result.text).not.toContain('INTERNAL_BROWSER_BOUNDARY_CANARY');
    }
  });

  test('Given a confirmation target containing a browser canary When confirmation is rejected Then the response does not echo it', async () => {
    // given
    const canaryTarget = 'runbooks/sk-FAKEFAKE1234';
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: 'inbox/confirmation-canary',
        targetSlug: canaryTarget,
        targetType: 'runbook',
      }),
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'confirmation_required' });
    expect(result.text).not.toContain(canaryTarget);
  });
});

// --- Route behavior tests ---

describe('review web routes', () => {
  test('GET /admin/api/review/inbox returns inbox drafts', async () => {
    // given
    const engine = mockEngine([
      makePage('inbox/draft-a', { type: 'incident' }),
      makePage('inbox/draft-b', { type: 'runbook' }),
      makePage('knowledge/not-inbox'),
    ]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/inbox');

    // then
    expect(result.status).toBe(200);
    const body = result.body as { readonly drafts: readonly { readonly slug: string }[] };
    expect(body.drafts).toHaveLength(2);
    expect(body.drafts.map((d) => d.slug)).toContain('inbox/draft-a');
    expect(body.drafts.map((d) => d.slug)).toContain('inbox/draft-b');
  });

  test('GET /admin/api/review/inbox/:slug returns draft detail', async () => {
    // given
    const engine = mockEngine([makePage('inbox/detail-test')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/inbox/inbox/detail-test');

    // then
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.slug).toBe('inbox/detail-test');
    expect(body.content_preview).toBeDefined();
    expect(body.compiled_truth).toBeUndefined();
  });

  test('GET /admin/api/review/inbox/:slug returns 404 for missing draft', async () => {
    // given
    const engine = mockEngine([]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/inbox/inbox/missing');

    // then
    expect(result.status).toBe(404);
  });

  test('POST /admin/api/review/plan returns plan result', async () => {
    // given
    const engine = mockEngine([makePage('inbox/plan-test')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'keep',
        sourceSlug: 'inbox/plan-test',
        targetSlug: 'incidents/plan-test',
        targetType: 'incident',
      }),
    });

    // then
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.code).toBe('ok');
  });

  test('POST /admin/api/review/plan with invalid action returns 400', async () => {
    // given
    const engine = mockEngine([]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'invalid' }),
    });

    // then
    expect(result.status).toBe(400);
  });

  test('Given malformed JSON When a review plan is requested Then the parser returns the fixed review error', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
  });

  test('Given an unsupported urlencoded charset When review confirmation is requested Then the parser returns the fixed review error', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=unsupported' },
      body: 'action=keep',
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
  });

  test('Given a URL-encoded review plan When the plan endpoint receives it Then it returns the plan result', async () => {
    // given
    const source = makePage('inbox/urlencoded-plan');
    const app = createApp(mockEngine([source]));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'kind=keep&sourceSlug=inbox%2Furlencoded-plan&targetSlug=incidents%2Furlencoded-plan&targetType=incident',
    });

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, code: 'ok' });
  });

  test('Given a malformed percent-encoded review plan When the plan endpoint parses it Then it returns the fixed review error', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'kind=keep%',
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
  });

  test('Given a malformed percent-encoded review confirmation When the confirmation endpoint parses it Then it returns the fixed review error', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'kind=keep%',
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
  });

  test('GET /admin/api/review/history returns review records', async () => {
    // given
    const reviewPage = makePage('decisions/reviews/test-review-20260726', {
      type: 'decision',
      title: 'Review test',
    });
    reviewPage.frontmatter = { ...reviewPage.frontmatter, review_action: 'keep', source_refs: ['inbox/test'] };
    const engine = mockEngine([reviewPage]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/history');

    // then
    expect(result.status).toBe(200);
    const body = result.body as { readonly reviews: readonly Record<string, unknown>[] };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]).toMatchObject({
      slug: 'decisions/reviews/test-review-20260726',
      action: 'keep',
      action_label: '留在项目内',
      source: 'inbox/test',
      status: 'draft',
      target: null,
    });
    expect(body.reviews[0]).toHaveProperty('date');
    expect(body.reviews[0]).toHaveProperty('updated_at');
  });

  test('GET /admin/review returns HTML inbox page', async () => {
    // given
    const engine = mockEngine([makePage('inbox/html-test')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('Inbox');
    expect(result.text).toContain('inbox/html-test');
  });

  test('GET /admin/review renders a simple classification queue', async () => {
    // given
    const engine = mockEngine([makePage('inbox/triage-test', { title: '分诊测试草稿' })]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('分诊测试草稿');
    expect(result.text).toContain('开始审核');
    expect(result.text).toContain('/admin/review/detail/' + encodeURIComponent('inbox/triage-test'));
    expect(result.text).toContain('建议分类');
    expect(result.text).toContain('待生成');
    expect(result.text).not.toContain('预检');
    // updated date present
    expect(result.text).toContain('2026-07-26');
    // only the four API-backed filters are offered; no risk filter
    expect(result.text).toContain('name="type"');
    expect(result.text).toContain('name="verification"');
    expect(result.text).toContain('name="stale"');
    expect(result.text).toContain('name="project_id"');
    expect(result.text).not.toContain('name="risk"');
  });

  test('GET /admin/review/history returns HTML history page', async () => {
    // given
    const engine = mockEngine([]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review/history');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('审核历史');
  });

  test('Given plan or history rendering failures When the HTML routes respond Then they use the fixed review error without exception text', async () => {
    // given
    const engine = {
      getPage: async () => { throw new Error('PLAN_HTML_INTERNAL_CANARY'); },
      listPages: async () => { throw new Error('HISTORY_HTML_INTERNAL_CANARY'); },
    } as unknown as BrainEngine;
    const app = createApp(engine);

    // when
    const plan = await fetchApp(app, `/admin/review/plan/${encodeURIComponent('inbox/html-error')}?action=keep&target=incidents%2Fhtml-error&target_type=incident`);
    const history = await fetchApp(app, '/admin/review/history');

    // then
    for (const result of [plan, history]) {
      expect(result.status).toBe(503);
      expect(result.text).toContain(REVIEW_ERROR_TEXT);
    }
    expect(plan.text).not.toContain('PLAN_HTML_INTERNAL_CANARY');
    expect(history.text).not.toContain('HISTORY_HTML_INTERNAL_CANARY');
  });

  test('GET /admin/review/detail/:slug returns current HTML detail route', async () => {
    // given
    const engine = mockEngine([makePage('inbox/html-detail')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, `/admin/review/detail/${encodeURIComponent('inbox/html-detail')}`);

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('确认经验分类');
    expect(result.text).toContain('inbox/html-detail');
  });

  test('GET /admin/review/plan/:slug returns current HTML plan route', async () => {
    // given
    const engine = mockEngine([makePage('inbox/html-plan')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, `/admin/review/plan/${encodeURIComponent('inbox/html-plan')}?action=keep&target=incidents%2Fhtml-plan&target_type=incident`);

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('审核计划');
    expect(result.text).toContain('incidents/html-plan');
  });

  test('Given a merge action with a PROMOTE-prefixed phrase When confirm is called Then the adapter rejects it', async () => {
    // given
    const source = makePage('inbox/web-merge', { type: 'incident' });
    const target = makePage('incidents/web-merge', { type: 'incident', title: 'Existing merge target' });
    const app = createApp(mockEngine([source, target]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'merge',
        sourceSlug: 'inbox/web-merge',
        targetSlug: 'incidents/web-merge',
        targetType: 'incident',
        confirmation: 'PROMOTE incidents/web-merge',
      }),
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'confirmation_required', message: '必须输入确认短语后才能执行该操作。' });
  });

  test('Given a merge action with its exact MERGE phrase When confirm is called Then the adapter applies the fresh plan', async () => {
    // given
    const source = makePage('inbox/web-merge', { type: 'incident' });
    const target = makePage('incidents/web-merge', { type: 'incident', title: 'Existing merge target' });
    const app = createApp(mockEngine([source, target]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'merge',
        sourceSlug: 'inbox/web-merge',
        targetSlug: 'incidents/web-merge',
        targetType: 'incident',
        confirmation: 'MERGE incidents/web-merge',
      }),
    });

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, code: 'ok', action: 'merge' });
  });

  test('Todo 6 source isolation: Web review reads bind to the default server source', async () => {
    // given
    const readCalls: unknown[][] = [];
    const page = makePage('inbox/web-unscoped');
    const engine = {
      getPage: async (...args: readonly unknown[]) => {
        readCalls.push([...args]);
        return page;
      },
      listPages: async () => [],
    } as unknown as BrainEngine;
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/inbox/inbox/web-unscoped');

    // then
    expect(result.status).toBe(200);
    expect(readCalls).toEqual([['inbox/web-unscoped', { sourceId: 'default' }]]);
  });
});

// --- Inbox triage console (Todo 3) ---

describe('review inbox triage console', () => {
  test('Given drafts of different types When filtered by type Then only matching drafts appear', async () => {
    // given
    const engine = mockEngine([
      makePage('inbox/inc-a', { type: 'incident', title: '事件 A' }),
      makePage('inbox/run-b', { type: 'runbook', title: '运行手册 B' }),
      makePage('inbox/inc-c', { type: 'incident', title: '事件 C' }),
    ]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review?type=incident');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('事件 A');
    expect(result.text).toContain('事件 C');
    expect(result.text).not.toContain('运行手册 B');
  });

  test('Given drafts with different verification When filtered by verification Then only matching drafts appear', async () => {
    // given
    const verified = makePage('inbox/ver-yes', { title: '已验证' });
    const unverified = makePage('inbox/ver-no', { title: '未验证' });
    unverified.frontmatter = { ...unverified.frontmatter, verification: 'unverified' };
    const engine = mockEngine([verified, unverified]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review?verification=unverified');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('未验证');
    expect(result.text).not.toContain('已验证');
  });

  test('Given an inbox with no drafts When the list is requested Then Chinese empty state renders', async () => {
    // given
    const engine = mockEngine([]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('暂无 inbox 草稿');
  });

  test('Given drafts but a filter that matches nothing When the list is requested Then filtered empty state renders', async () => {
    // given
    const engine = mockEngine([makePage('inbox/only-incident', { type: 'incident' })]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review?type=runbook');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('没有匹配当前筛选条件的 inbox 草稿');
  });

  test('Given a draft with missing optional metadata When rendered Then safe Chinese fallbacks render without breaking layout', async () => {
    // given
    const page = makePage('inbox/sparse', { title: '稀疏草稿' });
    page.frontmatter = { type: 'incident', date: '2026-07-26' };
    const engine = mockEngine([page]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('稀疏草稿');
    expect(result.text).toContain('unverified');
    expect(result.text).toContain('待生成');
    expect(result.text).not.toContain('预检');
  });

  test('Given an engine that throws on listPages When the list is requested Then 503 with fixed Chinese and no exception leak', async () => {
    // given
    const engine = {
      getPage: async () => null,
      listPages: async () => { throw new Error('SECRET_INTERNAL_DB_FAILURE'); },
    } as unknown as BrainEngine;
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then
    expect(result.status).toBe(503);
    expect(result.text).toContain('审核操作失败');
    expect(result.text).not.toContain('SECRET_INTERNAL_DB_FAILURE');
  });

  test('Given the triage list HTML When inspected Then no write-action form controls appear', async () => {
    // given
    const engine = mockEngine([makePage('inbox/no-write')]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then: navigation-only — no POST forms, no execute/confirm buttons, no action-name controls
    expect(result.status).toBe(200);
    expect(result.text).not.toContain('method="post"');
    expect(result.text).not.toContain('确认执行');
    expect(result.text).not.toContain('name="action"');
    expect(result.text).not.toContain('name="target"');
    expect(result.text).not.toContain('name="confirmation"');
    // the only form is the GET filter form
    expect(result.text).toContain('method="get"');
  });

  test('Given the triage list HTML When inspected Then each draft row links to detail via 开始审核', async () => {
    // given
    const engine = mockEngine([makePage('inbox/link-test', { title: '链接测试' })]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/review');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('开始审核');
    expect(result.text).toContain('href="/admin/review/detail/' + encodeURIComponent('inbox/link-test') + '"');
  });
});

describe('detail summary', () => {
  test('Given a verified draft When its detail renders Then the summary precedes expandable evidence without a preflight', async () => {
    // given
    const page = makePage('inbox/detail-summary', {
      type: 'unrecognized-source-type',
      title: '摘要优先草稿',
    });
    page.frontmatter = {
      ...page.frontmatter,
      applicability: ['当前项目', '复盘'],
      project_id: 'project-summary',
    };
    const getPageCalls: string[] = [];
    let listPagesCalls = 0;
    const app = createApp(mockEngine([page], {
      onGetPage: (slug) => getPageCalls.push(slug),
      onListPages: () => { listPagesCalls += 1; },
    }));

    // when
    const result = await fetchApp(app, `/admin/review/detail/${encodeURIComponent(page.slug)}`);

    // then
    expect(result.status).toBe(200);
    const summaryIndex = result.text.indexOf('class="detail-summary"');
    const metadataIndex = result.text.indexOf('<details');
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(metadataIndex).toBeGreaterThan(summaryIndex);
    expect(result.text).toContain('草稿类型');
    expect(result.text).toContain('用途');
    expect(result.text).toContain('验证状态');
    expect(result.text).toContain('模型建议');
    expect(result.text).toContain('正在生成模型建议');
    expect(result.text).not.toContain('预检');
    expect(result.text).toContain('unrecognized-source-type');
    expect(result.text).not.toContain('name="target_type"');
    expect(result.text).not.toContain('name="target"');
    expect(getPageCalls).toEqual([page.slug]);
    expect(listPagesCalls).toBe(0);
  });

  test('Given an unverified long draft with missing metadata When its detail renders Then fixed fallbacks and a bounded preview render', async () => {
    // given
    const longBody = `长草稿 ${'x'.repeat(2400)}`;
    const page = makePage('inbox/detail-sparse', { compiled_truth: longBody, timeline: '' });
    page.frontmatter = {};
    const app = createApp(mockEngine([page]));

    // when
    const result = await fetchApp(app, `/admin/review/detail/${encodeURIComponent(page.slug)}`);

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('先补证据');
    expect(result.text).toContain('未提供');
    expect(result.text).toContain('长草稿');
    expect(result.text).not.toContain('x'.repeat(2100));
    expect(result.text).toContain('<details');
    expect(result.text).toContain('草稿元数据');
    expect(result.text).toContain('内容预览');
  });
});

describe('detail summary canary', () => {
  test('Given sensitive and raw draft fields When detail HTML and JSON render Then browser-safe projections hide every canary', async () => {
    // given
    const sensitiveCanaries = [
      'sk-FAKEFAKE1234',
      'AKIAFAKEFAKE1234',
      'github_pat_FAKEFAKE1234',
      'xoxb-FAKEFAKE1234',
      'gbrain_FAKEFAKE1234',
      'eyJhbGciOiJGQUtFIn0.eyJzdWIiOiJGQUtFIn0.RkFLRV9TSUdOQVRVUkU',
      'Bearer FAKEFAKE1234567890',
      '-----BEGIN FAKE PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END FAKE PRIVATE KEY-----',
      'person@example.test',
      '555-123-4567',
      '123-45-6789',
      '4111 1111 1111 1111',
    ] as const;
    const rawTranscript = 'User: raw transcript\nAssistant: raw response';
    const rawJson = '{"access_token":"raw-auth-response"}';
    const rawEnv = 'FAKE_API_KEY=raw-env\nFAKE_REGION=test';
    const denseLog = Array.from({ length: 12 }, (_, index) => `2026-07-26T00:00:${String(index).padStart(2, '0')}Z ERROR raw detail log line`).join('\n');
    const page = makePage('inbox/detail-canary', {
      title: `标题 ${sensitiveCanaries.join(' ')}`,
      compiled_truth: `${rawTranscript}\n${rawEnv}`,
      timeline: `${rawJson}\n${denseLog}`,
    });
    page.frontmatter = {
      date: sensitiveCanaries[0],
      status: sensitiveCanaries[1],
      sensitivity: sensitiveCanaries[2],
      verification: sensitiveCanaries[3],
      applicability: [sensitiveCanaries[4], sensitiveCanaries[5]],
      non_applicable: [sensitiveCanaries[6], sensitiveCanaries[7]],
      review_action: sensitiveCanaries[8],
      project_id: `${sensitiveCanaries[9]} ${sensitiveCanaries[10]} ${sensitiveCanaries[11]}`,
      source_refs: [sensitiveCanaries.join(' ')],
    };
    const app = createApp(mockEngine([page]));

    // when
    const htmlResult = await fetchApp(app, `/admin/review/detail/${encodeURIComponent(page.slug)}`);
    const jsonResult = await fetchApp(app, `/admin/api/review/inbox/${encodeURIComponent(page.slug)}`);
    const rendered = `${htmlResult.text}\n${jsonResult.text}`;

    // then
    expect(htmlResult.status).toBe(200);
    expect(jsonResult.status).toBe(200);
    for (const canary of [...sensitiveCanaries, rawTranscript, rawJson, rawEnv, denseLog]) {
      expect(rendered).not.toContain(canary);
    }
    expect(rendered).not.toContain('compiled_truth');
    expect(rendered).not.toContain('frontmatter');
    expect(rendered).not.toContain('timeline');
    expect(rendered).not.toContain('source_refs');
    expect(rendered).toContain(BROWSER_SAFE_HIDDEN_TEXT);
  });
});

describe('single classification review', () => {
  test('Given a draft detail When rendered Then only category and one confirmation are editable', async () => {
    const page = makePage('inbox/single-review', { title: '单一审核草稿' });
    page.frontmatter.review_recommendation = {
      category: 'incident',
      scenario: '定位可复用的故障处理经验。',
      reason: '正文包含故障现象、根因和验证结果。',
      generated_by: 'model',
    };
    const result = await fetchApp(createApp(mockEngine([page])), `/admin/review/detail/${encodeURIComponent(page.slug)}`);

    expect(result.status).toBe(200);
    expect(result.text).toContain('大模型建议');
    expect(result.text).toContain('定位可复用的故障处理经验');
    expect(result.text.match(/<select/g)?.length).toBe(1);
    expect(result.text.match(/type="submit"/g)?.length).toBe(1);
    expect(result.text).toContain('拒绝并删除');
    for (const hidden of ['预检', '门禁', '确认短语', 'name="target"', 'name="reviewNotes"', '更多处理方式']) {
      expect(result.text).not.toContain(hidden);
    }
  });

  test('old drafts request a real recommendation once and reuse the bounded cache', async () => {
    const page = makePage('inbox/model-fallback');
    let calls = 0;
    const recommendationProvider: ReviewRecommendationProvider = async () => {
      calls += 1;
      return { category: 'knowledge', scenario: '跨项目复用。', reason: '内容是通用方法。', generated_by: 'model' };
    };
    const app = createApp(mockEngine([page]), undefined, { recommendationProvider });

    const detail = await fetchApp(app, `/admin/review/detail/${encodeURIComponent(page.slug)}`);
    expect(detail.status).toBe(200);
    expect(calls).toBe(0);
    expect(detail.text).toContain('正在生成模型建议');
    expect(detail.text).toContain('id="review-category" name="category" disabled');
    expect(detail.text).toContain('id="classification-submit" type="submit" disabled');

    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug: page.slug }),
    } as const;
    const first = await fetchApp(app, '/admin/api/review/recommendation', request);
    const second = await fetchApp(app, '/admin/api/review/recommendation', request);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(1);
    expect(first.body).toMatchObject({ recommendation: { category: 'knowledge', generated_by: 'model' } });
  });

  test('model failures return fixed Chinese guidance and never invent a recommendation', async () => {
    const page = makePage('inbox/model-failure');
    const app = createApp(mockEngine([page]), undefined, {
      recommendationProvider: async () => { throw new Error('SECRET_PROVIDER_FAILURE'); },
    });
    const result = await fetchApp(app, '/admin/api/review/recommendation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug }),
    });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: 'recommendation_unavailable',
      message: '暂时无法生成模型建议，请稍后刷新。',
    });
    expect(result.text).not.toContain('SECRET_PROVIDER_FAILURE');
  });

  test('captured recommendations bypass the provider and extra request fields fail closed', async () => {
    const page = makePage('inbox/captured-recommendation');
    page.frontmatter.review_recommendation = {
      category: 'incident', scenario: '故障复盘。', reason: '包含根因。', generated_by: 'model',
    };
    let calls = 0;
    const app = createApp(mockEngine([page]), undefined, {
      recommendationProvider: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    });
    const result = await fetchApp(app, '/admin/api/review/recommendation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug }),
    });
    const rejected = await fetchApp(app, '/admin/api/review/recommendation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug, target: 'incidents/evil' }),
    });
    expect(result.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(calls).toBe(0);
  });

  test('classification cannot bypass the required model recommendation', async () => {
    const page = makePage('inbox/recommendation-required');
    const result = await fetchApp(createApp(mockEngine([page])), '/admin/api/review/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug, category: 'incident' }),
    });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: 'model_recommendation_required' });
  });

  test('classification accepts only source and category, then writes and deletes through the attested writer', async () => {
    const page = makePage('inbox/classify-incident');
    page.frontmatter.review_recommendation = {
      category: 'incident', scenario: '故障复盘。', reason: '包含根因。', generated_by: 'model',
    };
    const backed = writerBackedEngine(page, 'incidents/classify-incident');
    const writes: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
    const app = createApp(backed.engine, async (name, args) => {
      writes.push({ name, args });
      if (name === 'put_page' && args.slug === 'incidents/classify-incident') backed.markTargetWritten();
      return { ok: true };
    });
    const result = await fetchApp(app, '/admin/api/review/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug, category: 'incident' }),
    });
    const rejected = await fetchApp(app, '/admin/api/review/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug, category: 'incident', targetSlug: 'incidents/evil' }),
    });
    expect(result.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(writes.map((write) => write.name)).toEqual(['put_page', 'put_page', 'delete_page']);
    expect(writes[0]?.args.slug).toBe('incidents/classify-incident');
    expect(String(writes[0]?.args.content)).not.toContain('review_recommendation');
  });

  test('reject is a category and writes the audit record before soft deletion', async () => {
    const page = makePage('inbox/classify-reject');
    page.frontmatter.review_recommendation = {
      category: 'reject', scenario: '不应归档。', reason: '没有可复用经验。', generated_by: 'model',
    };
    const calls: string[] = [];
    const result = await fetchApp(createApp(mockEngine([page]), async (name) => {
      calls.push(name);
      return { ok: true };
    }), '/admin/api/review/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSlug: page.slug, category: 'reject' }),
    });
    expect(result.status).toBe(200);
    expect(calls).toEqual(['put_page', 'delete_page']);
  });
});

describe('batch classification review', () => {
  test('inbox exposes current-page selection and exactly two batch decisions', async () => {
    const first = makePage('inbox/batch-ui-one', { title: '批量草稿一' });
    const second = makePage('inbox/batch-ui-two', { title: '批量草稿二' });

    const result = await fetchApp(createApp(mockEngine([first, second])), '/admin/review');

    expect(result.status).toBe(200);
    expect(result.text).toContain('id="review-select-all"');
    expect(result.text.match(/<input type="checkbox" name="sourceSlugs"/g)?.length).toBe(2);
    expect(result.text).toContain('id="batch-selected-count"');
    expect(result.text.match(/data-batch-decision=/g)?.length).toBe(2);
    expect(result.text).toMatch(/data-batch-decision="accept"[^>]*>同意<\/button>/);
    expect(result.text).toMatch(/data-batch-decision="reject"[^>]*>拒绝并删除<\/button>/);
    expect(result.text).not.toContain('name="batchCategory"');
    expect(result.text).not.toContain('批量预检');
  });

  test('batch request parser is strict, bounded, and deduplicates in first-seen order', () => {
    expect(parseBatchClassificationBody({
      sourceSlugs: ['inbox/one', 'inbox/two', 'inbox/one'],
      decision: 'accept',
    })).toEqual({ sourceSlugs: ['inbox/one', 'inbox/two'], decision: 'accept' });
    expect(parseBatchClassificationBody({ sourceSlugs: [], decision: 'accept' })).toBeNull();
    expect(parseBatchClassificationBody({ sourceSlugs: Array.from({ length: 51 }, (_, index) => `inbox/item-${index}`), decision: 'reject' })).toBeNull();
    expect(parseBatchClassificationBody({ sourceSlugs: ['inbox/one'], decision: 'accept', category: 'incident' })).toBeNull();
    expect(parseBatchClassificationBody({ sourceSlugs: ['knowledge/not-inbox'], decision: 'accept' })).toBeNull();
    expect(parseBatchClassificationBody({ sourceSlugs: ['inbox/../escape'], decision: 'reject' })).toBeNull();
    expect(parseBatchClassificationBody({ sourceSlugs: ['inbox/中文_经验'], decision: 'accept' })).toEqual({
      sourceSlugs: ['inbox/中文_经验'], decision: 'accept',
    });
  });

  test('accept uses each current model recommendation, keeps missing recommendations, and shares one attested writer session', async () => {
    const incident = makePage('inbox/batch-incident');
    incident.frontmatter.review_recommendation = {
      category: 'incident', scenario: '故障复盘。', reason: '包含根因。', generated_by: 'model',
    };
    const knowledge = makePage('inbox/batch-knowledge');
    knowledge.frontmatter.review_recommendation = {
      category: 'knowledge', scenario: '跨项目方法。', reason: '内容通用。', generated_by: 'model',
    };
    const missing = makePage('inbox/batch-missing');
    const pages = new Map([incident, knowledge, missing].map((page) => [page.slug, page]));
    const writerCalls: Array<{ readonly name: string; readonly slug: string }> = [];
    let sessions = 0;
    let closes = 0;
    const engine = {
      getPage: async (slug: string) => pages.get(slug) ?? null,
      listPages: async (filters: { readonly slugPrefix?: string }) => [...pages.values()].filter((page) => !page.deleted_at && (filters.slugPrefix === undefined || page.slug.startsWith(filters.slugPrefix))),
    } as unknown as BrainEngine;
    const app = createApp(engine, undefined, {
      writerSessionFactory: async () => {
        sessions += 1;
        return {
          callTool: async (name, args) => {
            if (name === 'whoami') return { source_id: 'default' };
            const slug = String(args.slug ?? '');
            writerCalls.push({ name, slug });
            if (name === 'put_page' && !slug.startsWith('decisions/reviews/')) {
              pages.set(slug, makePage(slug, { type: slug.startsWith('knowledge/') ? 'knowledge' : 'incident' }));
            }
            if (name === 'delete_page') {
              const source = pages.get(slug);
              if (source !== undefined) source.deleted_at = new Date();
            }
            return { ok: true };
          },
          close: async () => { closes += 1; },
        };
      },
    });

    const result = await fetchApp(app, '/admin/api/review/classify-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlugs: [incident.slug, missing.slug, knowledge.slug], decision: 'accept' }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ succeeded: 2, failed: 1 });
    expect((result.body as { results: readonly Record<string, unknown>[] }).results).toEqual([
      { sourceSlug: incident.slug, status: 'succeeded', category: 'incident' },
      { sourceSlug: missing.slug, status: 'failed', code: 'recommendation_missing', message: '该草稿缺少有效的模型推荐，已保留在收件箱。' },
      { sourceSlug: knowledge.slug, status: 'succeeded', category: 'knowledge' },
    ]);
    expect(sessions).toBe(1);
    expect(closes).toBe(1);
    expect(writerCalls.some((call) => call.slug === 'incidents/batch-incident')).toBe(true);
    expect(writerCalls.some((call) => call.slug === 'knowledge/batch-knowledge')).toBe(true);
    expect(missing.deleted_at).toBeUndefined();
  });

  test('reject does not require recommendations and preserves per-item audit-before-delete order', async () => {
    const first = makePage('inbox/batch-reject-one');
    const second = makePage('inbox/batch-reject-two');
    const calls: Array<{ readonly name: string; readonly slug: string }> = [];
    let sessions = 0;
    const result = await fetchApp(createApp(mockEngine([first, second]), undefined, {
      writerSessionFactory: async () => {
        sessions += 1;
        return {
          callTool: async (name, args) => {
            if (name === 'whoami') return { source_id: 'default' };
            calls.push({ name, slug: String(args.slug ?? '') });
            return { ok: true };
          },
          close: async () => {},
        };
      },
    }), '/admin/api/review/classify-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlugs: [first.slug, second.slug], decision: 'reject' }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ succeeded: 2, failed: 0 });
    expect((result.body as { results: readonly Record<string, unknown>[] }).results).toEqual([
      { sourceSlug: first.slug, status: 'succeeded', category: 'reject' },
      { sourceSlug: second.slug, status: 'succeeded', category: 'reject' },
    ]);
    expect(sessions).toBe(1);
    expect(calls.map((call) => call.name)).toEqual(['put_page', 'delete_page', 'put_page', 'delete_page']);
    expect(calls[0]?.slug).toStartWith('decisions/reviews/');
    expect(calls[1]?.slug).toBe(first.slug);
    expect(calls[2]?.slug).toStartWith('decisions/reviews/');
    expect(calls[3]?.slug).toBe(second.slug);
  });

  test('one failed item stays failed while a later item continues in the same batch', async () => {
    const first = makePage('inbox/batch-partial-one');
    const second = makePage('inbox/batch-partial-two');
    let firstAuditFailed = false;
    const calls: Array<{ readonly name: string; readonly slug: string }> = [];
    const result = await fetchApp(createApp(mockEngine([first, second]), async (name, args) => {
      const slug = String(args.slug ?? '');
      calls.push({ name, slug });
      if (name === 'put_page' && !firstAuditFailed) {
        firstAuditFailed = true;
        return { ok: false, error: 'SECRET_BATCH_WRITER_CANARY' };
      }
      return { ok: true };
    }), '/admin/api/review/classify-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlugs: [first.slug, second.slug], decision: 'reject' }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ succeeded: 1, failed: 1 });
    expect((result.body as { results: readonly Record<string, unknown>[] }).results).toEqual([
      { sourceSlug: first.slug, status: 'failed', code: 'review_write_failed', message: '审核写入失败，草稿已保留在收件箱。' },
      { sourceSlug: second.slug, status: 'succeeded', category: 'reject' },
    ]);
    expect(result.text).not.toContain('SECRET_BATCH_WRITER_CANARY');
    expect(calls.map((call) => call.name)).toEqual(['put_page', 'put_page', 'delete_page']);
  });

  test('writer attestation failure becomes fixed per-item failures without leaking the exception', async () => {
    const first = makePage('inbox/batch-writer-one');
    const second = makePage('inbox/batch-writer-two');
    const result = await fetchApp(createApp(mockEngine([first, second]), undefined, {
      writerSessionFactory: async () => ({
        callTool: async () => { throw new Error('SECRET_BATCH_ATTESTATION_CANARY'); },
        close: async () => {},
      }),
    }), '/admin/api/review/classify-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlugs: [first.slug, second.slug], decision: 'reject' }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ succeeded: 0, failed: 2 });
    for (const item of (result.body as { results: readonly Record<string, unknown>[] }).results) {
      expect(item).toMatchObject({ status: 'failed', code: 'writer_unavailable', message: '审核写入服务暂时不可用，草稿已保留在收件箱。' });
    }
    expect(result.text).not.toContain('SECRET_BATCH_ATTESTATION_CANARY');
  });

  test('invalid batch input and wrong origin fail before opening the writer session', async () => {
    const page = makePage('inbox/batch-security');
    let sessions = 0;
    const app = createApp(mockEngine([page]), undefined, {
      writerSessionFactory: async () => {
        sessions += 1;
        throw new Error('writer must not open');
      },
    });

    const invalid = await fetchApp(app, '/admin/api/review/classify-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlugs: [page.slug], decision: 'accept', category: 'incident' }),
    });
    const wrongOrigin = await fetchApp(app, '/admin/api/review/classify-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' },
      body: JSON.stringify({ sourceSlugs: [page.slug], decision: 'reject' }),
    });

    expect(invalid.status).toBe(400);
    expect(wrongOrigin.status).toBe(403);
    expect(sessions).toBe(0);
  });
});

// --- Pure helper tests ---

describe('parseActionBody', () => {
  test('supports all current review actions', () => {
    // given
    const inputs = [
      { kind: 'reject', sourceSlug: 'inbox/reject' },
      { kind: 'needs_evidence', sourceSlug: 'inbox/needs-evidence' },
      { kind: 'keep', sourceSlug: 'inbox/keep', targetSlug: 'incidents/keep', targetType: 'incident' },
      { kind: 'promote', sourceSlug: 'inbox/promote', targetSlug: 'knowledge/promote', targetType: 'knowledge' },
      { kind: 'merge', sourceSlug: 'inbox/merge', targetSlug: 'incidents/merge', targetType: 'incident' },
      { kind: 'repair', sourceSlug: 'inbox/repair' },
      { kind: 'cleanup', sourceSlug: 'inbox/cleanup' },
    ] as const;

    // when / then
    for (const input of inputs) {
      const action = parseActionBody(input);
      expect(action).not.toBeNull();
      expect(action?.kind).toBe(input.kind);
      expect(action?.sourceSlug).toBe(input.sourceSlug);
    }
  });

  test('parses keep action with camelCase fields', () => {
    const action = parseActionBody({ kind: 'keep', sourceSlug: 'inbox/x', targetSlug: 'incidents/x', targetType: 'incident' });
    expect(action).not.toBeNull();
    expect(action!.kind).toBe('keep');
  });

  test('parses promote action with snake_case fields', () => {
    const action = parseActionBody({ kind: 'promote', source_slug: 'inbox/x', target: 'runbooks/x', target_type: 'runbook', human_confirmation: true });
    expect(action).not.toBeNull();
    expect(action!.kind).toBe('promote');
    if (action!.kind === 'promote') expect(action!.humanConfirmation).toBe(true);
  });

  test('returns null for invalid kind', () => {
    expect(parseActionBody({ kind: 'bogus' })).toBeNull();
  });

  test('returns null for non-object', () => {
    expect(parseActionBody('string')).toBeNull();
    expect(parseActionBody(null)).toBeNull();
  });
});

describe('buildAction', () => {
  test('builds keep action', () => {
    const action = buildAction('keep', 'inbox/x', 'incidents/x', 'incident', false);
    expect(action).not.toBeNull();
    expect(action!.kind).toBe('keep');
  });

  test('returns null for invalid kind', () => {
    expect(buildAction('bogus', 'inbox/x', '', 'incident', false)).toBeNull();
  });
});

describe('review action catalog', () => {
  test('action catalog maps every backend action to the agreed Chinese label', () => {
    // given
    const expectedLabels = {
      keep: '留在项目内',
      promote: '变成通用经验',
      merge: '合并到已有内容',
      reject: '丢弃这条草稿',
      needs_evidence: '先补证据',
      repair: '修复审核记录',
      cleanup: '清理草稿残留',
    } as const;

    // when / then
    expect(Object.fromEntries(Object.entries(REVIEW_ACTION_CATALOG).map(([action, copy]) => [action, copy.label]))).toEqual(expectedLabels);
    expect(Object.values(REVIEW_ACTION_CATALOG).every((copy) => copy.explanation.length > 0 && copy.example.length > 0 && copy.riskText.length > 0)).toBe(true);
  });

  test('action catalog groups common and rare actions exactly', () => {
    expect(COMMON_REVIEW_ACTIONS).toEqual(['keep', 'promote', 'merge', 'needs_evidence']);
    expect(RARE_REVIEW_ACTIONS).toEqual(['reject', 'repair', 'cleanup']);
    expect(COMMON_REVIEW_ACTIONS.every((action) => REVIEW_ACTION_CATALOG[action].group === 'common')).toBe(true);
    expect(RARE_REVIEW_ACTIONS.every((action) => REVIEW_ACTION_CATALOG[action].group === 'rare')).toBe(true);
  });

  test('action catalog returns no misleading label for an unknown action', () => {
    expect(reviewActionCatalogEntry('archive')).toBeNull();
  });

  test('action catalog exposes required fields and exact confirmation requirements', () => {
    expect(REVIEW_ACTION_CATALOG.keep.requiredFields).toEqual(['targetSlug', 'targetType']);
    expect(REVIEW_ACTION_CATALOG.promote.confirmationRequirement).toBe('promote_phrase');
    expect(REVIEW_ACTION_CATALOG.merge.confirmationRequirement).toBe('merge_phrase');
    expect(REVIEW_ACTION_CATALOG.needs_evidence.requiredFields).toEqual(['reviewNotes']);
    expect(REVIEW_ACTION_CATALOG.reject.requiredFields).toEqual(['reviewNotes']);
    expect(REVIEW_ACTION_CATALOG.repair.confirmationRequirement).toBe('none');
    expect(REVIEW_ACTION_CATALOG.cleanup.confirmationRequirement).toBe('none');
  });
});

describe('review browser safe projection', () => {
  const sensitiveCanaries = [
    'sk-FAKEFAKE1234',
    'AKIAFAKEFAKE1234',
    'github_pat_FAKEFAKE1234',
    'xoxb-FAKEFAKE1234',
    'gbrain_FAKEFAKE1234',
    'eyJhbGciOiJGQUtFIn0.eyJzdWIiOiJGQUtFIn0.RkFLRV9TSUdOQVRVUkU',
    'Bearer FAKEFAKE1234567890',
    '-----BEGIN FAKE PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END FAKE PRIVATE KEY-----',
    'person@example.test',
    '555-123-4567',
    '123-45-6789',
    '4111 1111 1111 1111',
  ] as const;

  test('browser safe sanitizer permanently redacts every required sensitive family', () => {
    for (const canary of sensitiveCanaries) {
      const projected = projectBrowserSafeText(`prefix ${canary} suffix`);
      expect(projected).not.toContain(canary);
      expect(projected).toContain('[REDACTED]');
    }
  });

  test('browser safe sanitizer fails closed for raw transcript JSON auth env and dense logs', () => {
    const denseLog = Array.from({ length: 12 }, (_, index) => `2026-07-26T00:00:${String(index).padStart(2, '0')}Z ERROR synthetic worker diagnostic line`).join('\n');
    const hiddenInputs = [
      'User: synthetic raw transcript\nAssistant: synthetic response',
      '{"role":"user","content":"synthetic raw JSON"}',
      '{"access_token":"synthetic-auth-response"}',
      'HTTP/1.1 200 OK\naccess_token: synthetic-auth-response',
      'FAKE_API_KEY=synthetic\nFAKE_REGION=test',
      denseLog,
    ] as const;

    for (const input of hiddenInputs) expect(projectBrowserSafeText(input)).toBe(BROWSER_SAFE_HIDDEN_TEXT);
  });

  test('browser safe sanitizer fails closed when value projection throws', () => {
    const throwingValue = { toJSON: () => { throw new Error('synthetic projection failure'); } };
    expect(projectBrowserSafeText(throwingValue)).toBe(BROWSER_SAFE_HIDDEN_TEXT);
  });

  test('browser safe preview strips frontmatter collapses whitespace and enforces its length cap', () => {
    const preview = projectBrowserSafeText(`---\ntype: incident\n---\n\nSafe    browser\npreview ${'x'.repeat(2100)}`, 'preview');
    expect(preview).toStartWith('Safe browser preview ');
    expect(preview.length).toBe(2000);
    expect(preview).not.toContain('type: incident');
  });

  test('browser safe helper sanitizes before HTML escaping on every planned review surface', () => {
    const surfaces = ['list', 'detail', 'target search', 'preflight', 'result', 'history', 'filter state'] as const;
    for (const surface of surfaces) {
      const html = browserSafeHtml(`${surface}: sk-FAKEFAKE1234 <strong>unsafe</strong>`);
      expect(html).not.toContain('sk-FAKEFAKE1234');
      expect(html).not.toContain('<strong>');
      expect(html).toContain('&lt;strong&gt;unsafe&lt;/strong&gt;');
    }
  });

  test('browser safe helper maps unknown failures to fixed Chinese review error copy', () => {
    expect(browserSafeReviewError(new Error('must not cross browser boundary'))).toEqual({
      code: 'review_error',
      message: REVIEW_ERROR_TEXT,
    });
  });
});

describe('review targets', () => {
  test('Given default-source target pages When an authenticated target search is requested Then it returns the browser-safe read-only contract', async () => {
    // given
    const engine = mockEngine([
      makePage('incidents/target-search', { title: 'Target search result' }),
      makePage('knowledge/not-an-incident', { title: 'Other target type' }),
    ]);
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/targets?type=incident&q=search&limit=1&source_id=other-source');

    // then
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      targets: [{
        slug: 'incidents/target-search',
        type: 'incident',
        title: 'Target search result',
        updated_at: '2026-07-26T12:00:00.000Z',
      }],
    });
  });

  test('Given more than fifty matching pages When the requested limit is oversized Then the endpoint caps the read-only response at fifty', async () => {
    // given
    const targets = Array.from({ length: 51 }, (_, index) => makePage(`incidents/target-${String(index).padStart(2, '0')}`));
    const app = createApp(mockEngine(targets));

    // when
    const result = await fetchApp(app, '/admin/api/review/targets?type=incident&limit=500');

    // then
    expect(result.status).toBe(200);
    expect((result.body as { readonly targets: readonly unknown[] }).targets).toHaveLength(50);
  });

  test('Given same-slug targets in two sources When the browser supplies source_id Then only the trusted default-source target is returned', async () => {
    // given
    const defaultTarget = makePage('incidents/shared-target', { title: 'Default target', source_id: 'default' });
    const foreignTarget = makePage('incidents/shared-target', { title: 'Foreign target', source_id: 'other-source' });
    const app = createApp(mockEngine([defaultTarget, foreignTarget]));

    // when
    const result = await fetchApp(app, '/admin/api/review/targets?type=incident&source_id=other-source');

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ targets: [{ slug: 'incidents/shared-target', title: 'Default target' }] });
    expect(result.text).not.toContain('Foreign target');
  });

  test('Given a target title containing credential and raw-content canaries When it is searched Then the response only contains the scrubbed projection', async () => {
    // given
    const canaries = [
      'sk-FAKEFAKE1234', 'AKIAFAKEFAKE1234', 'github_pat_FAKEFAKE1234', 'xoxb-FAKEFAKE1234', 'gbrain_FAKEFAKE1234',
      'eyJhbGciOiJGQUtFIn0.eyJzdWIiOiJGQUtFIn0.RkFLRV9TSUdOQVRVUkU', 'Bearer FAKEFAKE1234567890',
      '-----BEGIN FAKE PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END FAKE PRIVATE KEY-----', 'person@example.test', '555-123-4567', '123-45-6789', '4111 1111 1111 1111',
      'User: raw transcript\nAssistant: raw response', '{"access_token":"raw-auth-response"}', 'FAKE_API_KEY=raw-env\nFAKE_REGION=test',
    ] as const;
    const app = createApp(mockEngine([makePage('incidents/canary-title', { title: canaries.join(' ') })]));

    // when
    const result = await fetchApp(app, '/admin/api/review/targets?type=incident');

    // then
    expect(result.status).toBe(200);
    for (const canary of canaries) expect(result.text).not.toContain(canary);
    expect(result.text).toContain(BROWSER_SAFE_HIDDEN_TEXT);
  });

  test('Given a search failure When the endpoint responds Then it returns only the fixed review error', async () => {
    // given
    const engine = { listPages: async () => { throw new Error('SECRET_SOURCE_REF_BODY_FRONTMATTER'); } } as unknown as BrainEngine;
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/targets');

    // then
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
    expect(result.text).not.toContain('SECRET_SOURCE_REF_BODY_FRONTMATTER');
  });

  test('Given an unauthenticated browser or a writer spy When targets are requested Then requireAdmin rejects access and GET performs no mutation', async () => {
    // given
    const engine = mockEngine([makePage('incidents/read-only')]);
    const unauthenticated = express();
    mountReviewRoutes(unauthenticated, engine, (_req, res) => { res.status(401).json({ error: 'unauthorized' }); });
    let writerCalls = 0;
    const app = createApp(engine, async () => { writerCalls += 1; return { ok: true }; });

    // when
    const denied = await fetchApp(unauthenticated, '/admin/api/review/targets');
    const allowed = await fetchApp(app, '/admin/api/review/targets');

    // then
    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(writerCalls).toBe(0);
  });
});

describe('review target validation', () => {
  test('Given each explicit review target type When a source slug is generated Then it uses the canonical prefix without source PageType inference', () => {
    // given / when / then
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'knowledge')).toBe('knowledge/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'runbook')).toBe('runbooks/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'incident')).toBe('incidents/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'decision')).toBe('decisions/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'project')).toBeNull();
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'project', 'prj-0123456789abcdef')).toBe('projects/prj-0123456789abcdef/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'environment')).toBe('environments/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/Alpha---Unsafe $$ Target', 'agent-skill')).toBe('agent-skills/alpha-unsafe-target');
    expect(generateReviewTargetSlug('inbox/---', 'incident')).toBeNull();
  });

  test('Given a generated target longer than eighty characters When it is generated Then it remains a valid bounded slug', () => {
    // when
    const slug = generateReviewTargetSlug(`inbox/${'long-target-'.repeat(12)}`, 'incident');

    // then
    expect(slug?.length).toBeLessThanOrEqual(80);
    expect(slug).toMatch(/^incidents\/[a-z0-9-]+$/);
  });

  test('Given an empty generated slug When the target selector renders Then it requires manual correction instead of inventing an alternate', async () => {
    // given
    const source = makePage('inbox/---');
    const app = createApp(mockEngine([source]));

    // when
    const result = await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=keep&target_type=incident`);

    // then
    expect(result.text).toContain('无法生成有效目标 slug');
    expect(result.text).toContain('高级：手动输入目标 slug');
  });

  test('Given invalid type or limit query values When targets are requested Then the fixed validation error is returned', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const invalidType = await fetchApp(app, '/admin/api/review/targets?type=untrusted');
    const invalidLimit = await fetchApp(app, '/admin/api/review/targets?limit=0');

    // then
    expect(invalidType.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
    expect(invalidLimit.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
  });

  test('Given a keep action without a target When the target selector renders Then it requires an explicit target type and offers validated manual entry', async () => {
    // given
    const source = makePage('inbox/Selector Source', { type: 'unrecognized-source-type' });
    const app = createApp(mockEngine([source]));

    // when
    const initial = await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=keep`);
    const typed = await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=keep&target_type=incident`);

    // then
    expect(initial.status).toBe(200);
    expect(initial.text).toContain('请选择目标类型');
    expect(initial.text).not.toContain('source_id');
    expect(typed.text).toContain('系统建议目标 slug');
    expect(typed.text).toContain('incidents/selector-source');
    expect(typed.text).toContain('高级：手动输入目标 slug');
    expect(typed.text).toContain('pattern="[a-z0-9-]+(/[a-z0-9-]+)*"');
  });

  test('Given a merge target search When a selected target exists or a direct target is missing Then only the existing target can pass selection', async () => {
    // given
    const source = makePage('inbox/merge-source');
    const existing = makePage('incidents/merge-existing', { title: 'Existing merge target' });
    const app = createApp(mockEngine([source, existing]));

    // when
    const selector = await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=merge&target_type=incident&q=existing`);
    const missing = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'merge', sourceSlug: source.slug, targetSlug: 'incidents/missing', targetType: 'incident', humanConfirmation: true }),
    });

    // then
    expect(selector.text).toContain('Existing merge target');
    expect(selector.text).toContain('target=incidents%2Fmerge-existing');
    expect(missing.body).toMatchObject({ code: 'merge_target_missing' });
  });

  test('Given an exact target collision outside fifty bounded candidates When keep is planned Then the exact source-bound getPage check blocks it', async () => {
    // given
    const source = makePage('inbox/exact-collision');
    const bounded = Array.from({ length: 51 }, (_, index) => makePage(`incidents/bounded-${String(index).padStart(2, '0')}`));
    const exact = makePage('incidents/exact-collision');
    const getPageCalls: Array<readonly [string, string | undefined]> = [];
    const app = createApp(mockEngine([source, ...bounded, exact], {
      onGetPage: (slug, sourceId) => { getPageCalls.push([slug, sourceId]); },
    }));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: exact.slug, targetType: 'incident' }),
    });

    // then
    expect(result.body).toMatchObject({ code: 'duplicate_target' });
    expect(getPageCalls).toContainEqual([exact.slug, 'default']);
  });
});

describe('planResultToJson', () => {
  test('serializes ok result with plan', async () => {
    const source = reviewSourcePage('inbox/serial-test', frontmatterText());
    const result = await planReview(mockDeps([source]), {
      action: { kind: 'keep', sourceSlug: 'inbox/serial-test', targetSlug: 'incidents/serial-test', targetType: 'incident' },
      reviewDate: REVIEW_DATE,
    });
    const json = planResultToJson(result);
    expect(json.ok).toBe(true);
    expect(json.code).toBe('ok');
    expect(json.plan).toBeDefined();
  });

  test('serializes failed result without plan', async () => {
    const result = await planReview(mockDeps([]), {
      action: { kind: 'keep', sourceSlug: 'inbox/missing', targetSlug: 'incidents/missing', targetType: 'incident' },
      reviewDate: REVIEW_DATE,
    });
    const json = planResultToJson(result);
    expect(json.ok).toBe(false);
    expect(json.plan).toBeUndefined();
  });

  test('Given plan gates and a generated page When projected for the browser Then raw action, title, details, and candidates are omitted', async () => {
    // given
    const source = reviewSourcePage('inbox/projection-safe', frontmatterText());
    const successful = await planReview(mockDeps([source]), {
      action: { kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/projection-safe', targetType: 'incident', reviewNotes: 'raw action note' },
      reviewDate: REVIEW_DATE,
    });
    const duplicate = await planReview(mockDeps([source], ['incidents/candidate-secret']), {
      action: { kind: 'promote', sourceSlug: source.slug, targetSlug: 'incidents/projection-safe', targetType: 'incident', humanConfirmation: true },
      reviewDate: REVIEW_DATE,
    });

    // when
    const successfulJson = planResultToJson(successful);
    const duplicateJson = planResultToJson(duplicate);

    // then
    const plan = successfulJson.plan as Record<string, unknown>;
    expect(plan.action).toBe('keep');
    expect((plan.target as Record<string, unknown>).title).toBeUndefined();
    expect(JSON.stringify(successfulJson)).not.toContain('raw action note');
    expect(JSON.stringify(duplicateJson)).not.toContain('candidate-secret');
    expect(JSON.stringify(duplicateJson)).not.toContain('candidates');
    expect(JSON.stringify(duplicateJson)).not.toContain('details');
  });

  test('Given a successful plan When projected for the browser Then only the documented action source target and gate fields remain', async () => {
    // given
    const source = reviewSourcePage('inbox/fixed-plan-projection', frontmatterText());
    const result = await planReview(mockDeps([source]), {
      action: { kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/fixed-plan-projection', targetType: 'incident' },
      reviewDate: REVIEW_DATE,
    });

    // when
    const json = planResultToJson(result);

    // then
    expect(Object.keys(json).sort()).toEqual(['code', 'gates', 'message', 'ok', 'plan']);
    expect(Object.keys(json.plan as Record<string, unknown>).sort()).toEqual(['action', 'source', 'target']);
    expect(Object.keys((json.plan as { readonly target: Record<string, unknown> }).target).sort()).toEqual(['slug', 'type']);
    expect(JSON.stringify(json)).not.toContain('review_slug');
    expect(JSON.stringify(json)).not.toContain('steps');
  });
});

describe('review browser remediation contracts', () => {
  test('Given an inbox draft with project_id When the list API responds Then the documented browser-safe list fields include it', async () => {
    // given
    const page = makePage('inbox/project-projection');
    page.frontmatter = { ...page.frontmatter, project_id: 'project-aurora' };
    const app = createApp(mockEngine([page]));

    // when
    const result = await fetchApp(app, '/admin/api/review/inbox');

    // then
    expect(result.status).toBe(200);
    const body = result.body as { readonly drafts: readonly Record<string, unknown>[] };
    expect(Object.keys(body.drafts[0] ?? {}).sort()).toEqual(['project_id', 'slug', 'stale', 'status', 'title', 'type', 'updated_at', 'verification']);
    expect(body.drafts[0]?.project_id).toBe('project-aurora');
  });

  test('Given reject or needs_evidence without nonempty notes When plan or confirm is posted Then the server rejects it before planning', async () => {
    // given
    let reads = 0;
    const engine = mockEngine([], { onGetPage: () => { reads += 1; } });
    const app = createApp(engine);

    // when
    for (const path of ['/admin/api/review/plan', '/admin/api/review/confirm']) {
      for (const kind of ['reject', 'needs_evidence']) {
        const result = await fetchApp(app, path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, sourceSlug: `inbox/${kind}`, reviewNotes: '   ' }),
        });

        // then
        expect(result.status).toBe(400);
        expect(result.body).toEqual({ error: 'invalid_request', message: '拒绝或补证据必须填写审核说明。' });
      }
    }
    expect(reads).toBe(0);
  });

  test('Given a reject action without notes When the Web plan flow opens Then it collects notes before preflight', async () => {
    // given
    const app = createApp(mockEngine([makePage('inbox/notes-form')]));

    // when
    const result = await fetchApp(app, '/admin/review/plan/inbox%2Fnotes-form?action=reject');

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('name="reviewNotes"');
    expect(result.text).toContain('填写审核说明后进入预检');
  });

  test('Given a rejected promote confirmation When the browser response is projected Then it does not expose expected as a raw field', async () => {
    // given
    const app = createApp(mockEngine([makePage('inbox/expected-projection', { type: 'runbook' })]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: 'inbox/expected-projection',
        targetSlug: 'runbooks/expected-projection',
        targetType: 'runbook',
      }),
    });

    // then
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'confirmation_required', message: '必须输入确认短语后才能执行该操作。' });
  });
});

describe('review preflight', () => {
  test('Given a promote preview When the plan page renders Then it is non-executing and marks confirmation as pending', async () => {
    // given
    const writerCalls: string[] = [];
    const source = makePage('inbox/preflight-promote', { type: 'runbook' });
    const app = createApp(mockEngine([source]), async (name) => {
      writerCalls.push(name);
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=promote&target=runbooks%2Fpreflight-promote&target_type=runbook`);

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('审核预检');
    expect(result.text).toContain('这是只读预览，不会授权或执行写入');
    expect(result.text).toContain('待输入确认短语');
    expect(result.text).toContain('PROMOTE runbooks/preflight-promote');
    expect(result.text).toContain('promote_confirmation_required');
    expect(result.text).toContain('待输入确认短语后，系统会重新运行全部门禁并生成执行计划。');
    expect(result.text).toContain('敏感内容检查');
    expect(result.text).toContain('重复检查');
    expect(writerCalls).toEqual([]);
  });

  test('Given a promote preview with an existing exact target When the plan page renders Then duplicate_target blocks the pending confirmation', async () => {
    // given
    const writerCalls: string[] = [];
    const source = makePage('inbox/preflight-duplicate', { type: 'runbook' });
    const existingTarget = makePage('runbooks/preflight-duplicate', { type: 'runbook' });
    const app = createApp(mockEngine([source, existingTarget]), async (name) => {
      writerCalls.push(name);
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=promote&target=runbooks%2Fpreflight-duplicate&target_type=runbook`);

    // then
    expect(result.status).toBe(200);
    expect(result.text).toContain('duplicate_target');
    expect(result.text).not.toContain('未发现精确重复目标');
    expect(result.text).not.toContain('确认执行');
    expect(writerCalls).toEqual([]);
  });

  test('Given a full diagnostic preview and final confirmation When the final phrase is submitted Then planning reads the source again before apply', async () => {
    // given
    const source = makePage('inbox/replan-promote', { type: 'runbook' });
    const reads: string[] = [];
    const targetSlug = 'runbooks/replan-promote';
    const target = makePage(targetSlug, { type: 'runbook' });
    let targetWritten = false;
    const engine = {
      getPage: async (slug: string) => {
        reads.push(slug);
        if (slug === source.slug) return source;
        if (slug === targetSlug) return targetWritten ? target : null;
        return null;
      },
      listPages: async () => [source],
    } as unknown as BrainEngine;
    const app = createApp(engine, async (name, args) => {
      if (name === 'put_page' && args.slug === targetSlug) targetWritten = true;
      return { ok: true };
    });

    // when
    await fetchApp(app, `/admin/review/plan/${encodeURIComponent(source.slug)}?action=promote&target=runbooks%2Freplan-promote&target_type=runbook`);
    const confirmed = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'runbooks/replan-promote',
        targetType: 'runbook',
        confirmation: 'PROMOTE runbooks/replan-promote',
      }),
    });

    // then
    expect(confirmed.status).toBe(200);
    expect(reads.filter((slug) => slug === source.slug)).toHaveLength(3);
  });
});

describe('writer payload', () => {
  test('Given a writer that rejects the old payload When confirm applies a keep plan Then only {slug, content} writes succeed', async () => {
    // given
    const calls: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
    const source = makePage('inbox/writer-payload');
    const review = writerBackedEngine(source, 'incidents/writer-payload');
    const app = createApp(review.engine, async (name, args) => {
      calls.push({ name, args });
      if (name === 'put_page' && (Object.keys(args).length !== 2 || typeof args.content !== 'string')) return { error: 'missing_content' };
      if (name === 'put_page' && args.slug === 'incidents/writer-payload') review.markTargetWritten();
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'keep',
        sourceSlug: source.slug,
        targetSlug: 'incidents/writer-payload',
        targetType: 'incident',
      }),
    });

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, code: 'ok' });
    const writes = calls.filter((call) => call.name === 'put_page');
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(Object.keys(write.args).sort()).toEqual(['content', 'slug']);
      expect(write.args.source_id).toBeUndefined();
      expect(JSON.stringify(write.args)).not.toContain('Bearer');
    }
    expect(calls.find((call) => call.name === 'delete_page')?.args).toEqual({ slug: source.slug });
  });

  test('Given a writer returning ok false for the target write When confirm applies a keep plan Then it fails without deleting the inbox source', async () => {
    // given
    const calls: string[] = [];
    const source = makePage('inbox/writer-structured-failure');
    const target = makePage('incidents/writer-structured-failure');
    let targetReads = 0;
    const engine = {
      getPage: async (slug: string) => {
        if (slug === source.slug) return source;
        if (slug === target.slug) {
          targetReads += 1;
          return targetReads === 1 ? null : target;
        }
        return null;
      },
      listPages: async () => [source],
    } as unknown as BrainEngine;
    const app = createApp(engine, async (name) => {
      calls.push(name);
      return name === 'put_page' ? { ok: false } : { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: target.slug, targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      ok: false,
      code: 'review_error',
      message: '审核执行失败：inbox 草稿已保留，请排查原因后重试。',
      source: 'inbox/writer-structured-failure',
      action: 'keep',
      target: 'incidents/writer-structured-failure',
      retrieval_verified: false,
      next_action: '请排查失败原因后重试；inbox 草稿已保留。',
    });
    expect(calls).toEqual(['put_page']);
  });
});

describe('writer attestation', () => {
  test('Given a systemd credential directory When resolving the writer env Then the credential is used without exposing the root-owned source', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gbrain-writer-credential-'));
    const credentialPath = join(tempDir, 'gbrain-local-writer.env');
    writeFileSync(credentialPath, 'GBRAIN_LOOPBACK_MCP_URL=http://127.0.0.1:3131/mcp\n');
    try {
      expect(localWriterEnvPath({ CREDENTIALS_DIRECTORY: tempDir }, '/unused-home')).toBe(credentialPath);
      expect(localWriterEnvPath({ GBRAIN_REVIEW_WRITER_ENV_PATH: '/explicit/writer.env', CREDENTIALS_DIRECTORY: tempDir }, '/unused-home')).toBe('/explicit/writer.env');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Given a loopback writer URL When opening the writer session Then it takes precedence over the public MCP URL', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gbrain-writer-loopback-'));
    const envPath = join(tempDir, 'writer.env');
    writeFileSync(envPath, 'GBRAIN_MCP_URL=http://public.test/mcp\nGBRAIN_LOOPBACK_MCP_URL=http://127.0.0.1:3131/mcp\nBEARER_TOKEN=test-bearer\n');
    const opened: string[] = [];
    const factory = createLocalWriterSessionFactory(envPath, async (url) => {
      opened.push(url);
      return { callTool: async () => ({ source_id: 'default' }), close: async () => {} };
    });
    try {
      const session = await factory('http://127.0.0.1:3131/mcp');
      await session.close();
      expect(opened).toEqual(['http://127.0.0.1:3131/mcp']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('review writer MCP URL defaults to loopback and rejects non-MCP paths', () => {
    expect(resolveReviewWriterMcpUrl(undefined, 3131).toString()).toBe('http://127.0.0.1:3131/mcp');
    expect(resolveReviewWriterMcpUrl('https://review.test/mcp', 3131).toString()).toBe('https://review.test/mcp');
    expect(() => resolveReviewWriterMcpUrl('https://review.test/admin', 3131)).toThrow('ending in /mcp');
  });

  test('Given an attested default-source writer session When a keep plan confirms Then identity and every write share that session', async () => {
    // given
    const calls: string[] = [];
    const source = makePage('inbox/attested-default');
    const review = writerBackedEngine(source, 'incidents/attested-default');
    const writerSessionFactory: WriterSessionFactory = async (expectedMcpUrl) => {
      expect(expectedMcpUrl).toBe('http://review.test/mcp');
      return {
        callTool: async (name, args) => {
          calls.push(name);
          if (name === 'put_page' && args.slug === 'incidents/attested-default') review.markTargetWritten();
          return name === 'whoami' ? { source_id: 'default' } : { ok: true };
        },
        close: async () => { calls.push('close'); },
      };
    };
    const app = createApp(review.engine, undefined, { writerSessionFactory });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/attested-default', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(200);
    expect(calls).toEqual(['whoami', 'put_page', 'put_page', 'delete_page', 'close']);
  });

  test('Given a writer identity with a different or missing source When confirm starts Then it fails closed before planning or writing', async () => {
    // given
    const source = makePage('inbox/attested-wrong');
    for (const identity of [{ source_id: 'other-source' }, {}, { source_id: ['default'] }] as const) {
      const calls: string[] = [];
      const app = createApp(mockEngine([source]), undefined, {
        writerSessionFactory: async () => ({
          callTool: async (name) => {
            calls.push(name);
            return identity;
          },
          close: async () => { calls.push('close'); },
        }),
      });

      // when
      const result = await fetchApp(app, '/admin/api/review/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/attested-wrong', targetType: 'incident' }),
      });

      // then
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
      expect(calls).toEqual(['whoami', 'close']);
    }
  });

  test('Given a writer configured for another MCP URL When confirm starts Then it fails closed without a writer call', async () => {
    // given
    const tempDir = mkdtempSync(join(tmpdir(), 'gbrain-writer-attestation-'));
    const envPath = join(tempDir, 'writer.env');
    writeFileSync(envPath, 'MCP_URL=http://other.test/mcp\nBEARER_TOKEN=test-bearer\n');
    const source = makePage('inbox/attested-url');
    const app = createApp(mockEngine([source]), undefined, {
      writerSessionFactory: createLocalWriterSessionFactory(envPath),
    });

    try {
      // when
      const result = await fetchApp(app, '/admin/api/review/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/attested-url', targetType: 'incident' }),
      });

      // then
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: 'review_error', message: REVIEW_ERROR_TEXT });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Given a bearer writer failure with OAuth configuration present When the first put fails Then no fallback or delete occurs', async () => {
    // given
    const tempDir = mkdtempSync(join(tmpdir(), 'gbrain-writer-bearer-'));
    const envPath = join(tempDir, 'writer.env');
    writeFileSync(envPath, 'MCP_URL=http://review.test/mcp\nBEARER_TOKEN=test-bearer\nTOKEN_ENDPOINT=http://oauth.test/token\nCLIENT_ID=test-client\nCLIENT_SECRET=test-secret\n');
    const openCalls: string[] = [];
    const toolCalls: string[] = [];
    const writerSessionFactory = createLocalWriterSessionFactory(envPath, async (_url, bearer) => {
      openCalls.push(bearer);
      return {
        callTool: async (name) => {
          toolCalls.push(name);
          if (name === 'whoami') return { source_id: 'default' };
          if (name === 'put_page') throw new Error(`bearer failure for ${bearer}`);
          return { ok: true };
        },
        close: async () => {},
      };
    });
    const source = makePage('inbox/bearer-failure');
    const app = createApp(mockEngine([source]), undefined, { writerSessionFactory });

    try {
      // when
      const result = await fetchApp(app, '/admin/api/review/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/bearer-failure', targetType: 'incident' }),
      });

      // then
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ ok: false, code: 'review_error' });
      expect(result.text).not.toContain('bearer failure');
      expect(openCalls).toEqual(['test-bearer']);
      expect(toolCalls).toEqual(['whoami', 'put_page']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// --- Todo 8: audit trail result, browser-safe json, origin gates ---

describe('review result', () => {
  test('Given a successful keep confirm When a JSON client posts Then the fixed-field receipt summary is returned', async () => {
    // given
    const source = makePage('inbox/result-success');
    const review = writerBackedEngine(source, 'incidents/result-success');
    const app = createApp(review.engine, async (name, args) => {
      if (name === 'put_page' && args.slug === 'incidents/result-success') review.markTargetWritten();
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/result-success', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['action', 'code', 'message', 'next_action', 'ok', 'retrieval_verified', 'review_slug', 'source', 'target']);
    expect(body).toMatchObject({
      ok: true,
      code: 'ok',
      message: '审核执行成功。',
      source: 'inbox/result-success',
      action: 'keep',
      target: 'incidents/result-success',
      review_slug: 'decisions/reviews/result-success-review-20260726',
      retrieval_verified: true,
      next_action: '审核已完成，无需后续操作。',
    });
  });

  test('Given a browser form post When a keep confirm succeeds Then an HTML result page is returned', async () => {
    // given
    const source = makePage('inbox/result-html');
    const review = writerBackedEngine(source, 'incidents/result-html');
    const app = createApp(review.engine, async (name, args) => {
      if (name === 'put_page' && args.slug === 'incidents/result-html') review.markTargetWritten();
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: 'action=keep&sourceSlug=inbox%2Fresult-html&target=incidents%2Fresult-html&target_type=incident',
    });

    // then
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/html');
    expect(result.text).toContain('审核结果');
    expect(result.text).toContain('inbox/result-html');
    expect(result.text).toContain('检索验证');
    expect(result.text).toContain('已验证');
    expect(result.text).toContain('返回 Inbox');
  });

  test('Given a duplicate target When promote confirm reaches the duplicate gate Then a 409 gate summary is returned', async () => {
    // given
    const source = makePage('inbox/result-dup', { type: 'runbook' });
    const target = makePage('runbooks/result-dup', { type: 'runbook' });
    const app = createApp(mockEngine([source, target]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'runbooks/result-dup',
        targetType: 'runbook',
        confirmation: 'PROMOTE runbooks/result-dup',
      }),
    });

    // then
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      ok: false,
      code: 'duplicate_target',
      source: 'inbox/result-dup',
      action: 'promote',
      target: 'runbooks/result-dup',
      review_slug: null,
      retrieval_verified: false,
      next_action: '门禁未通过，请根据预检结果修正后重试。',
    });
  });

  test('Given target verification fails When confirm applies Then the summary says inbox retained and repair required', async () => {
    // given
    const deleteCalls: string[] = [];
    const source = makePage('inbox/result-verify-fail');
    const engine = {
      getPage: async (slug: string) => (slug === source.slug ? source : null),
      listPages: async () => [source],
    } as unknown as BrainEngine;
    const app = createApp(engine, async (name, args) => {
      if (name === 'delete_page') deleteCalls.push(String(args.slug));
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/result-verify-fail', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(503);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('review_error');
    expect(body.message).toContain('inbox 草稿已保留');
    expect(body.message).toContain('修复');
    expect(typeof body.review_slug).toBe('string');
    expect(body.retrieval_verified).toBe(false);
    expect(deleteCalls).toEqual([]);
  });

  test('Given the review record write fails When confirm applies Then the summary says inbox retained and repair required', async () => {
    // given
    const deleteCalls: string[] = [];
    const source = makePage('inbox/result-review-fail');
    const review = writerBackedEngine(source, 'incidents/result-review-fail');
    const app = createApp(review.engine, async (name, args) => {
      if (name === 'put_page' && typeof args.slug === 'string' && args.slug.startsWith('decisions/reviews/')) return { ok: false };
      if (name === 'put_page' && args.slug === 'incidents/result-review-fail') review.markTargetWritten();
      if (name === 'delete_page') deleteCalls.push(String(args.slug));
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/result-review-fail', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(503);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('review_error');
    expect(body.message).toContain('inbox 草稿已保留');
    expect(body.message).toContain('修复');
    expect(body.retrieval_verified).toBe(true);
    expect(deleteCalls).toEqual([]);
  });

  test('Given verification fails for a browser form post When confirm applies Then an HTML failure page is returned', async () => {
    // given
    const source = makePage('inbox/result-html-fail');
    const engine = {
      getPage: async (slug: string) => (slug === source.slug ? source : null),
      listPages: async () => [source],
    } as unknown as BrainEngine;
    const app = createApp(engine, async () => ({ ok: true }));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: 'action=keep&sourceSlug=inbox%2Fresult-html-fail&target=incidents%2Fresult-html-fail&target_type=incident',
    });

    // then
    expect(result.status).toBe(503);
    expect(result.contentType).toContain('text/html');
    expect(result.text).toContain('审核结果');
    expect(result.text).toContain('inbox 草稿已保留');
    expect(result.text).toContain('修复');
  });
});

describe('browser-safe json', () => {
  test('Given a successful confirm When the JSON summary is inspected Then raw plan and receipt internals are absent', async () => {
    // given
    const source = makePage('inbox/bs-success');
    const review = writerBackedEngine(source, 'incidents/bs-success');
    const app = createApp(review.engine, async (name, args) => {
      if (name === 'put_page' && args.slug === 'incidents/bs-success') review.markTargetWritten();
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/bs-success', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    for (const key of ['receipts', 'plan', 'gates', 'apply', 'steps', 'details', 'candidates']) {
      expect(body[key]).toBeUndefined();
    }
    expect(result.text).not.toContain('write_target');
    expect(result.text).not.toContain('put_page');
    expect(result.text).not.toContain('delete_source');
  });

  test('Given a writer returning a structured error with a secret canary When confirm applies Then the summary maps to review_error without the canary', async () => {
    // given
    const source = makePage('inbox/bs-writer-error');
    const app = createApp(mockEngine([source]), async (name) => {
      if (name === 'put_page') return { error: { message: 'WRITER_SECRET_CANARY' } };
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/bs-writer-error', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(503);
    const body = result.body as Record<string, unknown>;
    expect(body.code).toBe('review_error');
    expect(result.text).not.toContain('WRITER_SECRET_CANARY');
  });

  test('Given a writer throwing with a secret canary When confirm applies Then the summary maps to review_error without the canary', async () => {
    // given
    const source = makePage('inbox/bs-writer-throw');
    const app = createApp(mockEngine([source]), async (name) => {
      if (name === 'put_page') throw new Error('THROWN_SECRET_CANARY');
      return { ok: true };
    });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/bs-writer-throw', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(503);
    const body = result.body as Record<string, unknown>;
    expect(body.code).toBe('review_error');
    expect(result.text).not.toContain('THROWN_SECRET_CANARY');
  });

  test('Given a gate failure When the 409 summary is inspected Then candidates and gate details are absent', async () => {
    // given
    const source = makePage('inbox/bs-gate', { type: 'runbook' });
    const target = makePage('runbooks/bs-gate', { type: 'runbook' });
    const app = createApp(mockEngine([source, target]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'promote',
        sourceSlug: source.slug,
        targetSlug: 'runbooks/bs-gate',
        targetType: 'runbook',
        confirmation: 'PROMOTE runbooks/bs-gate',
      }),
    });

    // then
    expect(result.status).toBe(409);
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['action', 'code', 'message', 'next_action', 'ok', 'retrieval_verified', 'review_slug', 'source', 'target']);
    expect(result.text).not.toContain('candidates');
  });
});

describe('origin', () => {
  test('Given a public HTTP admin origin When a review plan is posted Then that origin is accepted independently of the writer issuer', async () => {
    // given
    const source = makePage('inbox/public-http-origin');
    const app = createApp(mockEngine([source]), undefined, {
      adminOrigin: new URL('http://203.0.113.10:3131'),
    });

    // when
    const accepted = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://203.0.113.10:3131' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/public-http-origin', targetType: 'incident' }),
    });
    const rejected = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://review.test' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/public-http-origin', targetType: 'incident' }),
    });

    // then
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(403);
  });

  test('Given a missing Origin header When a review plan is posted Then 403 is returned before planning', async () => {
    // given
    let reads = 0;
    const engine = {
      getPage: async () => { reads += 1; return null; },
      listPages: async () => [],
    } as unknown as BrainEngine;
    const app = createApp(engine);

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: '__OMIT__' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: 'inbox/x', targetSlug: 'incidents/x', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'forbidden', message: '请求来源不被允许。' });
    expect(reads).toBe(0);
  });

  test('Given null malformed multiple or mismatched origins When review posts arrive Then all return fixed 403 before planning', async () => {
    // given
    let reads = 0;
    const engine = {
      getPage: async () => { reads += 1; return null; },
      listPages: async () => [],
    } as unknown as BrainEngine;
    const app = createApp(engine);

    // when / then
    for (const origin of ['null', 'ht!tp://bad origin', 'http://review.test, http://evil.test', 'http://evil.test', 'http://review.test/']) {
      const result = await fetchApp(app, '/admin/api/review/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ kind: 'keep', sourceSlug: 'inbox/x', targetSlug: 'incidents/x', targetType: 'incident' }),
      });
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: 'forbidden', message: '请求来源不被允许。' });
    }
    expect(reads).toBe(0);
  });

  test('Given a mismatched origin When confirm is posted Then writer and engine are never reached', async () => {
    // given
    let reads = 0;
    let writerCalls = 0;
    const engine = {
      getPage: async () => { reads += 1; return null; },
      listPages: async () => [],
    } as unknown as BrainEngine;
    const app = createApp(engine, async () => { writerCalls += 1; return { ok: true }; });

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: 'inbox/x', targetSlug: 'incidents/x', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(403);
    expect(reads).toBe(0);
    expect(writerCalls).toBe(0);
  });

  test('Given forged X-Forwarded headers When the origin is correct Then the request succeeds', async () => {
    // given
    const app = createApp(mockEngine([makePage('inbox/origin-forwarded')]));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: 'inbox/origin-forwarded', targetSlug: 'incidents/origin-forwarded', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, code: 'ok' });
  });

  test('Given forged X-Forwarded headers When the origin matches the forged host Then 403 is returned', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: 'inbox/x', targetSlug: 'incidents/x', targetType: 'incident' }),
    });

    // then
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'forbidden', message: '请求来源不被允许。' });
  });

  test('Given a correct origin When JSON plan and URL-encoded confirm are posted Then both proceed', async () => {
    // given
    const source = makePage('inbox/origin-ok');
    const review = writerBackedEngine(source, 'incidents/origin-ok');
    const app = createApp(review.engine, async (name, args) => {
      if (name === 'put_page' && args.slug === 'incidents/origin-ok') review.markTargetWritten();
      return { ok: true };
    });

    // when
    const plan = await fetchApp(app, '/admin/api/review/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'keep', sourceSlug: source.slug, targetSlug: 'incidents/origin-ok', targetType: 'incident' }),
    });
    const confirm = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=keep&sourceSlug=inbox%2Forigin-ok&target=incidents%2Forigin-ok&target_type=incident',
    });

    // then
    expect(plan.status).toBe(200);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ ok: true, code: 'ok' });
  });

  test('Given a wrong origin on a browser form post When confirm is posted Then an HTML 403 page is returned', async () => {
    // given
    const app = createApp(mockEngine([]));

    // when
    const result = await fetchApp(app, '/admin/api/review/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', Origin: 'http://evil.test' },
      body: 'action=keep&sourceSlug=inbox%2Fx&target=incidents%2Fx&target_type=incident',
    });

    // then
    expect(result.status).toBe(403);
    expect(result.contentType).toContain('text/html');
    expect(result.text).toContain('请求来源不被允许。');
  });
});
