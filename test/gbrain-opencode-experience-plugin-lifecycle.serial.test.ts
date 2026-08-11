import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient } from '../src/commands/gbrain-client-installer.ts';

type Hook = (input: unknown, output?: unknown) => Promise<void>;
type Prompt = (input: unknown) => Promise<unknown>;
type Harness = { root: string; hooks: Record<string, Hook> };

async function installPlugin(prompt: Prompt): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-opencode-lifecycle-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, '.gbrain-project.yaml'),
    'schema_version: 1\nproject_id: prj-0123456789abcdef\n',
    { mode: 0o600 },
  );
  expect(await runInstallClient(['--json'], {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
  })).toBe(0);
  const plugin = join(root, 'xdg', 'opencode', 'plugins', 'gbrain-experience-guard.ts');
  const module = await import(`${plugin}?test=${Date.now()}-${Math.random()}`);
  const hooks = await module.GBrainOpenCodeGuard({
    directory: project,
    client: { session: { promptAsync: prompt } },
  });
  return { root, hooks };
}

function textOutput(text: string, sessionID: string, messageID: string) {
  return {
    message: { id: messageID, sessionID },
    parts: [{ id: `part-${messageID}`, sessionID, messageID, type: 'text', text }],
  };
}

function hook(harness: Harness, name: string): Hook {
  const value = harness.hooks[name];
  if (!value) throw new Error(`installed OpenCode guard lacks ${name}`);
  return value;
}

describe('OpenCode GBrain guard lifecycle ordering', () => {
  test('continuation prompt re-entry does not deadlock the idle check', async () => {
    let reenter: (() => Promise<void>) | undefined;
    const harness = await installPlugin(async () => {
      if (!reenter) throw new Error('re-entry handler is not ready');
      await reenter();
      return { data: true };
    });
    try {
      const sessionID = 'session-reentrant';
      await hook(harness, 'chat.message')(
        { sessionID, messageID: 'turn-parent' },
        textOutput('请修改代码', sessionID, 'turn-parent'),
      );
      reenter = () => hook(harness, 'chat.message')(
        { sessionID, messageID: 'turn-continuation' },
        textOutput('继续完成经验收尾', sessionID, 'turn-continuation'),
      );

      const idle = hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID } } });
      const completed = await Promise.race([idle.then(() => true), Bun.sleep(250).then(() => false)]);
      expect(completed).toBe(true);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('fire-and-forget tool errors settle before the next system transform', async () => {
    const harness = await installPlugin(async () => ({ data: true }));
    try {
      const sessionID = 'session-error-order';
      await hook(harness, 'chat.message')(
        { sessionID, messageID: 'turn-error-order' },
        textOutput('please take care of it', sessionID, 'turn-error-order'),
      );
      const event = hook(harness, 'event')({ event: { type: 'message.part.updated', properties: {
        part: { type: 'tool', sessionID, callID: 'task-error', tool: 'task',
          state: { status: 'error', input: { prompt: 'work' } } },
      } } });
      const output = { system: [] as string[] };
      const transform = hook(harness, 'experimental.chat.system.transform')({ sessionID }, output);
      await Promise.all([event, transform]);
      expect(output.system.join('')).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('a rejected continuation fails open for the next user message', async () => {
    const harness = await installPlugin(async () => { throw new Error('unavailable'); });
    try {
      const sessionID = 'session-rejected-prompt';
      await hook(harness, 'chat.message')(
        { sessionID, messageID: 'turn-rejected' },
        textOutput('请修改代码', sessionID, 'turn-rejected'),
      );
      await expect(hook(harness, 'event')({
        event: { type: 'session.idle', properties: { sessionID } },
      })).resolves.toBeUndefined();
      const next = textOutput('请修改配置', sessionID, 'turn-after-rejection');
      await hook(harness, 'chat.message')({ sessionID, messageID: 'turn-after-rejection' }, next);
      expect(next.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
