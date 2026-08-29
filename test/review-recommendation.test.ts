import { describe, expect, test } from 'bun:test';
import {
  REVIEW_CATEGORY_LABELS,
  ReviewRecommendationCache,
  buildClassificationAction,
  generateClassificationTargetSlug,
  parseModelRecommendationJson,
  parseReviewRecommendation,
  recommendationCacheKey,
  type ReviewSourcePage,
} from '../src/core/review/index.ts';

function source(frontmatter: Record<string, unknown> = {}): ReviewSourcePage {
  return {
    slug: 'inbox/example',
    type: 'incident',
    title: '示例',
    compiledTruth: '已验证结论',
    timeline: '',
    frontmatter,
  };
}

describe('review recommendation contract', () => {
  test('accepts the five categories and their Chinese labels', () => {
    expect(REVIEW_CATEGORY_LABELS).toEqual({
      project: '项目经验',
      knowledge: '通用知识',
      runbook: '操作手册',
      incident: '故障经验',
      reject: '拒绝并删除',
    });
  });

  test('accepts a strict model recommendation and rejects unknown fields', () => {
    const valid = JSON.stringify({
      category: 'incident',
      scenario: '服务故障复盘。',
      reason: '包含可验证根因。',
      generated_by: 'model',
    });
    expect(parseModelRecommendationJson(valid)?.category).toBe('incident');
    expect(parseModelRecommendationJson(valid.slice(0, -1) + ',"target":"incidents/x"}')).toBeNull();
    expect(parseModelRecommendationJson('```json\n' + valid + '\n```')).toBeNull();
  });

  test('project recommendations require a bound canonical project id', () => {
    const value = { category: 'project', scenario: '项目约束。', reason: '仅本项目适用。', generated_by: 'model' };
    expect(parseReviewRecommendation(value, { frontmatter: {} })).toBeNull();
    expect(parseReviewRecommendation(value, {
      frontmatter: { project_binding: 'bound', project_id: 'prj-0123456789abcdef' },
    })?.category).toBe('project');
  });

  test('cache key changes with content and bounded cache evicts the oldest entry', () => {
    const page = { source_id: 'default', slug: 'inbox/a', content_hash: 'one', updated_at: new Date(0) };
    expect(recommendationCacheKey(page)).not.toBe(recommendationCacheKey({ ...page, content_hash: 'two' }));
    const cache = new ReviewRecommendationCache(1);
    const recommendation = { category: 'incident', scenario: '场景', reason: '理由', generated_by: 'model' } as const;
    cache.set('one', recommendation);
    cache.set('two', recommendation);
    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('two')).toEqual(recommendation);
  });
});

describe('review classification mapping', () => {
  test('maps archive categories to internal keep actions and reject to deletion', () => {
    expect(buildClassificationAction('knowledge', source())).toMatchObject({
      kind: 'keep', targetType: 'knowledge', targetSlug: 'knowledge/example',
    });
    expect(buildClassificationAction('runbook', source())).toMatchObject({
      kind: 'keep', targetType: 'runbook', targetSlug: 'runbooks/example',
    });
    expect(buildClassificationAction('incident', source())).toMatchObject({
      kind: 'keep', targetType: 'incident', targetSlug: 'incidents/example',
    });
    expect(buildClassificationAction('reject', source())).toMatchObject({ kind: 'reject' });
  });

  test('project classification requires and uses a canonical project id', () => {
    expect(buildClassificationAction('project', source())).toBeNull();
    const bound = source({ project_binding: 'bound', project_id: 'prj-0123456789abcdef' });
    expect(buildClassificationAction('project', bound)).toMatchObject({
      kind: 'keep', targetType: 'project', targetSlug: 'projects/prj-0123456789abcdef/example',
    });
    expect(generateClassificationTargetSlug('outside/example', 'incident')).toBeNull();
  });
});
