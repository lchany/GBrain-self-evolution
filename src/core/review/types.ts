import type { PageType } from '../types.ts';

export const REVIEW_TARGET_TYPES = [
  'knowledge',
  'runbook',
  'incident',
  'decision',
  'project',
  'environment',
  'agent-skill',
] as const;

export type ReviewTargetType = typeof REVIEW_TARGET_TYPES[number];

export type ReviewAction =
  | { readonly kind: 'reject'; readonly sourceSlug: string; readonly reviewNotes?: string }
  | { readonly kind: 'needs_evidence'; readonly sourceSlug: string; readonly reviewNotes?: string; readonly evidenceRefs?: readonly string[] }
  | { readonly kind: 'keep'; readonly sourceSlug: string; readonly targetSlug: string; readonly targetType: ReviewTargetType; readonly reviewNotes?: string; readonly evidenceRefs?: readonly string[] }
  | { readonly kind: 'promote'; readonly sourceSlug: string; readonly targetSlug: string; readonly targetType: ReviewTargetType; readonly humanConfirmation: boolean; readonly reviewNotes?: string; readonly evidenceRefs?: readonly string[] }
  | { readonly kind: 'merge'; readonly sourceSlug: string; readonly targetSlug: string; readonly targetType: ReviewTargetType; readonly humanConfirmation: boolean; readonly reviewNotes?: string; readonly evidenceRefs?: readonly string[] }
  | { readonly kind: 'repair'; readonly sourceSlug: string; readonly reviewNotes?: string }
  | { readonly kind: 'cleanup'; readonly sourceSlug: string; readonly reviewNotes?: string };

export type ReviewGateCode =
  | 'ok'
  | 'source_not_found'
  | 'source_slug_not_inbox'
  | 'review_date_required'
  | 'frontmatter_invalid'
  | 'missing_required_frontmatter'
  | 'missing_non_applicable'
  | 'missing_source_refs'
  | 'unsafe_content'
  | 'target_slug_required'
  | 'target_slug_invalid'
  | 'target_type_invalid'
  | 'project_binding_required'
  | 'project_path_mismatch'
  | 'promote_confirmation_required'
  | 'unverified_promote'
  | 'duplicate_target'
  | 'merge_target_missing'
  | 'plan_not_applicable'
  | 'apply_step_failed';

export type ReviewGateResult =
  | { readonly ok: true; readonly code: 'ok'; readonly message: string; readonly details?: readonly string[] }
  | { readonly ok: false; readonly code: Exclude<ReviewGateCode, 'ok'>; readonly message: string; readonly details?: readonly string[]; readonly candidates?: readonly DuplicateCandidate[] };

export interface ReviewSourcePage {
  readonly slug: string;
  readonly markdown?: string;
  readonly type?: PageType;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly compiledTruth?: string;
  readonly timeline?: string;
  readonly frontmatter?: Record<string, unknown>;
}

export interface ParsedReviewPage {
  readonly slug: string;
  readonly type: PageType;
  readonly title: string;
  readonly tags: readonly string[];
  readonly compiledTruth: string;
  readonly timeline: string;
  readonly frontmatter: Record<string, unknown>;
}

export interface DuplicateSearchRequest {
  readonly sourceSlug: string;
  readonly targetSlug: string;
  readonly title: string;
  readonly targetType: ReviewTargetType;
}

export interface DuplicateCandidate {
  readonly slug: string;
  readonly title: string;
  readonly score?: number;
}

export interface ReviewCoreDeps {
  readonly readPage: (slug: string) => Promise<ReviewSourcePage | null>;
  readonly searchDuplicates: (request: DuplicateSearchRequest) => Promise<readonly DuplicateCandidate[]>;
  readonly writePage?: (page: BuiltReviewPage) => Promise<ReviewStepReceipt>;
  readonly verifyPage?: (slug: string) => Promise<ReviewStepReceipt>;
  readonly deletePage?: (slug: string) => Promise<ReviewStepReceipt>;
}

export interface ReviewPlanRequest {
  readonly action: ReviewAction;
  readonly reviewDate: string;
}

export interface BuiltReviewPage {
  readonly slug: string;
  readonly type: PageType;
  readonly title: string;
  readonly frontmatter: Record<string, unknown>;
  readonly compiledTruth: string;
  readonly timeline: string;
  readonly markdown: string;
}

export type ReviewStepKind = 'write_target' | 'verify_target' | 'write_review' | 'delete_source' | 'keep_source';

export interface ReviewStepPlan {
  readonly kind: ReviewStepKind;
  readonly slug: string;
  readonly page?: BuiltReviewPage;
}

export interface ReviewWritePlan {
  readonly action: ReviewAction;
  readonly source: ParsedReviewPage;
  readonly targetPage?: BuiltReviewPage;
  readonly reviewPage: BuiltReviewPage;
  readonly steps: readonly ReviewStepPlan[];
}

export interface ReviewPlanResult {
  readonly ok: boolean;
  readonly code: ReviewGateCode;
  readonly message: string;
  readonly gates: readonly ReviewGateResult[];
  readonly plan?: ReviewWritePlan;
}

export interface ReviewStepReceipt {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

export interface ReviewApplyResult {
  readonly ok: boolean;
  readonly code: ReviewGateCode;
  readonly message: string;
  readonly receipts: readonly ReviewStepReceipt[];
}
