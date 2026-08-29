import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import type { Page, PageFilters, SearchOpts, SearchResult } from '../src/core/types.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

function page(slug: string, status: string, verification: string): Page {
  return {
    id: slug.length,
    slug,
    source_id: 'default',
    type: 'knowledge',
    title: slug,
    compiled_truth: `${slug} body`,
    timeline: '',
    frontmatter: { status, verification },
    created_at: new Date('2026-07-26T00:00:00Z'),
    updated_at: new Date('2026-07-26T00:00:00Z'),
  };
}

function searchResult(slug: string, pageId: number): SearchResult {
  return {
    slug,
    page_id: pageId,
    title: slug,
    type: 'knowledge',
    chunk_text: `${slug} body`,
    chunk_source: 'compiled_truth',
    chunk_id: pageId,
    chunk_index: 0,
    score: 1,
    stale: false,
    source_id: 'default',
  };
}

function fakeEngine(pages: readonly Page[], hits: readonly SearchResult[]): BrainEngine {
  return {
    kind: 'pglite',
    getConfig: async (key: string) => {
      if (key === 'search.mcp_keyword_only') return 'true';
      if (key === 'search.track_retrieval') return 'false';
      return null;
    },
    listPages: async (filters: PageFilters = {}) => {
      const offset = filters.offset ?? 0;
      const limit = filters.limit ?? 100;
      const scoped = filters.slugPrefix
        ? pages.filter((candidate) => candidate.slug.startsWith(filters.slugPrefix ?? ''))
        : pages;
      return scoped.slice(offset, offset + limit);
    },
    searchKeyword: async (_query: string, opts: SearchOpts = {}) => {
      const include = opts.include_slug_prefixes ?? [];
      const exclude = opts.exclude_slug_prefixes ?? [];
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 20;
      const scoped = hits.filter((hit) => {
        const included = include.length === 0 || include.some((prefix) => hit.slug.startsWith(prefix));
        const excluded = exclude.some((prefix) => hit.slug.startsWith(prefix));
        return included && !excluded;
      });
      return scoped.slice(offset, offset + limit);
    },
    searchTitles: async () => [],
    getBacklinkCounts: async () => new Map(),
    getSalienceScores: async () => new Map(),
    getEffectiveDates: async () => new Map(),
    resolveAliases: async () => new Map(),
    getContentFlagsByPageIds: async () => new Map(),
    getPage: async (slug: string) => pages.find((candidate) => candidate.slug === slug) ?? null,
    executeRaw: async () => [],
  } as unknown as BrainEngine;
}

function parseToolText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

const ctxOpts = { remote: true, sourceId: 'default' } as const;

describe('MCP read-side filters and pagination contract', () => {
  test('list_pages excludes inbox and returns pagination metadata when exclude_prefixes is set', async () => {
    // given
    const engine = fakeEngine([
      page('knowledge/alpha', 'verified', 'verified'),
      page('inbox/draft-alpha', 'draft', 'unverified'),
      page('runbooks/beta', 'reviewed', 'unverified'),
    ], []);

    // when
    const result = await dispatchToolCall(engine, 'list_pages', {
      exclude_prefixes: ['inbox/'],
      limit: 1,
      offset: 0,
      sort: 'slug',
    }, ctxOpts);

    // then
    expect(result.isError).toBeUndefined();
    const body = parseToolText(result) as {
      items: Array<{ slug: string }>;
      count: number;
      total_count: number;
      has_more: boolean;
      next_offset: number | null;
    };
    expect(body.items.map((item) => item.slug)).toEqual(['knowledge/alpha']);
    expect(body.items.some((item) => item.slug.startsWith('inbox/'))).toBe(false);
    expect(body.count).toBe(1);
    expect(body.total_count).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_offset).toBe(1);
  });

  test('search excludes inbox and returns pagination metadata when exclude_prefixes is set', async () => {
    // given
    const pages = [
      page('knowledge/alpha', 'verified', 'verified'),
      page('inbox/draft-alpha', 'draft', 'unverified'),
      page('runbooks/beta', 'reviewed', 'unverified'),
    ];
    const engine = fakeEngine(pages, pages.map((candidate, index) => searchResult(candidate.slug, index + 1)));

    // when
    const result = await dispatchToolCall(engine, 'search', {
      query: 'alpha',
      exclude_prefixes: ['inbox/'],
      limit: 1,
      offset: 0,
    }, ctxOpts);

    // then
    expect(result.isError).toBeUndefined();
    const body = parseToolText(result) as {
      results: Array<{ slug: string }>;
      count: number;
      total_count: number;
      has_more: boolean;
      next_offset: number | null;
    };
    expect(body.results.map((item) => item.slug)).toEqual(['knowledge/alpha']);
    expect(body.results.some((item) => item.slug.startsWith('inbox/'))).toBe(false);
    expect(body.count).toBe(1);
    expect(body.total_count).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_offset).toBe(1);
  });

  test('old list_pages callers still receive the legacy array response', async () => {
    // given
    const engine = fakeEngine([page('knowledge/alpha', 'verified', 'verified')], []);

    // when
    const result = await dispatchToolCall(engine, 'list_pages', {}, ctxOpts);

    // then
    expect(Array.isArray(parseToolText(result))).toBe(true);
  });

  test('remote default list, search, and query hide inbox drafts', async () => {
    // given
    const pages = [
      page('knowledge/alpha', 'verified', 'verified'),
      page('inbox/draft-alpha', 'draft', 'unverified'),
      page('runbooks/beta', 'reviewed', 'unverified'),
    ];
    const engine = fakeEngine(pages, pages.map((candidate, index) => searchResult(candidate.slug, index + 1)));

    // when
    const listResult = await dispatchToolCall(engine, 'list_pages', { limit: 50 }, ctxOpts);
    const searchResultBody = await dispatchToolCall(engine, 'search', { query: 'alpha', limit: 50 }, ctxOpts);
    const queryResult = await dispatchToolCall(engine, 'query', { query: 'alpha', limit: 50, autocut: false }, ctxOpts);

    // then
    expect(listResult.isError).toBeUndefined();
    expect(searchResultBody.isError).toBeUndefined();
    expect(queryResult.isError).toBeUndefined();
    const listBody = parseToolText(listResult) as Array<{ slug: string }>;
    const searchBody = parseToolText(searchResultBody) as Array<{ slug: string }>;
    const queryBody = parseToolText(queryResult) as Array<{ slug: string }>;
    expect(listBody.some((item) => item.slug.startsWith('inbox/'))).toBe(false);
    expect(searchBody.some((item) => item.slug.startsWith('inbox/'))).toBe(false);
    expect(queryBody.some((item) => item.slug.startsWith('inbox/'))).toBe(false);
  });

  test('remote explicit inbox include returns drafts for list, search, and query', async () => {
    // given
    const pages = [
      page('knowledge/alpha', 'verified', 'verified'),
      page('inbox/draft-alpha', 'draft', 'unverified'),
      page('inbox/draft-beta', 'draft', 'unverified'),
    ];
    const engine = fakeEngine(pages, pages.map((candidate, index) => searchResult(candidate.slug, index + 1)));
    const params = { include_prefixes: ['inbox/'], limit: 50 };

    // when
    const listResult = await dispatchToolCall(engine, 'list_pages', params, ctxOpts);
    const searchResultBody = await dispatchToolCall(engine, 'search', { ...params, query: 'draft' }, ctxOpts);
    const queryResult = await dispatchToolCall(engine, 'query', { ...params, query: 'draft', autocut: false }, ctxOpts);

    // then
    expect(listResult.isError).toBeUndefined();
    expect(searchResultBody.isError).toBeUndefined();
    expect(queryResult.isError).toBeUndefined();
    const listBody = parseToolText(listResult) as { items: Array<{ slug: string }> };
    const searchBody = parseToolText(searchResultBody) as { results: Array<{ slug: string }> };
    const queryBody = parseToolText(queryResult) as { results: Array<{ slug: string }> };
    expect(listBody.items.map((item) => item.slug)).toEqual(['inbox/draft-alpha', 'inbox/draft-beta']);
    expect(searchBody.results.map((item) => item.slug)).toEqual(['inbox/draft-alpha', 'inbox/draft-beta']);
    expect(queryBody.results.length).toBeGreaterThan(0);
    expect(queryBody.results.every((item) => item.slug.startsWith('inbox/'))).toBe(true);
  });

  test('local default list, search, and query keep inbox drafts visible', async () => {
    // given
    const pages = [
      page('knowledge/alpha', 'verified', 'verified'),
      page('inbox/draft-alpha', 'draft', 'unverified'),
    ];
    const engine = fakeEngine(pages, pages.map((candidate, index) => searchResult(candidate.slug, index + 1)));
    const localCtx = { remote: false, sourceId: 'default' } as const;

    // when
    const listResult = await dispatchToolCall(engine, 'list_pages', { limit: 50 }, localCtx);
    const searchResultBody = await dispatchToolCall(engine, 'search', { query: 'alpha', limit: 50 }, localCtx);
    const queryResult = await dispatchToolCall(engine, 'query', { query: 'alpha', limit: 50, autocut: false }, localCtx);

    // then
    expect(listResult.isError).toBeUndefined();
    expect(searchResultBody.isError).toBeUndefined();
    expect(queryResult.isError).toBeUndefined();
    const listBody = parseToolText(listResult) as Array<{ slug: string }>;
    const searchBody = parseToolText(searchResultBody) as Array<{ slug: string }>;
    const queryBody = parseToolText(queryResult) as Array<{ slug: string }>;
    expect(listBody.some((item) => item.slug === 'inbox/draft-alpha')).toBe(true);
    expect(searchBody.some((item) => item.slug === 'inbox/draft-alpha')).toBe(true);
    expect(queryBody.some((item) => item.slug === 'inbox/draft-alpha')).toBe(true);
  });

  test('invalid status, prefix, and limit values return tool errors without stack traces', async () => {
    // given
    const engine = fakeEngine([], []);

    // when
    const invalidStatus = await dispatchToolCall(engine, 'list_pages', { status: 'published' }, ctxOpts);
    const invalidPrefix = await dispatchToolCall(engine, 'search', {
      query: 'alpha',
      exclude_prefixes: ['../inbox'],
    }, ctxOpts);
    const invalidLimit = await dispatchToolCall(engine, 'query', { query: 'alpha', limit: 0 }, ctxOpts);

    // then
    for (const result of [invalidStatus, invalidPrefix, invalidLimit]) {
      expect(result.isError).toBe(true);
      const body = parseToolText(result) as { error: string; message: string };
      expect(body.error).toBe('invalid_params');
      expect(body.message).not.toContain('at ');
      expect(body.message).not.toContain('operations.ts');
    }
    expect((parseToolText(invalidStatus) as { message: string }).message).toContain('draft, reviewed, verified, migrated-legacy');
    expect((parseToolText(invalidPrefix) as { message: string }).message).toContain('safe slug prefix');
    expect((parseToolText(invalidLimit) as { message: string }).message).toContain('limit');
  });

  test('tool schemas and annotations expose the read-side contract', () => {
    // given
    const defs = buildToolDefs(operations);

    // when
    const listPages = defs.find((tool) => tool.name === 'list_pages');
    const search = defs.find((tool) => tool.name === 'search');
    const query = defs.find((tool) => tool.name === 'query');
    const deletePage = defs.find((tool) => tool.name === 'delete_page');

    // then
    expect(listPages?.inputSchema.properties.exclude_prefixes).toMatchObject({
      type: 'array',
      maxItems: 20,
      items: expect.objectContaining({ type: 'string', pattern: expect.any(String) }),
    });
    expect(search?.inputSchema.properties.limit).toMatchObject({ type: 'number', minimum: 1, maximum: 100 });
    expect(query?.inputSchema.properties.verification).toMatchObject({ enum: ['unverified', 'verified'] });
    expect(listPages?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(query?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(deletePage?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });
});
