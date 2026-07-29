import { scrubPii } from './eval-capture-scrub.ts';

const REDACTED = '[REDACTED]';
const SECRET_LIKE_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|github_pat_[A-Za-z0-9_]+|xox[A-Za-z0-9_-]+|gbrain_[A-Za-z0-9_-]{8,})\b/i;
const SECRET_LIKE_RE_GLOBAL = /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|github_pat_[A-Za-z0-9_]+|xox[A-Za-z0-9_-]+|gbrain_[A-Za-z0-9_-]{8,})\b/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const RAW_TRANSCRIPT_RE = /\b(?:raw transcript|full transcript|raw tool output|full tool output)\b|^\s*(?:Assistant|User|System|Tool|assistant_message|user_message|system_message|tool_result)\s*:/im;
const RAW_JSON_RE = /^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/;
const RAW_AUTH_RESPONSE_RE = /(?:^|\n)\s*(?:HTTP\/\d(?:\.\d)?\s+\d{3}|(?:access_token|refresh_token|id_token|client_secret|authorization)\s*[:=])/im;
const RAW_ENV_RE = /(?:^|\s)(?:export\s+)?[A-Z_][A-Z0-9_]{1,}=.*$/m;
const LOG_LINE_RE = /^\s*(?:\[[^\]\n]{1,40}\]|\d{4}-\d{2}-\d{2}[T ][^\n]{0,40}|(?:INFO|WARN|ERROR|DEBUG|TRACE)\b|(?:stdout|stderr)>|\+\s|\$\s).{20,}$/i;
const STACK_LINE_RE = /^\s*(?:at\s+\S+\s+\(|File "[^"]+", line \d+|Traceback \(most recent call last\)|Caused by:|Error: ).{10,}$/;
const DENSE_LOG_LINE_THRESHOLD = 12;

export type ForbiddenContentKind = 'sensitive' | 'raw' | 'dense_log';

function hasDenseLogs(input: string): boolean {
  return input.split('\n').filter((line) => LOG_LINE_RE.test(line) || STACK_LINE_RE.test(line)).length >= DENSE_LOG_LINE_THRESHOLD;
}

export function classifyForbiddenContent(input: string): ForbiddenContentKind | null {
  if (RAW_TRANSCRIPT_RE.test(input) || RAW_JSON_RE.test(input) || RAW_AUTH_RESPONSE_RE.test(input) || RAW_ENV_RE.test(input)) return 'raw';
  if (hasDenseLogs(input)) return 'dense_log';
  if (scrubPii(input) !== input || SECRET_LIKE_RE.test(input) || PRIVATE_KEY_RE.test(input)) return 'sensitive';
  return null;
}

export function redactSensitiveContent(input: string): string {
  return scrubPii(input)
    .replace(PRIVATE_KEY_BLOCK_RE, REDACTED)
    .replace(SECRET_LIKE_RE_GLOBAL, REDACTED);
}
