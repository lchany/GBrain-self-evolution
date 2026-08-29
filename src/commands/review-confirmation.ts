import type { ReviewAction } from '../core/review/index.ts';

export function normalizeWebAction(action: ReviewAction): ReviewAction {
  if (action.kind === 'keep' && (action.targetType === 'knowledge' || action.targetType === 'runbook')) {
    return {
      kind: 'promote',
      sourceSlug: action.sourceSlug,
      targetSlug: action.targetSlug,
      targetType: action.targetType,
      humanConfirmation: false,
      ...(action.reviewNotes === undefined ? {} : { reviewNotes: action.reviewNotes }),
    };
  }
  return action;
}

export function requiredConfirmation(action: ReviewAction): string | null {
  switch (action.kind) {
    case 'promote':
      return `PROMOTE ${action.targetSlug}`;
    case 'merge':
      return `MERGE ${action.targetSlug}`;
    case 'reject':
    case 'needs_evidence':
    case 'keep':
    case 'repair':
    case 'cleanup':
      return null;
  }
}

export function withHumanConfirmation(action: ReviewAction): ReviewAction {
  switch (action.kind) {
    case 'promote':
    case 'merge':
      return { ...action, humanConfirmation: true };
    case 'reject':
    case 'needs_evidence':
    case 'keep':
    case 'repair':
    case 'cleanup':
      return action;
  }
}

export function hasAttestedSource(identity: unknown, sourceId: string): boolean {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return false;
  return (identity as Record<string, unknown>).source_id === sourceId;
}
