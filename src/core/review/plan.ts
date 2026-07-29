import { assertNever } from '../types.ts';
import { buildReviewApprovalPage, buildTargetPage } from './builders.ts';
import { parseReviewSourcePage, validateReviewFrontmatter } from './frontmatter.ts';
import { runDuplicateSearch, runForbiddenContentChecks, validateSourceSlug, validateTargetSlugAndType, validateVerificationGate } from './gates.ts';
import type { BuiltReviewPage, ParsedReviewPage, ReviewAction, ReviewCoreDeps, ReviewGateResult, ReviewPlanRequest, ReviewPlanResult, ReviewStepPlan } from './types.ts';

export async function loadSourcePage(deps: ReviewCoreDeps, sourceSlug: string): Promise<{ readonly page: ParsedReviewPage; readonly gate: ReviewGateResult } | { readonly gate: ReviewGateResult }> {
  const source = await deps.readPage(sourceSlug);
  if (source === null) {
    return { gate: { ok: false, code: 'source_not_found', message: '找不到待审核 inbox 草稿。' } };
  }
  return parseReviewSourcePage(source);
}

export async function planReview(deps: ReviewCoreDeps, request: ReviewPlanRequest): Promise<ReviewPlanResult> {
  const action = request.action;
  const gates: ReviewGateResult[] = [];
  const dateGate = validateReviewDate(request.reviewDate);
  gates.push(dateGate);
  if (!dateGate.ok) return fail(dateGate, gates);

  const sourceSlugGate = validateSourceSlug(action.sourceSlug);
  gates.push(sourceSlugGate);
  if (!sourceSlugGate.ok) return fail(sourceSlugGate, gates);

  const loaded = await loadSourcePage(deps, action.sourceSlug);
  gates.push(loaded.gate);
  if (!loaded.gate.ok || !('page' in loaded)) return fail(loaded.gate, gates);

  const frontmatterGate = validateReviewFrontmatter(loaded.page);
  gates.push(frontmatterGate);
  if (!frontmatterGate.ok) return fail(frontmatterGate, gates);

  const targetGate = validateTargetSlugAndType(action);
  gates.push(targetGate);
  if (!targetGate.ok) return fail(targetGate, gates);

  const forbiddenGate = runForbiddenContentChecks(loaded.page);
  gates.push(forbiddenGate);
  if (!forbiddenGate.ok) return fail(forbiddenGate, gates);

  const verificationGate = validateVerificationGate(action, loaded.page);
  gates.push(verificationGate);
  if (!verificationGate.ok) return fail(verificationGate, gates);

  const duplicateGate = await runDuplicateSearch(deps, action, loaded.page);
  gates.push(duplicateGate);
  if (!duplicateGate.ok) return fail(duplicateGate, gates);

  const existingTarget = await loadExistingTarget(deps, action);
  if (existingTarget.gate !== null) {
    gates.push(existingTarget.gate);
    if (!existingTarget.gate.ok) return fail(existingTarget.gate, gates);
  }

  const targetPage = buildTargetPage(action, loaded.page, existingTarget.page);
  const reviewPage = buildReviewApprovalPage(action, loaded.page, request.reviewDate, targetPage ?? undefined);
  return {
    ok: true,
    code: 'ok',
    message: '审核计划已生成，可由 CLI 或 Web UI 直接消费。',
    gates,
    plan: { action, source: loaded.page, targetPage: targetPage ?? undefined, reviewPage, steps: buildWriteStepPlan(action, reviewPage, targetPage ?? undefined) },
  };
}

export function buildWriteStepPlan(action: ReviewAction, reviewPage: BuiltReviewPage, targetPage?: BuiltReviewPage): readonly ReviewStepPlan[] {
  switch (action.kind) {
    case 'keep':
    case 'promote':
    case 'merge':
      if (targetPage === undefined) return [];
      return [
        { kind: 'write_target', slug: targetPage.slug, page: targetPage },
        { kind: 'verify_target', slug: targetPage.slug },
        { kind: 'write_review', slug: reviewPage.slug, page: reviewPage },
        { kind: 'delete_source', slug: action.sourceSlug },
      ];
    case 'reject':
      return [
        { kind: 'write_review', slug: reviewPage.slug, page: reviewPage },
        { kind: 'delete_source', slug: action.sourceSlug },
      ];
    case 'needs_evidence':
    case 'repair':
      return [{ kind: 'write_review', slug: reviewPage.slug, page: reviewPage }, { kind: 'keep_source', slug: action.sourceSlug }];
    case 'cleanup':
      return [
        { kind: 'write_review', slug: reviewPage.slug, page: reviewPage },
        { kind: 'delete_source', slug: action.sourceSlug },
      ];
    default:
      return assertNever(action);
  }
}

function validateReviewDate(reviewDate: string): ReviewGateResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) {
    return { ok: false, code: 'review_date_required', message: 'reviewDate 必须由调用方注入，格式为 YYYY-MM-DD。' };
  }
  return { ok: true, code: 'ok', message: '审核日期已由调用方注入。' };
}

async function loadExistingTarget(deps: ReviewCoreDeps, action: ReviewAction): Promise<{ readonly page?: ParsedReviewPage; readonly gate: ReviewGateResult | null }> {
  switch (action.kind) {
    case 'merge': {
      const target = await deps.readPage(action.targetSlug);
      if (target === null) return { gate: { ok: false, code: 'merge_target_missing', message: 'merge 目标页不存在。' } };
      const parsed = parseReviewSourcePage(target);
      if (!parsed.gate.ok || !('page' in parsed)) return { gate: parsed.gate };
      return { page: parsed.page, gate: { ok: true, code: 'ok', message: 'merge 目标页存在。' } };
    }
    case 'reject':
    case 'needs_evidence':
    case 'keep':
    case 'promote':
    case 'repair':
    case 'cleanup':
      return { gate: null };
    default:
      return assertNever(action);
  }
}

function fail(gate: ReviewGateResult, gates: readonly ReviewGateResult[]): ReviewPlanResult {
  return { ok: false, code: gate.code, message: gate.message, gates };
}
