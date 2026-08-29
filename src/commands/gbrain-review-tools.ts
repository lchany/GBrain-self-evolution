import { type ReviewCoreDeps, type ReviewSourcePage, type DuplicateCandidate, type DuplicateSearchRequest } from '../core/review/index.ts';
import type { ToolCaller } from './gbrain-review.ts';

export function reviewDeps(callReadTool: ToolCaller): ReviewCoreDeps {
  return { readPage: (slug) => readPage(callReadTool, slug), searchDuplicates: (request) => searchDuplicates(callReadTool, request) };
}

export function applyDeps(callWriteTool: ToolCaller): ReviewCoreDeps {
  return {
    readPage: (slug) => readPage(callWriteTool, slug),
    searchDuplicates: async () => [],
    writePage: async (page) => toolReceipt(callWriteTool, 'put_page', { slug: page.slug, content: page.markdown }),
    verifyPage: async (slug) => toolReceipt(callWriteTool, 'get_page', { slug }),
    deletePage: async (slug) => toolReceipt(callWriteTool, 'delete_page', { slug }),
  };
}

export async function readPage(callTool: ToolCaller, slug: string): Promise<ReviewSourcePage | null> {
  try {
    const raw = await callTool('get_page', { slug });
    return pageFromTool(slug, raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('page_not_found') || message.includes('Page not found')) return null;
    throw error;
  }
}

export async function searchDuplicates(callTool: ToolCaller, request: DuplicateSearchRequest): Promise<readonly DuplicateCandidate[]> {
  const raw = await callTool('search', { query: request.title, include_prefixes: [slugPrefix(request.targetSlug)], limit: 10 });
  return resultSlugs(raw).map((slug) => ({ slug, title: slug }));
}

export async function inboxPages(raw: unknown): Promise<readonly ReviewSourcePage[]> {
  const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  return values.flatMap((value) => isRecord(value) && typeof value.slug === 'string' ? [pageFromTool(value.slug, value)] : []);
}

export async function filterByProject(pages: readonly ReviewSourcePage[], projectId: string, callTool: ToolCaller): Promise<readonly ReviewSourcePage[]> {
  const loaded = await Promise.all(pages.map((page) => readPage(callTool, page.slug)));
  return loaded.filter((page): page is ReviewSourcePage => page?.frontmatter?.project_id === projectId);
}

export function resultSlugs(raw: unknown): readonly string[] {
  const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
  return values.flatMap((value) => isRecord(value) && typeof value.slug === 'string' ? [value.slug] : []);
}

export function slugPrefix(slug: string): string {
  const slash = slug.indexOf('/');
  return slash === -1 ? '' : slug.slice(0, slash + 1);
}

function pageFromTool(slug: string, raw: unknown): ReviewSourcePage {
  if (!isRecord(raw)) return { slug };
  return {
    slug: typeof raw.slug === 'string' ? raw.slug : slug,
    ...(typeof raw.markdown === 'string' ? { markdown: raw.markdown } : {}),
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(Array.isArray(raw.tags) ? { tags: raw.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
    ...(typeof raw.compiled_truth === 'string' ? { compiledTruth: raw.compiled_truth } : {}),
    ...(typeof raw.timeline === 'string' ? { timeline: raw.timeline } : {}),
    ...(isRecord(raw.frontmatter) ? { frontmatter: raw.frontmatter } : {}),
  };
}

async function toolReceipt(callTool: ToolCaller, name: string, args: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly code: string; readonly message: string }> {
  try {
    await callTool(name, args);
    return { ok: true, code: 'ok', message: `${name} ${String(args.slug)} 完成。` };
  } catch (error) {
    return { ok: false, code: 'tool_failed', message: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
