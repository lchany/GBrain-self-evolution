import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalReadToolCaller } from './gbrain-review-reader.ts';
import { createLocalWriterToolCaller } from './gbrain-capture-writer.ts';
import type { ToolCaller } from './gbrain-review.ts';
import { GBRAIN_CAPTURE_SKILL, GBRAIN_CLIENT_RULES, GBRAIN_REVIEW_SKILL, GBRAIN_RULES_BLOCK_END, GBRAIN_RULES_BLOCK_START } from './gbrain-client-installer-content.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface InstallClientDeps {
  readonly env?: Env;
  readonly homeDir?: string;
  readonly now?: () => Date;
  readonly callReadTool?: ToolCaller;
  readonly callWriteTool?: ToolCaller;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

interface Flags {
  readonly json: boolean;
  readonly readEnvSource?: string;
  readonly writerEnvSource?: string;
  readonly probeSlug?: string;
  readonly probes: boolean;
}

interface Paths {
  readonly gbrainDir: string;
  readonly readEnv: string;
  readonly writerEnv: string;
  readonly opencodeAgents: string;
  readonly opencodeSkills: string;
  readonly codexAgents: string;
  readonly codexSkills: string;
}

const HELP = `gbrain install-client — install GBrain rules, skills, credentials, and probes

Usage:
  gbrain install-client [--read-env-source PATH] [--writer-env-source PATH] [--json]

Installs user-level OpenCode and Codex GBrain rules/skills, installs
~/.config/gbrain/local-read.env and local-writer.env with mode 600, then runs a
read probe and an inbox write/get/delete probe. Output is always redacted.
`;

export async function runInstallClient(args: readonly string[], deps: InstallClientDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  let secrets: readonly string[] = [];
  try {
    const flags = parseFlags(args);
    if (args.includes('--help') || args.includes('-h')) {
      stdout(HELP);
      return 0;
    }
    const env = deps.env ?? process.env;
    const home = resolve(deps.homeDir ?? env.HOME ?? homedir());
    const paths = resolvePaths(env, home);
    const readSource = resolve(flags.readEnvSource ?? paths.readEnv);
    const writerSource = resolve(flags.writerEnvSource ?? paths.writerEnv);
    const readEnv = readCredentialEnv(readSource, 'read');
    const writerEnv = readCredentialEnv(writerSource, 'writer');
    secrets = secretsFrom(readEnv, writerEnv);

    installCredentialFile(readEnv, paths.readEnv);
    installCredentialFile(writerEnv, paths.writerEnv);
    installRulesAndSkills(paths);

    const probes = flags.probes
      ? await runProbes({
        callReadTool: deps.callReadTool ?? createLocalReadToolCaller(paths.readEnv),
        callWriteTool: deps.callWriteTool ?? createLocalWriterToolCaller(paths.writerEnv),
        now: deps.now ?? (() => new Date()),
        probeSlug: flags.probeSlug,
      })
      : [];
    const summary = {
      ok: true,
      env_files: [modeSummary(paths.readEnv), modeSummary(paths.writerEnv)],
      surfaces: [
        { name: 'opencode', rules: paths.opencodeAgents, skills: ['gbrain-capture', 'gbrain-review'] },
        { name: 'codex', rules: paths.codexAgents, skills: ['gbrain-capture', 'gbrain-review'] },
      ],
      probes,
    };
    printSummary(summary, flags.json, stdout, secrets);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safe = redact(message, secrets);
    if (args.includes('--json')) stdout(JSON.stringify({ ok: false, error: safe }, null, 2) + '\n');
    else stderr(`gbrain install-client failed: ${safe}\n`);
    return 1;
  }
}

function parseFlags(args: readonly string[]): Flags {
  const parsed: { readEnvSource?: string; writerEnvSource?: string; probeSlug?: string } = {};
  let json = false;
  let probes = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--no-probes') { probes = false; continue; }
    if (arg === '--read-env-source') { parsed.readEnvSource = requiredValue(args, ++i, arg); continue; }
    if (arg === '--writer-env-source') { parsed.writerEnvSource = requiredValue(args, ++i, arg); continue; }
    if (arg === '--probe-slug') { parsed.probeSlug = requiredValue(args, ++i, arg); continue; }
    if (arg === '--help' || arg === '-h') continue;
    throw new Error(`unknown install-client argument: ${arg}`);
  }
  return { json, probes, ...parsed };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function resolvePaths(env: Env, home: string): Paths {
  const xdgConfig = resolve(env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const codexHome = resolve(env.CODEX_HOME ?? join(home, '.codex'));
  const gbrainDir = join(xdgConfig, 'gbrain');
  const opencodeDir = join(xdgConfig, 'opencode');
  return {
    gbrainDir,
    readEnv: join(gbrainDir, 'local-read.env'),
    writerEnv: join(gbrainDir, 'local-writer.env'),
    opencodeAgents: join(opencodeDir, 'AGENTS.md'),
    opencodeSkills: join(opencodeDir, 'skills'),
    codexAgents: join(codexHome, 'AGENTS.md'),
    codexSkills: join(codexHome, 'skills'),
  };
}

function readCredentialEnv(path: string, label: 'read' | 'writer'): ReadonlyMap<string, string> {
  if (!existsSync(path)) throw new Error(`missing ${label} env source: pass --${label === 'read' ? 'read' : 'writer'}-env-source PATH`);
  const env = parseEnvFile(readFileSync(path, 'utf8'));
  const hasBearer = Boolean(env.get('GBRAIN_REMOTE_TOKEN'));
  const hasClientCredentials = Boolean(env.get('GBRAIN_TOKEN_ENDPOINT') && env.get('GBRAIN_CLIENT_ID') && env.get('GBRAIN_CLIENT_SECRET'));
  if (!env.get('GBRAIN_MCP_URL')) throw new Error(`${label} env source is missing GBRAIN_MCP_URL`);
  if (!hasBearer && !hasClientCredentials) throw new Error(`${label} env source needs GBRAIN_REMOTE_TOKEN or client credentials`);
  if (label === 'writer' && env.get('GBRAIN_SCOPES') && !env.get('GBRAIN_SCOPES')?.split(/\s+/).includes('write')) {
    throw new Error('writer env source must include write scope');
  }
  return env;
}

function parseEnvFile(content: string): ReadonlyMap<string, string> {
  const env = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    const value = body.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    env.set(key, value);
  }
  return env;
}

function installCredentialFile(env: ReadonlyMap<string, string>, target: string): void {
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, formatCredentialEnv(env));
  chmodSync(target, 0o600);
}

function formatCredentialEnv(env: ReadonlyMap<string, string>): string {
  const keys = ['GBRAIN_MCP_URL', 'GBRAIN_TOKEN_ENDPOINT', 'GBRAIN_CLIENT_ID', 'GBRAIN_CLIENT_SECRET', 'GBRAIN_REMOTE_TOKEN', 'GBRAIN_SCOPES'] as const;
  return keys.flatMap((key) => {
    const value = env.get(key);
    return value ? [`export ${key}=${shellQuote(value)}`] : [];
  }).join('\n') + '\n';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function installRulesAndSkills(paths: Paths): void {
  writeManagedBlock(paths.opencodeAgents);
  writeManagedBlock(paths.codexAgents);
  writeSkill(paths.opencodeSkills, 'gbrain-capture', GBRAIN_CAPTURE_SKILL);
  writeSkill(paths.opencodeSkills, 'gbrain-review', GBRAIN_REVIEW_SKILL);
  writeSkill(paths.codexSkills, 'gbrain-capture', GBRAIN_CAPTURE_SKILL);
  writeSkill(paths.codexSkills, 'gbrain-review', GBRAIN_REVIEW_SKILL);
}

function writeManagedBlock(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const pattern = new RegExp(`${escapeRegExp(GBRAIN_RULES_BLOCK_START)}[\\s\\S]*?${escapeRegExp(GBRAIN_RULES_BLOCK_END)}\\n?`, 'm');
  const next = pattern.test(existing)
    ? existing.replace(pattern, GBRAIN_CLIENT_RULES)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${GBRAIN_CLIENT_RULES}`;
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`);
}

function writeSkill(root: string, name: string, content: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content.endsWith('\n') ? content : `${content}\n`);
}

async function runProbes(input: { readonly callReadTool: ToolCaller; readonly callWriteTool: ToolCaller; readonly now: () => Date; readonly probeSlug?: string }): Promise<readonly Record<string, unknown>[]> {
  const slug = input.probeSlug ?? `inbox/gbrain-client-install-probe-${input.now().toISOString().replace(/[:.]/g, '-')}`;
  await input.callReadTool('get_brain_identity', {});
  await input.callWriteTool('put_page', { slug, content: probeMarkdown(input.now) });
  await input.callWriteTool('get_page', { slug });
  await input.callWriteTool('delete_page', { slug });
  return [
    { tool: 'get_brain_identity', ok: true },
    { tool: 'put_page', ok: true, slug },
    { tool: 'get_page', ok: true, slug },
    { tool: 'delete_page', ok: true, slug },
  ];
}

function probeMarkdown(now: () => Date): string {
  const date = now().toISOString().slice(0, 10);
  return `---\ntype: knowledge\ndate: ${date}\nstatus: draft\nsensitivity: internal\nverification: unverified\napplicability:\n  - gbrain-client-installer\nnon_applicable: []\nsource_refs:\n  - installer-probe\nmigrated_from: null\n---\n\n# GBrain client installer probe\n\nTemporary inbox probe created by the client installer and deleted immediately after retrieval.\n`;
}

function modeSummary(path: string): Record<string, string> {
  return { path, mode: (statSync(path).mode & 0o777).toString(8).padStart(3, '0') };
}

function printSummary(summary: Record<string, unknown>, json: boolean, stdout: (text: string) => void, secrets: readonly string[]): void {
  const text = json
    ? JSON.stringify(summary, null, 2) + '\n'
    : `GBrain client install complete. Env files mode 600, rules and skills installed, probes passed. Promote still requires PROMOTE <target-slug>.\n`;
  stdout(redact(text, secrets));
}

function secretsFrom(...envs: readonly ReadonlyMap<string, string>[]): readonly string[] {
  return envs.flatMap((env) => [...env.entries()].filter(([key]) => /TOKEN|SECRET|PASSWORD|CLIENT_ID|MCP_URL|TOKEN_ENDPOINT/.test(key)).map(([, value]) => value));
}

function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    safe = safe.split(secret).join('[REDACTED]');
  }
  return safe;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __testing = { formatCredentialEnv, parseEnvFile, resolvePaths, runProbes };
