import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient } from '../src/commands/gbrain-client-installer.ts';

type PluginHarness = {
  readonly root: string;
  readonly project: string;
  readonly stateDir: string;
  readonly script: string;
  readonly calls: unknown[];
  readonly hooks: Record<string, (input: unknown, output?: unknown) => Promise<void>>;
};

async function installPlugin(bound = true, promptResult: unknown = { data: true }): Promise<PluginHarness> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-opencode-guard-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  if (bound) {
    writeFileSync(
      join(project, '.gbrain-project.yaml'),
      'schema_version: 1\nproject_id: prj-0123456789abcdef\n',
      { mode: 0o600 },
    );
  }
  expect(await runInstallClient(['--json'], {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
  })).toBe(0);
  const pluginPath = join(root, 'xdg', 'opencode', 'plugins', 'gbrain-experience-guard.ts');
  const module = await import(`${pluginPath}?test=${Date.now()}-${Math.random()}`);
  const factory = module.GBrainOpenCodeGuard;
  if (typeof factory !== 'function') throw new Error('installed OpenCode guard has no factory');
  const calls: unknown[] = [];
  const hooks = await factory({
    directory: project,
    client: {
      session: {
        promptAsync: async (input: unknown) => {
          calls.push(input);
          return promptResult;
        },
      },
    },
  });
  return {
    root,
    project,
    stateDir: join(root, 'xdg', 'opencode', 'gbrain-experience-guard'),
    script: join(root, 'xdg', 'opencode', 'hooks', 'gbrain-experience-guard.py'),
    calls,
    hooks,
  };
}

function textOutput(text: string, sessionID = 'session-test', messageID = 'message-test') {
  return {
    message: { id: messageID, sessionID },
    parts: [{ id: 'part-test', sessionID, messageID, type: 'text', text }],
  };
}

function hook(harness: PluginHarness, name: string): (input: unknown, output?: unknown) => Promise<void> {
  const value = harness.hooks[name];
  if (typeof value !== 'function') throw new Error(`installed OpenCode guard lacks ${name}`);
  return value;
}

describe('OpenCode GBrain client guard', () => {
  test('Given an unbound project and nontrivial prompt When the first message runs Then bootstrap and recall are injected', async () => {
    const harness = await installPlugin(false);
    try {
      const output = textOutput('请修改代码并完成部署配置');
      await hook(harness, 'chat.message')({ sessionID: 'session-parent', messageID: 'turn-parent' }, output);
      expect(output.parts[0]?.text).toContain('GBRAIN_PROJECT_BOOTSTRAP_REQUIRED');
      expect(output.parts[0]?.text).toContain('GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY=');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=gbr_');
      expect(output.parts[0]?.text).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(output.parts[0]?.text).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=gbc_');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_HOOK_STATE_DIR=');

      const second = textOutput('继续');
      await hook(harness, 'chat.message')({ sessionID: 'session-parent', messageID: 'turn-second' }, second);
      expect(second.parts[0]?.text).not.toContain('GBrain 项目 ID 启动检查');
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given a file-only first message When guards add context Then the synthetic text part has complete OpenCode identity fields', async () => {
    const harness = await installPlugin(false);
    try {
      const output = {
        message: { id: 'message-file', sessionID: 'session-file' },
        parts: [{ id: 'part-file', sessionID: 'session-file', messageID: 'message-file', type: 'file' }],
      };
      await hook(harness, 'chat.message')({ sessionID: 'session-file', messageID: 'message-file' }, output);
      const synthetic = output.parts.find((part) => part.type === 'text');
      expect(synthetic).toMatchObject({
        sessionID: 'session-file', messageID: 'message-file', type: 'text', synthetic: true,
      });
      expect(typeof synthetic?.id).toBe('string');
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given the recall-only plugin When hooks are registered Then tool, system, and idle hooks are absent', async () => {
    const harness = await installPlugin();
    try {
      const output = textOutput('please take care of it');
      await hook(harness, 'chat.message')({ sessionID: 'session-tools', messageID: 'turn-tools' }, output);
      expect(output.parts[0]?.text).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(harness.hooks['tool.execute.after']).toBeUndefined();
      expect(harness.hooks['experimental.chat.system.transform']).toBeUndefined();
      expect(harness.hooks.event).toBeUndefined();
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given missing recall receipt When the session becomes idle Then OpenCode does not resume the session', async () => {
    const harness = await installPlugin();
    try {
      const output = textOutput('请修改代码');
      await hook(harness, 'chat.message')({ sessionID: 'session-idle', messageID: 'turn-idle' }, output);
      expect(harness.hooks.event).toBeUndefined();
      expect(harness.calls).toHaveLength(0);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

});
