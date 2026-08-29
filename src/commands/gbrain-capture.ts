import { buildCandidate, buildCandidateMarkdown, parseSensitivity, parseSuggestedType, parseVerification, assertInboxSlug } from './gbrain-capture-candidate.ts';
import type { CaptureCandidate, Sensitivity, SuggestedType, Verification } from './gbrain-capture-candidate.ts';
import { listOfflineCandidateFiles, readOfflineCandidate, removeOfflineCandidate, writeOfflineCandidate } from './gbrain-capture-queue.ts';
import { createLocalWriterToolCaller, MissingWriterCredentialsError } from './gbrain-capture-writer.ts';
import { RemoteMcpError } from '../core/mcp-client.ts';

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

interface RunDeps {
  readonly cwd: string;
  readonly now: () => Date;
  readonly callTool: ToolCaller;
}

interface ParsedCaptureArgs {
  readonly title: string;
  readonly suggestedType: SuggestedType;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly requestedVerification: Verification;
  readonly sensitivity: Sensitivity;
  readonly projectId?: string;
  readonly json: boolean;
}

interface RetryArgs {
  readonly json: boolean;
}

const STRUCTURED_FLAGS: ReadonlySet<string> = new Set(['--title', '--summary', '--body', '--evidence']);

export function isGbrainCaptureArgs(args: readonly string[]): boolean {
  return args[0] === 'retry' || args.some((arg) => STRUCTURED_FLAGS.has(arg));
}

export async function runGbrainCapture(args: string[], deps: Partial<RunDeps> = {}): Promise<void> {
  const resolvedDeps: RunDeps = {
    cwd: deps.cwd ?? process.cwd(),
    now: deps.now ?? (() => new Date()),
    callTool: deps.callTool ?? createLocalWriterToolCaller(),
  };
  if (args[0] === 'retry') {
    await retryOffline(args.slice(1), resolvedDeps);
    return;
  }
  const parsed = parseCaptureArgs(args);
  const candidate = buildCandidate({
    title: parsed.title,
    suggestedType: parsed.suggestedType,
    summary: parsed.summary,
    evidenceRefs: parsed.evidenceRefs,
    requestedVerification: parsed.requestedVerification,
    sensitivity: parsed.sensitivity,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    now: resolvedDeps.now(),
  });
  const result = await writeOnlineOrQueue(candidate, parsed.json, resolvedDeps);
  printCaptureResult(result, parsed.json);
}

function parseCaptureArgs(args: readonly string[]): ParsedCaptureArgs {
  let title: string | undefined;
  let suggestedType: SuggestedType = 'knowledge';
  let summary: string | undefined;
  const evidenceRefs: string[] = [];
  let requestedVerification: Verification = 'unverified';
  let sensitivity: Sensitivity = 'internal';
  let projectId: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--title') { title = requiredValue(args, ++i, arg); continue; }
    if (arg === '--type' || arg === '--suggested-type') { suggestedType = parseSuggestedType(requiredValue(args, ++i, arg)); continue; }
    if (arg === '--summary' || arg === '--body') { summary = requiredValue(args, ++i, arg); continue; }
    if (arg === '--evidence') { evidenceRefs.push(requiredValue(args, ++i, arg)); continue; }
    if (arg === '--verification') { requestedVerification = parseVerification(requiredValue(args, ++i, arg)); continue; }
    if (arg === '--sensitivity') { sensitivity = parseSensitivity(requiredValue(args, ++i, arg)); continue; }
    if (arg === '--project-id') { projectId = requiredValue(args, ++i, arg); continue; }
    throw new Error(`unknown structured capture argument: ${arg}`);
  }
  if (!title) throw new Error('structured capture requires --title');
  if (!summary) throw new Error('structured capture requires --summary or --body');
  return { title, suggestedType, summary, evidenceRefs, requestedVerification, sensitivity, ...(projectId ? { projectId } : {}), json };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function writeOnlineOrQueue(candidate: CaptureCandidate, json: boolean, deps: RunDeps): Promise<Record<string, unknown>> {
  try {
    const slug = await putCandidate(candidate, deps.callTool);
    return { ok: true, mode: 'online', slug, status: 'draft', verification: 'unverified', search_before_create: true };
  } catch (error) {
    const offlinePath = writeOfflineCandidate(deps.cwd, candidate, queueReason(error), deps.now());
    return { ok: true, mode: 'offline', offline_path: offlinePath, slug: candidate.slug, status: 'draft', verification: 'unverified', search_before_create: true, ...(json ? { reason: queueReason(error) } : {}) };
  }
}

async function putCandidate(candidate: CaptureCandidate, callTool: ToolCaller): Promise<string> {
  const searchResult = await callTool('search', { query: candidate.title, limit: 5 });
  const slug = selectWriteSlug(candidate.slug, searchResult);
  const selected = slug === candidate.slug ? candidate : { ...candidate, slug };
  await callTool('put_page', { slug: selected.slug, content: buildCandidateMarkdown(selected) });
  return selected.slug;
}

function selectWriteSlug(candidateSlug: string, searchResult: unknown): string {
  const exact = resultSlugs(searchResult).find((slug) => slug === candidateSlug);
  return assertInboxSlug(exact ?? candidateSlug);
}

function resultSlugs(searchResult: unknown): readonly string[] {
  if (!Array.isArray(searchResult)) return [];
  return searchResult.flatMap((item) => {
    if (typeof item === 'object' && item !== null && 'slug' in item && typeof item.slug === 'string') {
      return [item.slug];
    }
    return [];
  });
}

function queueReason(error: unknown): string {
  if (error instanceof MissingWriterCredentialsError) return 'writer_credentials_unavailable';
  if (error instanceof RemoteMcpError) return `writer_${error.reason}`;
  return 'writer_unavailable';
}

async function retryOffline(args: readonly string[], deps: RunDeps): Promise<void> {
  const parsed = parseRetryArgs(args);
  const files = listOfflineCandidateFiles(deps.cwd);
  const retried: string[] = [];
  const remaining: string[] = [];
  for (const file of files) {
    try {
      const record = readOfflineCandidate(file);
      const slug = await putCandidate(record.candidate, deps.callTool);
      removeOfflineCandidate(file);
      retried.push(slug);
    } catch {
      remaining.push(file);
    }
  }
  printRetryResult({ ok: remaining.length === 0, retried: retried.length, remaining: remaining.length, slugs: retried }, parsed.json);
}

function parseRetryArgs(args: readonly string[]): RetryArgs {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') { json = true; continue; }
    throw new Error(`unknown retry argument: ${arg}`);
  }
  return { json };
}

function printCaptureResult(result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`captured ${result.mode}: ${result.slug}`);
}

function printRetryResult(result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`retried: ${result.retried}; remaining: ${result.remaining}`);
}

export const __testing = {
  assertInboxSlug,
  buildCandidate,
  buildCandidateMarkdown,
  isGbrainCaptureArgs,
  parseCaptureArgs,
  selectWriteSlug,
};
