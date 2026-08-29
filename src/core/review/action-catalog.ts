import type { ReviewAction } from './types.ts';

export type ReviewActionKind = ReviewAction['kind'];
export type ReviewActionGroup = 'common' | 'rare';
export type ReviewConfirmationRequirement = 'none' | 'promote_phrase' | 'merge_phrase';

export type ReviewActionCatalogEntry = {
  readonly value: ReviewActionKind;
  readonly label: string;
  readonly explanation: string;
  readonly example: string;
  readonly requiredFields: readonly string[];
  readonly riskText: string;
  readonly group: ReviewActionGroup;
  readonly confirmationRequirement: ReviewConfirmationRequirement;
};

export const COMMON_REVIEW_ACTIONS = ['keep', 'promote', 'merge', 'needs_evidence'] as const satisfies readonly ReviewActionKind[];
export const RARE_REVIEW_ACTIONS = ['reject', 'repair', 'cleanup'] as const satisfies readonly ReviewActionKind[];

export const REVIEW_ACTION_CATALOG = {
  keep: {
    value: 'keep', label: '留在项目内', explanation: '把草稿整理为当前项目专用记录。', example: '适合只对当前项目有效的结论。',
    requiredFields: ['targetSlug', 'targetType'], riskText: '不会成为跨项目通用经验。', group: 'common', confirmationRequirement: 'none',
  },
  promote: {
    value: 'promote', label: '变成通用经验', explanation: '把已验证内容提升为可跨项目复用的经验。', example: '适合已验证并可参数化复用的方法。',
    requiredFields: ['targetSlug', 'targetType', 'confirmation'], riskText: '会进入共享知识或通用运行手册。', group: 'common', confirmationRequirement: 'promote_phrase',
  },
  merge: {
    value: 'merge', label: '合并到已有内容', explanation: '把草稿结论并入已有目标页。', example: '适合目标主题已经存在的情况。',
    requiredFields: ['targetSlug', 'targetType', 'confirmation'], riskText: '会修改已有内容，必须先核对目标页。', group: 'common', confirmationRequirement: 'merge_phrase',
  },
  needs_evidence: {
    value: 'needs_evidence', label: '先补证据', explanation: '保留草稿并标记尚缺少的验证材料。', example: '适合结论合理但证据不足的情况。',
    requiredFields: ['reviewNotes'], riskText: '证据补齐前不能提升为通用经验。', group: 'common', confirmationRequirement: 'none',
  },
  reject: {
    value: 'reject', label: '丢弃这条草稿', explanation: '记录拒绝原因并结束这条草稿的审核。', example: '适合错误、重复或没有保留价值的内容。',
    requiredFields: ['reviewNotes'], riskText: '草稿将不再进入正常审核流程。', group: 'rare', confirmationRequirement: 'none',
  },
  repair: {
    value: 'repair', label: '修复审核记录', explanation: '修正不完整或不一致的审核记录。', example: '适合审核记录写入后需要修复的情况。',
    requiredFields: [], riskText: '仅用于修复审核状态，不替代正常审核。', group: 'rare', confirmationRequirement: 'none',
  },
  cleanup: {
    value: 'cleanup', label: '清理草稿残留', explanation: '清理已完成流程遗留的 inbox 草稿。', example: '适合目标页和审核记录都已确认存在的情况。',
    requiredFields: [], riskText: '可能移除草稿，执行前必须确认流程已经完成。', group: 'rare', confirmationRequirement: 'none',
  },
} as const satisfies Record<ReviewActionKind, ReviewActionCatalogEntry>;

export function reviewActionCatalogEntry(action: string): ReviewActionCatalogEntry | null {
  switch (action) {
    case 'keep': return REVIEW_ACTION_CATALOG.keep;
    case 'promote': return REVIEW_ACTION_CATALOG.promote;
    case 'merge': return REVIEW_ACTION_CATALOG.merge;
    case 'needs_evidence': return REVIEW_ACTION_CATALOG.needs_evidence;
    case 'reject': return REVIEW_ACTION_CATALOG.reject;
    case 'repair': return REVIEW_ACTION_CATALOG.repair;
    case 'cleanup': return REVIEW_ACTION_CATALOG.cleanup;
    default: return null;
  }
}
