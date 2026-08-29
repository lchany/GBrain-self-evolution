import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  GBRAIN_CAPTURE_SKILL,
  GBRAIN_REVIEW_SKILL,
} from './gbrain-client-installer-content.ts';
import { GBRAIN_CODEX_EXPERIENCE_HOOK } from './gbrain-codex-experience-hook-content.ts';
import {
  buildCodexHooksConfig,
  CodexHooksConfigError,
  inspectCodexHooksConfig,
  type ManagedCodexHooks,
} from './gbrain-codex-hooks-config.ts';
import { managedBlockState } from './gbrain-client-managed-block.ts';
import { managedPathIssues, pathEntryExists } from './gbrain-client-path-safety.ts';
import { GBRAIN_CODEX_PROJECT_HOOK } from './gbrain-codex-project-hook-content.ts';
import {
  CLIENT_ASSET_DIGEST,
  CLIENT_MANIFEST_SCHEMA_VERSION,
  CLIENT_PROTOCOL_VERSION,
  expectedOpenCodePlugin,
  normalizedClientAsset,
  type ClientManifest,
  type ClientPaths,
} from './gbrain-client-install-layout.ts';

export {
  CLIENT_ASSET_DIGEST,
  CLIENT_PROTOCOL_VERSION,
  resolveClientPaths,
  writeClientManifests,
  type ClientPaths,
} from './gbrain-client-install-layout.ts';

export type ClientName = 'opencode' | 'codex';
export type SurfaceStatus = 'current' | 'stale' | 'not_installed';
export type SurfaceCheck = {
  readonly name: ClientName;
  readonly status: SurfaceStatus;
  readonly experience_hook: boolean | null;
  readonly issues: readonly string[];
};
export type ClientInstallCheck = {
  readonly ok: boolean;
  readonly protocol_version: 2;
  readonly asset_digest: string;
  readonly surfaces: readonly SurfaceCheck[];
};
type ManifestRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly value: ClientManifest };
type FileExpectation = { readonly path: string; readonly expected: string; readonly mode: number | null; readonly code: string };
type SharedAssets = { readonly agents: string; readonly skills: string; readonly projectHook: string };
type CodexConfigExpectation = { readonly paths: ClientPaths; readonly content: string | null; readonly enabled: boolean | null };

export function checkClientInstallations(paths: ClientPaths): ClientInstallCheck {
  const initial = [checkOpenCode(paths), checkCodex(paths)] as const;
  const installedChoices = new Set(initial
    .filter((entry) => entry.status !== 'not_installed' && entry.experience_hook !== null)
    .map((entry) => entry.experience_hook));
  const surfaces = installedChoices.size > 1
    ? initial.map((entry) => surface(entry.name, entry.experience_hook, [...entry.issues, 'experience_choice_conflict']))
    : initial;
  return {
    ok: surfaces.every((surface) => surface.status === 'current'),
    protocol_version: CLIENT_PROTOCOL_VERSION,
    asset_digest: CLIENT_ASSET_DIGEST,
    surfaces,
  };
}

export function recoverExperienceChoice(check: ClientInstallCheck): boolean | null {
  const installed = check.surfaces.filter((surface) => surface.status !== 'not_installed');
  if (installed.length === 0) return true;
  const choices = new Set(installed.map((surface) => surface.experience_hook));
  if (choices.size !== 1) return null;
  return installed[0]?.experience_hook ?? null;
}

function checkOpenCode(paths: ClientPaths): SurfaceCheck {
  const rulesState = managedBlockState(readRegularFile(paths.opencodeAgents));
  const preflightIssues = managedPathIssues(paths.opencodeRoot, [
    { path: paths.opencodeAgents, code: 'rules' },
    { path: join(paths.opencodeSkills, 'gbrain-capture', 'SKILL.md'), code: 'skill_capture' },
    { path: join(paths.opencodeSkills, 'gbrain-review', 'SKILL.md'), code: 'skill_review' },
    { path: paths.opencodeProjectHook, code: 'project_hook' },
    { path: paths.opencodeExperienceHook, code: 'experience_hook' },
    { path: paths.opencodeExperiencePlugin, code: 'plugin' },
    { path: paths.opencodeManifest, code: 'manifest' },
  ]);
  const traced = rulesState !== 'missing'
    || [paths.opencodeManifest, paths.opencodeProjectHook, paths.opencodeExperienceHook,
      paths.opencodeExperiencePlugin].some(pathEntryExists);
  if (!traced) return notInstalled('opencode', preflightIssues);
  const manifest = readManifest(paths.opencodeManifest);
  const experienceHook = choiceFromManifestOrOpenCode(manifest, paths);
  const issues = [...manifestIssues(manifest, paths.opencodeManifest), ...preflightIssues];
  checkSharedAssets(issues, {
    agents: paths.opencodeAgents, skills: paths.opencodeSkills, projectHook: paths.opencodeProjectHook,
  });
  checkFile(issues, {
    path: paths.opencodeExperiencePlugin, expected: expectedOpenCodePlugin(experienceHook ?? true), mode: 0o600, code: 'plugin',
  });
  checkOptionalExperience(issues, paths.opencodeExperienceHook, experienceHook);
  if (experienceHook === null) issues.push('experience_choice_unknown');
  return surface('opencode', experienceHook, issues);
}

function checkCodex(paths: ClientPaths): SurfaceCheck {
  const hooksText = readRegularFile(paths.codexHooksConfig);
  const rulesState = managedBlockState(readRegularFile(paths.codexAgents));
  const preflightIssues = [...managedPathIssues(paths.codexRoot, [
    { path: paths.codexAgents, code: 'rules' },
    { path: join(paths.codexSkills, 'gbrain-capture', 'SKILL.md'), code: 'skill_capture' },
    { path: join(paths.codexSkills, 'gbrain-review', 'SKILL.md'), code: 'skill_review' },
    { path: paths.codexHooksConfig, code: 'hooks_config' },
    { path: paths.codexProjectHook, code: 'project_hook' },
    { path: paths.codexExperienceHook, code: 'experience_hook' },
    { path: paths.codexManifest, code: 'manifest' },
  ])];
  const managedHooks = inspectExistingCodexConfig(hooksText, preflightIssues);
  const traced = rulesState !== 'missing'
    || [paths.codexManifest, paths.codexProjectHook, paths.codexExperienceHook].some(pathEntryExists)
    || managedHooks?.project === true
    || managedHooks?.experience === true;
  if (!traced) return notInstalled('codex', preflightIssues);
  const manifest = readManifest(paths.codexManifest);
  const experienceHook = choiceFromManifestOrCodex(manifest, paths, managedHooks);
  const issues = [...manifestIssues(manifest, paths.codexManifest), ...preflightIssues];
  checkSharedAssets(issues, { agents: paths.codexAgents, skills: paths.codexSkills, projectHook: paths.codexProjectHook });
  checkOptionalExperience(issues, paths.codexExperienceHook, experienceHook);
  if (!issues.includes('hooks_config_invalid')) checkCodexConfig(issues, { paths, content: hooksText, enabled: experienceHook });
  if (experienceHook === null) issues.push('experience_choice_unknown');
  return surface('codex', experienceHook, issues);
}

function checkSharedAssets(issues: string[], assets: SharedAssets): void {
  const { agents, skills, projectHook } = assets;
  const rulesState = managedBlockState(readRegularFile(agents));
  if (rulesState !== 'current') issues.push(`rules_${rulesState}`);
  checkFile(issues, { path: join(skills, 'gbrain-capture', 'SKILL.md'), expected: normalizedClientAsset(GBRAIN_CAPTURE_SKILL), mode: null, code: 'skill_capture' });
  checkFile(issues, { path: join(skills, 'gbrain-review', 'SKILL.md'), expected: normalizedClientAsset(GBRAIN_REVIEW_SKILL), mode: null, code: 'skill_review' });
  checkFile(issues, { path: projectHook, expected: normalizedClientAsset(GBRAIN_CODEX_PROJECT_HOOK), mode: 0o700, code: 'project_hook' });
}

function checkOptionalExperience(issues: string[], path: string, enabled: boolean | null): void {
  if (enabled === true) checkFile(issues, { path, expected: normalizedClientAsset(GBRAIN_CODEX_EXPERIENCE_HOOK), mode: 0o700, code: 'experience_hook' });
  if (enabled === false && existsSync(path)) issues.push('experience_hook_unexpected');
}

function checkCodexConfig(issues: string[], expectation: CodexConfigExpectation): void {
  const { paths, content, enabled } = expectation;
  if (content === null) {
    issues.push('hooks_config_missing');
    return;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) throw new SyntaxError('hooks config must be an object');
    const expected = buildCodexHooksConfig(parsed, {
      projectScriptPath: paths.codexProjectHook,
      experienceScriptPath: paths.codexExperienceHook,
      experienceHook: enabled ?? true,
    });
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) issues.push('hooks_config_drift');
    if (fileMode(paths.codexHooksConfig) !== 0o600) issues.push('hooks_config_mode');
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CodexHooksConfigError) issues.push('hooks_config_invalid');
    else throw error;
  }
}

function checkFile(issues: string[], expectation: FileExpectation): void {
  const { path, expected, mode, code } = expectation;
  const actual = readRegularFile(path);
  if (actual === null) issues.push(`${code}_missing`);
  else if (actual !== expected) issues.push(`${code}_drift`);
  if (actual !== null && mode !== null && fileMode(path) !== mode) issues.push(`${code}_mode`);
}

function manifestIssues(manifest: ManifestRead, path: string): string[] {
  if (manifest.kind === 'missing') return ['manifest_missing'];
  if (manifest.kind === 'invalid') return ['manifest_invalid'];
  const issues: string[] = [];
  if (manifest.value.schema_version !== CLIENT_MANIFEST_SCHEMA_VERSION) issues.push('manifest_schema_version');
  if (manifest.value.protocol_version !== CLIENT_PROTOCOL_VERSION) issues.push('protocol_version_mismatch');
  if (manifest.value.asset_digest !== CLIENT_ASSET_DIGEST) issues.push('asset_digest_mismatch');
  if (fileMode(path) !== 0o600) issues.push('manifest_mode');
  return issues;
}

function readManifest(path: string): ManifestRead {
  const content = readRegularFile(path);
  if (content === null) return existsSync(path) ? { kind: 'invalid' } : { kind: 'missing' };
  try {
    const value: unknown = JSON.parse(content);
    if (!isManifest(value)) return { kind: 'invalid' };
    return { kind: 'valid', value };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'invalid' };
    throw error;
  }
}

function isManifest(value: unknown): value is ClientManifest {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'asset_digest,experience_hook,protocol_version,schema_version') return false;
  return typeof value.schema_version === 'number'
    && typeof value.protocol_version === 'number'
    && typeof value.asset_digest === 'string'
    && typeof value.experience_hook === 'boolean';
}

function choiceFromManifestOrOpenCode(manifest: ManifestRead, paths: ClientPaths): boolean | null {
  if (manifest.kind === 'valid' && manifest.value.schema_version === CLIENT_MANIFEST_SCHEMA_VERSION) return manifest.value.experience_hook;
  if (pathEntryExists(paths.opencodeExperienceHook)) return true;
  const plugin = readRegularFile(paths.opencodeExperiencePlugin);
  if (plugin?.includes('const EXPERIENCE_ENABLED = true')) return true;
  if (plugin?.includes('const EXPERIENCE_ENABLED = false')) return false;
  return existsSync(paths.opencodeProjectHook) ? false : null;
}

function choiceFromManifestOrCodex(manifest: ManifestRead, paths: ClientPaths, hooks: ManagedCodexHooks | null): boolean | null {
  if (manifest.kind === 'valid' && manifest.value.schema_version === CLIENT_MANIFEST_SCHEMA_VERSION) return manifest.value.experience_hook;
  if (pathEntryExists(paths.codexExperienceHook) || hooks?.experience === true) return true;
  return existsSync(paths.codexProjectHook) || hooks?.project === true ? false : null;
}

function inspectExistingCodexConfig(content: string | null, issues: string[]): ManagedCodexHooks | null {
  if (content === null) return { project: false, experience: false };
  try {
    return inspectCodexHooksConfig(content);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CodexHooksConfigError) {
      issues.push('hooks_config_invalid');
      return null;
    }
    throw error;
  }
}

function readRegularFile(path: string): string | null {
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  return readFileSync(path, 'utf8');
}

function fileMode(path: string): number | null {
  return existsSync(path) ? statSync(path).mode & 0o777 : null;
}

function surface(name: ClientName, experienceHook: boolean | null, issues: readonly string[]): SurfaceCheck {
  return { name, status: issues.length === 0 ? 'current' : 'stale', experience_hook: experienceHook, issues };
}

function notInstalled(name: ClientName, issues: readonly string[] = []): SurfaceCheck {
  return { name, status: 'not_installed', experience_hook: null, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
