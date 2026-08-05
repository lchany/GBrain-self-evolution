import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GBRAIN_CAPTURE_SKILL,
  GBRAIN_CLIENT_RULES,
  GBRAIN_REVIEW_SKILL,
  GBRAIN_RULES_BLOCK_END,
  GBRAIN_RULES_BLOCK_START,
} from './gbrain-client-installer-content.ts';
import {
  GBRAIN_CODEX_PROJECT_HOOK,
  GBRAIN_CODEX_PROJECT_HOOK_FILENAME,
  GBRAIN_CODEX_PROJECT_HOOK_STATUS,
} from './gbrain-codex-project-hook-content.ts';
import {
  GBRAIN_CODEX_EXPERIENCE_HOOK,
  GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME,
  GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS,
} from './gbrain-codex-experience-hook-content.ts';

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
  readonly codexHooksConfig: string;
  readonly codexProjectHook: string;
  readonly codexExperienceHook: string;
}

const HELP = `gbrain install-client — install GBrain rules, skills, and Codex hooks

Usage:
  gbrain install-client [--json] [--no-experience-hook]

Installs user-level OpenCode and Codex GBrain rules and skills, plus a read-only
Codex SessionStart project hook and, by default, a turn-close experience guard.
Use --no-experience-hook to remove only the GBrain experience guard handlers.
Client credentials and network access are managed outside this installer.
`;

export async function runInstallClient(args: readonly string[], deps: InstallClientDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  try {
    const flags = parseFlags(args);
    if (args.includes('--help') || args.includes('-h')) {
      stdout(HELP);
      return 0;
    }
    const env = deps.env ?? process.env;
    const home = resolve(deps.homeDir ?? env.HOME ?? homedir());
    const paths = resolvePaths(env, home);
    installClientAssets(paths, flags.experienceHook);
    const summary = {
      ok: true,
      surfaces: [
        { name: 'opencode', rules: paths.opencodeAgents, skills: ['gbrain-capture', 'gbrain-review'] },
        {
          name: 'codex',
          rules: paths.codexAgents,
          skills: ['gbrain-capture', 'gbrain-review'],
          hook: {
            script: paths.codexProjectHook,
            config: paths.codexHooksConfig,
            trust_required: true,
          },
          experience_hook: {
            script: paths.codexExperienceHook,
            mode: flags.experienceHook ? 'enforce' : 'disabled',
          },
        },
      ],
    };
    const text = flags.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : 'GBrain client rules, skills, and Codex current-directory project hook installed. Trust it once with /hooks.\n';
    stdout(text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) stdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    else stderr(`gbrain install-client failed: ${message}\n`);
    return 1;
  }
}

function parseFlags(args: readonly string[]): { json: boolean; experienceHook: boolean } {
  let json = false;
  let experienceHook = true;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-experience-hook') {
      experienceHook = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') continue;
    throw new Error(`unknown install-client argument: ${arg}`);
  }
  return { json, experienceHook };
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
    codexHooksConfig: join(codexHome, 'hooks.json'),
    codexProjectHook: join(codexHome, 'hooks', GBRAIN_CODEX_PROJECT_HOOK_FILENAME),
    codexExperienceHook: join(codexHome, 'hooks', GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME),
  };
}

function installClientAssets(paths: Paths, experienceHook: boolean): void {
  writeManagedBlock(paths.opencodeAgents);
  writeManagedBlock(paths.codexAgents);
  writeSkill(paths.opencodeSkills, 'gbrain-capture', GBRAIN_CAPTURE_SKILL);
  writeSkill(paths.opencodeSkills, 'gbrain-review', GBRAIN_REVIEW_SKILL);
  writeSkill(paths.codexSkills, 'gbrain-capture', GBRAIN_CAPTURE_SKILL);
  writeSkill(paths.codexSkills, 'gbrain-review', GBRAIN_REVIEW_SKILL);
  writeCodexProjectHook(paths.codexProjectHook);
  if (experienceHook) writeCodexExperienceHook(paths.codexExperienceHook);
  mergeCodexHooksConfig(paths.codexHooksConfig, paths.codexProjectHook, paths.codexExperienceHook, experienceHook);
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

function writeCodexProjectHook(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, GBRAIN_CODEX_PROJECT_HOOK.endsWith('\n') ? GBRAIN_CODEX_PROJECT_HOOK : `${GBRAIN_CODEX_PROJECT_HOOK}\n`, {
    encoding: 'utf8',
    mode: 0o700,
  });
  chmodSync(path, 0o700);
}

function writeCodexExperienceHook(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, GBRAIN_CODEX_EXPERIENCE_HOOK.endsWith('\n') ? GBRAIN_CODEX_EXPERIENCE_HOOK : `${GBRAIN_CODEX_EXPERIENCE_HOOK}\n`, {
    encoding: 'utf8',
    mode: 0o700,
  });
  chmodSync(path, 0o700);
}

function mergeCodexHooksConfig(
  configPath: string,
  projectScriptPath: string,
  experienceScriptPath: string,
  experienceHook: boolean,
): void {
  mkdirSync(join(configPath, '..'), { recursive: true });
  const config = readHooksConfig(configPath);
  const hooks = getHooksTable(config);
  const sessionStart = getSessionStartGroups(hooks);
  const withoutManagedHandler = sessionStart.flatMap((group) => removeManagedHandlers(group));
  withoutManagedHandler.push({
    matcher: '^(startup|resume)$',
    hooks: [{
      type: 'command',
      command: `python3 ${shellQuote(projectScriptPath)}`,
      statusMessage: GBRAIN_CODEX_PROJECT_HOOK_STATUS,
      timeout: 5,
      additionalContextLimit: 300,
    }],
  });
  hooks.SessionStart = withoutManagedHandler;
  for (const eventName of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    const groups = getHookGroups(hooks, eventName);
    const withoutExperience = groups.flatMap((group) => removeManagedExperienceHandlers(group));
    if (experienceHook) {
      withoutExperience.push({
        ...(eventName === 'PostToolUse' ? { matcher: '*' } : {}),
        hooks: [{
          type: 'command',
          command: `python3 ${shellQuote(experienceScriptPath)}`,
          statusMessage: GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS,
          timeout: 5,
          additionalContextLimit: 1200,
        }],
      });
    }
    if (withoutExperience.length > 0) hooks[eventName] = withoutExperience;
    else delete hooks[eventName];
  }
  config.hooks = hooks;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
}

function readHooksConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`invalid Codex hooks config: ${configPath} must contain a JSON object`);
  return parsed;
}

function getHooksTable(config: Record<string, unknown>): Record<string, unknown> {
  if (config.hooks === undefined) return {};
  if (!isRecord(config.hooks)) throw new Error(`invalid Codex hooks config: hooks must be a JSON object`);
  return { ...config.hooks };
}

function getSessionStartGroups(hooks: Record<string, unknown>): unknown[] {
  if (hooks.SessionStart === undefined) return [];
  if (!Array.isArray(hooks.SessionStart)) {
    throw new Error(`invalid Codex hooks config: hooks.SessionStart must be an array`);
  }
  return hooks.SessionStart;
}

function getHookGroups(hooks: Record<string, unknown>, eventName: string): unknown[] {
  if (hooks[eventName] === undefined) return [];
  if (!Array.isArray(hooks[eventName])) {
    throw new Error(`invalid Codex hooks config: hooks.${eventName} must be an array`);
  }
  return hooks[eventName];
}

function removeManagedHandlers(group: unknown): unknown[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
  const handlers = group.hooks.filter((handler) => !isManagedProjectHook(handler));
  if (handlers.length === group.hooks.length) return [group];
  if (handlers.length === 0) return [];
  return [{ ...group, hooks: handlers }];
}

function removeManagedExperienceHandlers(group: unknown): unknown[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
  const handlers = group.hooks.filter((handler) => !isManagedExperienceHook(handler));
  if (handlers.length === group.hooks.length) return [group];
  if (handlers.length === 0) return [];
  return [{ ...group, hooks: handlers }];
}

function isManagedProjectHook(handler: unknown): boolean {
  if (!isRecord(handler)) return false;
  if (handler.statusMessage === GBRAIN_CODEX_PROJECT_HOOK_STATUS) return true;
  return typeof handler.command === 'string' && handler.command.includes(GBRAIN_CODEX_PROJECT_HOOK_FILENAME);
}

function isManagedExperienceHook(handler: unknown): boolean {
  if (!isRecord(handler)) return false;
  if (handler.statusMessage === GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS) return true;
  return typeof handler.command === 'string' && handler.command.includes(GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __testing = { resolvePaths, shellQuote };
