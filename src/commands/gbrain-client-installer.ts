import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { installClientAssets } from './gbrain-client-asset-writer.ts';
import { shellQuote } from './gbrain-codex-hooks-config.ts';
import {
  checkClientInstallations,
  recoverExperienceChoice,
  resolveClientPaths,
  writeClientManifests,
  type ClientInstallCheck,
} from './gbrain-client-install-protocol.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface InstallClientDeps {
  readonly env?: Env;
  readonly homeDir?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

type InstallFlags = { readonly json: boolean; readonly check: boolean; readonly experienceHook: boolean | null };
export type ClientRepairResult = { readonly status: 'skipped' | 'current' | 'repaired' | 'unrecoverable'; readonly check: ClientInstallCheck };

const HELP = `gbrain install-client — install GBrain rules, skills, and client guards

Usage:
  gbrain install-client [--json] [--experience-hook|--no-experience-hook]
  gbrain install-client --check [--json]

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
    const paths = resolveClientPaths(env, home);
    const before = checkClientInstallations(paths);
    if (flags.check) {
      stdout(formatCheck(before, flags.json));
      return before.ok ? 0 : 1;
    }
    if (hasBlockingInstallIssue(before, flags.experienceHook !== null)) {
      throw new Error(`client installation requires manual repair: ${formatIssues(before)}`);
    }
    const experienceHook = flags.experienceHook ?? recoverExperienceChoice(before);
    if (experienceHook === null) {
      throw new Error('cannot recover experience hook choice; pass --experience-hook or --no-experience-hook');
    }
    installClientAssets(paths, experienceHook);
    writeClientManifests(paths, experienceHook);
    const verified = checkClientInstallations(paths);
    if (!verified.ok) throw new Error(`client install verification failed: ${formatIssues(verified)}`);
    const summary = {
      ok: true,
      protocol_version: verified.protocol_version,
      asset_digest: verified.asset_digest,
      surfaces: [
        {
          name: 'opencode',
          status: verified.surfaces[0].status,
          issues: verified.surfaces[0].issues,
          experience_enabled: experienceHook,
          rules: paths.opencodeAgents,
          skills: ['gbrain-capture', 'gbrain-review'],
          hook: {
            script: paths.opencodeProjectHook,
            config: paths.opencodeExperiencePlugin,
            trust_required: false,
          },
          experience_hook: experienceHook ? {
            script: paths.opencodeExperienceHook,
            plugin: paths.opencodeExperiencePlugin,
            mode: 'isolated_subagent_capture',
          } : null,
        },
        {
          name: 'codex',
          status: verified.surfaces[1].status,
          issues: verified.surfaces[1].issues,
          experience_enabled: experienceHook,
          rules: paths.codexAgents,
          skills: ['gbrain-capture', 'gbrain-review'],
          hook: {
            script: paths.codexProjectHook,
            config: paths.codexHooksConfig,
            trust_required: true,
          },
          experience_hook: experienceHook ? {
            script: paths.codexExperienceHook,
            mode: 'isolated_subagent_capture',
          } : null,
        },
      ],
    };
    const text = flags.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `GBrain rules, skills, and project guards installed for OpenCode and Codex; experience guards ${experienceHook ? 'enabled' : 'disabled'}. In Codex, trust the hooks once with /hooks.\n`;
    stdout(text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) stdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    else stderr(`gbrain install-client failed: ${message}\n`);
    return 1;
  }
}

export function repairManagedClientInstallations(deps: InstallClientDeps = {}): ClientRepairResult {
  const env = deps.env ?? process.env;
  const home = resolve(deps.homeDir ?? env.HOME ?? homedir());
  const paths = resolveClientPaths(env, home);
  const before = checkClientInstallations(paths);
  if (before.surfaces.every((surface) => surface.status === 'not_installed')) {
    return { status: 'skipped', check: before };
  }
  if (before.ok) return { status: 'current', check: before };
  if (hasBlockingInstallIssue(before)) return { status: 'unrecoverable', check: before };
  const experienceHook = recoverExperienceChoice(before);
  if (experienceHook === null) return { status: 'unrecoverable', check: before };
  installClientAssets(paths, experienceHook);
  writeClientManifests(paths, experienceHook);
  const after = checkClientInstallations(paths);
  return { status: after.ok ? 'repaired' : 'unrecoverable', check: after };
}

function parseFlags(args: readonly string[]): InstallFlags {
  let json = false;
  let check = false;
  let experienceHook: boolean | null = null;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-experience-hook') {
      experienceHook = false;
      continue;
    }
    if (arg === '--experience-hook') {
      experienceHook = true;
      continue;
    }
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') continue;
    throw new Error(`unknown install-client argument: ${arg}`);
  }
  if (check && experienceHook !== null) throw new Error('--check does not accept an experience hook choice');
  return { json, check, experienceHook };
}

function formatCheck(check: ClientInstallCheck, json: boolean): string {
  if (json) return `${JSON.stringify(check, null, 2)}\n`;
  return `${check.surfaces.map((surface) => `${surface.name}: ${surface.status}${surface.issues.length > 0 ? ` (${surface.issues.join(', ')})` : ''}`).join('\n')}\n`;
}

function formatIssues(check: ClientInstallCheck): string {
  return check.surfaces.flatMap((surface) => surface.issues.map((issue) => `${surface.name}:${issue}`)).join(', ');
}

function hasBlockingInstallIssue(check: ClientInstallCheck, allowChoiceConflict = false): boolean {
  return check.surfaces.some((surface) => surface.issues.some((issue) =>
    issue.endsWith('_unsafe_type')
      || issue === 'rules_unclosed'
      || issue === 'hooks_config_invalid'
      || (!allowChoiceConflict && issue === 'experience_choice_conflict')));
}

export const __testing = { resolvePaths: resolveClientPaths, shellQuote };
