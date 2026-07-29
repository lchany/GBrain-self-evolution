import type { ReviewApplyResult, ReviewCoreDeps, ReviewStepReceipt, ReviewWritePlan } from './types.ts';

export async function applyReviewPlan(deps: ReviewCoreDeps, plan: ReviewWritePlan): Promise<ReviewApplyResult> {
  const receipts: ReviewStepReceipt[] = [];
  let targetWritten = false;
  let targetVerified = false;
  let reviewWritten = false;

  for (const step of plan.steps) {
    if (step.kind === 'delete_source' && !canDeleteSource(plan, targetWritten, targetVerified, reviewWritten)) {
      return { ok: false, code: 'apply_step_failed', message: '目标页、检索验证和审核记录未全部成功前，不能删除 inbox 草稿。', receipts };
    }
    const receipt = await runStep(deps, step);
    receipts.push(receipt);
    if (!receipt.ok) return { ok: false, code: 'apply_step_failed', message: receipt.message, receipts };
    if (step.kind === 'write_target') targetWritten = true;
    if (step.kind === 'verify_target') targetVerified = true;
    if (step.kind === 'write_review') reviewWritten = true;
  }
  return { ok: true, code: 'ok', message: '审核计划执行完成。', receipts };
}

async function runStep(deps: ReviewCoreDeps, step: ReviewWritePlan['steps'][number]): Promise<ReviewStepReceipt> {
  switch (step.kind) {
    case 'write_target':
    case 'write_review':
      if (step.page === undefined || deps.writePage === undefined) return missingRunner(step.kind);
      return deps.writePage(step.page);
    case 'verify_target':
      if (deps.verifyPage === undefined) return missingRunner(step.kind);
      return deps.verifyPage(step.slug);
    case 'delete_source':
      if (deps.deletePage === undefined) return missingRunner(step.kind);
      return deps.deletePage(step.slug);
    case 'keep_source':
      return { ok: true, code: 'kept_source', message: '保留 inbox 草稿。' };
  }
}

function canDeleteSource(plan: ReviewWritePlan, targetWritten: boolean, targetVerified: boolean, reviewWritten: boolean): boolean {
  if (plan.targetPage === undefined) return reviewWritten;
  return targetWritten && targetVerified && reviewWritten;
}

function missingRunner(kind: string): ReviewStepReceipt {
  return { ok: false, code: 'missing_runner', message: `缺少执行步骤 ${kind} 的注入函数。` };
}
