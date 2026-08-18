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

export function mergeCodexHooksConfig(
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
    if (experienceHook && (eventName === 'UserPromptSubmit' || eventName === 'PostToolUse')) {
      withoutExperience.push({
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
  if (!isRecord(config.hooks)) throw new Error('invalid Codex hooks config: hooks must be a JSON object');
  return { ...config.hooks };
}

function getSessionStartGroups(hooks: Record<string, unknown>): unknown[] {
  if (hooks.SessionStart === undefined) return [];
  if (!Array.isArray(hooks.SessionStart)) {
    throw new Error('invalid Codex hooks config: hooks.SessionStart must be an array');
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

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
