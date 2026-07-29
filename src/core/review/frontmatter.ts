import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import type { ParseValidationError } from '../markdown.ts';
import type { ParsedReviewPage, ReviewGateResult, ReviewSourcePage } from './types.ts';

const REQUIRED_FRONTMATTER_FIELDS = [
  'type',
  'date',
  'status',
  'sensitivity',
  'verification',
  'applicability',
  'non_applicable',
  'source_refs',
  'migrated_from',
] as const;

export function parseReviewSourcePage(source: ReviewSourcePage): { readonly page: ParsedReviewPage; readonly gate: ReviewGateResult } | { readonly gate: ReviewGateResult } {
  if (source.markdown !== undefined) {
    const parsed = parseMarkdown(source.markdown, `${source.slug}.md`, { validate: true, expectedSlug: source.slug });
    const errors = parsed.errors ?? [];
    if (errors.length > 0) return { gate: frontmatterInvalid(errors) };
    const frontmatter = { ...parsed.frontmatter, type: parsed.type, title: parsed.title, tags: parsed.tags };
    return {
      page: {
        slug: source.slug,
        type: parsed.type,
        title: parsed.title,
        tags: parsed.tags,
        compiledTruth: parsed.compiled_truth,
        timeline: parsed.timeline,
        frontmatter,
      },
      gate: { ok: true, code: 'ok', message: 'frontmatter 解析通过。' },
    };
  }

  const frontmatter = { ...(source.frontmatter ?? {}), type: source.type ?? 'note', title: source.title ?? 'Untitled', tags: source.tags ?? [] };
  return {
    page: {
      slug: source.slug,
      type: source.type ?? 'note',
      title: source.title ?? 'Untitled',
      tags: source.tags ?? [],
      compiledTruth: source.compiledTruth ?? '',
      timeline: source.timeline ?? '',
      frontmatter,
    },
    gate: { ok: true, code: 'ok', message: 'frontmatter 解析通过。' },
  };
}

export function validateReviewFrontmatter(page: ParsedReviewPage): ReviewGateResult {
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!(field in page.frontmatter)) {
      return field === 'non_applicable'
        ? { ok: false, code: 'missing_non_applicable', message: '缺少 non_applicable，不能确认适用边界。' }
        : { ok: false, code: 'missing_required_frontmatter', message: `缺少必填 frontmatter 字段：${field}。`, details: [field] };
    }
  }
  if (!Array.isArray(page.frontmatter.non_applicable)) {
    return { ok: false, code: 'missing_non_applicable', message: 'non_applicable 必须是列表，空列表 [] 也可以。' };
  }
  const sourceRefs = page.frontmatter.source_refs;
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
    return { ok: false, code: 'missing_source_refs', message: '缺少 source_refs，审核记录必须指向证据。' };
  }
  return { ok: true, code: 'ok', message: '必填 frontmatter 字段完整。' };
}

export function renderReviewPage(page: Omit<ParsedReviewPage, 'slug'> & { readonly slug: string }): string {
  return serializeMarkdown(page.frontmatter, page.compiledTruth, page.timeline, {
    type: page.type,
    title: page.title,
    tags: [...page.tags],
  });
}

function frontmatterInvalid(errors: readonly ParseValidationError[]): ReviewGateResult {
  return {
    ok: false,
    code: 'frontmatter_invalid',
    message: 'frontmatter 解析或格式校验失败。',
    details: errors.map((error) => `${error.code}: ${error.message}`),
  };
}
