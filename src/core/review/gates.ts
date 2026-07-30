import { assessContentSanity } from '../content-sanity.ts';
import { scrubPii } from '../eval-capture-scrub.ts';
import type { ParsedReviewPage, ReviewAction, ReviewCoreDeps, ReviewGateResult, ReviewTargetType } from './types.ts';
import { PROJECT_ID_RE } from '../project-context.ts';

export const REVIEW_TARGET_PREFIXES: Record<ReviewTargetType, string> = {
  knowledge: 'knowledge/',
  runbook: 'runbooks/',
  incident: 'incidents/',
  decision: 'decisions/',
  project: 'projects/',
  environment: 'environments/',
  'agent-skill': 'agent-skills/',
};

export function validateSourceSlug(sourceSlug: string): ReviewGateResult {
  if (!sourceSlug.startsWith('inbox/')) {
    return { ok: false, code: 'source_slug_not_inbox', message: '审核来源必须是 inbox/ 草稿。' };
  }
  return { ok: true, code: 'ok', message: '来源 slug 属于 inbox。' };
}

export function validateTargetSlugAndType(action: ReviewAction, source?: ParsedReviewPage): ReviewGateResult {
  switch (action.kind) {
    case 'reject':
    case 'needs_evidence':
    case 'repair':
    case 'cleanup':
      return { ok: true, code: 'ok', message: '该动作不需要目标 slug。' };
    case 'keep':
    case 'promote':
    case 'merge': {
      if (action.targetSlug.length === 0) {
        return { ok: false, code: 'target_slug_required', message: '缺少目标 slug。' };
      }
      if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(action.targetSlug)) {
        return { ok: false, code: 'target_slug_invalid', message: '目标 slug 只能包含小写字母、数字、连字符和路径斜杠。' };
      }
      const prefix = REVIEW_TARGET_PREFIXES[action.targetType];
      if (!action.targetSlug.startsWith(prefix)) {
        return { ok: false, code: 'target_type_invalid', message: `目标类型 ${action.targetType} 必须写入 ${prefix}。` };
      }
      if (action.targetType === 'project' && source !== undefined) {
        const projectId = source.frontmatter.project_id;
        if (source.frontmatter.project_binding !== 'bound' || typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
          return { ok: false, code: 'project_binding_required', message: '项目经验在审核前必须绑定规范 project_id。' };
        }
        if (!action.targetSlug.startsWith(`projects/${projectId}/`)) {
          return { ok: false, code: 'project_path_mismatch', message: `项目经验只能写入 projects/${projectId}/。` };
        }
      }
      return { ok: true, code: 'ok', message: '目标 slug 与类型匹配。' };
    }
  }
}

export function runForbiddenContentChecks(page: ParsedReviewPage): ReviewGateResult {
  const body = `${page.title}\n${page.compiledTruth}\n${page.timeline}`;
  if (scrubPii(body) !== body) {
    return { ok: false, code: 'unsafe_content', message: '发现疑似个人信息、令牌或认证片段，不能写入正式页。' };
  }
  const result = assessContentSanity({
    compiled_truth: page.compiledTruth,
    timeline: page.timeline,
    title: page.title,
  });
  if (result.shouldHardBlock || result.shouldSkipEmbed) {
    return { ok: false, code: 'unsafe_content', message: '发现禁止内容或高置信垃圾内容，不能写入正式页。', details: result.reason_messages };
  }
  return { ok: true, code: 'ok', message: '未发现禁止内容。' };
}

export function validateVerificationGate(action: ReviewAction, source: ParsedReviewPage): ReviewGateResult {
  switch (action.kind) {
    case 'promote':
      if (!action.humanConfirmation) {
        return { ok: false, code: 'promote_confirmation_required', message: `升级通用经验必须明确确认 PROMOTE ${action.targetSlug}。` };
      }
      if (source.frontmatter.verification !== 'verified') {
        return { ok: false, code: 'unverified_promote', message: '未验证内容不能升级到 knowledge/ 或 runbooks/。' };
      }
      return { ok: true, code: 'ok', message: 'promote 人工确认与验证状态通过。' };
    case 'merge':
      if (!action.humanConfirmation) {
        return { ok: false, code: 'promote_confirmation_required', message: `合并必须明确确认目标 ${action.targetSlug}。` };
      }
      return { ok: true, code: 'ok', message: 'merge 人工确认通过。' };
    case 'reject':
    case 'needs_evidence':
    case 'keep':
    case 'repair':
    case 'cleanup':
      return { ok: true, code: 'ok', message: '该动作不需要 promote 验证门禁。' };
  }
}

export async function runDuplicateSearch(deps: ReviewCoreDeps, action: ReviewAction, source: ParsedReviewPage): Promise<ReviewGateResult> {
  switch (action.kind) {
    case 'reject':
    case 'needs_evidence':
    case 'repair':
    case 'cleanup':
    case 'merge':
      return { ok: true, code: 'ok', message: '该动作不需要创建前重复检查。' };
    case 'keep':
    case 'promote': {
      const candidates = await deps.searchDuplicates({ sourceSlug: source.slug, targetSlug: action.targetSlug, title: source.title, targetType: action.targetType });
      const duplicate = candidates.find((candidate) => candidate.slug === action.targetSlug);
      if (duplicate !== undefined) {
        return { ok: false, code: 'duplicate_target', message: '发现重复目标页，请改用 merge。', candidates };
      }
      return { ok: true, code: 'ok', message: 'search-before-create 未发现重复目标。' };
    }
  }
}
