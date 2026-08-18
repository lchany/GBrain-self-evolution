import type { PageType } from '../types.ts';
import type { BuiltReviewPage, ParsedReviewPage, ReviewAction } from './types.ts';
import { renderReviewPage } from './frontmatter.ts';

export function buildTargetPage(action: ReviewAction, source: ParsedReviewPage, existingTarget?: ParsedReviewPage): BuiltReviewPage | null {
  switch (action.kind) {
    case 'keep':
    case 'promote': {
      const projectId = typeof source.frontmatter.project_id === 'string' ? source.frontmatter.project_id : undefined;
      const promotesGlobally = projectId !== undefined && action.targetType !== 'project';
      const nextFrontmatter = { ...source.frontmatter };
      if (promotesGlobally) {
        delete nextFrontmatter.project_id;
        delete nextFrontmatter.project_binding;
        delete nextFrontmatter.record_kind;
    }
      return materializePage({
        slug: action.targetSlug,
        type: action.targetType,
        title: source.title,
        tags: source.tags,
        compiledTruth: source.compiledTruth,
        timeline: source.timeline,
        frontmatter: {
          ...nextFrontmatter,
          type: action.targetType,
          status: source.frontmatter.verification === 'verified' ? 'verified' : 'reviewed',
          verification: source.frontmatter.verification,
          reviewed_from: source.slug,
          ...(promotesGlobally ? { source_project_ids: mergeList(source.frontmatter.source_project_ids, [projectId]) } : {}),
        },
      });
      }
    case 'merge': {
      if (existingTarget === undefined) return null;
      const sourceProjectId = typeof source.frontmatter.project_id === 'string'
        ? source.frontmatter.project_id
        : undefined;
      const mergesGlobally = sourceProjectId !== undefined && action.targetType !== 'project';
      return materializePage({
        slug: action.targetSlug,
        type: action.targetType,
        title: existingTarget.title,
        tags: existingTarget.tags,
        compiledTruth: `${existingTarget.compiledTruth}\n\n## 合并来源\n\n来自 ${source.slug}:\n\n${source.compiledTruth}`.trim(),
        timeline: existingTarget.timeline || source.timeline,
        frontmatter: {
          ...existingTarget.frontmatter,
          type: action.targetType,
          source_refs: mergeList(existingTarget.frontmatter.source_refs, source.frontmatter.source_refs),
          merged_from: mergeList(existingTarget.frontmatter.merged_from, [source.slug]),
          ...(mergesGlobally
            ? { source_project_ids: mergeList(existingTarget.frontmatter.source_project_ids, [sourceProjectId]) }
            : {}),
        },
      });
    }
    case 'reject':
    case 'needs_evidence':
    case 'repair':
    case 'cleanup':
      return null;
  }
}

export function buildReviewApprovalPage(action: ReviewAction, source: ParsedReviewPage, reviewDate: string, targetPage?: BuiltReviewPage): BuiltReviewPage {
  const subjectSlug = targetPage?.slug ?? source.slug;
  const subjectName = subjectSlug.split('/').at(-1) ?? 'review';
  const slug = `decisions/reviews/${subjectName}-review-${reviewDate.replace(/-/g, '')}`;
  const decision = targetPage === undefined ? action.kind : `${action.kind}:${targetPage.slug}`;
  return materializePage({
    slug,
    type: 'decision',
    title: `Review ${subjectName}`,
    tags: [],
    compiledTruth: [
      '## 审核决定',
      '',
      `- action: ${action.kind}`,
      `- source: ${source.slug}`,
      targetPage ? `- target: ${targetPage.slug}` : '- target: null',
      `- decision: ${decision}`,
    ].join('\n'),
    timeline: '',
    frontmatter: {
      type: 'decision',
      date: reviewDate,
      status: 'reviewed',
      sensitivity: source.frontmatter.sensitivity ?? 'internal',
      verification: 'verified',
      applicability: ['all'],
      non_applicable: [],
      source_refs: [source.slug],
      migrated_from: null,
      review_action: action.kind,
    },
  });
}

function materializePage(page: {
  readonly slug: string;
  readonly type: PageType;
  readonly title: string;
  readonly tags: readonly string[];
  readonly compiledTruth: string;
  readonly timeline: string;
  readonly frontmatter: Record<string, unknown>;
}): BuiltReviewPage {
  return {
    slug: page.slug,
    type: page.type,
    title: page.title,
    frontmatter: page.frontmatter,
    compiledTruth: page.compiledTruth,
    timeline: page.timeline,
    markdown: renderReviewPage(page),
  };
}

function mergeList(left: unknown, right: unknown): readonly string[] {
  const values = [...coerceList(left), ...coerceList(right)];
  return [...new Set(values)];
}

function coerceList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}
