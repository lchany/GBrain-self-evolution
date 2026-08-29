import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { applyReviewPlan, planReview, type ReviewAction, type ReviewTargetType } from '../core/review/index.ts';
import { createLocalWriterToolCaller } from './gbrain-capture-writer.ts';
import { createLocalReadToolCaller } from './gbrain-review-reader.ts';
import { applyDeps, filterByProject, inboxPages, readPage, resultSlugs, reviewDeps, slugPrefix } from './gbrain-review-tools.ts';
import { fail, printApply, printHelp, printList, printPlan, printResult, printShow } from './gbrain-review-render.ts';

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RunDeps {
  readonly callReadTool: ToolCaller;
  readonly callWriteTool: ToolCaller;
  readonly now: () => Date;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly inputLines?: readonly string[];
}

export interface Flags {
  readonly json: boolean;
  readonly stale: boolean;
  readonly sourceSlug?: string;
  readonly targetSlug?: string;
  readonly targetType?: ReviewTargetType;
  readonly reason?: string;
  readonly confirm?: string;
  readonly action?: string;
  readonly limit?: number;
  readonly status?: string;
  readonly verification?: string;
  readonly projectId?: string;
}

const WRITE_COMMANDS = ['reject', 'needs-evidence', 'keep', 'promote', 'merge', 'repair', 'cleanup'] as const;
type WriteCommand = typeof WRITE_COMMANDS[number];

export async function runGbrainReview(args: readonly string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const resolved = resolveDeps(deps);
  try {
    if (args.length === 0) return runInteractive(resolved);
    const [command, ...rest] = args;
    switch (command) {
      case 'list': return runList(parseFlags(rest), resolved);
      case 'show': return runShow(parseFlags(rest, true), resolved);
      case 'plan': return runPlan(parseFlags(rest, true), resolved);
      case 'verify': return runVerify(parseFlags(rest, true), resolved);
      case 'reject':
      case 'needs-evidence':
      case 'keep':
      case 'promote':
      case 'merge':
      case 'repair':
      case 'cleanup':
        return runWrite(command, parseFlags(rest, true), resolved);
      case '--help':
      case '-h':
        printHelp(resolved.stdout);
        return 0;
      default:
        return fail({ ok: false, code: 'unknown_command', message: `未知 review 子命令: ${command}` }, parseFlags(rest), resolved);
    }
  } catch (error) {
    resolved.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function resolveDeps(deps: Partial<RunDeps>): RunDeps {
  return {
    callReadTool: deps.callReadTool ?? createLocalReadToolCaller(),
    callWriteTool: deps.callWriteTool ?? createLocalWriterToolCaller(),
    now: deps.now ?? (() => new Date()),
    stdout: deps.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps.stderr ?? ((text) => process.stderr.write(text)),
    ...(deps.inputLines ? { inputLines: deps.inputLines } : {}),
  };
}

function parseFlags(args: readonly string[], firstIsSource = false): Flags {
  const parsed: { sourceSlug?: string; targetSlug?: string; targetType?: ReviewTargetType; reason?: string; confirm?: string; action?: string; limit?: number; status?: string; verification?: string; projectId?: string } = {};
  let json = false;
  let stale = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (firstIsSource && parsed.sourceSlug === undefined && !arg.startsWith('--')) { parsed.sourceSlug = arg; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--stale') { stale = true; continue; }
    if (arg === '--target') { parsed.targetSlug = requiredValue(args, ++i, arg); continue; }
    if (arg === '--type') { parsed.targetType = parseTargetType(requiredValue(args, ++i, arg)); continue; }
    if (arg === '--reason') { parsed.reason = requiredValue(args, ++i, arg); continue; }
    if (arg === '--confirm') { parsed.confirm = requiredValue(args, ++i, arg); continue; }
    if (arg === '--action') { parsed.action = requiredValue(args, ++i, arg); continue; }
    if (arg === '--limit') { parsed.limit = Number(requiredValue(args, ++i, arg)); continue; }
    if (arg === '--status') { parsed.status = requiredValue(args, ++i, arg); continue; }
    if (arg === '--verification') { parsed.verification = requiredValue(args, ++i, arg); continue; }
    if (arg === '--project-id') { parsed.projectId = requiredValue(args, ++i, arg); continue; }
    throw new Error(`unknown review argument: ${arg}`);
  }
  return { json, stale, ...parsed };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseTargetType(value: string): ReviewTargetType {
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
      throw new Error(`unknown review target type: ${value}`);
  }
}

async function runList(flags: Flags, deps: RunDeps): Promise<number> {
  const request: Record<string, unknown> = { include_prefixes: ['inbox/'], limit: flags.limit ?? 50 };
  if (flags.targetType) request.type = flags.targetType;
  if (flags.status) request.status = flags.status;
  if (flags.verification) request.verification = flags.verification;
  const pages = await inboxPages(await deps.callReadTool('list_pages', request));
  printList(flags.projectId ? await filterByProject(pages, flags.projectId, deps.callReadTool) : pages, flags, deps.stdout);
  return 0;
}

async function runShow(flags: Flags, deps: RunDeps): Promise<number> {
  const page = await readPage(deps.callReadTool, requireSource(flags));
  if (page === null) return fail({ ok: false, code: 'source_not_found', message: '找不到待审核 inbox 草稿。' }, flags, deps);
  printShow(page, flags, deps.stdout);
  return 0;
}

async function runPlan(flags: Flags, deps: RunDeps): Promise<number> {
  if (requiresReviewNotes(flags.action) && reviewNotes(flags.reason) === undefined) {
    return fail({ ok: false, code: 'reason_required', message: '拒绝或需要补证据必须填写 reason。' }, flags, deps);
  }
  const result = await planReview(reviewDeps(deps.callReadTool), { action: buildPlanAction(flags), reviewDate: reviewDate(deps.now()) });
  printPlan(result, flags, deps.stdout);
  return result.ok ? 0 : 1;
}

async function runVerify(flags: Flags, deps: RunDeps): Promise<number> {
  const slug = requireSource(flags);
  const page = await readPage(deps.callReadTool, slug);
  const results = resultSlugs(await deps.callReadTool('search', { query: slug, include_prefixes: [slugPrefix(slug)], limit: 5 }));
  const ok = page !== null && results.includes(slug);
  printResult({ ok, code: ok ? 'ok' : 'target_not_retrievable', slug, retrieval_verified: ok }, deps.stdout);
  return ok ? 0 : 1;
}

async function runWrite(command: WriteCommand, flags: Flags, deps: RunDeps): Promise<number> {
  if (requiresReviewNotes(command) && reviewNotes(flags.reason) === undefined) {
    return fail({ ok: false, code: 'reason_required', message: '拒绝或需要补证据必须填写 reason。' }, flags, deps);
  }
  const planned = await planReview(reviewDeps(deps.callReadTool), { action: buildWriteAction(command, flags), reviewDate: reviewDate(deps.now()) });
  if (!planned.ok || planned.plan === undefined) { printPlan(planned, flags, deps.stdout); return 1; }
  const applied = await applyReviewPlan(applyDeps(deps.callWriteTool), planned.plan);
  printApply(planned, applied, flags, deps.stdout);
  return applied.ok ? 0 : 1;
}

function buildPlanAction(flags: Flags): ReviewAction {
  if (flags.action === 'reject' || flags.action === 'needs_evidence' || flags.action === 'needs-evidence' || flags.action === 'repair' || flags.action === 'cleanup') return buildWriteAction(normalizeWriteCommand(flags.action), flags);
  const targetType = requireTargetType(flags);
  const targetSlug = requireTarget(flags);
  if (flags.action === 'merge') return { kind: 'merge', sourceSlug: requireSource(flags), targetSlug, targetType, humanConfirmation: flags.confirm === `MERGE ${targetSlug}` };
  if (flags.action === 'keep') return { kind: 'keep', sourceSlug: requireSource(flags), targetSlug, targetType };
  if (targetType === 'knowledge' || targetType === 'runbook' || flags.action === 'promote') return { kind: 'promote', sourceSlug: requireSource(flags), targetSlug, targetType, humanConfirmation: flags.confirm === `PROMOTE ${targetSlug}` };
  return { kind: 'keep', sourceSlug: requireSource(flags), targetSlug, targetType };
}

function buildWriteAction(command: WriteCommand, flags: Flags): ReviewAction {
  const sourceSlug = requireSource(flags);
  switch (command) {
    case 'reject': return { kind: 'reject', sourceSlug, reviewNotes: reviewNotes(flags.reason) };
    case 'needs-evidence': return { kind: 'needs_evidence', sourceSlug, reviewNotes: reviewNotes(flags.reason) };
    case 'repair': return { kind: 'repair', sourceSlug, reviewNotes: flags.reason };
    case 'cleanup': return { kind: 'cleanup', sourceSlug, reviewNotes: flags.reason };
    case 'keep': return buildKeepAction(sourceSlug, flags);
    case 'promote': return { kind: 'promote', sourceSlug, targetSlug: requireTarget(flags), targetType: requireTargetType(flags), humanConfirmation: flags.confirm === `PROMOTE ${requireTarget(flags)}`, reviewNotes: reviewNotes(flags.reason) };
    case 'merge': return { kind: 'merge', sourceSlug, targetSlug: requireTarget(flags), targetType: requireTargetType(flags), humanConfirmation: flags.confirm === `MERGE ${requireTarget(flags)}`, reviewNotes: reviewNotes(flags.reason) };
  }
}

function buildKeepAction(sourceSlug: string, flags: Flags): ReviewAction {
  const targetSlug = requireTarget(flags);
  const targetType = requireTargetType(flags);
  if (targetType === 'knowledge' || targetType === 'runbook') return { kind: 'promote', sourceSlug, targetSlug, targetType, humanConfirmation: flags.confirm === `PROMOTE ${targetSlug}`, reviewNotes: reviewNotes(flags.reason) };
  return { kind: 'keep', sourceSlug, targetSlug, targetType, reviewNotes: reviewNotes(flags.reason) };
}

function requiresReviewNotes(command: string | undefined): boolean {
  return command === 'reject' || command === 'needs-evidence' || command === 'needs_evidence';
}

function reviewNotes(reason: string | undefined): string | undefined {
  const value = reason?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function normalizeWriteCommand(value: string): WriteCommand {
  if (value === 'needs_evidence') return 'needs-evidence';
  for (const command of WRITE_COMMANDS) if (value === command) return command;
  throw new Error(`unknown review action: ${value}`);
}

async function runInteractive(deps: RunDeps): Promise<number> {
  const pages = await inboxPages(await deps.callReadTool('list_pages', { include_prefixes: ['inbox/'], limit: 50 }));
  printList(pages, { json: false, stale: false }, deps.stdout);
  if (pages.length === 0) return 0;
  const input = lineReader(deps);
  try {
    const selected = Number(await input.ask('选择要审核的 draft: '));
    const page = pages[selected - 1];
    if (page === undefined) return fail({ ok: false, code: 'invalid_selection', message: '选择的 draft 编号不存在。' }, { json: false, stale: false }, deps);
    deps.stdout(`草稿: ${page.slug}\n选择处置动作: needs-evidence / reject / keep / promote / merge\n`);
    const command = normalizeInteractiveAction(await input.ask('选择处置动作: '));
    if (command === 'reject' || command === 'needs-evidence') return runWrite(command, { json: false, stale: false, sourceSlug: page.slug, reason: await input.ask('原因: ') }, deps);
    const targetSlug = await input.ask('目标 slug: ');
    const targetType = parseTargetType(await input.ask('目标类型: '));
    const confirm = command === 'promote'
      ? await input.ask(`请输入确认短语：PROMOTE ${targetSlug}: `)
      : command === 'merge'
        ? await input.ask(`请输入确认短语：MERGE ${targetSlug}: `)
        : targetSlug;
    return runWrite(command, { json: false, stale: false, sourceSlug: page.slug, targetSlug, targetType, confirm }, deps);
  } finally {
    input.close();
  }
}

function normalizeInteractiveAction(value: string): WriteCommand {
  if (value === 'needs_evidence') return 'needs-evidence';
  if (value === 'needs-evidence' || value === 'reject' || value === 'keep' || value === 'promote' || value === 'merge') return value;
  throw new Error(`unknown interactive review action: ${value}`);
}

function lineReader(deps: RunDeps): { readonly ask: (prompt: string) => Promise<string>; readonly close: () => void } {
  if (deps.inputLines) {
    let index = 0;
    return { ask: async (prompt) => { deps.stdout(`? ${prompt}\n`); return deps.inputLines?.[index++] ?? ''; }, close: () => {} };
  }
  const rl = createInterface({ input: processStdin, output: processStdout });
  return { ask: (prompt) => rl.question(`? ${prompt}`), close: () => rl.close() };
}

function requireSource(flags: Flags): string {
  if (!flags.sourceSlug) throw new Error('review command requires an inbox slug');
  return flags.sourceSlug;
}

function requireTarget(flags: Flags): string {
  if (!flags.targetSlug) throw new Error('review command requires --target');
  return flags.targetSlug;
}

function requireTargetType(flags: Flags): ReviewTargetType {
  if (!flags.targetType) throw new Error('review command requires --type');
  return flags.targetType;
}

function reviewDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
