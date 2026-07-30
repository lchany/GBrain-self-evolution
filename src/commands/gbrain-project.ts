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

const HELP = `gbrain project — resolve and bind stable business-project identity

Usage:
  gbrain project current [--json]
  gbrain project match [--json]
  gbrain project init --name <name> [--repo <url>] [--json]
  gbrain project bind <project_id> [--json]
`;

export async function runGbrainProject(args: readonly string[], deps: Partial<ProjectCommandDeps> = {}): Promise<number> {
  const resolved: ProjectCommandDeps = {
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}),
    callTool: deps.callTool ?? createLocalWriterToolCaller(),
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
    else throw new Error(`unknown project command: ${command}`);
    printResult(result, json, resolved.stdout);
    return result.ok === false ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { ok: false, code: errorCode(message), message };
    if (json) resolved.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else resolved.stderr(`gbrain project failed: ${message}\n`);
    return 1;
  }
}

function validateCommandArgs(args: readonly string[]): void {
  const command = args[0];
  const allowed = command === 'init'
    ? new Set(['--name', '--repo', '--json'])
    : command === 'current' || command === 'match' || command === 'bind'
      ? new Set(['--json'])
      : new Set<string>();
  const positionalLimit = command === 'bind' ? 2 : 1;
  for (let index = positionalLimit; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    if (!allowed.has(arg)) throw new Error(`project_argument_invalid: unknown argument ${arg}`);
    if (arg === '--name' || arg === '--repo') index++;
  }
}

function currentProject(cwd: string): Record<string, unknown> {
  const marker = readProjectMarker(cwd);
  if (marker === null) return { ok: true, status: 'unbound', code: 'project_unbound', project_id: null };
  return { ok: true, status: 'bound', code: 'ok', project_id: marker.project_id, marker_path: marker.marker_path };
}

async function matchProject(deps: ProjectCommandDeps): Promise<Record<string, unknown>> {
  const current = currentProject(deps.cwd);
  if (current.status === 'bound') return current;
  const repositoryRef = detectRepositoryRef(deps.cwd);
  const projectName = findProjectRoot(deps.cwd).split('/').at(-1)?.toLowerCase() ?? '';
  const candidates = projectRegistryPages(await deps.callTool('list_pages', { prefix: 'projects/' }))
    .filter((page) => {
      const refs = stringList(page.frontmatter.repository_refs);
      const aliases = [page.frontmatter.project_name, ...stringList(page.frontmatter.project_aliases)]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());
      return (repositoryRef !== null && refs.includes(repositoryRef)) || aliases.includes(projectName);
    })
    .map((page) => ({
      project_id: page.frontmatter.project_id,
      project_name: page.frontmatter.project_name,
      slug: page.slug,
      match_reason: repositoryRef !== null && stringList(page.frontmatter.repository_refs).includes(repositoryRef) ? 'repository_ref' : 'name_or_alias',
    }));
  return {
    ok: true,
    status: candidates.length === 0 ? 'unmatched' : 'confirmation_required',
    code: candidates.length === 0 ? 'project_match_not_found' : 'project_match_confirmation_required',
    repository_ref: repositoryRef,
    candidates,
  };
}

async function bindProject(args: readonly string[], deps: ProjectCommandDeps): Promise<Record<string, unknown>> {
  const projectId = assertProjectId(requiredPositional(args, 1, 'project_id'));
  const registrySlug = `projects/${projectId}/index`;
  const registry = pageFrom(await deps.callTool('get_page', { slug: registrySlug }));
  if (registry === null || registry.slug !== registrySlug || registry.frontmatter.record_kind !== 'project-registry' || registry.frontmatter.project_id !== projectId) {
    throw new Error(`project_registry_not_found: ${registrySlug}`);
  }
  const markerPath = writeProjectMarker(deps.projectRoot ?? findProjectRoot(deps.cwd), projectId);
  return { ok: true, status: 'bound', code: 'ok', project_id: projectId, marker_path: markerPath };
}

async function initProject(args: readonly string[], deps: ProjectCommandDeps): Promise<Record<string, unknown>> {
  const name = flagValue(args, '--name');
  if (!name?.trim()) throw new Error('project_name_required: --name is required');
  if (readProjectMarker(deps.cwd) !== null) throw new Error('project_binding_conflict: this project is already bound');
  const repoArg = flagValue(args, '--repo');
  const repositoryRef = repoArg ? normalizeRepositoryRef(repoArg) : detectRepositoryRef(deps.cwd);
  if (repoArg && repositoryRef === null) throw new Error('repository_ref_invalid: --repo must be a supported Git remote URL');
  const registries = projectRegistryPages(await deps.callTool('list_pages', { prefix: 'projects/' }));
  const duplicate = registries.find((page) => {
    const names = [page.frontmatter.project_name, ...stringList(page.frontmatter.project_aliases)]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase());
    return names.includes(name.trim().toLowerCase())
      || (repositoryRef !== null && stringList(page.frontmatter.repository_refs).includes(repositoryRef));
  });
  if (duplicate) {
    return {
      ok: false,
      status: 'confirmation_required',
      code: 'project_match_confirmation_required',
      candidate: { project_id: duplicate.frontmatter.project_id, project_name: duplicate.frontmatter.project_name, slug: duplicate.slug },
    };
  }
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

function projectRegistryPages(result: unknown): Array<{ slug: string; frontmatter: Record<string, unknown> }> {
  const values = Array.isArray(result)
    ? result
    : typeof result === 'object' && result !== null && 'pages' in result && Array.isArray(result.pages)
      ? result.pages
      : [];
  return values.map(pageFrom).filter((page): page is { slug: string; frontmatter: Record<string, unknown> } =>
    page !== null && page.frontmatter.record_kind === 'project-registry');
}

function pageFrom(value: unknown): { slug: string; frontmatter: Record<string, unknown> } | null {
  if (typeof value !== 'object' || value === null || !('slug' in value) || typeof value.slug !== 'string') return null;
  if ('frontmatter' in value && typeof value.frontmatter === 'object' && value.frontmatter !== null) {
    return { slug: value.slug, frontmatter: value.frontmatter as Record<string, unknown> };
  }
  if ('markdown' in value && typeof value.markdown === 'string') {
    return { slug: value.slug, frontmatter: matter(value.markdown).data };
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : requiredPositional(args, index + 1, flag);
}

function requiredPositional(args: readonly string[], index: number, label: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${label}_required: missing ${label}`);
  return value;
}

function printResult(result: Record<string, unknown>, json: boolean, stdout: (text: string) => void): void {
  stdout(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.status}: ${result.project_id ?? result.code}\n`);
}

function errorCode(message: string): string {
  const match = /^([a-z][a-z0-9_]+):/.exec(message);
  return match?.[1] ?? 'project_command_failed';
}
