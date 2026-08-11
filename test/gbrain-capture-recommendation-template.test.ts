import { describe, expect, test } from 'bun:test';
import { GBRAIN_CAPTURE_SKILL, GBRAIN_CLIENT_RULES } from '../src/commands/gbrain-client-installer-content.ts';

describe('GBrain capture-time review recommendation', () => {
  test('client rules require a real model recommendation before human classification', () => {
    expect(GBRAIN_CLIENT_RULES).toContain('每个新草稿必须由大模型写入 `review_recommendation`');
    expect(GBRAIN_CLIENT_RULES).toContain('“拒绝并删除”也是分类之一');
    expect(GBRAIN_CAPTURE_SKILL).toContain('review_recommendation:');
    expect(GBRAIN_CAPTURE_SKILL).toContain('category: <project|knowledge|runbook|incident|reject>');
    expect(GBRAIN_CAPTURE_SKILL).toContain('generated_by: model');
    expect(GBRAIN_CAPTURE_SKILL).toContain('不能要求用户先选分类');
  });
});
