import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runInstallClient } from '../src/commands/gbrain-client-installer.ts';

const tool = Object.assign(<T>(definition: T): T => definition, { schema: z });
mock.module('@opencode-ai/plugin', () => ({ tool }));

async function waitForCalls(calls: unknown[], count: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (calls.length < count && Date.now() < deadline) await Bun.sleep(25);
  expect(calls).toHaveLength(count);
}

async function installedPlugin(root: string): Promise<Record<string, unknown>> {
  expect(await runInstallClient(['--json'], {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
  })).toBe(0);
  const pluginPath = join(root, 'xdg', 'opencode', 'plugins', 'gbrain-experience-guard.ts');
  expect(existsSync(pluginPath)).toBe(true);
  return import(`${pluginPath}?test=${Date.now()}`);
}

describe('OpenCode GBrain experience review plugin', () => {
  test('silence after session idle prompts the same session exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-opencode-review-'));
    const priorTesting = process.env.GBRAIN_EXPERIENCE_HOOK_TESTING;
    const priorSeconds = process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS;
    process.env.GBRAIN_EXPERIENCE_HOOK_TESTING = '1';
    process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS = '1';
    try {
      const module = await installedPlugin(root);
      const calls: unknown[] = [];
      const factory = module.GBrainExperienceGuard as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
      const hooks = await factory({
        client: { session: { promptAsync: async (input: unknown) => { calls.push(input); return { data: true }; } } },
      });
      const tools = hooks.tool as Record<string, { execute: (args: unknown, context: unknown) => Promise<string> }>;
      await tools.gbrain_experience_review_start.execute(
        { slug: 'inbox/opencode-silent-review' },
        { sessionID: 'session-opencode', messageID: 'message-preview', directory: '/workspace' },
      );
      const handleEvent = hooks.event as (input: unknown) => Promise<void>;
      await handleEvent({ event: { type: 'session.idle', properties: { sessionID: 'session-opencode' } } });
      await waitForCalls(calls, 1);
      await Bun.sleep(1_100);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0])).toContain('session-opencode');
      expect(JSON.stringify(calls[0])).toContain('inbox/opencode-silent-review');
      await (hooks.dispose as () => Promise<void>)();
    } finally {
      if (priorTesting === undefined) delete process.env.GBRAIN_EXPERIENCE_HOOK_TESTING;
      else process.env.GBRAIN_EXPERIENCE_HOOK_TESTING = priorTesting;
      if (priorSeconds === undefined) delete process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS;
      else process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS = priorSeconds;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a user message before expiry cancels the scheduled prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-opencode-cancel-'));
    const priorTesting = process.env.GBRAIN_EXPERIENCE_HOOK_TESTING;
    const priorSeconds = process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS;
    process.env.GBRAIN_EXPERIENCE_HOOK_TESTING = '1';
    process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS = '1';
    try {
      const module = await installedPlugin(root);
      const calls: unknown[] = [];
      const factory = module.GBrainExperienceGuard as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
      const hooks = await factory({
        client: { session: { promptAsync: async (input: unknown) => { calls.push(input); return { data: true }; } } },
      });
      const tools = hooks.tool as Record<string, { execute: (args: unknown, context: unknown) => Promise<string> }>;
      await tools.gbrain_experience_review_start.execute(
        { slug: 'inbox/opencode-cancelled-review' },
        { sessionID: 'session-opencode', messageID: 'message-preview', directory: '/workspace' },
      );
      const handleEvent = hooks.event as (input: unknown) => Promise<void>;
      await handleEvent({
        event: {
          type: 'message.updated',
          properties: { info: { role: 'user', sessionID: 'session-opencode', id: 'message-user-reply' } },
        },
      });
      await handleEvent({ event: { type: 'session.idle', properties: { sessionID: 'session-opencode' } } });
      await Bun.sleep(1_200);
      expect(calls).toHaveLength(0);
      await (hooks.dispose as () => Promise<void>)();
    } finally {
      if (priorTesting === undefined) delete process.env.GBRAIN_EXPERIENCE_HOOK_TESTING;
      else process.env.GBRAIN_EXPERIENCE_HOOK_TESTING = priorTesting;
      if (priorSeconds === undefined) delete process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS;
      else process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS = priorSeconds;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
