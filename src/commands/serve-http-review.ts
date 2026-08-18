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
import type { Page, SearchResult } from '../core/types.ts';
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
} from '../core/review/index.ts';
import {
  createLocalWriterSessionFactory,
  type WriterSessionFactory,
  type WriterToolSession,
} from './gbrain-capture-writer.ts';
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
        : `<section class="review-queue" aria-label="待人工分类的经验">
          ${drafts.map((p, index) => renderDraftRow(p, index + 1)).join('\n')}
        </section>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell('Inbox 草稿审核', `
        <main class="review-workbench">
          <header class="workbench-header">
            <div>
              <p class="eyebrow">经验分类</p>
              <h1>待人工分类 <span class="heading-count">${drafts.length}</span></h1>
              <p class="workbench-intro">先读清这条经验，再决定它应该保留在项目内、成为通用经验，还是不进入经验库。</p>
            </div>
          </header>
          ${filterBar}
          ${bodyContent}
          <p class="history-link"><a href="/admin/review/history">查看审核历史</a></p>
        </main>
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
      const recallItems = await loadReviewRecall(engine, page, reviewSourceId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderShell(`草稿详情：${escapeHtml(slug)}`, `
        <main class="review-sheet">
          ${renderReviewDetail(page, recallItems)}
          ${renderReviewActionSelect(page.slug)}
          <p><a href="/admin/review">返回列表</a></p>
        </main>
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
      if (!result.ok && result.code === 'source_not_found') {
        const completedReview = await findCompletedReview(engine, reviewSourceId, slug);
        if (completedReview !== null) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(renderShell('审核已完成', `
            <main class="review-sheet">
              <section class="review-section completed-review" aria-labelledby="completed-review-title">
                <h1 id="completed-review-title">这条经验已经完成审核</h1>
                <p>处理结果：${escapeHtml(completedReview.actionLabel)}</p>
                <p class="slug-mono">${escapeHtml(slug)}</p>
                <p><a class="action-link" href="/admin/review">返回待审核列表</a> · <a href="/admin/review/history">查看审核历史</a></p>
              </section>
            </main>
          `));
          return;
        }
      }
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

async function findCompletedReview(
  engine: BrainEngine,
  sourceId: string,
  sourceSlug: string,
): Promise<{ readonly actionLabel: string } | null> {
  const pages = await engine.listPages({
    slugPrefix: 'decisions/reviews/',
    limit: 100,
    sort: 'updated_desc',
    sourceId,
  });
  for (const page of pages) {
    if (page.deleted_at) continue;
    const sourceRefs = Array.isArray(page.frontmatter.source_refs) ? page.frontmatter.source_refs : [];
    if (!sourceRefs.some((ref) => projectBrowserSafeText(ref) === sourceSlug)) continue;
    const review = historyReviewJson(page);
    return { actionLabel: String(review.action_label ?? '已处理') };
  }
  return null;
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
  readonly content: string;
  readonly eventPreview: string;
};

type ReviewRecallItem = {
  readonly score: number;
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly chunkText: string;
  readonly content: string;
};

function detailMetadataValue(value: unknown): string {
  const projected = projectBrowserSafeText(value);
  return projected.length > 0 ? projected : '未提供';
}

function detailPreviewValue(value: unknown): string {
  const projected = projectBrowserSafeText(value, 'preview');
  return projected.length > 0 ? projected : '未提供';
}

function detailContentValue(value: unknown): string {
  const projected = projectBrowserSafeText(value);
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
    content: detailContentValue(page.compiled_truth),
    eventPreview: detailPreviewValue(page.timeline),
  };
}

function detailEvidenceStatus(page: Page): string {
  return page.frontmatter.verification === 'verified' ? '证据已验证' : REVIEW_ACTION_CATALOG.needs_evidence.label;
}

function detailSuggestedNext(page: Page): string {
  return page.frontmatter.verification === 'verified'
    ? '选择处理方式后查看完整预检'
    : REVIEW_ACTION_CATALOG.needs_evidence.label;
}

function buildReviewRecallQuery(page: Page): string {
  const applicability = projectBrowserSafeText(page.frontmatter.applicability);
  const content = projectBrowserSafeText(page.compiled_truth, 'preview');
  return [projectBrowserSafeText(page.title), applicability, content.slice(0, 600)]
    .filter((part) => part.length > 0 && part !== '未提供')
    .join(' ');
}

async function loadReviewRecall(engine: BrainEngine, page: Page, sourceId: string): Promise<readonly ReviewRecallItem[]> {
  const query = buildReviewRecallQuery(page);
  if (query.length === 0 || typeof engine.searchKeyword !== 'function') return [];
  try {
    const results = await engine.searchKeyword(query, { limit: 12, sourceId });
    const candidates = results
      .filter((result) => result.slug !== page.slug)
      .filter((result) => !result.slug.startsWith('inbox/'))
      .slice(0, 5);
    return await Promise.all(candidates.map(async (result) => projectRecallItem(engine, result, sourceId)));
  } catch {
    return [];
  }
}

async function projectRecallItem(engine: BrainEngine, result: SearchResult, sourceId: string): Promise<ReviewRecallItem> {
  let content = result.chunk_text;
  try {
    const page = await engine.getPage(result.slug, { sourceId });
    if (page !== null) content = page.compiled_truth;
  } catch {
    // The matched chunk is still useful when full-page hydration fails.
  }
  return {
    score: Number.isFinite(result.score) ? result.score : 0,
    slug: detailMetadataValue(result.slug),
    title: detailMetadataValue(result.title),
    type: detailMetadataValue(result.type),
    chunkText: detailPreviewValue(result.chunk_text),
    content: detailContentValue(content),
  };
}

function extractMarkdownSections(markdown: string, headings: readonly string[]): readonly string[] {
  const wanted = new Set(headings.map(normalizeReviewHeading));
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      if (current !== null) {
        const value = current.join('\n').trim();
        if (value.length > 0) sections.push(value);
      }
      current = wanted.has(normalizeReviewHeading(match[1] ?? '')) ? [] : null;
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) {
    const value = current.join('\n').trim();
    if (value.length > 0) sections.push(value);
  }
  return sections;
}

function normalizeReviewHeading(value: string): string {
  return value.trim().toLowerCase().replace(/[：:]/g, '').replace(/\s+/g, '');
}

function projectScenarioValues(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => projectBrowserSafeText(item))
    .filter((item) => item.length > 0 && item !== '未提供' && !isReviewScenarioPlaceholder(item));
}

function isReviewScenarioPlaceholder(value: string): boolean {
  return new Set([
    'pending-human-review',
    'pending review',
    'not provided',
    'n/a',
    'none',
  ]).has(value.trim().toLowerCase());
}

function reviewRecallScenarios(page: Page): readonly string[] {
  const structured = projectScenarioValues(page.frontmatter.applicability);
  const sections = extractMarkdownSections(page.compiled_truth, [
    '召回场景', '适用场景', '使用场景', '问题场景', '触发条件', '什么时候使用', '何时使用',
  ]).map((section) => projectBrowserSafeText(section));
  const values = [
    ...structured,
    ...sections,
  ].filter((value) => value.length > 0);
  return [...new Set(values)];
}

function reviewNonApplicableScenarios(page: Page): readonly string[] {
  const structured = projectScenarioValues(page.frontmatter.non_applicable);
  const sections = extractMarkdownSections(page.compiled_truth, [
    '不适用场景', '不应召回', '不要使用', '何时不使用',
  ]).map((section) => projectBrowserSafeText(section));
  const values = [
    ...structured,
    ...sections,
  ].filter((value) => value.length > 0);
  return [...new Set(values)];
}

function renderReviewDetail(
  page: Page,
  recallItems: readonly ReviewRecallItem[],
): string {
  const detail = detailReviewData(page);
  const recallScenarios = reviewRecallScenarios(page);
  const nonApplicable = reviewNonApplicableScenarios(page);
  return `<header class="review-detail-header">
    <p class="eyebrow">经验审核</p>
    <h1>${escapeHtml(detail.title)}</h1>
    <div class="detail-meta">
      <span class="badge badge-draft">${escapeHtml(detail.type)}</span>
      <span class="badge badge-draft">${escapeHtml(detail.status)}</span>
      <span class="badge ${page.frontmatter.verification === 'verified' ? 'badge-verified' : 'badge-unverified'}">${escapeHtml(detail.verification)}</span>
    </div>
    <div class="slug-mono">${escapeHtml(detail.slug)}</div>
  </header>
  <section class="review-section" aria-labelledby="experience-content-title">
    <h2 id="experience-content-title">经验内容</h2>
    <pre class="experience-content">${escapeHtml(detail.content)}</pre>
  </section>
  ${renderReviewRecallSection(recallScenarios, nonApplicable)}
  <section class="review-section" aria-labelledby="similar-experience-title">
    <h2 id="similar-experience-title">相似经验召回</h2>
    ${renderRecallItems(recallItems)}
  </section>`;
}

function renderReviewRecallSection(recallScenarios: readonly string[], nonApplicable: readonly string[]): string {
  return `<section class="review-section" aria-labelledby="recall-scenario-title">
    <h2 id="recall-scenario-title">什么场景下会被召回</h2>
    ${renderScenarioList(recallScenarios, '尚未提供具体召回场景')}
    <h3>不应召回的场景</h3>
    ${renderScenarioList(nonApplicable, '尚未提供不应召回的场景')}
  </section>`;
}

function renderScenarioList(values: readonly string[], emptyText: string): string {
  if (values.length === 0) return `<p class="missing-field">${escapeHtml(emptyText)}</p>`;
  return `<ul class="scenario-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`;
}

function renderRecallItems(items: readonly ReviewRecallItem[]): string {
  if (items.length === 0) return '<p class="muted">暂无相似经验。</p>';
  return `<div class="recall-list">${items.map((item) => `<article class="recall-item">
    <div class="recall-item-head">
      <strong>${escapeHtml(item.title)}</strong>
      <span class="recall-score">${escapeHtml(item.score.toFixed(4))}</span>
    </div>
    <div class="recall-meta"><span>${escapeHtml(item.type)}</span><code>${escapeHtml(item.slug)}</code></div>
    <div class="recall-chunk">${escapeHtml(item.chunkText)}</div>
    <details><summary>查看完整经验内容</summary><pre>${escapeHtml(item.content)}</pre></details>
  </article>`).join('')}</div>`;
}

function renderReviewActionSelect(sourceSlug: string): string {
  const options = Object.values(REVIEW_ACTION_CATALOG)
    .map((entry) => `<option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>`)
    .join('');
  return `<section class="review-section review-action-section" aria-labelledby="review-action-title">
    <h2 id="review-action-title">审核操作</h2>
    <form class="review-action-form" method="get" action="/admin/review/plan/${encodeURIComponent(sourceSlug)}">
      <label for="review-action">选择操作</label>
      <select id="review-action" name="action" required>
        <option value="" selected disabled>请选择</option>
        ${options}
      </select>
      <button type="submit">下一步</button>
    </form>
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
    content_preview: detailPreviewValue(page.compiled_truth),
    event_preview: detail.eventPreview,
  };
}

function renderFilterBar(typeFilter: string | undefined, verificationFilter: string | undefined, staleOnly: boolean, projectId: string | undefined): string {
  const staleVal = staleOnly ? 'true' : '';
  return `<details class="review-filter-panel">
    <summary>筛选待审核经验</summary>
    <form class="review-filters" method="get" action="/admin/review">
      <label>类型<input name="type" type="text" value="${escapeHtml(typeFilter ?? '')}" placeholder="如 incident" /></label>
      <label>验证<input name="verification" type="text" value="${escapeHtml(verificationFilter ?? '')}" placeholder="如 verified" /></label>
      <label>过期<select name="stale"><option value="">全部</option><option value="true"${staleOnly ? ' selected' : ''}>仅过期</option></select></label>
      <label>项目 ID<input name="project_id" type="text" value="${escapeHtml(projectId ?? '')}" placeholder="可选" /></label>
      <button type="submit">应用筛选</button>
      <a class="action-link" href="/admin/review">重置</a>
    </form>
  </details>`;
}

function renderEmptyState(typeFilter: string | undefined, verificationFilter: string | undefined, staleOnly: boolean, projectId: string | undefined): string {
  const hasFilter = typeFilter !== undefined || verificationFilter !== undefined || staleOnly || projectId !== undefined;
  if (hasFilter) {
    return `<div class="empty-state"><p>没有匹配当前筛选条件的 inbox 草稿。</p><p><a class="action-link" href="/admin/review">重置筛选条件</a></p></div>`;
  }
  return `<div class="empty-state"><p>暂无 inbox 草稿。</p><p>新草稿捕获后会出现在这里。</p></div>`;
}

function renderDraftRow(p: Page, reviewOrder: number): string {
  const updatedDate = p.updated_at.toISOString().slice(0, 10);
  const detailHref = `/admin/review/detail/${encodeURIComponent(p.slug)}`;
  const projectIdRaw = typeof p.frontmatter.project_id === 'string' ? p.frontmatter.project_id : '';
  const projectIdLine = projectIdRaw.length > 0 ? `<span>项目：${escapeHtml(projectIdRaw)}</span>` : '';
  return `<article class="review-queue-item">
    <div class="queue-order" aria-label="审核顺序">${String(reviewOrder).padStart(2, '0')}</div>
    <div class="queue-item-copy">
      <p class="queue-kicker">待人工分类</p>
      <h2><a href="${detailHref}">${escapeHtml(p.title)}</a></h2>
      <div class="queue-provenance"><code>${escapeHtml(p.slug)}</code>${projectIdLine}</div>
    </div>
    <div class="classification-rail">
      <span>AI 初判</span>
      <strong>${escapeHtml(reviewSuggestedTypeLabel(p.type))}</strong>
      <code>${escapeHtml(p.type)}</code>
    </div>
    <div class="queue-item-action">
      <time datetime="${escapeHtml(p.updated_at.toISOString())}">更新于 ${escapeHtml(updatedDate)}</time>
      <a class="review-button" href="${detailHref}">打开并分类 <span aria-hidden="true">→</span></a>
    </div>
  </article>`;
}

function reviewSuggestedTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    knowledge: '通用知识',
    runbook: '通用操作经验',
    incident: '故障经验',
    decision: '决策经验',
    project: '项目经验',
    environment: '环境经验',
    'agent-skill': 'Agent 技能',
  };
  return labels[type] ?? type;
}

function renderShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - GBrain 审核</title>
<style>
  :root{
    color-scheme:light;
    --page:#f7f8fc;
    --surface:#ffffff;
    --surface-subtle:#f2f5fb;
    --text:#18243a;
    --muted:#67758d;
    --faint:#8b96a8;
    --border:#dbe1ec;
    --border-strong:#c4cedf;
    --accent:#3658cf;
    --accent-hover:#2845af;
    --accent-soft:#e7ecff;
    --success:#2d7a65;
    --success-soft:#e7f4ef;
    --warning:#986227;
    --warning-soft:#fcf3e4;
    --danger:#a34f4a;
    --danger-soft:#faeceb;
    --radius:6px;
    --font-display:'MiSans','HarmonyOS Sans SC','Noto Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
    --font-body:'MiSans','HarmonyOS Sans SC','Noto Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
    --font-mono:'IBM Plex Mono','SFMono-Regular',Consolas,'Liberation Mono',monospace;
  }
  *{box-sizing:border-box}
  body{max-width:1240px;margin:0 auto;font-family:var(--font-body);background:var(--page);color:var(--text);padding:48px 32px 64px;font-size:16px;line-height:1.72;overflow-wrap:anywhere}
  h1{font-family:var(--font-display);font-size:38px;line-height:1.18;font-weight:800;margin:0;color:var(--text);letter-spacing:-.035em}
  h2{font-family:var(--font-display);font-size:23px;line-height:1.35;font-weight:750;margin-top:28px;margin-bottom:12px;color:var(--text);text-align:left;letter-spacing:-.02em}
  table.review-table{border-collapse:separate;border-spacing:0;width:100%;margin:20px 0;table-layout:fixed;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
  table.review-table th,table.review-table td{border:0;border-bottom:1px solid var(--border);padding:14px 16px;text-align:left;font-size:15px;overflow-wrap:anywhere;word-break:normal;white-space:normal}
  table.review-table tr:last-child td{border-bottom:0}
  table.review-table th{background:#e8efec;color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.06em}
  table.review-table td{background:var(--surface)}
  table.review-table tr:hover td{background:#f7faf8}
  pre{background:var(--surface-subtle);padding:18px;border:1px solid var(--border);border-radius:10px;overflow-x:auto;white-space:pre-wrap;font-size:15px;font-family:var(--font-mono);line-height:1.78}
  form{margin:16px 0;padding:18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
  label{display:inline-block;margin-right:12px;font-size:14px;text-align:left}
  input,select,textarea{background:var(--surface);border:1px solid var(--border-strong);color:var(--text);padding:10px 12px;border-radius:8px;font:inherit;font-size:15px;transition:border-color 150ms,box-shadow 150ms}
  textarea{display:block;inline-size:100%;min-block-size:96px;resize:vertical;box-sizing:border-box}
  input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  button{background:var(--accent);color:#fff;border:1px solid var(--accent);padding:10px 16px;border-radius:8px;cursor:pointer;font:inherit;font-size:15px;font-weight:700;transition:background 150ms,border-color 150ms}
  button:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
  a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #8bb4d8;outline-offset:3px}
  button:disabled{background:#e6e6e3;border-color:#e6e6e3;color:var(--faint);cursor:not-allowed}
  .stale{color:var(--danger);font-weight:650}
  .warn{background:var(--warning-soft);border:1px solid #ead49b;border-radius:var(--radius);padding:11px 14px;font-size:13px}
  code{background:#e9efec;color:#31514a;padding:2px 6px;border-radius:4px;font-size:12px;font-family:var(--font-mono)}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .muted{color:var(--muted);font-size:15px;text-align:left}
  .slug-mono{font-family:var(--font-mono);font-size:13px;color:var(--muted)}
  .action-link{color:var(--accent);font-size:15px;font-weight:700;text-decoration:none}
  .action-link:hover{text-decoration:underline}
  .badge{display:inline-block;padding:3px 9px;border-radius:9999px;font-size:12px;font-family:var(--font-mono);border:1px solid transparent}
  .badge-verified{background:var(--success-soft);color:var(--success);border-color:#b9dfc8}
  .badge-unverified{background:var(--warning-soft);color:var(--warning);border-color:#ead49b}
  .badge-draft{background:#f0f0ed;color:var(--muted);border-color:var(--border)}
  .badge-stale{background:var(--danger-soft);color:var(--danger);border-color:#edbcbc}
  .badge-na{background:#f0f0ed;color:var(--muted);border-color:var(--border)}
  .review-workbench{max-width:1120px;margin:0 auto}
  .workbench-header{display:block;padding:18px 0 29px;border-bottom:2px solid var(--text)}
  .eyebrow{margin:0 0 10px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.14em}
  .heading-count{display:inline-flex;vertical-align:middle;align-items:center;justify-content:center;min-width:32px;height:32px;margin-left:12px;border-radius:50%;background:var(--accent);color:#fff;font-family:var(--font-mono);font-size:14px;font-weight:700;letter-spacing:0}
  .workbench-intro{max-width:680px;margin:12px 0 0;color:var(--muted);font-size:17px}
  .review-filter-panel{margin:18px 0 8px;border:0;border-bottom:1px solid var(--border);border-radius:0;background:transparent}
  .review-filter-panel summary{padding:10px 0 13px;color:var(--muted);font-size:14px;font-weight:700;cursor:pointer}
  .review-filter-panel[open] summary{border-bottom:1px solid var(--border)}
  .review-filters{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:0;padding:8px 0 18px;background:transparent;border:0;border-radius:0}
  .review-filters label{display:flex;flex-direction:column;font-size:13px;color:var(--muted);font-weight:700;gap:5px}
  .review-filters input,.review-filters select{background:var(--surface);border:1px solid var(--border-strong);color:var(--text);padding:9px 10px;border-radius:8px;font-size:14px;min-width:140px}
  .review-queue{margin-top:0;border-bottom:1px solid var(--border)}
  .review-queue-item{position:relative;display:grid;grid-template-columns:54px minmax(0,1fr) 190px 154px;align-items:center;gap:22px;padding:23px 0;border-top:1px solid var(--border);background:transparent;transition:background 150ms ease,padding 150ms ease}
  .review-queue-item:hover{margin:0 -18px;padding-right:18px;padding-left:18px;background:var(--surface-subtle)}
  .queue-order{align-self:start;padding-top:3px;color:#9ba7ba;font-family:var(--font-mono);font-size:14px;font-weight:700}
  .queue-kicker{margin:0 0 6px;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.08em}
  .queue-item-copy h2{margin:0;font-family:var(--font-body);font-size:20px;font-weight:800;line-height:1.36;letter-spacing:-.02em}
  .queue-item-copy h2 a{color:var(--text);text-decoration:none}
  .queue-item-copy h2 a:hover{color:var(--accent)}
  .queue-provenance{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-top:9px;color:var(--muted);font-size:13px}
  .classification-rail{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:9px 13px;border-left:3px solid var(--accent);background:var(--accent-soft)}
  .classification-rail span{color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.07em}
  .classification-rail strong{color:var(--text);font-size:15px;line-height:1.4}
  .classification-rail code{padding:0;background:transparent;color:var(--muted);font-size:11px}
  .queue-item-action{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
  .queue-item-action time{color:var(--muted);font-size:13px;white-space:nowrap}
  .review-button{display:inline-flex;align-items:center;gap:7px;padding:0;border-radius:0;background:transparent;color:var(--accent);font-size:14px;font-weight:800;line-height:1.3;text-decoration:none;white-space:nowrap;transition:color 150ms}
  .review-button:hover{background:transparent;color:var(--accent-hover);text-decoration:none}
  .review-button span{font-size:18px;line-height:.8;transition:transform 150ms}
  .review-button:hover span{transform:translateX(3px)}
  .history-link{margin:22px 0 0;text-align:right}
  .empty-state{text-align:center;color:var(--muted);padding:72px 0;font-size:16px}
  .review-sheet{max-width:920px;margin:0 auto}
  .review-detail-header{margin-bottom:28px;padding-bottom:24px;border-bottom:1px solid var(--border)}
  .review-detail-header h1{margin-bottom:14px;font-size:32px}
  .detail-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
  .review-section{margin-top:18px;padding:26px 28px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
  .review-section h2{margin-top:0}
  .review-section h3{margin:24px 0 8px;font-size:16px}
  .experience-content{margin:0;background:var(--surface-subtle);line-height:1.75}
  .scenario-list{margin:8px 0;padding-left:22px}
  .scenario-list li{margin:5px 0;white-space:pre-wrap}
  .missing-field{margin:8px 0;color:var(--warning);font-size:15px}
  .recall-list{display:grid;gap:12px}
  .recall-item{padding:18px;background:var(--surface-subtle);border:1px solid var(--border);border-radius:10px}
  .recall-item-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}
  .recall-score{flex:none;color:var(--success);font-family:var(--font-mono);font-size:13px}
  .recall-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:5px 0 10px;color:var(--muted);font-size:13px}
  .recall-chunk{padding:12px 14px;background:var(--surface);border-left:3px solid #9fcdbf;white-space:pre-wrap;font-size:15px}
  .recall-item details{margin-top:10px}
  .recall-item summary{color:var(--accent);cursor:pointer;font-size:14px;font-weight:800}
  .review-action-form{display:flex;align-items:flex-end;gap:10px;margin:0;padding:0;border:0}
  .review-action-form label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:12px}
  .review-action-form select{min-width:220px}

  @media (max-width: 768px) {
    body{padding:28px 16px 44px;font-size:16px;overflow-wrap:anywhere}
    h1{font-size:30px}
    h2{font-size:21px}
    .workbench-header{padding-top:6px;padding-bottom:24px}
    .workbench-intro{font-size:16px}
    .heading-count{min-width:28px;height:28px;margin-left:8px;font-size:12px}
    .review-queue-item{grid-template-columns:36px minmax(0,1fr);gap:12px;padding:21px 0}
    .review-queue-item:hover{margin:0 -10px;padding-right:10px;padding-left:10px}
    .queue-order{grid-column:1;grid-row:1;color:var(--accent)}
    .queue-item-copy{grid-column:2;grid-row:1}
    .classification-rail{grid-column:2;grid-row:2;padding:9px 12px;border-left:3px solid var(--accent);border-top:0}
    .queue-item-action{grid-column:2;grid-row:3;align-items:flex-start;gap:8px}
    .queue-item-action{align-items:stretch;gap:10px}
    .queue-item-action time{text-align:left}
    .review-button{justify-content:center}
    .history-link{text-align:left}
    .review-section{padding:20px}
    .review-action-form{align-items:stretch;flex-direction:column}
    .review-action-form label,.review-action-form select,.review-action-form button{width:100%}
    .muted,p{font-size:16px;line-height:1.72}
    table.review-table{table-layout:auto}
    table.review-table thead{display:none}
    table.review-table tbody,table.review-table tr,table.review-table th,table.review-table td{display:block;width:100%;box-sizing:border-box}
    table.review-table tr{margin:8px 0;border:1px solid var(--border)}
    table.review-table th,table.review-table td{border:0;padding:8px 10px}
    table.review-table th{background:var(--surface-subtle)}
    table.review-table td[data-label]::before{content:attr(data-label);display:block;margin-bottom:4px;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.02em}
  }
</style></head><body>
${body}
</body></html>`;
}
