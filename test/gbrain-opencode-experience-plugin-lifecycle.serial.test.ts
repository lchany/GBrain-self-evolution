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
  test('failure observation keeps tool hooks but never resumes an idle session', async () => {
    let promptCalls = 0;
    const harness = await installPlugin(async () => {
      promptCalls += 1;
      return { data: true };
    });
    try {
      const sessionID = 'session-reentrant';
      await hook(harness, 'chat.message')(
        { sessionID, messageID: 'turn-parent' },
        textOutput('请修改代码', sessionID, 'turn-parent'),
      );
      expect(harness.hooks.event).toBeFunction();
      expect(harness.hooks['tool.execute.after']).toBeFunction();
      expect(harness.hooks['experimental.chat.system.transform']).toBeFunction();
      await hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID } } });
      expect(promptCalls).toBe(0);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
