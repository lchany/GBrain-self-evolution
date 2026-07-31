import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import matter from 'gray-matter';
import {
  assertProjectId,
  generateProjectId,
  normalizeRepositoryRef,
  readProjectMarker,
  writeProjectMarker,
} from '../core/project-context.ts';
import { createLocalWriterToolCaller } from './gbrain-capture-writer.ts';

export type ProjectToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

interface ProjectCommandDeps {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly callTool: ProjectToolCaller;
  readonly generateId: () => string;
  readonly now: () => Date;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const HELP = `gbrain project — 解析并绑定稳定的业务项目身份

用法：
  gbrain project current [--json]
  gbrain project match [--json]
  gbrain project init --name <name> [--repo <url>] [--json]
  gbrain project bind <project_id> (--resolved|--confirmed) [--json]
`;

export async function runGbrainProject(args: readonly string[], deps: Partial<ProjectCommandDeps> = {}): Promise<number> {
  let localWriterCaller: ProjectToolCaller | undefined;
  const resolved: ProjectCommandDeps = {
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}),
    callTool: deps.callTool ?? ((name, toolArgs) => {
      localWriterCaller ??= createLocalWriterToolCaller();
      return localWriterCaller(name, toolArgs);
    }),
    generateId: deps.generateId ?? generateProjectId,
    now: deps.now ?? (() => new Date()),
    stdout: deps.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps.stderr ?? ((text) => process.stderr.write(text)),
  };
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    resolved.stdout(HELP);
    return args.length === 0 ? 1 : 0;
  }
  const json = args.includes('--json');
  const command = args[0];
  try {
    validateCommandArgs(args);
    let result: Record<string, unknown>;
    if (command === 'current') result = currentProject(resolved.cwd);
    else if (command === 'match') result = await matchProject(resolved);
    else if (command === 'bind') result = await bindProject(args, resolved);
    else if (command === 'init') result = await initProject(args, resolved);
    else throw new Error(`project_command_unknown: 未知项目命令 ${command}`);
    printResult(result, json, resolved.stdout);
    return result.ok === false ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { ok: false, code: errorCode(message), message };
    if (json) resolved.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else resolved.stderr(`gbrain project 失败：${message}\n`);
    return 1;
  }
}

function validateCommandArgs(args: readonly string[]): void {
  const command = args[0];
  if (command !== 'current' && command !== 'match' && command !== 'bind' && command !== 'init') return;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') continue;
    if (command === 'bind' && (arg === '--confirmed' || arg === '--resolved')) continue;
    if (command === 'bind' && index === 1 && !arg.startsWith('--')) continue;
    if (command === 'init' && (arg === '--name' || arg === '--repo')) {
      requiredPositional(args, ++index, arg);
      continue;
    }
    throw new Error(`project_argument_invalid: 不支持的参数 ${arg}`);
  }
}

function currentProject(cwd: string): Record<string, unknown> {
  const marker = readProjectMarker(cwd);
  if (marker === null) return { ok: true, status: 'unbound', code: 'project_unbound', project_id: null };
  return { ok: true, status: 'bound', code: 'ok', project_id: marker.project_id, marker_path: marker.marker_path };
}

async function matchProject(deps: ProjectCommandDeps): Promise<Record<string, unknown>> {
  const current = currentProject(deps.cwd);
  if (current.status === 'bound') {
    const projectId = current.project_id as string;
    return {
      ok: true,
      status: 'mcp_required',
      code: 'project_match_via_mcp',
      tool: 'match_project',
      project_id: projectId,
      arguments: { project_id: projectId },
    };
  }
  return {
    ok: true,
    status: 'mcp_required',
    code: 'project_ensure_via_mcp',
    tool: 'ensure_project',
    project_id: null,
    arguments: {},
  };
}

async function bindProject(args: readonly string[], deps: ProjectCommandDeps): Promise<Record<string, unknown>> {
  if (!args.includes('--confirmed') && !args.includes('--resolved')) {
    throw new Error('project_confirmation_required: 必须使用 --resolved 或 --confirmed 完成本地绑定');
  }
  const projectId = assertProjectId(requiredPositional(args, 1, 'project_id'));
  const markerPath = writeProjectMarker(deps.projectRoot ?? findProjectRoot(deps.cwd), projectId);
  return { ok: true, status: 'bound', code: 'ok', project_id: projectId, marker_path: markerPath };
}

async function initProject(args: readonly string[], deps: ProjectCommandDeps): Promise<Record<string, unknown>> {
  const name = flagValue(args, '--name');
  if (!name?.trim()) throw new Error('project_name_required: 必须提供 --name');
  if (readProjectMarker(deps.cwd) !== null) throw new Error('project_binding_conflict: 当前项目已经绑定');
  const repoArg = flagValue(args, '--repo');
  const repositoryRef = repoArg ? normalizeRepositoryRef(repoArg) : detectRepositoryRef(deps.cwd);
  if (repoArg && repositoryRef === null) throw new Error('repository_ref_invalid: --repo 必须是受支持的 Git remote URL');
  const projectId = assertProjectId(deps.generateId());
  const slug = `projects/${projectId}/index`;
  const content = matter.stringify(`# ${name.trim()}\n\nCanonical project registry.\n`, {
    type: 'project',
    date: deps.now().toISOString().slice(0, 10),
    status: 'reviewed',
    sensitivity: 'internal',
    verification: 'verified',
    applicability: [`project:${projectId}`],
    non_applicable: [],
    source_refs: ['local-project-init'],
    migrated_from: null,
    record_kind: 'project-registry',
    project_id: projectId,
    project_name: name.trim(),
    project_aliases: [],
    repository_refs: repositoryRef === null ? [] : [repositoryRef],
    environment_refs: [],
  });
  await deps.callTool('put_page', { slug, content });
  const markerPath = writeProjectMarker(deps.projectRoot ?? findProjectRoot(deps.cwd), projectId);
  return { ok: true, status: 'created', code: 'ok', project_id: projectId, registry_slug: slug, marker_path: markerPath };
}

function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 50; depth++) {
    const gitPath = join(dir, '.git');
    try {
      if (existsSync(gitPath) && (lstatSync(gitPath).isDirectory() || lstatSync(gitPath).isFile())) return dir;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

function detectRepositoryRef(cwd: string): string | null {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return normalizeRepositoryRef(remote);
  } catch {
    return null;
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : requiredPositional(args, index + 1, flag);
}

function requiredPositional(args: readonly string[], index: number, label: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${label}_required: 缺少 ${label}`);
  return value;
}

function printResult(result: Record<string, unknown>, json: boolean, stdout: (text: string) => void): void {
  stdout(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.status}: ${result.project_id ?? result.code}\n`);
}

function errorCode(message: string): string {
  const match = /^([a-z][a-z0-9_]+):/.exec(message);
  return match?.[1] ?? 'project_command_failed';
}
