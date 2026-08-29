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
  test('Given an unbound project and major decision prompt When the first message runs Then bootstrap and recall are injected', async () => {
    const harness = await installPlugin(false);
    try {
      const output = textOutput('请在两种数据库之间选型并决定生产架构');
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

  test('Given OpenCode tool outcomes When only failure occurs Then one failure recall is injected', async () => {
    const harness = await installPlugin();
    try {
      const output = textOutput('please take care of it');
      await hook(harness, 'chat.message')({ sessionID: 'session-tools', messageID: 'turn-tools' }, output);
      expect(output.parts[0]?.text).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      await hook(harness, 'tool.execute.after')(
        { tool: 'bash', sessionID: 'session-tools', callID: 'success', args: { command: 'check' } },
        { output: 'ok', metadata: { exit: 0 } },
      );
      const afterSuccess = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: 'session-tools' }, afterSuccess);
      expect(afterSuccess.system).toHaveLength(0);

      await hook(harness, 'tool.execute.after')(
        { tool: 'bash', sessionID: 'session-tools', callID: 'failure', args: { command: 'apply-plan' } },
        { output: 'secret failure', metadata: { exit: 2 } },
      );
      const afterFailure = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: 'session-tools' }, afterFailure);
      expect(afterFailure.system.join('')).toContain('当前方案出现非预期错误');
      expect(afterFailure.system.join('')).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=gbr_');
      expect(afterFailure.system.join('')).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      const repeated = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: 'session-tools' }, repeated);
      expect(repeated.system).toHaveLength(0);

      const eventOutput = textOutput('continue ordinary work', 'session-event', 'turn-event');
      await hook(harness, 'chat.message')({ sessionID: 'session-event', messageID: 'turn-event' }, eventOutput);
      await hook(harness, 'event')({ event: { type: 'message.part.updated', properties: { part: {
        type: 'tool', sessionID: 'session-event', tool: 'bash', state: { status: 'error', input: { command: 'apply-plan' } },
      } } } });
      const afterEventFailure = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: 'session-event' }, afterEventFailure);
      expect(afterEventFailure.system.join('')).toContain('当前方案出现非预期错误');
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
      await hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID: 'session-idle' } } });
      expect(harness.calls).toHaveLength(0);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

});
