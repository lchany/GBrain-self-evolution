import { describe, expect, test } from 'bun:test';
import express from 'express';
import type { Request, Response } from 'express';
import { mountReviewRoutes } from '../src/commands/serve-http-review.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

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

const mockPages: Page[] = [
  makePage('inbox/list-item-1', { title: '草稿一：测试列表项', type: 'incident' }),
  makePage('incidents/existing-target', { title: '已存在的目标页面', type: 'incident' }),
];

const mockEngine: BrainEngine = {
  getPage: async (slug: string, options?: { readonly sourceId?: string }) => {
    return mockPages.find((page) => page.slug === slug && page.source_id === (options?.sourceId ?? 'default')) ?? null;
  },
  listPages: async (filters: { readonly slugPrefix?: string; readonly type?: string; readonly limit?: number; readonly sourceId?: string }) => {
    let result = mockPages.filter((p) => !p.deleted_at);
    if (filters.sourceId !== undefined) result = result.filter((p) => p.source_id === filters.sourceId);
    if (filters.slugPrefix) result = result.filter((p) => p.slug.startsWith(filters.slugPrefix!));
    if (filters.type) result = result.filter((p) => p.type === filters.type!);
    if (filters.limit) result = result.slice(0, filters.limit);
    return result;
  },
} as unknown as BrainEngine;

function createApp() {
  const app = express();

  // requireAdmin that returns 401 if not authenticated
  function requireAdmin(req: Request, res: Response, next: (err?: unknown) => void) {
    const authHeader = req.headers['x-test-auth'];
    if (authHeader === 'admin') {
      next();
    } else {
      res.status(401).send('Unauthorized');
    }
  }

  mountReviewRoutes(app, mockEngine, requireAdmin, {
    writerSessionFactory: async () => ({
      callTool: async (name, args) => ({ ok: true }),
      close: async () => {},
    }),
    issuerUrl: new URL('http://review.test'),
    reviewSourceId: 'default',
  });

  // SPA fallback
  app.get('/admin/{*path}', (req, res) => {
    res.send('SPA index.html');
  });

  return app;
}

async function fetchApp(app: express.Express, path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://localhost:${port}${path}`, { headers });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    server.close();
  }
}

describe('serve-http-admin-review-fallback', () => {
  test('Given unauthenticated request to /admin/review When requested Then returns 401 instead of SPA fallback', async () => {
    const app = createApp();
    const result = await fetchApp(app, '/admin/review');
    expect(result.status).toBe(401);
    expect(result.text).not.toContain('SPA index.html');
  });

  test('Given unauthenticated request to /admin/api/review/targets When requested Then returns 401 instead of SPA fallback', async () => {
    const app = createApp();
    const result = await fetchApp(app, '/admin/api/review/targets');
    expect(result.status).toBe(401);
    expect(result.text).not.toContain('SPA index.html');
  });

  test('Given authenticated request to /admin/review When requested Then returns 200', async () => {
    const app = createApp();
    const result = await fetchApp(app, '/admin/review', { 'x-test-auth': 'admin' });
    expect(result.status).toBe(200);
    expect(result.text).toContain('Inbox 草稿审核');
  });

  test('Given dual-source same-slug fixtures When requested Then browser requests stay on the server-bound source', async () => {
    const source1Page = makePage('inbox/list-item-1', { title: 'Source 1 Page', source_id: 'default' });
    const source2Page = makePage('inbox/list-item-1', { title: 'Source 2 Page', source_id: 'other' });

    const dualSourceEngine: BrainEngine = {
      getPage: async (slug: string, options?: { readonly sourceId?: string }) => {
        const sourceId = options?.sourceId ?? 'default';
        if (sourceId === 'default') return source1Page;
        if (sourceId === 'other') return source2Page;
        return null;
      },
      listPages: async (filters: { readonly sourceId?: string }) => {
        const sourceId = filters.sourceId ?? 'default';
        if (sourceId === 'default') return [source1Page];
        if (sourceId === 'other') return [source2Page];
        return [];
      },
    } as unknown as BrainEngine;

    const app = express();
    function requireAdmin(req: Request, res: Response, next: (err?: unknown) => void) {
      next();
    }
    mountReviewRoutes(app, dualSourceEngine, requireAdmin, {
      writerSessionFactory: async () => ({
        callTool: async (name, args) => ({ ok: true }),
        close: async () => {},
      }),
      issuerUrl: new URL('http://review.test'),
      reviewSourceId: 'default',
    });

    const result = await fetchApp(app, `/admin/review/detail/${encodeURIComponent('inbox/list-item-1')}`);
    expect(result.status).toBe(200);
    expect(result.text).toContain('Source 1 Page');
    expect(result.text).not.toContain('Source 2 Page');
  });
});
