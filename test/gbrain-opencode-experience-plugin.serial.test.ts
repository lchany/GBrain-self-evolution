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

function tokenFromText(text: string, marker: 'RECALL' | 'CLOSEOUT'): string {
  const token = text.match(new RegExp(`GBRAIN_EXPERIENCE_${marker}_WORKER_TOKEN=([A-Za-z0-9_-]+)`))?.[1];
  if (!token) throw new Error(`missing ${marker.toLowerCase()} worker token`);
  return token;
}

function workerReceipt(harness: PluginHarness, args: string[]) {
  return Bun.spawnSync(['python3', harness.script, 'receipt', ...args], {
    env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: harness.stateDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('OpenCode GBrain client guard', () => {
  test('Given an unbound project and nontrivial prompt When the first message runs Then bootstrap and both worker phases are injected', async () => {
    const harness = await installPlugin(false);
    try {
      const output = textOutput('请修改代码并完成部署配置');
      await hook(harness, 'chat.message')({ sessionID: 'session-parent', messageID: 'turn-parent' }, output);
      expect(output.parts[0]?.text).toContain('GBRAIN_PROJECT_BOOTSTRAP_REQUIRED');
      expect(output.parts[0]?.text).toContain('GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY=');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=gbr_');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(output.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=gbc_');
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

  test('Given a generic prompt followed by a write tool When the next model step starts Then closeout context is injected once', async () => {
    const harness = await installPlugin();
    try {
      const output = textOutput('please take care of it');
      await hook(harness, 'chat.message')({ sessionID: 'session-tools', messageID: 'turn-tools' }, output);
      expect(output.parts[0]?.text).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');

      await hook(harness, 'tool.execute.after')(
        { tool: 'apply_patch', sessionID: 'session-tools', callID: 'edit-1', args: { patchText: 'change' } },
        { title: 'Done', output: 'Done', metadata: {} },
      );
      const system = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: 'session-tools' }, system);
      expect(system.system.join('\n')).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      const repeated = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: 'session-tools' }, repeated);
      expect(repeated.system).toHaveLength(0);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given missing closeout receipt When the session becomes idle Then OpenCode resumes the same session', async () => {
    const harness = await installPlugin();
    try {
      const output = textOutput('请修改代码');
      await hook(harness, 'chat.message')({ sessionID: 'session-idle', messageID: 'turn-idle' }, output);
      await hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID: 'session-idle' } } });
      expect(harness.calls).toHaveLength(1);
      expect(JSON.stringify(harness.calls[0])).toContain('session-idle');
      expect(JSON.stringify(harness.calls[0])).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(JSON.stringify(harness.calls[0])).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given explicit recall and closeout receipts from isolated workers When the parent idles Then no resume prompt is sent', async () => {
    const harness = await installPlugin();
    try {
      const parent = textOutput('请修改代码');
      await hook(harness, 'chat.message')({ sessionID: 'session-parent', messageID: 'turn-parent' }, parent);
      const parentText = parent.parts[0]?.text ?? '';
      const recallToken = tokenFromText(parentText, 'RECALL');
      const closeoutToken = tokenFromText(parentText, 'CLOSEOUT');

      const worker = textOutput(`GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=${closeoutToken}\n完成经验收尾。`);
      await hook(harness, 'chat.message')({ sessionID: 'session-worker', messageID: 'turn-worker' }, worker);
      const recalled = workerReceipt(harness, [
        '--token', recallToken, '--classification', 'none', '--constraints-json', '[]',
      ]);
      expect(recalled.exitCode).toBe(0);
      const closed = workerReceipt(harness, [
        '--token', closeoutToken, '--outcome', 'captured', '--verified', '--slug', 'inbox/opencode-capture',
      ]);
      expect(closed.exitCode).toBe(0);

      await hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID: 'session-parent' } } });
      expect(harness.calls).toHaveLength(0);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given real OpenCode failure shapes When tools finish Then failures trigger closeout and unverified claims are rejected', async () => {
    const harness = await installPlugin();
    try {
      for (const [sessionID, toolName, metadata] of [
        ['session-edit', 'edit', {}],
        ['session-bash', 'bash', { exit: 2 }],
      ] as const) {
        await hook(harness, 'chat.message')(
          { sessionID, messageID: `turn-${sessionID}` },
          textOutput('please take care of it', sessionID, `turn-${sessionID}`),
        );
        await hook(harness, 'tool.execute.after')(
          { tool: toolName, sessionID, callID: `call-${sessionID}`, args: { command: 'custom-command' } },
          { title: 'Done', output: 'Process exited with code 2', metadata },
        );
        const system = { system: [] as string[] };
        await hook(harness, 'experimental.chat.system.transform')({ sessionID }, system);
        expect(system.system.join('')).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      }

      const taskSession = 'session-task-error';
      await hook(harness, 'chat.message')(
        { sessionID: taskSession, messageID: 'turn-task-error' },
        textOutput('please take care of it', taskSession, 'turn-task-error'),
      );
      await hook(harness, 'event')({
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool', sessionID: taskSession, callID: 'task-error', tool: 'task',
              state: { status: 'error', input: { prompt: 'work' }, error: 'failed' },
            },
          },
        },
      });
      const taskSystem = { system: [] as string[] };
      await hook(harness, 'experimental.chat.system.transform')({ sessionID: taskSession }, taskSystem);
      expect(taskSystem.system.join('')).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');

      const captureSession = 'session-failed-capture';
      const parent = textOutput('请修改代码', captureSession, 'turn-failed-capture');
      await hook(harness, 'chat.message')({ sessionID: captureSession, messageID: 'turn-failed-capture' }, parent);
      const token = tokenFromText(parent.parts[0]?.text ?? '', 'CLOSEOUT');
      for (const [toolName, callID] of [['gbrain_put_page', 'failed-put'], ['gbrain_get_page', 'failed-get']]) {
        await hook(harness, 'tool.execute.after')(
          { tool: toolName, sessionID: captureSession, callID, args: { slug: 'inbox/failed-capture' } },
          { isError: true, error: 'MCP failed' },
        );
      }
      const receipt = workerReceipt(harness, [
        '--token', token, '--outcome', 'captured',
        '--slug', 'inbox/failed-capture',
      ]);
      expect(receipt.exitCode).toBe(1);
      await hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID: captureSession } } });
      expect(harness.calls).toHaveLength(1);
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('Given promptAsync returns an error When idle needs continuation Then the session fails open for the next message', async () => {
    const harness = await installPlugin(true, { error: { message: 'unavailable' } });
    try {
      await hook(harness, 'chat.message')(
        { sessionID: 'session-prompt-error', messageID: 'turn-prompt-error' },
        textOutput('请修改代码', 'session-prompt-error', 'turn-prompt-error'),
      );
      await hook(harness, 'event')({ event: { type: 'session.idle', properties: { sessionID: 'session-prompt-error' } } });
      const next = textOutput('请修改配置', 'session-prompt-error', 'turn-after-error');
      await hook(harness, 'chat.message')({ sessionID: 'session-prompt-error', messageID: 'turn-after-error' }, next);
      expect(next.parts[0]?.text).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
    } finally {
      await hook(harness, 'dispose')({});
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
