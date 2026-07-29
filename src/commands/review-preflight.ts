import { browserSafeHtml as escapeHtml } from '../core/review/browser-safe.ts';
import type { ReviewAction, ReviewGateResult, ReviewPlanResult } from '../core/review/index.ts';

type PendingConfirmation = {
  readonly gateIndex: number;
  readonly gate: ReviewGateResult;
};

export function renderReviewPreflight(result: ReviewPlanResult, action: ReviewAction, pendingConfirmation?: PendingConfirmation): string {
  const target = targetDescription(action);
  const confirmation = confirmationDescription(action);
  const confirmationPending = pendingConfirmation !== undefined;
  const gateRows = result.gates.map((gate, index) => {
    if (pendingConfirmation?.gateIndex === index) {
      return `<tr><td>${escapeHtml(pendingConfirmation.gate.code)}</td><td>待确认</td><td>${escapeHtml(pendingConfirmation.gate.message)}</td></tr>`;
    }
    return `<tr><td>${escapeHtml(gate.code)}</td><td>${gate.ok ? '通过' : '失败'}</td><td>${escapeHtml(gate.message)}</td></tr>`;
  }).join('\n');
  const impact = confirmationPending
    ? '待输入确认短语后，系统会重新运行全部门禁并生成执行计划。'
    : result.plan === undefined
    ? '门禁未通过，系统不会创建、修改或删除任何页面。'
    : result.plan.steps.map((step) => `${step.kind}: ${step.slug}`).join('；');
  const evidenceGap = result.gates.some((gate) => gate.code === 'unverified_promote' || gate.code === 'missing_source_refs')
    ? '存在证据缺口，不能继续当前操作。'
    : '未发现阻断当前操作的证据缺口。';
  const sensitiveCheck = result.gates.find((gate) => gate.code === 'unsafe_content');
  const duplicateCheck = result.gates.find((gate) => gate.code === 'duplicate_target');

  return `<h1>审核预检</h1>
    <p class="muted">这是只读预览，不会授权或执行写入。最终确认会重新解析短语并重新运行全部门禁。</p>
    <table class="review-table"><tbody>
      <tr><th>选择的操作</th><td>${escapeHtml(action.kind)}</td></tr>
      <tr><th>来源</th><td>${escapeHtml(action.sourceSlug)}</td></tr>
      <tr><th>目标</th><td>${escapeHtml(target)}</td></tr>
      <tr><th>影响</th><td>${escapeHtml(impact)}</td></tr>
      <tr><th>证据缺口</th><td>${escapeHtml(evidenceGap)}</td></tr>
      <tr><th>敏感内容检查</th><td>${escapeHtml(sensitiveCheck?.message ?? '未发现禁止内容。')}</td></tr>
      <tr><th>重复检查</th><td>${escapeHtml(duplicateCheck?.message ?? '未发现精确重复目标。')}</td></tr>
      <tr><th>确认要求</th><td>${confirmation}</td></tr>
    </tbody></table>
    <h2>门禁结果</h2>
    <table class="review-table"><thead><tr><th>门禁码</th><th>结果</th><th>说明</th></tr></thead><tbody>${gateRows}</tbody></table>
    ${renderConfirmForm(result, action)}`;
}

function targetDescription(action: ReviewAction): string {
  switch (action.kind) {
    case 'keep':
    case 'promote':
    case 'merge':
      return `${action.targetSlug} (${action.targetType})`;
    case 'reject':
    case 'needs_evidence':
    case 'repair':
    case 'cleanup':
      return '不需要目标页';
  }
}

function confirmationDescription(action: ReviewAction): string {
  switch (action.kind) {
    case 'promote':
      return `待输入确认短语：<code>PROMOTE ${escapeHtml(action.targetSlug)}</code>`;
    case 'merge':
      return `待输入确认短语：<code>MERGE ${escapeHtml(action.targetSlug)}</code>`;
    case 'reject':
    case 'needs_evidence':
    case 'keep':
    case 'repair':
    case 'cleanup':
      return '无需输入确认短语';
  }
}

function renderConfirmForm(result: ReviewPlanResult, action: ReviewAction): string {
  if (!result.ok && result.code !== 'promote_confirmation_required') return '<p class="warn">门禁未通过，提交按钮已禁用。请修正上述问题后重试。</p>';
  const actionFields = `<input type="hidden" name="sourceSlug" value="${escapeHtml(action.sourceSlug)}" />
    <input type="hidden" name="action" value="${escapeHtml(action.kind)}" />`;
  switch (action.kind) {
    case 'promote':
    case 'merge':
      return `<form method="post" action="/admin/api/review/confirm">${actionFields}
        <input type="hidden" name="target" value="${escapeHtml(action.targetSlug)}" />
        <input type="hidden" name="target_type" value="${escapeHtml(action.targetType)}" />
        <label>确认短语：<input name="confirmation" type="text" required /></label>
        <button type="submit">确认执行</button>
      </form>`;
    case 'keep':
      return `<form method="post" action="/admin/api/review/confirm">${actionFields}
        <input type="hidden" name="target" value="${escapeHtml(action.targetSlug)}" />
        <input type="hidden" name="target_type" value="${escapeHtml(action.targetType)}" />
        <button type="submit">确认执行</button>
      </form>`;
    case 'reject':
    case 'needs_evidence':
      return `<form method="post" action="/admin/api/review/confirm">${actionFields}
        <label>审核说明：<textarea name="reviewNotes" required></textarea></label>
        <button type="submit">确认执行</button>
      </form>`;
    case 'repair':
    case 'cleanup':
      return `<form method="post" action="/admin/api/review/confirm">${actionFields}<button type="submit">确认执行</button></form>`;
  }
}
