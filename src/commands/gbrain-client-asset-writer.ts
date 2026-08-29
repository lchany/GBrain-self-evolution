import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GBRAIN_CAPTURE_SKILL,
  GBRAIN_REVIEW_SKILL,
} from './gbrain-client-installer-content.ts';
import { GBRAIN_CODEX_PROJECT_HOOK } from './gbrain-codex-project-hook-content.ts';
import { GBRAIN_CODEX_EXPERIENCE_HOOK } from './gbrain-codex-experience-hook-content.ts';
import { GBRAIN_OPENCODE_EXPERIENCE_PLUGIN } from './gbrain-opencode-experience-plugin-content.ts';
import { mergeCodexHooksConfig } from './gbrain-codex-hooks-config.ts';
import { writeManagedBlock } from './gbrain-client-managed-block.ts';
import type { ClientPaths } from './gbrain-client-install-layout.ts';

export function installClientAssets(paths: ClientPaths, experienceHook: boolean): void {
  writeManagedBlock(paths.opencodeAgents);
  writeManagedBlock(paths.codexAgents);
  writeSkill(paths.opencodeSkills, 'gbrain-capture', GBRAIN_CAPTURE_SKILL);
  writeSkill(paths.opencodeSkills, 'gbrain-review', GBRAIN_REVIEW_SKILL);
  writeSkill(paths.codexSkills, 'gbrain-capture', GBRAIN_CAPTURE_SKILL);
  writeSkill(paths.codexSkills, 'gbrain-review', GBRAIN_REVIEW_SKILL);
  writeExecutable(paths.opencodeProjectHook, GBRAIN_CODEX_PROJECT_HOOK);
  writeOpenCodePlugin(paths.opencodeExperiencePlugin, experienceHook);
  writeExecutable(paths.codexProjectHook, GBRAIN_CODEX_PROJECT_HOOK);
  if (experienceHook) {
    writeExecutable(paths.opencodeExperienceHook, GBRAIN_CODEX_EXPERIENCE_HOOK);
    writeExecutable(paths.codexExperienceHook, GBRAIN_CODEX_EXPERIENCE_HOOK);
  } else {
    unlinkIfPresent(paths.opencodeExperienceHook);
    unlinkIfPresent(paths.codexExperienceHook);
  }
  mergeCodexHooksConfig({
    configPath: paths.codexHooksConfig,
    projectScriptPath: paths.codexProjectHook,
    experienceScriptPath: paths.codexExperienceHook,
    experienceHook,
  });
}

function writeSkill(root: string, name: string, content: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), normalize(content));
}

function writeExecutable(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, normalize(content), { encoding: 'utf8', mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeOpenCodePlugin(path: string, experienceHook: boolean): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const content = GBRAIN_OPENCODE_EXPERIENCE_PLUGIN.replace(
    '__EXPERIENCE_ENABLED__',
    experienceHook ? 'true' : 'false',
  );
  writeFileSync(path, normalize(content), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function unlinkIfPresent(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) unlinkSync(path);
}

function normalize(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
