import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
} from './gbrain-codex-project-hook-content.ts';
import {
  GBRAIN_CODEX_EXPERIENCE_HOOK,
  GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME,
} from './gbrain-codex-experience-hook-content.ts';
import {
  GBRAIN_OPENCODE_EXPERIENCE_PLUGIN,
  GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME,
} from './gbrain-opencode-experience-plugin-content.ts';
import { mergeCodexHooksConfig, shellQuote } from './gbrain-codex-hooks-config.ts';

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
  readonly opencodeProjectHook: string;
  readonly opencodeExperienceHook: string;
  readonly opencodeExperiencePlugin: string;
  readonly codexAgents: string;
  readonly codexSkills: string;
  readonly codexHooksConfig: string;
  readonly codexProjectHook: string;
  readonly codexExperienceHook: string;
}

const HELP = `gbrain install-client — install GBrain rules, skills, and client guards

Usage:
  gbrain install-client [--json] [--no-experience-hook]

Installs user-level OpenCode and Codex GBrain rules, skills, project guards, and,
by default, isolated turn-close experience guards. Use --no-experience-hook to
disable only the GBrain experience guards on both clients.
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
        {
          name: 'opencode',
          rules: paths.opencodeAgents,
          skills: ['gbrain-capture', 'gbrain-review'],
          hook: {
            script: paths.opencodeProjectHook,
            config: paths.opencodeExperiencePlugin,
            trust_required: false,
          },
          experience_hook: flags.experienceHook ? {
            script: paths.opencodeExperienceHook,
            plugin: paths.opencodeExperiencePlugin,
            mode: 'isolated_subagent_capture',
          } : null,
        },
        {
          name: 'codex',
          rules: paths.codexAgents,
          skills: ['gbrain-capture', 'gbrain-review'],
          hook: {
            script: paths.codexProjectHook,
            config: paths.codexHooksConfig,
            trust_required: true,
          },
          experience_hook: flags.experienceHook ? {
            script: paths.codexExperienceHook,
            mode: 'isolated_subagent_capture',
          } : null,
        },
      ],
    };
    const text = flags.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `GBrain rules, skills, and project guards installed for OpenCode and Codex; experience guards ${flags.experienceHook ? 'enabled' : 'disabled'}. In Codex, trust the hooks once with /hooks.\n`;
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
    opencodeProjectHook: join(opencodeDir, 'hooks', GBRAIN_CODEX_PROJECT_HOOK_FILENAME),
    opencodeExperienceHook: join(opencodeDir, 'hooks', GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME),
    opencodeExperiencePlugin: join(opencodeDir, 'plugins', GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME),
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
  writeCodexProjectHook(paths.opencodeProjectHook);
  writeOpenCodePlugin(paths.opencodeExperiencePlugin, experienceHook);
  writeCodexProjectHook(paths.codexProjectHook);
  if (experienceHook) {
    writeCodexExperienceHook(paths.opencodeExperienceHook);
    writeCodexExperienceHook(paths.codexExperienceHook);
  } else {
    unlinkIfPresent(paths.opencodeExperienceHook);
    unlinkIfPresent(paths.codexExperienceHook);
  }
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

function writeOpenCodePlugin(path: string, experienceHook: boolean): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const content = GBRAIN_OPENCODE_EXPERIENCE_PLUGIN.replace(
    '__EXPERIENCE_ENABLED__',
    experienceHook ? 'true' : 'false',
  );
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function unlinkIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __testing = { resolvePaths, shellQuote };
