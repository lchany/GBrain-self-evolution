import express from 'express';
import type { Request, Response } from 'express';
import { mountReviewRoutes } from '../../src/commands/serve-http-review.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Page } from '../../src/core/types.ts';

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

const mockPages: Page[] = [
  makePage('inbox/list-item-1', { title: '草稿一：测试列表项', type: 'incident' }),
  makePage('inbox/list-item-2', { title: '草稿二：测试列表项', type: 'runbook', frontmatter: { type: 'runbook', verification: 'unverified' } }),
  makePage('inbox/list-item-3', { title: '草稿三：测试列表项', type: 'knowledge', frontmatter: { type: 'knowledge', verification: 'verified' } }),
  makePage('incidents/existing-target', { title: '已存在的目标页面', type: 'incident' }),
];

function reviewPageType(slug: string): Page['type'] {
  if (slug.startsWith('runbooks/')) return 'runbook';
  return 'incident';
}

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

const app = express();

function requireAdmin(req: Request, res: Response, next: (err?: unknown) => void) {
  if (req.headers['x-test-session'] !== 'test-session') {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

mountReviewRoutes(app, mockEngine, requireAdmin, {
  writerSessionFactory: async () => ({
    callTool: async (name, args) => {
      if (name === 'get_brain_identity') {
        return { source_id: 'default' };
      }
      if (name === 'put_page' && typeof args.slug === 'string' && !mockPages.some((page) => page.slug === args.slug)) {
        mockPages.push(makePage(args.slug, { type: reviewPageType(args.slug) }));
      }
      return { ok: true };
    },
    close: async () => {},
  }),
  issuerUrl: new URL('http://127.0.0.1:4173'),
  reviewDate: () => REVIEW_DATE,
  reviewSourceId: 'default',
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4173;
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Fixture server listening on http://127.0.0.1:${port}`);
});

const shutdown = () => {
  console.log('Shutting down fixture server...');
  server.close(() => {
    console.log('Fixture server stopped.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
