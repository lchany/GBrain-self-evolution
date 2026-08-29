import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GBRAIN_CODEX_PROJECT_HOOK_FILENAME,
  GBRAIN_CODEX_PROJECT_HOOK_STATUS,
} from './gbrain-codex-project-hook-content.ts';
import {
  GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME,
  GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS,
} from './gbrain-codex-experience-hook-content.ts';

export type CodexHooksLayout = {
  readonly projectScriptPath: string;
  readonly experienceScriptPath: string;
  readonly experienceHook: boolean;
};

type CodexHooksFile = CodexHooksLayout & { readonly configPath: string };

export class CodexHooksConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexHooksConfigError';
  }
}

export type ManagedCodexHooks = {
  readonly project: boolean;
  readonly experience: boolean;
};

export function inspectCodexHooksConfig(content: string): ManagedCodexHooks {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new CodexHooksConfigError('invalid Codex hooks config: root must be a JSON object');
  const hooks = getHooksTable(parsed);
  let project = false;
  let experience = false;
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new CodexHooksConfigError(`invalid Codex hooks config: hooks.${eventName} must be an array`);
    for (const group of groups) {
      for (const handler of getHandlers(group)) {
        project ||= isManagedProjectHook(handler);
        experience ||= isManagedExperienceHook(handler);
      }
    }
  }
  return { project, experience };
}

export function mergeCodexHooksConfig(options: CodexHooksFile): void {
  const { configPath } = options;
  mkdirSync(join(configPath, '..'), { recursive: true });
  const config = readHooksConfig(configPath);
  const next = buildCodexHooksConfig(config, options);
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export function buildCodexHooksConfig(
  config: Readonly<Record<string, unknown>>,
  options: CodexHooksLayout,
): Record<string, unknown> {
  const { projectScriptPath, experienceScriptPath, experienceHook } = options;
  const hooks = getHooksTable(config);
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new CodexHooksConfigError(`invalid Codex hooks config: hooks.${eventName} must be an array`);
    }
    const userGroups = groups.flatMap((group) => removeManagedHandlers(group));
    if (userGroups.length > 0) hooks[eventName] = userGroups;
    else delete hooks[eventName];
  }
  const sessionStart = getHookGroups(hooks, 'SessionStart');
  sessionStart.push({
    matcher: '^(startup|resume)$',
    hooks: [{
      type: 'command',
      command: `python3 ${shellQuote(projectScriptPath)}`,
      statusMessage: GBRAIN_CODEX_PROJECT_HOOK_STATUS,
      timeout: 5,
      additionalContextLimit: 300,
    }],
  });
  hooks.SessionStart = sessionStart;
  for (const eventName of ['UserPromptSubmit', 'PostToolUse']) {
    const groups = getHookGroups(hooks, eventName);
    if (experienceHook) {
      groups.push({
        ...(eventName === 'PostToolUse' ? { matcher: '*' } : {}),
        hooks: [{
          type: 'command',
          command: `python3 ${shellQuote(experienceScriptPath)}`,
          statusMessage: GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS,
          timeout: 5,
          additionalContextLimit: 2048,
        }],
      });
    }
    if (groups.length > 0) hooks[eventName] = groups;
    else delete hooks[eventName];
  }
  return { ...config, hooks };
}

function readHooksConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!isRecord(parsed)) throw new CodexHooksConfigError(`invalid Codex hooks config: ${configPath} must contain a JSON object`);
  return parsed;
}

function getHooksTable(config: Record<string, unknown>): Record<string, unknown> {
  if (config.hooks === undefined) return {};
  if (!isRecord(config.hooks)) throw new CodexHooksConfigError('invalid Codex hooks config: hooks must be a JSON object');
  return { ...config.hooks };
}

function getHookGroups(hooks: Record<string, unknown>, eventName: string): unknown[] {
  if (hooks[eventName] === undefined) return [];
  if (!Array.isArray(hooks[eventName])) {
    throw new CodexHooksConfigError(`invalid Codex hooks config: hooks.${eventName} must be an array`);
  }
  return hooks[eventName];
}

function removeManagedHandlers(group: unknown): unknown[] {
  if (!isRecord(group)) {
    throw new CodexHooksConfigError('invalid Codex hooks config: every hook group must be an object with a hooks array');
  }
  const originalHandlers = getHandlers(group);
  const handlers = originalHandlers.filter((handler) => !isManagedProjectHook(handler) && !isManagedExperienceHook(handler));
  if (handlers.length === originalHandlers.length) return [group];
  if (handlers.length === 0) return [];
  return [{ ...group, hooks: handlers }];
}

function getHandlers(group: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
    throw new CodexHooksConfigError('invalid Codex hooks config: every hook group must be an object with a hooks array');
  }
  if (!group.hooks.every(isRecord)) {
    throw new CodexHooksConfigError('invalid Codex hooks config: every hook handler must be an object');
  }
  return group.hooks;
}

export function isManagedProjectHook(handler: unknown): boolean {
  if (!isRecord(handler)) return false;
  if (handler.statusMessage === GBRAIN_CODEX_PROJECT_HOOK_STATUS) return true;
  return typeof handler.command === 'string' && handler.command.includes(GBRAIN_CODEX_PROJECT_HOOK_FILENAME);
}

export function isManagedExperienceHook(handler: unknown): boolean {
  if (!isRecord(handler)) return false;
  if (handler.statusMessage === GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS) return true;
  return typeof handler.command === 'string' && handler.command.includes(GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
