import type { Page } from '../types.ts';
import { PROJECT_ID_RE } from '../project-context.ts';

export const REVIEW_CATEGORIES = ['project', 'knowledge', 'runbook', 'incident', 'reject'] as const;

export type ReviewCategory = typeof REVIEW_CATEGORIES[number];

export const REVIEW_CATEGORY_LABELS: Readonly<Record<ReviewCategory, string>> = {
  project: '项目经验',
  knowledge: '通用知识',
  runbook: '操作手册',
  incident: '故障经验',
  reject: '拒绝并删除',
};

export interface ReviewRecommendation {
  readonly category: ReviewCategory;
  readonly scenario: string;
  readonly reason: string;
  readonly generated_by: 'model';
}

export interface ReviewRecommendationInput {
  readonly title: string;
  readonly type: string;
  readonly projectId: string | null;
  readonly verification: string;
  readonly applicability: string;
  readonly nonApplicable: string;
  readonly contentPreview: string;
}

export type ReviewRecommendationProvider = (
  input: ReviewRecommendationInput,
) => Promise<ReviewRecommendation>;

export function parseReviewCategory(value: unknown): ReviewCategory | null {
  return typeof value === 'string' && REVIEW_CATEGORIES.includes(value as ReviewCategory)
    ? value as ReviewCategory
    : null;
}

export function parseReviewRecommendation(value: unknown, page?: Pick<Page, 'frontmatter'>): ReviewRecommendation | null {
  if (!isPlainObject(value)) return null;
  const category = parseReviewCategory(value.category);
  const scenario = boundedText(value.scenario);
  const reason = boundedText(value.reason);
  if (category === null || scenario === null || reason === null || value.generated_by !== 'model') return null;
  if (category === 'project' && page !== undefined && !hasBoundProject(page.frontmatter)) return null;
  return { category, scenario, reason, generated_by: 'model' };
}

export function parseModelRecommendationJson(text: string, page?: Pick<Page, 'frontmatter'>): ReviewRecommendation | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value) || Object.keys(value).some((key) => !['category', 'scenario', 'reason', 'generated_by'].includes(key))) {
      return null;
    }
    return parseReviewRecommendation(value, page);
  } catch {
    return null;
  }
}

export function recommendationCacheKey(page: Pick<Page, 'source_id' | 'slug' | 'content_hash' | 'updated_at'>): string {
  return `${page.source_id}\u0000${page.slug}\u0000${page.content_hash ?? page.updated_at.toISOString()}`;
}

export class ReviewRecommendationCache {
  readonly #entries = new Map<string, ReviewRecommendation>();

  constructor(readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('recommendation cache capacity must be positive');
  }

  get(key: string): ReviewRecommendation | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: ReviewRecommendation): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

function hasBoundProject(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.project_binding === 'bound'
    && typeof frontmatter.project_id === 'string'
    && PROJECT_ID_RE.test(frontmatter.project_id);
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 500 ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
