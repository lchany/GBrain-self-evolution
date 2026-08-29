/**
 * GBrain Web UI review routes (Todo 7).
 *
 * Server-side adapter over the shared review core (`src/core/review/`).
 * Adds Inbox/Detail/Plan/Confirm/History pages and JSON API endpoints to
 * the existing admin surface in serve-http.ts.
 *
 * Invariants:
 * - The browser NEVER sees writer token, client secret, or bearer token.
 *   All write operations are executed server-side via the injected writer
 *   caller; only structured results reach the browser.
 * - Read-only browsing uses the same `requireAdmin` cookie auth as the
 *   existing admin dashboard. Review write actions additionally require
 *   the writer credential server-side; browsing stays read-only.
 * - Gate logic is NOT reimplemented here. `planReview` / `applyReviewPlan`
 *   are consumed unchanged through injected `ReviewCoreDeps`.
 * - All user-facing text is Chinese; slugs and field names stay English.
 */

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import type { Page } from '../core/types.ts';
import { chat, getChatModel, isAvailable } from '../core/ai/gateway.ts';
import { browserSafeHtml as escapeHtml, browserSafeReviewError, projectBrowserSafeText, REVIEW_ERROR_TEXT, REVIEW_ERROR_CODE } from '../core/review/browser-safe.ts';
import {
  REVIEW_ACTION_CATALOG,
  type ReviewActionCatalogEntry,
} from '../core/review/action-catalog.ts';
import {
  planReview,
  applyReviewPlan,
  type ReviewAction,
  type ReviewCoreDeps,
  type ReviewPlanResult,
  type ReviewApplyResult,
  type ReviewSourcePage,
  type BuiltReviewPage,
  type ReviewStepReceipt,
  type ReviewTargetType,
  REVIEW_TARGET_PREFIXES,
  REVIEW_TARGET_TYPES,
  REVIEW_CATEGORY_LABELS,
  REVIEW_CATEGORIES,
  ReviewRecommendationCache,
  buildClassificationAction,
  parseModelRecommendationJson,
  parseReviewCategory,
  parseReviewRecommendation,
  recommendationCacheKey,
  type ReviewCategory,
  type ReviewRecommendation,
  type ReviewRecommendationInput,
  type ReviewRecommendationProvider,
} from '../core/review/index.ts';
import {
  createLocalWriterSessionFactory,
  type WriterSessionFactory,
  type WriterToolSession,
} from './gbrain-capture-writer.ts';
import {
  executeBatchClassification,
  parseBatchClassificationBody,
  renderBatchReviewControls,
  renderBatchReviewScript,
} from './serve-http-review-batch.ts';
import { renderReviewPreflight } from './review-preflight.ts';
import {
  hasAttestedSource,
  normalizeWebAction,
  requiredConfirmation,
  withHumanConfirmation,
} from './review-confirmation.ts';

/** Stale threshold: drafts older than this many days are flagged stale. */
const STALE_DAYS = 14;

function logReviewFailure(stage: string, error: unknown): void {
  const rawType = error instanceof Error ? error.name : '';
  const errorType = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType)
    ? rawType
    : 'UnknownError';
  console.error(`[review] stage=${stage} error_type=${errorType}`);
}

export interface MountReviewRoutesOptions {
  adminOrigin?: URL;
  writerSessionFactory?: WriterSessionFactory;
  writerEnvPath?: string;
  writerMcpUrl?: URL;
  issuerUrl?: URL;
  /** Inject reviewDate for tests. Defaults to today's YYYY-MM-DD. */
  reviewDate?: () => string;
  reviewSourceId?: string;
  /** Injected for hermetic tests. Production uses the configured chat model. */
  recommendationProvider?: ReviewRecommendationProvider;
}

/**
 * Mount review API + HTML routes onto the Express app. Must be called BEFORE
 * the admin SPA fallback so `/admin/review/*` and `/admin/api/review/*` are
 * matched first.
 */
export function mountReviewRoutes(
  app: Express,
  engine: BrainEngine,
  requireAdmin: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  options: MountReviewRoutesOptions = {},
): void {
  const writerSessionFactory = options.writerSessionFactory ?? createLocalWriterSessionFactory(options.writerEnvPath);
  const expectedWriterMcpUrl = options.writerMcpUrl?.toString()
    ?? (options.issuerUrl === undefined ? null : new URL('/mcp', options.issuerUrl).toString());
  // CSRF gate: the only trusted origin is derived from the server-configured
  // issuerUrl. It is NEVER derived from Host / X-Forwarded-* request headers.
  const expectedAdminOrigin = options.adminOrigin?.origin ?? options.issuerUrl?.origin ?? null;
  const getReviewDate = options.reviewDate ?? (() => new Date().toISOString().slice(0, 10));
  const reviewSourceId = options.reviewSourceId ?? 'default';
  const recommendationProvider = options.recommendationProvider ?? defaultReviewRecommendationProvider;
  const recommendationCache = new ReviewRecommendationCache(256);
  const recommendationInFlight = new Map<string, Promise<ReviewRecommendation>>();

  // --- Helpers: build ReviewCoreDeps from engine + writer caller ---

  async function readPage(slug: string): Promise<ReviewSourcePage | null> {
    const page = await engine.getPage(slug, { sourceId: reviewSourceId });
    if (page === null) return null;
    return pageToReviewSource(page);
  }

  async function searchDuplicates(request: {
    readonly sourceSlug: string;
    readonly targetSlug: string;
    readonly title: string;
    readonly targetType: ReviewTargetType;
  }): Promise<readonly { readonly slug: string; readonly title: string; readonly score?: number }[]> {
    const exactTarget = await engine.getPage(request.targetSlug, { sourceId: reviewSourceId });
    const prefix = request.targetSlug.split('/').slice(0, -1).join('/') + '/';
    const pages = await engine.listPages({ slugPrefix: prefix, limit: 50, sourceId: reviewSourceId });
    const candidates = pages
      .filter((p) => !p.deleted_at)
      .map((p) => ({ slug: p.slug, title: p.title }));
    if (exactTarget !== null && !candidates.some((candidate) => candidate.slug === exactTarget.slug)) {
      return [{ slug: exactTarget.slug, title: exactTarget.title }, ...candidates];
    }
    return candidates;
  }

  async function writePage(writerSession: WriterToolSession, page: BuiltReviewPage): Promise<ReviewStepReceipt> {
    try {
      const result = await writerSession.callTool('put_page', {
        slug: page.slug,
        content: page.markdown,
      });
      return receiptFromToolResult(result, 'write_target');
    } catch (e) {
      return { ok: false, code: 'write_failed', message: errorMessage(e) };
    }
  }

  async function verifyPage(slug: string): Promise<ReviewStepReceipt> {
    try {
      const page = await engine.getPage(slug, { sourceId: reviewSourceId });
      if (page === null) {
        return { ok: false, code: 'verify_failed', message: `检索验证失败：找不到 ${slug}。` };
      }
      return { ok: true, code: 'verified', message: `检索验证通过：${slug} 可读。` };
    } catch (e) {
      return { ok: false, code: 'verify_failed', message: errorMessage(e) };
    }
  }

  async function deletePage(writerSession: WriterToolSession, slug: string): Promise<ReviewStepReceipt> {
    try {
      const result = await writerSession.callTool('delete_page', { slug });
      return receiptFromToolResult(result, 'delete_source');
    } catch (e) {
      return { ok: false, code: 'delete_failed', message: errorMessage(e) };
    }
  }

  function buildDeps(writerSession?: WriterToolSession): ReviewCoreDeps {
    return {
      readPage,
      searchDuplicates,
      verifyPage,
      ...(writerSession === undefined ? {} : {
        writePage: (page) => writePage(writerSession, page),
        deletePage: (slug) => deletePage(writerSession, slug),
      }),
    };
  }

  async function createAttestedWriterSession(): Promise<WriterToolSession> {
    if (expectedWriterMcpUrl === null) throw new Error('missing review writer issuer');
    const session = await writerSessionFactory(expectedWriterMcpUrl);
    try {
      const identity = await session.callTool('whoami', {});
      if (!hasAttestedSource(identity, reviewSourceId)) throw new Error('writer source mismatch');
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  function reviewParserError(_error: unknown, _req: Request, res: Response, _next: NextFunction): void {
    const safeError = browserSafeReviewError(_error);
    res.status(400).json({ error: safeError.code, message: safeError.message });
  }

  const reviewUrlEncodedParser = express.urlencoded({
    extended: false,
    verify(_request, _response, body) {
      decodeURIComponent(body.toString('utf8').replace(/\+/g, ' '));
    },
  });

  function wantsHtml(req: Request): boolean {
    const accept = req.headers.accept;
    return typeof accept === 'string' && accept.includes('text/html');
  }

  function respondSimpleError(req: Request, res: Response, status: number, payload: Record<string, unknown>): void {
    if (wantsHtml(req)) {
      const message = typeof payload.message === 'string' ? payload.message : REVIEW_ERROR_TEXT;
      res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell('审核请求被拒绝', `<h1>审核请求被拒绝</h1><p>${escapeHtml(message)}</p><p><a href="/admin/review">返回 Inbox</a></p>`));
      return;
    }
    res.status(status).json(payload);
  }

  function respondSummary(req: Request, res: Response, status: number, summary: ReviewExecutionSummary): void {
    if (wantsHtml(req)) {
      res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell(summary.ok ? '审核结果' : '审核结果（失败）', renderExecutionSummaryHtml(summary)));
      return;
    }
    res.status(status).json(summary);
  }

  function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
    if (expectedAdminOrigin === null || !isAllowedOrigin(req.headers.origin, expectedAdminOrigin)) {
      respondSimpleError(req, res, 403, { error: 'forbidden', message: '请求来源不被允许。' });
      return;
    }
    next();
  }

  // --- API: GET /admin/api/review/inbox ---

  app.get('/admin/api/review/inbox', requireAdmin, async (req: Request, res: Response) => {
    try {
      const typeFilter = typeof req.query.type === 'string' ? req.query.type : undefined;
      const verificationFilter = typeof req.query.verification === 'string' ? req.query.verification : undefined;
      const staleOnly = req.query.stale === 'true';
      const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;

      const pages = await engine.listPages({ slugPrefix: 'inbox/', limit: 100, sort: 'updated_desc', sourceId: reviewSourceId });
      const now = Date.now();
      const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

      const drafts = pages
        .filter((p) => !p.deleted_at)
        .filter((p) => typeFilter === undefined || p.type === typeFilter)
        .filter((p) => verificationFilter === undefined || p.frontmatter.verification === verificationFilter)
        .filter((p) => projectId === undefined || p.frontmatter.project_id === projectId)
        .filter((p) => !staleOnly || (now - p.updated_at.getTime()) > staleMs)
        .map((p) => {
          const projectId = projectBrowserSafeText(p.frontmatter.project_id);
          return {
            slug: projectBrowserSafeText(p.slug),
            type: projectBrowserSafeText(p.type),
            title: projectBrowserSafeText(p.title),
            verification: projectBrowserSafeText(p.frontmatter.verification ?? 'unverified'),
            status: projectBrowserSafeText(p.frontmatter.status ?? 'draft'),
            updated_at: p.updated_at.toISOString(),
            stale: (now - p.updated_at.getTime()) > staleMs,
            ...(projectId.length === 0 ? {} : { project_id: projectId }),
          };
        });

      res.json({ drafts });
    } catch (error) {
      logReviewFailure('list_inbox', error);
      const safeError = browserSafeReviewError(error);
      res.status(503).json({ error: safeError.code, message: safeError.message });
    }
  });

  app.get('/admin/api/review/targets', requireAdmin, async (req: Request, res: Response) => {
    const targetType = parseReviewTargetType(req.query.type);
    const limit = parseTargetSearchLimit(req.query.limit);
    if ((req.query.type !== undefined && targetType === null) || limit === null) {
      res.status(400).json({ error: REVIEW_ERROR_CODE, message: REVIEW_ERROR_TEXT });
      return;
    }
    try {
      const targets = await searchReviewTargets(engine, reviewSourceId, {
        query: typeof req.query.q === 'string' ? req.query.q : '',
        targetType,
        limit,
      });
      res.json({ targets });
    } catch (error) {
      logReviewFailure('search_targets', error);
      const safeError = browserSafeReviewError(error);
      res.status(503).json({ error: safeError.code, message: safeError.message });
    }
  });

  // --- API: GET /admin/api/review/inbox/:slug ---

  app.get('/admin/api/review/inbox/{*slug}', requireAdmin, async (req: Request, res: Response) => {
    try {
      const slug = decodeSlugParam(req.params.slug);
      const page = await engine.getPage(slug, { sourceId: reviewSourceId });
      if (page === null) {
        res.status(404).json({ error: 'not_found', message: '找不到该 inbox 草稿。' });
        return;
      }
      res.json(projectDetailJson(page));
    } catch (error) {
      logReviewFailure('get_draft', error);
      res.status(503).json({ error: REVIEW_ERROR_CODE, message: REVIEW_ERROR_TEXT });
    }
  });

  // --- API: POST /admin/api/review/recommendation ---

  app.post('/admin/api/review/recommendation', requireAdmin, requireSameOrigin, express.json(), reviewParserError, async (req: Request, res: Response) => {
    const sourceSlug = parseExactSourceBody(req.body);
    if (sourceSlug === null) {
      res.status(400).json({ error: 'invalid_request', message: '请求只能包含 sourceSlug。' });
      return;
    }
    try {
      const page = await engine.getPage(sourceSlug, { sourceId: reviewSourceId });
      if (page === null || page.deleted_at || !page.slug.startsWith('inbox/')) {
        res.status(404).json({ error: 'not_found', message: '找不到该 inbox 草稿。' });
        return;
      }
      const captured = parseReviewRecommendation(page.frontmatter.review_recommendation, page);
      if (captured !== null) {
        res.json({ recommendation: projectRecommendation(captured) });
        return;
      }

      const key = recommendationCacheKey(page);
      const cached = recommendationCache.get(key);
      if (cached !== undefined) {
        res.json({ recommendation: projectRecommendation(cached) });
        return;
      }
      if (recommendationInFlight.size >= 32 && !recommendationInFlight.has(key)) {
        res.status(503).json({ error: 'recommendation_busy', message: '模型建议服务繁忙，请稍后刷新。' });
        return;
      }
      let pending = recommendationInFlight.get(key);
      if (pending === undefined) {
        pending = recommendationProvider(recommendationInput(page));
        recommendationInFlight.set(key, pending);
      }
      try {
        const recommendation = parseReviewRecommendation(await pending, page);
        if (recommendation === null) throw new Error('invalid recommendation');
        recommendationCache.set(key, recommendation);
        res.json({ recommendation: projectRecommendation(recommendation) });
      } finally {
        recommendationInFlight.delete(key);
      }
    } catch (error) {
      logReviewFailure('recommendation', error);
      res.status(503).json({ error: 'recommendation_unavailable', message: '暂时无法生成模型建议，请稍后刷新。' });
    }
  });

  // --- API: POST /admin/api/review/classify ---

  app.post('/admin/api/review/classify', requireAdmin, requireSameOrigin, express.json(), reviewParserError, reviewUrlEncodedParser, reviewParserError, async (req: Request, res: Response) => {
    const request = parseClassificationBody(req.body);
    if (request === null) {
      respondSimpleError(req, res, 400, { error: 'invalid_request', message: '请求只能包含 sourceSlug 和 category。' });
      return;
    }
    try {
      const page = await engine.getPage(request.sourceSlug, { sourceId: reviewSourceId });
      if (page === null || page.deleted_at || !page.slug.startsWith('inbox/')) {
        respondSimpleError(req, res, 404, { error: 'not_found', message: '找不到该 inbox 草稿。' });
        return;
      }
      const availableRecommendation = parseReviewRecommendation(page.frontmatter.review_recommendation, page)
        ?? recommendationCache.get(recommendationCacheKey(page));
      if (availableRecommendation === undefined || availableRecommendation === null) {
        respondSimpleError(req, res, 409, {
          error: 'model_recommendation_required',
          message: '请等待大模型给出分类建议后再确认。',
        });
        return;
      }
      const action = buildClassificationAction(request.category, pageToReviewSource(page));
      if (action === null) {
        respondSimpleError(req, res, 400, { error: 'invalid_category_target', message: '该草稿未绑定项目，无法归为项目经验。' });
        return;
      }
      const writerSession = await createAttestedWriterSession();
      try {
        const planResult = await planReview(buildDeps(), { action, reviewDate: getReviewDate() });
        if (!planResult.ok || planResult.plan === undefined) {
          respondSummary(req, res, 409, buildGateFailureSummary(planResult, action));
          return;
        }
        const applyResult = await applyReviewPlan(buildDeps(writerSession), planResult.plan);
        respondSummary(req, res, applyResult.ok ? 200 : 503, buildExecutionSummary(planResult, applyResult));
      } finally {
        await writerSession.close();
      }
    } catch (error) {
      logReviewFailure('classify', error);
      respondSimpleError(req, res, 503, { error: REVIEW_ERROR_CODE, message: REVIEW_ERROR_TEXT });
    }
  });

  // --- API: POST /admin/api/review/classify-batch ---

  app.post('/admin/api/review/classify-batch', requireAdmin, requireSameOrigin, express.json(), reviewParserError, async (req: Request, res: Response) => {
    const request = parseBatchClassificationBody(req.body);
    if (request === null) {
      res.status(400).json({ error: 'invalid_request', message: '请求只能包含 1 至 50 个 inbox 草稿和批量决定。' });
      return;
    }

    res.json(await executeBatchClassification(request, {
      readPage: (sourceSlug) => engine.getPage(sourceSlug, { sourceId: reviewSourceId }),
      recommendationFor: (page) => parseReviewRecommendation(page.frontmatter.review_recommendation, page)
        ?? recommendationCache.get(recommendationCacheKey(page)),
      actionFor: (category, page) => buildClassificationAction(category, pageToReviewSource(page)),
      plan: (action) => planReview(buildDeps(), { action, reviewDate: getReviewDate() }),
      apply: (writerSession, plan) => applyReviewPlan(buildDeps(writerSession), plan),
      createWriterSession: createAttestedWriterSession,
      logFailure: logReviewFailure,
    }));
  });

  // --- API: POST /admin/api/review/plan ---

  app.post('/admin/api/review/plan', requireAdmin, requireSameOrigin, express.json(), reviewParserError, reviewUrlEncodedParser, reviewParserError, async (req: Request, res: Response) => {
    try {
      const action = parseActionBody(req.body);
      if (action === null) {
        res.status(400).json({ error: 'invalid_request', message: '缺少有效的 action 参数。' });
        return;
      }
      if (!hasRequiredReviewNotes(action)) {
        respondSimpleError(req, res, 400, { error: 'invalid_request', message: '拒绝或补证据必须填写审核说明。' });
        return;
      }
      const result = await planReview(buildDeps(), { action, reviewDate: getReviewDate() });
      res.json(planResultToJson(result));
    } catch (error) {
      logReviewFailure('plan', error);
      const safeError = browserSafeReviewError(error);
      res.status(503).json({ error: safeError.code, message: safeError.message });
    }
  });

  // --- API: POST /admin/api/review/confirm ---

  app.post('/admin/api/review/confirm', requireAdmin, requireSameOrigin, express.json(), reviewParserError, reviewUrlEncodedParser, reviewParserError, async (req: Request, res: Response) => {
    try {
      let action = parseActionBody(req.body);
      if (action === null) {
        respondSimpleError(req, res, 400, { error: 'invalid_request', message: '缺少有效的 action 参数。' });
        return;
      }
      if (!hasRequiredReviewNotes(action)) {
        respondSimpleError(req, res, 400, { error: 'invalid_request', message: '拒绝或补证据必须填写审核说明。' });
        return;
      }
      const confirmation = typeof req.body.confirmation === 'string' ? req.body.confirmation : '';

      const expected = requiredConfirmation(action);
      if (expected !== null) {
        if (confirmation !== expected) {
          respondSimpleError(req, res, 400, {
            error: 'confirmation_required',
            message: '必须输入确认短语后才能执行该操作。',
          });
          return;
        }
        action = withHumanConfirmation(action);
      }

      const writerSession = await createAttestedWriterSession();
      try {
        const planResult = await planReview(buildDeps(), { action, reviewDate: getReviewDate() });
        if (!planResult.ok || planResult.plan === undefined) {
          respondSummary(req, res, 409, buildGateFailureSummary(planResult, action));
          return;
        }
        const applyResult = await applyReviewPlan(buildDeps(writerSession), planResult.plan);
        respondSummary(req, res, applyResult.ok ? 200 : 503, buildExecutionSummary(planResult, applyResult));
      } finally {
        await writerSession.close();
      }
    } catch (error) {
      logReviewFailure('confirm', error);
      respondSimpleError(req, res, 503, { error: REVIEW_ERROR_CODE, message: REVIEW_ERROR_TEXT });
    }
  });

  // --- API: GET /admin/api/review/history ---

  app.get('/admin/api/review/history', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const pages = await engine.listPages({ slugPrefix: 'decisions/reviews/', limit: 100, sort: 'updated_desc', sourceId: reviewSourceId });
      const reviews = pages
        .filter((p) => !p.deleted_at)
        .map((p) => historyReviewJson(p));
      res.json({ reviews });
    } catch (error) {
      logReviewFailure('history', error);
      const safeError = browserSafeReviewError(error);
      res.status(503).json({ error: safeError.code, message: safeError.message });
    }
  });

  // --- HTML pages ---

  app.get('/admin/review', requireAdmin, async (req: Request, res: Response) => {
    try {
      const typeFilter = typeof req.query.type === 'string' && req.query.type.length > 0 ? req.query.type : undefined;
      const verificationFilter = typeof req.query.verification === 'string' && req.query.verification.length > 0 ? req.query.verification : undefined;
      const staleOnly = req.query.stale === 'true';
      const projectId = typeof req.query.project_id === 'string' && req.query.project_id.length > 0 ? req.query.project_id : undefined;

      const pages = await engine.listPages({ slugPrefix: 'inbox/', limit: 100, sort: 'updated_desc', sourceId: reviewSourceId });
      const now = Date.now();
      const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

      const drafts = pages
        .filter((p) => !p.deleted_at)
        .filter((p) => typeFilter === undefined || p.type === typeFilter)
        .filter((p) => verificationFilter === undefined || p.frontmatter.verification === verificationFilter)
        .filter((p) => projectId === undefined || p.frontmatter.project_id === projectId)
        .filter((p) => !staleOnly || (now - p.updated_at.getTime()) > staleMs);

      const filterBar = renderFilterBar(typeFilter, verificationFilter, staleOnly, projectId);
      const bodyContent = drafts.length === 0
        ? renderEmptyState(typeFilter, verificationFilter, staleOnly, projectId)
        : `${renderBatchReviewControls()}
        <table class="review-table" id="review-inbox-table">
          <thead><tr><th class="review-select-cell"><input id="review-select-all" type="checkbox" aria-label="全选当前页" /></th><th>标题</th><th>建议分类</th><th>验证</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>${drafts.map((p) => renderDraftRow(p)).join('\n')}</tbody>
        </table>
        ${renderBatchReviewScript()}`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell('Inbox 草稿审核', `
        <h1>Inbox 草稿审核</h1>
        <p class="muted">选择一条草稿，只需确认经验分类；“拒绝并删除”也是一个分类。</p>
        ${filterBar}
        ${bodyContent}
        <p><a href="/admin/review/history">查看审核历史</a></p>
      `));
    } catch (error) {
      logReviewFailure('render_inbox', error);
      res.status(503).send(renderShell('审核列表不可用', `<p>${REVIEW_ERROR_TEXT}</p>`));
    }
  });

  app.get('/admin/review/detail/:slug', requireAdmin, async (req: Request, res: Response) => {
    try {
      const slug = decodeSlugParam(req.params.slug);
      const page = await engine.getPage(slug, { sourceId: reviewSourceId });
      if (page === null) {
        res.status(404).send(renderShell('未找到', `<p>找不到 ${escapeHtml(slug)}。</p>`));
        return;
      }
      const summaryHtml = renderDetailSummary(page);
      const recommendation = parseReviewRecommendation(page.frontmatter.review_recommendation, page);
      const classificationHtml = renderClassificationReview(page, recommendation);
      const expandableHtml = renderDetailExpandable(page);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell(`草稿详情：${escapeHtml(slug)}`, `
        <div class="review-container">
          <div class="review-sidebar">
            ${summaryHtml}
          </div>
          <div class="review-main">
            <h1>确认经验分类</h1>
            ${classificationHtml}
            ${expandableHtml}
            <p><a href="/admin/review">返回列表</a></p>
          </div>
        </div>
      `));
    } catch (error) {
      logReviewFailure('render_detail', error);
      res.status(503).send(renderShell('错误', `<p>${REVIEW_ERROR_TEXT}</p>`));
    }
  });

  app.get('/admin/review/plan/:slug', requireAdmin, async (req: Request, res: Response) => {
    try {
      const slug = decodeSlugParam(req.params.slug);
      const actionKind = typeof req.query.action === 'string' ? req.query.action : 'keep';
      const targetSlug = typeof req.query.target === 'string' ? req.query.target : '';
      const targetType = parseReviewTargetType(req.query.target_type);
      const reviewNotes = parseReviewNotes(req.query.reviewNotes ?? req.query.reason);
      if (requiresReviewNotes(actionKind) && reviewNotes === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderShell('填写审核说明', renderReviewNotesForm(slug, actionKind)));
        return;
      }
      if (requiresReviewTarget(actionKind) && targetType === null) {
        if (req.query.target_type !== undefined || targetSlug.length > 0) {
          res.status(400).send(renderShell('参数错误', `<p>${REVIEW_ERROR_TEXT}</p>`));
          return;
        }
        const selector = await renderTargetSelector(engine, reviewSourceId, slug, actionKind, targetType, typeof req.query.q === 'string' ? req.query.q : '');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderShell('选择审核目标', selector));
        return;
      }
      if (requiresReviewTarget(actionKind) && targetSlug.length === 0) {
        const selector = await renderTargetSelector(engine, reviewSourceId, slug, actionKind, targetType, typeof req.query.q === 'string' ? req.query.q : '');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderShell('选择审核目标', selector));
        return;
      }

      const action = buildAction(actionKind, slug, targetSlug, targetType ?? 'incident', false, reviewNotes);
      if (action === null) {
        res.status(400).send(renderShell('参数错误', '<p>无效的 action 参数。</p>'));
        return;
      }
      const confirmationPlan = await planReview(buildDeps(), { action, reviewDate: getReviewDate() });
      const confirmationGate = confirmationPlan.gates.at(-1);
      const hasPendingConfirmation = confirmationGate?.code === 'promote_confirmation_required';
      const result = hasPendingConfirmation
        ? await planReview(buildDeps(), { action: withHumanConfirmation(action), reviewDate: getReviewDate() })
        : confirmationPlan;
      const pendingConfirmation = hasPendingConfirmation && confirmationGate !== undefined
        ? { gateIndex: confirmationPlan.gates.length - 1, gate: confirmationGate }
        : undefined;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell('审核计划', `
        ${renderReviewPreflight(result, action, pendingConfirmation)}
        <p><a href="/admin/review/detail/${encodeURIComponent(slug)}">返回详情</a> | <a href="/admin/review">返回列表</a></p>
      `));
    } catch (error) {
      logReviewFailure('render_plan', error);
      res.status(503).send(renderShell('错误', `<p>${REVIEW_ERROR_TEXT}</p>`));
    }
  });

  app.get('/admin/review/history', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const pages = await engine.listPages({ slugPrefix: 'decisions/reviews/', limit: 100, sort: 'updated_desc', sourceId: reviewSourceId });
      const rows = pages
        .filter((p) => !p.deleted_at)
        .map((p) => {
          const review = historyReviewJson(p);
          return `<tr>
  <td data-label="审核记录">${escapeHtml(review.slug)}</td>
  <td data-label="操作">${escapeHtml(review.action_label)}</td>
  <td data-label="来源">${escapeHtml(review.source)}</td>
  <td data-label="目标">${escapeHtml(review.target === null ? '无' : review.target)}</td>
  <td data-label="状态">${escapeHtml(review.status)}</td>
  <td data-label="日期">${escapeHtml(review.date)}</td>
</tr>`;
        }).join('\n');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell('审核历史', `
        <h1>审核历史</h1>
        <p>读取 decisions/reviews/* 审核记录，展示操作含义、来源、目标、状态与日期。</p>
        <table class="review-table">
          <thead><tr><th>审核记录</th><th>操作</th><th>来源</th><th>目标</th><th>状态</th><th>日期</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">暂无审核记录。</td></tr>'}</tbody>
        </table>
        <p><a href="/admin/review">返回 Inbox</a></p>
      `));
    } catch (error) {
      logReviewFailure('render_history', error);
      res.status(503).send(renderShell('错误', `<p>${REVIEW_ERROR_TEXT}</p>`));
    }
  });
}

// --- Pure helpers (exported for testing) ---

export function pageToReviewSource(page: Page): ReviewSourcePage {
  return {
    slug: page.slug,
    type: page.type,
    title: page.title,
    tags: Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags as string[] : [],
    compiledTruth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter,
  };
}

export function parseClassificationBody(body: unknown): { readonly sourceSlug: string; readonly category: ReviewCategory } | null {
  if (!isPlainRecord(body)) return null;
  if (Object.keys(body).some((key) => key !== 'sourceSlug' && key !== 'category')) return null;
  if (typeof body.sourceSlug !== 'string' || !body.sourceSlug.startsWith('inbox/')) return null;
  const category = parseReviewCategory(body.category);
  return category === null ? null : { sourceSlug: body.sourceSlug, category };
}

function parseExactSourceBody(body: unknown): string | null {
  if (!isPlainRecord(body) || Object.keys(body).some((key) => key !== 'sourceSlug')) return null;
  return typeof body.sourceSlug === 'string' && body.sourceSlug.startsWith('inbox/') ? body.sourceSlug : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function defaultReviewRecommendationProvider(input: ReviewRecommendationInput): Promise<ReviewRecommendation> {
  if (!isAvailable('chat')) throw new Error('chat model unavailable');
  const result = await chat({
    model: getChatModel(),
    system: [
      '你是 GBrain 经验审核分类助手。根据脱敏后的草稿摘要给出真实的分类建议。',
      '只输出单行 JSON，不要 Markdown。字段必须且只能是 category、scenario、reason、generated_by。',
      'category 只能是 project、knowledge、runbook、incident、reject。',
      'scenario 和 reason 使用清晰中文，各不超过 500 字。generated_by 固定为 model。',
      '只有存在 projectId 时才能选择 project。信息明显不可复用或不应归档时选择 reject。',
    ].join('\n'),
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    maxTokens: 320,
    abortSignal: AbortSignal.timeout(20_000),
    cacheSystem: true,
  });
  const recommendation = parseModelRecommendationJson(result.text);
  if (recommendation === null) throw new Error('invalid model recommendation');
  return recommendation;
}

function recommendationInput(page: Page): ReviewRecommendationInput {
  return {
    title: projectBrowserSafeText(page.title),
    type: projectBrowserSafeText(page.type),
    projectId: typeof page.frontmatter.project_id === 'string'
      ? projectBrowserSafeText(page.frontmatter.project_id)
      : null,
    verification: projectBrowserSafeText(page.frontmatter.verification ?? 'unverified'),
    applicability: projectBrowserSafeText(page.frontmatter.applicability),
    nonApplicable: projectBrowserSafeText(page.frontmatter.non_applicable),
    contentPreview: projectBrowserSafeText(page.compiled_truth, 'preview'),
  };
}

function projectRecommendation(recommendation: ReviewRecommendation): ReviewRecommendation {
  return {
    category: recommendation.category,
    scenario: projectBrowserSafeText(recommendation.scenario, 'preview').slice(0, 500),
    reason: projectBrowserSafeText(recommendation.reason, 'preview').slice(0, 500),
    generated_by: 'model',
  };
}

export function parseActionBody(body: unknown): ReviewAction | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const kind = b.kind ?? b.action;
  const sourceSlug = typeof b.sourceSlug === 'string' ? b.sourceSlug : typeof b.source_slug === 'string' ? b.source_slug : '';
  const targetSlug = typeof b.targetSlug === 'string' ? b.targetSlug : typeof b.target === 'string' ? b.target : '';
  const targetType = parseReviewTargetType(typeof b.targetType === 'string' ? b.targetType : b.target_type);
  const reviewNotes = parseReviewNotes(typeof b.reviewNotes === 'string' ? b.reviewNotes : b.reason);
  const humanConfirmation = b.humanConfirmation === true || b.human_confirmation === true;

  switch (kind) {
    case 'reject':
      return { kind: 'reject', sourceSlug, reviewNotes };
    case 'needs_evidence':
      return { kind: 'needs_evidence', sourceSlug, reviewNotes };
    case 'keep':
      return targetType === null ? null : normalizeWebAction({ kind: 'keep', sourceSlug, targetSlug, targetType, reviewNotes });
    case 'promote':
      return targetType === null ? null : { kind: 'promote', sourceSlug, targetSlug, targetType, humanConfirmation, reviewNotes };
    case 'merge':
      return targetType === null ? null : { kind: 'merge', sourceSlug, targetSlug, targetType, humanConfirmation, reviewNotes };
    case 'repair':
      return { kind: 'repair', sourceSlug, reviewNotes };
    case 'cleanup':
      return { kind: 'cleanup', sourceSlug, reviewNotes };
    default:
      return null;
  }
}

export function buildAction(
  kind: string,
  sourceSlug: string,
  targetSlug: string,
  targetType: ReviewTargetType,
  humanConfirmation: boolean,
  reviewNotes?: string,
): ReviewAction | null {
  switch (kind) {
    case 'reject':
      return { kind: 'reject', sourceSlug, ...(reviewNotes === undefined ? {} : { reviewNotes }) };
    case 'needs_evidence':
      return { kind: 'needs_evidence', sourceSlug, ...(reviewNotes === undefined ? {} : { reviewNotes }) };
    case 'keep':
      return normalizeWebAction({ kind: 'keep', sourceSlug, targetSlug, targetType });
    case 'promote':
      return { kind: 'promote', sourceSlug, targetSlug, targetType, humanConfirmation };
    case 'merge':
      return { kind: 'merge', sourceSlug, targetSlug, targetType, humanConfirmation };
    case 'repair':
      return { kind: 'repair', sourceSlug };
    case 'cleanup':
      return { kind: 'cleanup', sourceSlug };
    default:
      return null;
  }
}

export function parseReviewTargetType(value: unknown): ReviewTargetType | null {
  switch (value) {
    case 'knowledge':
    case 'runbook':
    case 'incident':
    case 'decision':
    case 'project':
    case 'environment':
    case 'agent-skill':
      return value;
    default:
      return null;
  }
}

export function generateReviewTargetSlug(sourceSlug: string, targetType: ReviewTargetType, projectId?: string): string | null {
  if (!sourceSlug.startsWith('inbox/')) return null;
  const tail = sourceSlug.slice('inbox/'.length)
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (tail.length === 0) return null;
  if (targetType === 'project' && (projectId === undefined || !/^prj-[0-9a-f]{16}$/.test(projectId))) return null;
  const prefix = targetType === 'project' ? `projects/${projectId}/` : REVIEW_TARGET_PREFIXES[targetType];
  const slug = `${prefix}${tail}`
    .slice(0, 80)
    .replace(/-+$/g, '')
    .replace(/\/+$/g, '');
  return /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(slug) ? slug : null;
}

export function planResultToJson(result: ReviewPlanResult): Record<string, unknown> {
  return {
    ok: result.ok,
    code: result.code,
    message: projectBrowserSafeText(result.message),
    gates: result.gates.map((gate) => ({
      code: gate.code,
      ok: gate.ok,
      message: projectBrowserSafeText(gate.message),
    })),
    plan: result.plan === undefined ? undefined : {
      action: result.plan.action.kind,
      source: projectBrowserSafeText(result.plan.source.slug),
      target: result.plan.targetPage === undefined ? null : {
        slug: projectBrowserSafeText(result.plan.targetPage.slug),
        type: projectBrowserSafeText(result.plan.targetPage.type),
      },
    },
  };
}

export type ReviewExecutionSummary = {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly source: string;
  readonly action: string;
  readonly target: string | null;
  readonly review_slug: string | null;
  readonly retrieval_verified: boolean;
  readonly next_action: string;
};

export function buildExecutionSummary(planResult: ReviewPlanResult, applyResult: ReviewApplyResult): ReviewExecutionSummary {
  const plan = planResult.plan;
  if (plan === undefined) throw new Error('buildExecutionSummary requires a plan');
  const verifyIndex = plan.steps.findIndex((step) => step.kind === 'verify_target');
  const retrievalVerified = verifyIndex >= 0 && applyResult.receipts[verifyIndex]?.ok === true;
  const failedIndex = applyResult.receipts.findIndex((receipt) => !receipt.ok);
  const failedKind = failedIndex >= 0 ? plan.steps[failedIndex]?.kind : undefined;
  const verifyOrReviewWriteFailed = failedKind === 'verify_target' || failedKind === 'write_review';
  const message = applyResult.ok
    ? '审核执行成功。'
    : verifyOrReviewWriteFailed
      ? '检索验证或审核记录写入失败：inbox 草稿已保留，需要修复后重试。'
      : '审核执行失败：inbox 草稿已保留，请排查原因后重试。';
  const nextAction = applyResult.ok
    ? '审核已完成，无需后续操作。'
    : verifyOrReviewWriteFailed
      ? '请使用「修复审核记录」修复后重试；inbox 草稿已保留。'
      : '请排查失败原因后重试；inbox 草稿已保留。';
  return {
    ok: applyResult.ok,
    code: applyResult.ok ? 'ok' : REVIEW_ERROR_CODE,
    message,
    source: projectBrowserSafeText(plan.source.slug),
    action: plan.action.kind,
    target: plan.targetPage === undefined ? null : projectBrowserSafeText(plan.targetPage.slug),
    review_slug: projectBrowserSafeText(plan.reviewPage.slug),
    retrieval_verified: retrievalVerified,
    next_action: nextAction,
  };
}

export function buildGateFailureSummary(planResult: ReviewPlanResult, action: ReviewAction): ReviewExecutionSummary {
  return {
    ok: false,
    code: planResult.code,
    message: projectBrowserSafeText(planResult.message),
    source: projectBrowserSafeText(action.sourceSlug),
    action: action.kind,
    target: 'targetSlug' in action && action.targetSlug.length > 0 ? projectBrowserSafeText(action.targetSlug) : null,
    review_slug: null,
    retrieval_verified: false,
    next_action: '门禁未通过，请根据预检结果修正后重试。',
  };
}

export function renderExecutionSummaryHtml(summary: ReviewExecutionSummary): string {
  const rows: readonly (readonly [string, string])[] = [
    ['结果', summary.ok ? '成功' : '失败'],
    ['代码', summary.code],
    ['说明', summary.message],
    ['来源', summary.source],
    ['操作', summary.action],
    ['目标', summary.target ?? '无'],
    ['审核记录', summary.review_slug ?? '无'],
    ['检索验证', summary.retrieval_verified ? '已验证' : '未验证'],
    ['下一步', summary.next_action],
  ];
  const body = rows.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('\n');
  return `<h1>审核结果</h1>
    <table class="review-table"><tbody>${body}</tbody></table>
    <p><a href="/admin/review">返回 Inbox</a> | <a href="/admin/review/history">查看审核历史</a></p>`;
}

export function isAllowedOrigin(rawOrigin: string | undefined, expectedOrigin: string): boolean {
  if (typeof rawOrigin !== 'string') return false;
  const origin = rawOrigin.trim();
  if (origin === '' || origin === 'null' || origin.includes(',')) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.origin === origin && parsed.origin === expectedOrigin;
}

function historyTargetSlug(page: Page): string | null {
  const match = /^- target: (.+)$/m.exec(page.compiled_truth);
  if (match === null) return null;
  const value = (match[1] ?? '').trim();
  if (value === 'null' || value.length === 0) return null;
  return projectBrowserSafeText(value);
}

export function historyReviewJson(page: Page): Record<string, unknown> {
  const rawAction = typeof page.frontmatter.review_action === 'string' ? page.frontmatter.review_action : 'unknown';
  const catalogEntry = (REVIEW_ACTION_CATALOG as Record<string, ReviewActionCatalogEntry | undefined>)[rawAction];
  const sourceRefs = Array.isArray(page.frontmatter.source_refs) ? page.frontmatter.source_refs : [];
  const date = typeof page.frontmatter.date === 'string' && page.frontmatter.date.length > 0
    ? projectBrowserSafeText(page.frontmatter.date)
    : page.updated_at.toISOString().slice(0, 10);
  return {
    slug: projectBrowserSafeText(page.slug),
    action: catalogEntry === undefined ? 'unknown' : rawAction,
    action_label: catalogEntry?.label ?? '未知操作',
    source: sourceRefs.length > 0 ? projectBrowserSafeText(sourceRefs[0]) : '未提供',
    target: historyTargetSlug(page),
    status: projectBrowserSafeText(page.frontmatter.status ?? 'reviewed'),
    date,
    updated_at: page.updated_at.toISOString(),
  };
}

// --- Internal helpers ---

type TargetSearchRequest = {
  readonly query: string;
  readonly targetType: ReviewTargetType | null;
  readonly limit: number;
};

type BrowserReviewTarget = {
  readonly slug: string;
  readonly type: ReviewTargetType;
  readonly title: string;
  readonly updated_at: string;
};

function requiresReviewTarget(action: string): boolean {
  return action === 'keep' || action === 'promote' || action === 'merge';
}

function requiresReviewNotes(action: string): boolean {
  return action === 'reject' || action === 'needs_evidence';
}

export function hasRequiredReviewNotes(action: ReviewAction): boolean {
  switch (action.kind) {
    case 'reject':
    case 'needs_evidence': {
      const reviewNotes = action.reviewNotes?.trim();
      return reviewNotes !== undefined && reviewNotes.length > 0;
    }
    case 'keep':
    case 'promote':
    case 'merge':
    case 'repair':
    case 'cleanup':
      return true;
  }
}

function parseReviewNotes(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const reviewNotes = value.trim();
  return reviewNotes.length === 0 ? undefined : reviewNotes;
}

function renderReviewNotesForm(sourceSlug: string, action: string): string {
  const actionPath = `/admin/review/plan/${encodeURIComponent(sourceSlug)}`;
  return `<h1>填写审核说明</h1>
    <p class="muted">${escapeHtml(action === 'reject' ? '丢弃草稿前必须说明原因。' : '标记补证据前必须说明缺少什么。')}</p>
    <form method="get" action="${actionPath}">
      <input type="hidden" name="action" value="${escapeHtml(action)}" />
      <label>审核说明<textarea name="reviewNotes" required></textarea></label>
      <button type="submit">填写审核说明后进入预检</button>
    </form>`;
}

function parseTargetSearchLimit(value: unknown): number | null {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  if (limit < 1) return null;
  return Math.min(limit, 50);
}

function targetTypeForSlug(slug: string): ReviewTargetType | null {
  for (const targetType of REVIEW_TARGET_TYPES) {
    if (slug.startsWith(REVIEW_TARGET_PREFIXES[targetType])) return targetType;
  }
  return null;
}

async function searchReviewTargets(engine: BrainEngine, sourceId: string, request: TargetSearchRequest): Promise<readonly BrowserReviewTarget[]> {
  const pages = await engine.listPages({ limit: 50, sort: 'updated_desc', sourceId });
  const query = request.query.trim().toLowerCase();
  return pages
    .filter((page) => !page.deleted_at)
    .map((page) => ({ page, targetType: targetTypeForSlug(page.slug) }))
    .filter((candidate): candidate is { readonly page: Page; readonly targetType: ReviewTargetType } => candidate.targetType !== null)
    .filter((candidate) => request.targetType === null || candidate.targetType === request.targetType)
    .filter((candidate) => query.length === 0 || candidate.page.slug.toLowerCase().includes(query) || candidate.page.title.toLowerCase().includes(query))
    .slice(0, request.limit)
    .map((candidate) => ({
      slug: projectBrowserSafeText(candidate.page.slug),
      type: candidate.targetType,
      title: projectBrowserSafeText(candidate.page.title),
      updated_at: candidate.page.updated_at.toISOString(),
    }));
}

async function renderTargetSelector(engine: BrainEngine, sourceId: string, sourceSlug: string, action: string, targetType: ReviewTargetType | null, query: string): Promise<string> {
  const actionPath = `/admin/review/plan/${encodeURIComponent(sourceSlug)}`;
  const options = REVIEW_TARGET_TYPES.map((value) => `<option value="${value}"${targetType === value ? ' selected' : ''}>${value}</option>`).join('');
  const typeForm = `<form method="get" action="${actionPath}">
    <input type="hidden" name="action" value="${escapeHtml(action)}" />
    <label>目标类型<select name="target_type" required><option value="">请选择目标类型</option>${options}</select></label>
    <button type="submit">继续选择目标</button>
  </form>`;
  if (targetType === null) return `<h1>选择审核目标</h1><p>目标类型必须由人工从七种审核目标类型中选择。</p>${typeForm}`;

  if (action === 'merge') {
    const targets = await searchReviewTargets(engine, sourceId, { query, targetType, limit: 50 });
    const rows = targets.map((target) => `<tr><td>${escapeHtml(target.slug)}</td><td>${escapeHtml(target.title)}</td><td><a href="${actionPath}?action=merge&amp;target_type=${target.type}&amp;target=${encodeURIComponent(target.slug)}">选择</a></td></tr>`).join('');
    return `<h1>选择已有目标</h1><p>合并只能选择当前审核来源内已存在的页面。</p>${typeForm}
      <form method="get" action="${actionPath}"><input type="hidden" name="action" value="merge" /><input type="hidden" name="target_type" value="${targetType}" /><label>搜索已有页面<input name="q" value="${escapeHtml(query)}" /></label><button type="submit">搜索</button></form>
      <table class="review-table"><thead><tr><th>Slug</th><th>标题</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="3">没有匹配的已有页面。</td></tr>'}</tbody></table>
      <details><summary>高级：手动输入已有目标 slug</summary><form method="get" action="${actionPath}"><input type="hidden" name="action" value="merge" /><input type="hidden" name="target_type" value="${targetType}" /><label>目标 slug<input name="target" required /></label><button type="submit">验证已有目标</button></form></details>`;
  }

  const sourceProjectId = targetType === 'project'
    ? (await engine.getPage(sourceSlug, { sourceId }))?.frontmatter.project_id
    : undefined;
  const generatedSlug = generateReviewTargetSlug(
    sourceSlug,
    targetType,
    typeof sourceProjectId === 'string' ? sourceProjectId : undefined,
  );
  if (generatedSlug === null) {
    return `<h1>选择审核目标</h1><p class="warn">无法生成有效目标 slug，请使用高级手动输入。</p>${typeForm}<details open><summary>高级：手动输入目标 slug</summary>${renderManualTargetForm(actionPath, action, targetType, '')}</details>`;
  }
  const collision = await engine.getPage(generatedSlug, { sourceId });
  const collisionFeedback = collision === null
    ? '<p>目标 slug 校验通过，尚未发现精确冲突。</p>'
    : `<p class="warn">发现已有目标页。请改用 <a href="${actionPath}?action=merge&amp;target_type=${targetType}&amp;q=${encodeURIComponent(generatedSlug)}">合并到已有内容</a>。</p>`;
  const continueForm = collision === null
    ? `<form method="get" action="${actionPath}"><input type="hidden" name="action" value="${escapeHtml(action)}" /><input type="hidden" name="target_type" value="${targetType}" /><input type="hidden" name="target" value="${escapeHtml(generatedSlug)}" /><button type="submit">使用建议目标并进入预检</button></form>`
    : '';
  return `<h1>选择审核目标</h1><p>系统建议目标 slug：<code>${escapeHtml(generatedSlug)}</code></p>${collisionFeedback}${continueForm}${typeForm}<details><summary>高级：手动输入目标 slug</summary>${renderManualTargetForm(actionPath, action, targetType, generatedSlug)}</details>`;
}

function renderManualTargetForm(actionPath: string, action: string, targetType: ReviewTargetType, target: string): string {
  return `<form method="get" action="${actionPath}"><input type="hidden" name="action" value="${escapeHtml(action)}" /><input type="hidden" name="target_type" value="${targetType}" /><label>目标 slug<input name="target" value="${escapeHtml(target)}" required pattern="[a-z0-9-]+(/[a-z0-9-]+)*" /></label><button type="submit">验证并进入预检</button></form>`;
}

function receiptFromToolResult(result: unknown, kind: string): ReviewStepReceipt {
  if (result !== null && typeof result === 'object' && ('error' in result || ('ok' in result && result.ok === false))) {
    return { ok: false, code: `${kind}_failed`, message: `${kind} 失败。` };
  }
  return { ok: true, code: kind, message: `${kind} 成功。` };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function decodeSlugParam(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).map(decodeURIComponent).join('/').replace(/^\/+/, '');
  if (typeof raw !== 'string') return '';
  return decodeURIComponent(raw).replace(/^\/+/, '');
}

type DetailReviewData = {
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly projectId: string;
  readonly date: string;
  readonly status: string;
  readonly sensitivity: string;
  readonly verification: string;
  readonly applicability: string;
  readonly nonApplicable: string;
  readonly reviewAction: string;
  readonly sourceReferenceCount: number;
  readonly contentPreview: string;
  readonly eventPreview: string;
};

function detailMetadataValue(value: unknown): string {
  const projected = projectBrowserSafeText(value);
  return projected.length > 0 ? projected : '未提供';
}

function detailPreviewValue(value: unknown): string {
  const projected = projectBrowserSafeText(value, 'preview');
  return projected.length > 0 ? projected : '未提供';
}

function detailReviewData(page: Page): DetailReviewData {
  const frontmatter = page.frontmatter;
  return {
    slug: detailMetadataValue(page.slug),
    title: detailMetadataValue(page.title),
    type: detailMetadataValue(page.type),
    projectId: detailMetadataValue(frontmatter.project_id),
    date: detailMetadataValue(frontmatter.date),
    status: detailMetadataValue(frontmatter.status),
    sensitivity: detailMetadataValue(frontmatter.sensitivity),
    verification: detailMetadataValue(frontmatter.verification),
    applicability: detailMetadataValue(frontmatter.applicability),
    nonApplicable: detailMetadataValue(frontmatter.non_applicable),
    reviewAction: detailMetadataValue(frontmatter.review_action),
    sourceReferenceCount: Array.isArray(frontmatter.source_refs) ? frontmatter.source_refs.length : 0,
    contentPreview: detailPreviewValue(page.compiled_truth),
    eventPreview: detailPreviewValue(page.timeline),
  };
}

function detailEvidenceStatus(page: Page): string {
  return page.frontmatter.verification === 'verified' ? '证据已验证' : REVIEW_ACTION_CATALOG.needs_evidence.label;
}

function detailSuggestedNext(page: Page): string {
  const recommendation = parseReviewRecommendation(page.frontmatter.review_recommendation, page);
  return recommendation === null ? '正在生成模型建议' : REVIEW_CATEGORY_LABELS[recommendation.category];
}

function renderDetailSummary(page: Page): string {
  const detail = detailReviewData(page);
  return `<section class="detail-summary" aria-labelledby="detail-summary-title">
    <h2 id="detail-summary-title">审核摘要</h2>
    <table class="review-table"><tbody>
      <tr><th>草稿类型</th><td>${escapeHtml(detail.type)}</td></tr>
      <tr><th>用途</th><td>${escapeHtml(detail.applicability)}</td></tr>
      <tr><th>验证状态</th><td>${detailEvidenceStatus(page)}</td></tr>
      <tr><th>模型建议</th><td>${detailSuggestedNext(page)}</td></tr>
    </tbody></table>
  </section>`;
}

function renderClassificationReview(page: Page, recommendation: ReviewRecommendation | null): string {
  const safeRecommendation = recommendation === null ? null : projectRecommendation(recommendation);
  const selected = safeRecommendation?.category;
  const options = REVIEW_CATEGORIES.map((category) => {
    const selectedAttribute = category === selected ? ' selected' : '';
    return `<option value="${category}"${selectedAttribute}>${escapeHtml(REVIEW_CATEGORY_LABELS[category])}</option>`;
  }).join('');
  const sourceSlug = projectBrowserSafeText(page.slug);
  const disabled = safeRecommendation === null ? ' disabled' : '';
  const recommendationStatus = safeRecommendation === null ? '正在生成模型建议…' : '大模型建议';
  const scenario = safeRecommendation?.scenario ?? '';
  const reason = safeRecommendation?.reason ?? '';
  const script = safeRecommendation === null ? renderRecommendationLoader(page.slug) : '';
  return `<section class="classification-review" aria-labelledby="classification-title">
    <div class="recommendation-panel">
      <div class="recommendation-kicker" id="recommendation-status">${recommendationStatus}</div>
      <h2 id="classification-title">建议归为：<span id="recommendation-label">${selected === undefined ? '加载中' : escapeHtml(REVIEW_CATEGORY_LABELS[selected])}</span></h2>
      <p><strong>使用场景：</strong><span id="recommendation-scenario">${escapeHtml(scenario, 'preview')}</span></p>
      <p><strong>推荐理由：</strong><span id="recommendation-reason">${escapeHtml(reason, 'preview')}</span></p>
      <p class="recommendation-error" id="recommendation-error" role="alert"></p>
    </div>
    <form method="post" action="/admin/api/review/classify" class="classification-form">
      <input type="hidden" name="sourceSlug" value="${escapeHtml(sourceSlug)}" />
      <label for="review-category">经验分类</label>
      <select id="review-category" name="category"${disabled}>${options}</select>
      <button id="classification-submit" type="submit"${disabled}>${selected === 'reject' ? '确认并删除' : '确认分类'}</button>
    </form>
  </section>${script}`;
}

function renderRecommendationLoader(sourceSlug: string): string {
  const encodedSlug = encodeURIComponent(sourceSlug);
  return `<script>
  (() => {
    const sourceSlug = decodeURIComponent(${JSON.stringify(encodedSlug)});
    const select = document.getElementById('review-category');
    const submit = document.getElementById('classification-submit');
    const error = document.getElementById('recommendation-error');
    fetch('/admin/api/review/recommendation', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug })
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '暂时无法生成模型建议');
      const recommendation = payload.recommendation;
      document.getElementById('recommendation-status').textContent = '大模型建议';
      document.getElementById('recommendation-label').textContent = select.querySelector('option[value="' + recommendation.category + '"]').textContent;
      document.getElementById('recommendation-scenario').textContent = recommendation.scenario;
      document.getElementById('recommendation-reason').textContent = recommendation.reason;
      select.value = recommendation.category;
      select.disabled = false;
      submit.disabled = false;
      submit.textContent = recommendation.category === 'reject' ? '确认并删除' : '确认分类';
    }).catch(() => {
      document.getElementById('recommendation-status').textContent = '模型建议不可用';
      error.textContent = '暂时无法生成模型建议，请稍后刷新。';
    });
    select.addEventListener('change', () => {
      submit.textContent = select.value === 'reject' ? '确认并删除' : '确认分类';
    });
  })();
  </script>`;
}

function renderDetailExpandable(page: Page): string {
  const detail = detailReviewData(page);
  return `<section class="detail-evidence" aria-label="草稿审核详情">
    <details>
      <summary>草稿元数据</summary>
      <table class="review-table"><tbody>
        <tr><th>标题</th><td>${escapeHtml(detail.title)}</td></tr>
        <tr><th>Slug</th><td>${escapeHtml(detail.slug)}</td></tr>
        <tr><th>项目 ID</th><td>${escapeHtml(detail.projectId)}</td></tr>
        <tr><th>日期</th><td>${escapeHtml(detail.date)}</td></tr>
        <tr><th>状态</th><td>${escapeHtml(detail.status)}</td></tr>
        <tr><th>敏感性标记</th><td>${escapeHtml(detail.sensitivity)}</td></tr>
        <tr><th>验证状态</th><td>${escapeHtml(detail.verification)}</td></tr>
        <tr><th>适用范围</th><td>${escapeHtml(detail.applicability)}</td></tr>
        <tr><th>不适用范围</th><td>${escapeHtml(detail.nonApplicable)}</td></tr>
        <tr><th>已有审核动作</th><td>${escapeHtml(detail.reviewAction)}</td></tr>
        <tr><th>证据引用数量</th><td>${detail.sourceReferenceCount}</td></tr>
      </tbody></table>
    </details>
    <details>
      <summary>内容预览</summary>
      <pre>${escapeHtml(detail.contentPreview, 'preview')}</pre>
    </details>
    <details>
      <summary>时间线预览</summary>
      <pre>${escapeHtml(detail.eventPreview, 'preview')}</pre>
    </details>
  </section>`;
}

function projectDetailJson(page: Page): Record<string, unknown> {
  const detail = detailReviewData(page);
  return {
    slug: detail.slug,
    title: detail.title,
    type: detail.type,
    project_id: detail.projectId,
    metadata: {
      date: detail.date,
      status: detail.status,
      sensitivity: detail.sensitivity,
      verification: detail.verification,
      applicability: detail.applicability,
      non_applicable: detail.nonApplicable,
      review_action: detail.reviewAction,
      source_reference_count: detail.sourceReferenceCount,
    },
    summary: {
      evidence_sufficiency: detailEvidenceStatus(page),
      sensitive_content_status: '未预检',
      duplicate_status: '未预检',
      suggested_next_step: detailSuggestedNext(page),
    },
    content_preview: detail.contentPreview,
    event_preview: detail.eventPreview,
  };
}

function renderFilterBar(typeFilter: string | undefined, verificationFilter: string | undefined, staleOnly: boolean, projectId: string | undefined): string {
  const staleVal = staleOnly ? 'true' : '';
  return `<form class="review-filters" method="get" action="/admin/review">
    <label>类型<input name="type" type="text" value="${escapeHtml(typeFilter ?? '')}" placeholder="如 incident" /></label>
    <label>验证<input name="verification" type="text" value="${escapeHtml(verificationFilter ?? '')}" placeholder="如 verified" /></label>
    <label>过期<select name="stale"><option value="">全部</option><option value="true"${staleOnly ? ' selected' : ''}>仅过期</option></select></label>
    <label>项目 ID<input name="project_id" type="text" value="${escapeHtml(projectId ?? '')}" placeholder="可选" /></label>
    <button type="submit">筛选</button>
    <a class="action-link" href="/admin/review">重置</a>
  </form>`;
}

function renderEmptyState(typeFilter: string | undefined, verificationFilter: string | undefined, staleOnly: boolean, projectId: string | undefined): string {
  const hasFilter = typeFilter !== undefined || verificationFilter !== undefined || staleOnly || projectId !== undefined;
  if (hasFilter) {
    return `<div class="empty-state"><p>没有匹配当前筛选条件的 inbox 草稿。</p><p><a class="action-link" href="/admin/review">重置筛选条件</a></p></div>`;
  }
  return `<div class="empty-state"><p>暂无 inbox 草稿。</p><p>新草稿捕获后会出现在这里。</p></div>`;
}

function renderDraftRow(p: Page): string {
  const verification = String(p.frontmatter.verification ?? 'unverified');
  const updatedDate = p.updated_at.toISOString().slice(0, 10);
  const detailHref = `/admin/review/detail/${encodeURIComponent(p.slug)}`;
  const projectIdRaw = typeof p.frontmatter.project_id === 'string' ? p.frontmatter.project_id : '';
  const projectIdLine = projectIdRaw.length > 0 ? `<div class="slug-mono">项目：${escapeHtml(projectIdRaw)}</div>` : '';
  const verificationBadge = verification === 'verified'
    ? `<span class="badge badge-verified">${escapeHtml(verification)}</span>`
    : `<span class="badge badge-unverified">${escapeHtml(verification)}</span>`;
  const recommendation = parseReviewRecommendation(p.frontmatter.review_recommendation, p);
  const recommendationLabel = recommendation === null ? '待生成' : REVIEW_CATEGORY_LABELS[recommendation.category];
  return `<tr>
  <td class="review-select-cell" data-label="选择"><input type="checkbox" name="sourceSlugs" value="${escapeHtml(p.slug)}" aria-label="选择 ${escapeHtml(p.title)}" /></td>
  <td data-label="草稿"><div>${escapeHtml(p.title)}</div><div class="slug-mono">${escapeHtml(p.slug)}</div>${projectIdLine}</td>
  <td data-label="建议分类">${escapeHtml(recommendationLabel)}</td>
  <td data-label="验证">${verificationBadge}</td>
  <td class="slug-mono" data-label="更新时间">${escapeHtml(updatedDate)}</td>
  <td data-label="操作"><a class="action-link" href="${detailHref}">开始审核</a></td>
</tr>`;
}

function renderShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - GBrain 审核</title>
<style>
  body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;padding:24px;line-height:1.6;overflow-wrap:anywhere}
  h1{font-size:22px;border-bottom:1px solid #1e1e2e;padding-bottom:8px;margin-top:0;margin-bottom:16px;text-align:left}
  h2{font-size:17px;margin-top:24px;margin-bottom:12px;color:#88aaff;text-align:left}
  table.review-table{border-collapse:collapse;width:100%;margin:12px 0;table-layout:fixed}
  table.review-table th,table.review-table td{border:1px solid #1e1e2e;padding:10px 16px;text-align:left;font-size:13px;font-family:'JetBrains Mono',monospace;overflow-wrap:anywhere;word-break:normal;white-space:normal}
  table.review-table th{background:#12121a;color:#888888;font-family:Inter,sans-serif;font-weight:500;text-transform:uppercase;letter-spacing:1px}
  table.review-table tr:hover td{background:#1a1a2a}
  pre{background:#0f0f1a;padding:12px;border:1px solid #1e1e2e;border-radius:8px;overflow-x:auto;white-space:pre-wrap;font-size:13px;font-family:'JetBrains Mono',monospace}
  form{margin:16px 0;padding:16px;background:#12121a;border:1px solid #1e1e2e;border-radius:8px}
  label{display:inline-block;margin-right:12px;font-size:13px;text-align:left}
  input,select,textarea{background:#0f0f1a;border:1px solid #1e1e2e;color:#e0e0e0;padding:6px 10px;border-radius:8px;font-size:13px;transition:border-color 150ms}
  textarea{display:block;inline-size:100%;min-block-size:96px;resize:vertical;box-sizing:border-box}
  button{background:#3a3a5a;color:#fff;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;transition:background 150ms}
  button:hover{background:#4a4a6a}
  a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.decision-card:focus-visible,summary:focus-visible{outline:3px solid #88aaff;outline-offset:3px}
  button:disabled{background:#1e1e2e;color:#555555;cursor:not-allowed}
  .stale{color:#ff6b6b;font-weight:bold}
  .warn{background:rgba(245,166,35,0.1);border:1px solid rgba(245,166,35,0.3);border-radius:8px;padding:10px 14px;font-size:13px}
  code{background:#0f0f1a;padding:2px 6px;border-radius:3px;font-size:12px;font-family:'JetBrains Mono',monospace}
  a{color:#88aaff;text-decoration:none}
  a:hover{text-decoration:underline}
  .muted{color:#888888;font-size:13px;text-align:left}
  .slug-mono{font-family:'JetBrains Mono',monospace;font-size:12px;color:#555555}
  .action-link{color:#88aaff;font-size:13px;text-decoration:none}
  .action-link:hover{text-decoration:underline}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:12px;font-family:'JetBrains Mono',monospace;border:1px solid transparent}
  .badge-verified{background:rgba(52,168,83,0.15);color:#34a853;border-color:rgba(52,168,83,0.3)}
  .badge-unverified{background:rgba(245,166,35,0.15);color:#f5a623;border-color:rgba(245,166,35,0.3)}
  .badge-draft{background:rgba(136,136,136,0.15);color:#888888;border-color:rgba(136,136,136,0.3)}
  .badge-stale{background:rgba(255,107,107,0.15);color:#ff6b6b;border-color:rgba(255,107,107,0.3)}
  .badge-na{background:rgba(85,85,85,0.15);color:#555555;border-color:rgba(85,85,85,0.3)}
  .review-filters{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:16px 0;padding:16px;background:#12121a;border:1px solid #1e1e2e;border-radius:8px}
  .review-filters label{display:flex;flex-direction:column;font-size:12px;color:#888888;gap:4px}
  .review-filters input,.review-filters select{background:#0f0f1a;border:1px solid #1e1e2e;color:#e0e0e0;padding:6px 10px;border-radius:8px;font-size:13px;min-width:120px}
  .batch-review-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0;padding:12px 16px;background:#12121a;border:1px solid #1e1e2e;border-radius:8px}
  .batch-review-controls #batch-review-result{flex-basis:100%;margin:0}
  .batch-reject-button{background:#6a2f38}
  .batch-reject-button:hover{background:#7d3944}
  .review-select-cell{width:44px;text-align:center!important;padding-left:8px!important;padding-right:8px!important}
  .review-select-cell input{margin:0}
  .empty-state{text-align:center;color:#888888;padding:48px 0}
  .decision-card-section{margin-top:32px}
  .decision-card-section h2{margin-bottom:8px}
  .decision-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px}
  .decision-card{display:block;background:#12121a;border:1px solid #1e1e2e;border-radius:16px;color:#e0e0e0;padding:24px;text-decoration:none;transition:background 150ms,border-color 150ms;text-align:left}
  .decision-card:hover{background:#1a1a2a;border-color:#3a3a5a;text-decoration:none}
  .decision-card:focus-visible{outline:2px solid #88aaff;outline-offset:2px}
  .decision-card-primary{border-color:#3a3a5a}
  .decision-card h3{font-size:14px;margin:0 0 16px;text-align:left}
  .decision-card-details{display:grid;gap:12px;margin:0}
  .decision-card-details div{display:grid;gap:4px}
  .decision-card-details dt{color:#888888;font-size:12px;text-align:left}
  .decision-card-details dd{margin:0;font-size:13px;overflow-wrap:anywhere;text-align:left}
  .decision-card-risk{border-left:3px solid #f5a623;padding-left:8px}
  .decision-card-rare .decision-card-risk{border-left-color:#ff6b6b}

  /* Desktop two-column layout and mobile single-column layout */
  @media (min-width: 769px) {
    .review-container {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 24px;
      align-items: start;
    }
    .review-sidebar {
      grid-column: 1;
      position: sticky;
      top: 24px;
    }
    .review-main {
      grid-column: 2;
    }
  }
  @media (max-width: 768px) {
    body{padding:16px;overflow-wrap:anywhere}
    .review-container {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .decision-card-details dd, .muted, p {
      font-size: 14px;
      line-height: 1.7;
    }
    table.review-table{table-layout:auto}
    table.review-table thead{display:none}
    table.review-table tbody,table.review-table tr,table.review-table th,table.review-table td{display:block;width:100%;box-sizing:border-box}
    table.review-table tr{margin:8px 0;border:1px solid #1e1e2e}
    table.review-table th,table.review-table td{border:0;padding:8px 10px}
    table.review-table th{background:#12121a}
    table.review-table td[data-label]::before{content:attr(data-label);display:block;margin-bottom:4px;color:#888888;font-family:Inter,sans-serif;font-size:12px;font-weight:500;letter-spacing:.04em}
  }
</style></head><body>
${body}
</body></html>`;
}
