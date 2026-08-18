import { PROJECT_ID_RE } from '../project-context.ts';
import { REVIEW_TARGET_PREFIXES } from './gates.ts';
import type { ReviewCategory } from './recommendation.ts';
import type { ReviewAction, ReviewSourcePage, ReviewTargetType } from './types.ts';

export function buildClassificationAction(category: ReviewCategory, source: ReviewSourcePage): ReviewAction | null {
  if (category === 'reject') {
    return { kind: 'reject', sourceSlug: source.slug, reviewNotes: '审核者选择分类：拒绝并删除。' };
  }

  const targetType: ReviewTargetType = category;
  const projectId = typeof source.frontmatter?.project_id === 'string' ? source.frontmatter.project_id : undefined;
  const targetSlug = generateClassificationTargetSlug(source.slug, targetType, projectId);
  if (targetSlug === null) return null;

  // 分类只决定归档位置，不改变 verification。旧 promote 动作的确认短语和
  // verified 门禁用于“真实性晋升”，不适用于本次单一分类审核。
  return { kind: 'keep', sourceSlug: source.slug, targetSlug, targetType };
}

export function generateClassificationTargetSlug(
  sourceSlug: string,
  targetType: Extract<ReviewTargetType, 'project' | 'knowledge' | 'runbook' | 'incident'>,
  projectId?: string,
): string | null {
  if (!sourceSlug.startsWith('inbox/')) return null;
  const tail = sourceSlug.slice('inbox/'.length)
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (tail.length === 0) return null;
  if (targetType === 'project' && (projectId === undefined || !PROJECT_ID_RE.test(projectId))) return null;
  const prefix = targetType === 'project' ? `projects/${projectId}/` : REVIEW_TARGET_PREFIXES[targetType];
  const slug = `${prefix}${tail}`.slice(0, 80).replace(/-+$/g, '').replace(/\/+$/g, '');
  return /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(slug) ? slug : null;
}
