import type { Page } from '../core/types.ts';
import { validateSlug } from '../core/utils.ts';
import { projectBrowserSafeText, REVIEW_ERROR_CODE } from '../core/review/browser-safe.ts';
import type {
  ReviewAction,
  ReviewApplyResult,
  ReviewCategory,
  ReviewPlanResult,
  ReviewRecommendation,
  ReviewWritePlan,
} from '../core/review/index.ts';
import type { WriterToolSession } from './gbrain-capture-writer.ts';

export type BatchReviewDecision = 'accept' | 'reject';

export type BatchClassificationRequest = {
  readonly sourceSlugs: readonly string[];
  readonly decision: BatchReviewDecision;
};

export type BatchClassificationResult =
  | { readonly sourceSlug: string; readonly status: 'succeeded'; readonly category: ReviewCategory }
  | { readonly sourceSlug: string; readonly status: 'failed'; readonly code: string; readonly message: string };

export type BatchClassificationResponse = {
  readonly ok: true;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BatchClassificationResult[];
};

export interface BatchClassificationDeps {
  readonly readPage: (sourceSlug: string) => Promise<Page | null>;
  readonly recommendationFor: (page: Page) => ReviewRecommendation | null | undefined;
  readonly actionFor: (category: ReviewCategory, page: Page) => ReviewAction | null;
  readonly plan: (action: ReviewAction) => Promise<ReviewPlanResult>;
  readonly apply: (writerSession: WriterToolSession, plan: ReviewWritePlan) => Promise<ReviewApplyResult>;
  readonly createWriterSession: () => Promise<WriterToolSession>;
  readonly logFailure: (stage: string, error: unknown) => void;
}

const BATCH_REVIEW_LIMIT = 50;

export function parseBatchClassificationBody(body: unknown): BatchClassificationRequest | null {
  if (!isPlainRecord(body)) return null;
  if (Object.keys(body).some((key) => key !== 'sourceSlugs' && key !== 'decision')) return null;
  if (body.decision !== 'accept' && body.decision !== 'reject') return null;
  if (!Array.isArray(body.sourceSlugs) || body.sourceSlugs.length === 0 || body.sourceSlugs.length > BATCH_REVIEW_LIMIT) return null;
  if (body.sourceSlugs.some((slug) => !isCanonicalInboxSlug(slug))) return null;
  return { sourceSlugs: [...new Set(body.sourceSlugs as string[])], decision: body.decision };
}

function isCanonicalInboxSlug(value: unknown): value is string {
  if (typeof value !== 'string' || value === 'inbox/' || !value.startsWith('inbox/')) return false;
  try {
    return validateSlug(value) === value;
  } catch {
    return false;
  }
}

export async function executeBatchClassification(
  request: BatchClassificationRequest,
  deps: BatchClassificationDeps,
): Promise<BatchClassificationResponse> {
  let writerSession: WriterToolSession;
  try {
    writerSession = await deps.createWriterSession();
  } catch (error) {
    deps.logFailure('classify_batch_writer', error);
    return buildBatchResponse(request.sourceSlugs.map((sourceSlug) => batchFailure(
      sourceSlug,
      'writer_unavailable',
      '审核写入服务暂时不可用，草稿已保留在收件箱。',
    )));
  }

  const results: BatchClassificationResult[] = [];
  try {
    for (const sourceSlug of request.sourceSlugs) {
      try {
        results.push(await executeBatchItem(request.decision, sourceSlug, writerSession, deps));
      } catch (error) {
        deps.logFailure('classify_batch_item', error);
        results.push(batchFailure(sourceSlug, REVIEW_ERROR_CODE, '审核操作失败，草稿已保留在收件箱。'));
      }
    }
  } finally {
    try {
      await writerSession.close();
    } catch (error) {
      deps.logFailure('classify_batch_close', error);
    }
  }
  return buildBatchResponse(results);
}

async function executeBatchItem(
  decision: BatchReviewDecision,
  sourceSlug: string,
  writerSession: WriterToolSession,
  deps: BatchClassificationDeps,
): Promise<BatchClassificationResult> {
  const page = await deps.readPage(sourceSlug);
  if (page === null || page.deleted_at || !page.slug.startsWith('inbox/')) {
    return batchFailure(sourceSlug, 'not_found', '找不到该 inbox 草稿，未执行审核。');
  }

  let category: ReviewCategory;
  if (decision === 'reject') {
    category = 'reject';
  } else {
    const recommendation = deps.recommendationFor(page);
    if (recommendation === undefined || recommendation === null) {
      return batchFailure(sourceSlug, 'recommendation_missing', '该草稿缺少有效的模型推荐，已保留在收件箱。');
    }
    category = recommendation.category;
  }

  const action = deps.actionFor(category, page);
  if (action === null) {
    return batchFailure(sourceSlug, 'invalid_category_target', '该草稿缺少有效项目绑定，已保留在收件箱。');
  }
  const planResult = await deps.plan(action);
  if (!planResult.ok || planResult.plan === undefined) {
    return batchFailure(sourceSlug, 'review_gate_failed', '审核门禁未通过，草稿已保留在收件箱。');
  }
  const applyResult = await deps.apply(writerSession, planResult.plan);
  if (!applyResult.ok) {
    return batchFailure(sourceSlug, 'review_write_failed', '审核写入失败，草稿已保留在收件箱。');
  }
  return { sourceSlug: projectBrowserSafeText(sourceSlug), status: 'succeeded', category };
}

function batchFailure(sourceSlug: string, code: string, message: string): BatchClassificationResult {
  return { sourceSlug: projectBrowserSafeText(sourceSlug), status: 'failed', code, message };
}

function buildBatchResponse(results: readonly BatchClassificationResult[]): BatchClassificationResponse {
  const succeeded = results.filter((result) => result.status === 'succeeded').length;
  return { ok: true, succeeded, failed: results.length - succeeded, results };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function renderBatchReviewControls(): string {
  return `<section class="batch-review-controls" aria-label="批量审核">
    <span id="batch-selected-count" class="muted">已选择 0 条</span>
    <button type="button" disabled data-batch-decision="accept">同意</button>
    <button type="button" disabled data-batch-decision="reject" class="batch-reject-button">拒绝并删除</button>
    <p id="batch-review-result" class="muted" role="status" aria-live="polite"></p>
  </section>`;
}

export function renderBatchReviewScript(): string {
  return `<script>
  (() => {
    const selectAll = document.getElementById('review-select-all');
    const selectedCount = document.getElementById('batch-selected-count');
    const resultMessage = document.getElementById('batch-review-result');
    const buttons = Array.from(document.querySelectorAll('[data-batch-decision]'));
    const boxes = () => Array.from(document.querySelectorAll('input[name="sourceSlugs"]'));
    const updateSelection = () => {
      const current = boxes();
      const selected = current.filter((box) => box.checked).length;
      selectedCount.textContent = '已选择 ' + selected + ' 条';
      buttons.forEach((button) => { button.disabled = selected === 0; });
      selectAll.checked = current.length > 0 && selected === current.length;
      selectAll.indeterminate = selected > 0 && selected < current.length;
    };
    selectAll.addEventListener('change', () => {
      boxes().forEach((box) => { box.checked = selectAll.checked; });
      updateSelection();
    });
    boxes().forEach((box) => box.addEventListener('change', updateSelection));
    buttons.forEach((button) => button.addEventListener('click', async () => {
      const sourceSlugs = boxes().filter((box) => box.checked).map((box) => box.value);
      if (sourceSlugs.length === 0) return;
      boxes().forEach((box) => { box.disabled = true; });
      buttons.forEach((item) => { item.disabled = true; });
      resultMessage.textContent = '正在处理 ' + sourceSlugs.length + ' 条草稿…';
      try {
        const response = await fetch('/admin/api/review/classify-batch', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceSlugs, decision: button.dataset.batchDecision })
        });
        if (!response.ok) throw new Error('batch request failed');
        const payload = await response.json();
        for (const item of payload.results) {
          if (item.status !== 'succeeded') continue;
          const box = boxes().find((candidate) => candidate.value === item.sourceSlug);
          if (box) box.closest('tr').remove();
        }
        const failedItems = payload.results.filter((item) => item.status === 'failed');
        resultMessage.textContent = '批量审核完成：成功 ' + payload.succeeded + ' 条，失败 ' + payload.failed + ' 条。'
          + (failedItems.length === 0 ? '' : ' ' + failedItems.map((item) => item.sourceSlug + '：' + item.message).join('；'));
      } catch {
        resultMessage.textContent = '批量审核请求失败，请刷新列表后重试。';
      } finally {
        boxes().forEach((box) => { box.checked = false; box.disabled = false; });
        updateSelection();
      }
    }));
    updateSelection();
  })();
  </script>`;
}
