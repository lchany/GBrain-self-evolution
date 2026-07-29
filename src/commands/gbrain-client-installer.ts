import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GBRAIN_CAPTURE_SKILL,
  GBRAIN_CLIENT_RULES,
  GBRAIN_REVIEW_SKILL,
  GBRAIN_RULES_BLOCK_END,
  GBRAIN_RULES_BLOCK_START,
} from './gbrain-client-installer-content.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface InstallClientDeps {
  readonly env?: Env;
  readonly homeDir?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

interface Paths {
  readonly opencodeAgents: string;
  readonly opencodeSkills: string;
  readonly codexAgents: string;
  readonly codexSkills: string;
}

const HELP = `gbrain install-client — install GBrain rules and skills

Usage:
  gbrain install-client [--json]

Installs user-level OpenCode and Codex GBrain rules and skills only.
Client credentials and network access are managed outside this installer.
`;

export async function runInstallClient(args: readonly string[], deps: InstallClientDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  try {
    const json = parseFlags(args);
    if (args.includes('--help') || args.includes('-h')) {
      stdout(HELP);
      return 0;
    }
    const env = deps.env ?? process.env;
    const home = resolve(deps.homeDir ?? env.HOME ?? homedir());
    const paths = resolvePaths(env, home);
    installRulesAndSkills(paths);
    const summary = {
      ok: true,
      surfaces: [
        { name: 'opencode', rules: paths.opencodeAgents, skills: ['gbrain-capture', 'gbrain-review'] },
        { name: 'codex', rules: paths.codexAgents, skills: ['gbrain-capture', 'gbrain-review'] },
      ],
    };
    const text = json ? `${JSON.stringify(summary, null, 2)}\n` : 'GBrain client rules and skills installed.\n';
    stdout(text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) stdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    else stderr(`gbrain install-client failed: ${message}\n`);
    return 1;
  }
}

function parseFlags(args: readonly string[]): boolean {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') continue;
    throw new Error(`unknown install-client argument: ${arg}`);
  }
  return json;
}

function resolvePaths(env: Env, home: string): Paths {
  const xdgConfig = resolve(env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const codexHome = resolve(env.CODEX_HOME ?? join(home, '.codex'));
  const opencodeDir = join(xdgConfig, 'opencode');
  return {
    opencodeAgents: join(opencodeDir, 'AGENTS.md'),
    opencodeSkills: join(opencodeDir, 'skills'),
    codexAgents: join(codexHome, 'AGENTS.md'),
    codexSkills: join(codexHome, 'skills'),
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __testing = { resolvePaths };
