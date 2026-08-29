import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GBRAIN_CAPTURE_SKILL,
  GBRAIN_CLIENT_RULES,
  GBRAIN_REVIEW_SKILL,
} from './gbrain-client-installer-content.ts';
import { GBRAIN_CODEX_EXPERIENCE_HOOK, GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME } from './gbrain-codex-experience-hook-content.ts';
import { buildCodexHooksConfig } from './gbrain-codex-hooks-config.ts';
import { GBRAIN_CODEX_PROJECT_HOOK, GBRAIN_CODEX_PROJECT_HOOK_FILENAME } from './gbrain-codex-project-hook-content.ts';
import { GBRAIN_OPENCODE_EXPERIENCE_PLUGIN, GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME } from './gbrain-opencode-experience-plugin-content.ts';

export const CLIENT_PROTOCOL_VERSION = 2;
export const CLIENT_MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = '.gbrain-client-install.json';

export type ClientManifest = {
  readonly schema_version: number;
  readonly protocol_version: number;
  readonly asset_digest: string;
  readonly experience_hook: boolean;
};

export type ClientPaths = {
  readonly opencodeRoot: string;
  readonly opencodeAgents: string;
  readonly opencodeSkills: string;
  readonly opencodeProjectHook: string;
  readonly opencodeExperienceHook: string;
  readonly opencodeExperiencePlugin: string;
  readonly opencodeManifest: string;
  readonly codexRoot: string;
  readonly codexAgents: string;
  readonly codexSkills: string;
  readonly codexHooksConfig: string;
  readonly codexProjectHook: string;
  readonly codexExperienceHook: string;
  readonly codexManifest: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export const normalizedClientAsset = (content: string): string => content.endsWith('\n') ? content : `${content}\n`;
export const expectedOpenCodePlugin = (enabled: boolean): string => normalizedClientAsset(
  GBRAIN_OPENCODE_EXPERIENCE_PLUGIN.replace('__EXPERIENCE_ENABLED__', enabled ? 'true' : 'false'),
);

export const CLIENT_ASSET_DIGEST = createHash('sha256').update(JSON.stringify([
  normalizedClientAsset(GBRAIN_CLIENT_RULES),
  normalizedClientAsset(GBRAIN_CAPTURE_SKILL),
  normalizedClientAsset(GBRAIN_REVIEW_SKILL),
  normalizedClientAsset(GBRAIN_CODEX_PROJECT_HOOK),
  normalizedClientAsset(GBRAIN_CODEX_EXPERIENCE_HOOK),
  expectedOpenCodePlugin(true),
  expectedOpenCodePlugin(false),
  buildCodexHooksConfig({}, {
    projectScriptPath: '<PROJECT_HOOK>', experienceScriptPath: '<EXPERIENCE_HOOK>', experienceHook: true,
  }),
  buildCodexHooksConfig({}, {
    projectScriptPath: '<PROJECT_HOOK>', experienceScriptPath: '<EXPERIENCE_HOOK>', experienceHook: false,
  }),
])).digest('hex');

export function resolveClientPaths(env: Env, home: string): ClientPaths {
  const opencodeRoot = join(resolve(env.XDG_CONFIG_HOME ?? join(home, '.config')), 'opencode');
  const codexRoot = resolve(env.CODEX_HOME ?? join(home, '.codex'));
  return {
    opencodeRoot,
    opencodeAgents: join(opencodeRoot, 'AGENTS.md'),
    opencodeSkills: join(opencodeRoot, 'skills'),
    opencodeProjectHook: join(opencodeRoot, 'hooks', GBRAIN_CODEX_PROJECT_HOOK_FILENAME),
    opencodeExperienceHook: join(opencodeRoot, 'hooks', GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME),
    opencodeExperiencePlugin: join(opencodeRoot, 'plugins', GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME),
    opencodeManifest: join(opencodeRoot, MANIFEST_FILENAME),
    codexRoot,
    codexAgents: join(codexRoot, 'AGENTS.md'),
    codexSkills: join(codexRoot, 'skills'),
    codexHooksConfig: join(codexRoot, 'hooks.json'),
    codexProjectHook: join(codexRoot, 'hooks', GBRAIN_CODEX_PROJECT_HOOK_FILENAME),
    codexExperienceHook: join(codexRoot, 'hooks', GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME),
    codexManifest: join(codexRoot, MANIFEST_FILENAME),
  };
}

export function writeClientManifests(paths: ClientPaths, experienceHook: boolean): void {
  const manifest: ClientManifest = {
    schema_version: CLIENT_MANIFEST_SCHEMA_VERSION,
    protocol_version: CLIENT_PROTOCOL_VERSION,
    asset_digest: CLIENT_ASSET_DIGEST,
    experience_hook: experienceHook,
  };
  writeManifest(paths.opencodeManifest, manifest);
  writeManifest(paths.codexManifest, manifest);
}

function writeManifest(path: string, manifest: ClientManifest): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
