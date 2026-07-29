import { classifyForbiddenContent, redactSensitiveContent } from '../forbidden-content.ts';

export const BROWSER_SAFE_HIDDEN_TEXT = '内容已隐藏，请通过本地审核工具查看。';
export const REVIEW_ERROR_TEXT = '审核操作失败，请查看服务端日志。';
export const REVIEW_ERROR_CODE = 'review_error';
export const BROWSER_SAFE_PREVIEW_MAX_CHARS = 2000;

export type BrowserSafeProjectionPurpose = 'metadata' | 'preview';

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(textValue).join(', ');
  return JSON.stringify(value) ?? '';
}

function stripFrontmatter(input: string): string {
  return input.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function projectBrowserSafeText(value: unknown, purpose: BrowserSafeProjectionPurpose = 'metadata'): string {
  try {
    const text = purpose === 'preview' ? stripFrontmatter(textValue(value)) : textValue(value);
    const category = classifyForbiddenContent(text);
    if (category === 'raw' || category === 'dense_log') return BROWSER_SAFE_HIDDEN_TEXT;
    const redacted = redactSensitiveContent(text);
    if (purpose === 'metadata') return redacted;
    return redacted.replace(/\s+/g, ' ').trim().slice(0, BROWSER_SAFE_PREVIEW_MAX_CHARS);
  } catch {
    return BROWSER_SAFE_HIDDEN_TEXT;
  }
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function browserSafeHtml(value: unknown, purpose: BrowserSafeProjectionPurpose = 'metadata'): string {
  return escapeHtml(projectBrowserSafeText(value, purpose));
}

export function browserSafeReviewError(_cause: unknown): { readonly code: 'review_error'; readonly message: string } {
  return { code: REVIEW_ERROR_CODE, message: REVIEW_ERROR_TEXT };
}
