import type { ReviewApplyResult, ReviewPlanResult, ReviewSourcePage } from '../core/review/index.ts';
import type { Flags, RunDeps } from './gbrain-review.ts';

export function printList(pages: readonly ReviewSourcePage[], flags: Flags, write: (text: string) => void): void {
  if (flags.json) { printResult({ ok: true, items: pages }, write); return; }
  write('待审核草稿\n');
  pages.forEach((page, index) => write(`${index + 1}. ${page.slug}\t${page.type ?? '?'}\t${String(page.frontmatter?.verification ?? '?')}\t${page.title ?? ''}\n`));
}

export function printShow(page: ReviewSourcePage, flags: Flags, write: (text: string) => void): void {
  if (flags.json) { printResult({ ok: true, page }, write); return; }
  write(`Slug: ${page.slug}\n建议类型: ${page.type ?? page.frontmatter?.type ?? '?'}\n验证状态: ${String(page.frontmatter?.verification ?? '?')}\n风险检查:\n  请查看下方门禁计划输出。\n`);
}

export function printPlan(result: ReviewPlanResult, flags: Flags, write: (text: string) => void): void {
  if (flags.json) { printResult(result, write); return; }
  write(`审核计划\n结果: ${result.message}\n`);
  result.gates.forEach((gate) => write(`  ${gate.ok ? '✓' : '✗'} ${gate.code}: ${gate.message}\n`));
  result.plan?.steps.forEach((step) => write(`  - ${step.kind}: ${step.slug}\n`));
}

export function printApply(plan: ReviewPlanResult, applied: ReviewApplyResult, flags: Flags, write: (text: string) => void): void {
  const result = {
    ok: applied.ok,
    code: applied.code,
    message: applied.message,
    action: plan.plan?.action.kind,
    source_slug: plan.plan?.source.slug,
    target_slug: plan.plan?.targetPage?.slug,
    review_slug: plan.plan?.reviewPage.slug,
    receipts: applied.receipts,
  };
  if (flags.json) { printResult(result, write); return; }
  applied.receipts.forEach((receipt) => write(`${receipt.ok ? '✓' : '✗'} ${receipt.message}\n`));
  write(`完成: ${applied.message}\n`);
}

export function printResult(result: unknown, write: (text: string) => void): void {
  write(`${JSON.stringify(result, null, 2)}\n`);
}

export function fail(result: { readonly ok: false; readonly code: string; readonly message: string }, flags: Flags, deps: RunDeps): number {
  if (flags.json) printResult(result, deps.stdout);
  else deps.stderr(`${result.code}: ${result.message}\n`);
  return 1;
}

export function printHelp(write: (text: string) => void): void {
  write('Usage: gbrain review <list|show|plan|reject|needs-evidence|keep|promote|merge|verify|repair|cleanup>\n');
}
