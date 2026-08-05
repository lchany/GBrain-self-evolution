import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInstallClient, type InstallClientDeps } from '../src/commands/gbrain-client-installer.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-experience-hook-'));
}

function deps(root: string): InstallClientDeps {
  return {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
  };
}

function runHook(
  script: string,
  stateDir: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> } {
  const result = spawnSync('python3', [script], {
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir, ...extraEnv },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {},
  };
}

function event(eventName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'session-test',
    turn_id: 'turn-test',
    cwd: '/workspace',
    hook_event_name: eventName,
    model: 'test-model',
    permission_mode: 'default',
    ...extra,
  };
}

describe('Codex GBrain experience guard', () => {
  test('enforce blocks a nontrivial turn until a valid no-candidate receipt is recorded', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');

      expect(runHook(script, stateDir, event('UserPromptSubmit', { prompt: '请修改代码并完成部署配置' })).status).toBe(0);
      const stopped = runHook(script, stateDir, event('Stop', {
        stop_hook_active: false,
        last_assistant_message: '实现已经完成。',
      }));
      expect(stopped.status).toBe(0);
      expect(stopped.json.decision).toBe('block');
      expect(stopped.json.reason).toContain('经验收尾检查');
      const token = String(stopped.json.reason).match(/--token ([A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeTruthy();

      const receipt = spawnSync('python3', [script, 'receipt', '--token', token!, '--outcome', 'no_candidate'], {
        encoding: 'utf8',
        env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
      });
      expect(receipt.status).toBe(0);
      expect(JSON.parse(receipt.stdout).ok).toBe(true);

      const released = runHook(script, stateDir, event('Stop', {
        stop_hook_active: true,
        last_assistant_message: '没有形成值得持久化的新经验。',
      }));
      expect(released.status).toBe(0);
      expect(released.json.decision).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('previewed and captured receipts require matching evidence', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'apply_patch', tool_use_id: 'edit-1', tool_input: { command: 'secret patch body' }, tool_response: 'Done!',
      }));
      const first = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '完成。' }));
      const token = String(first.json.reason).match(/--token ([A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeTruthy();

      const forged = spawnSync('python3', [script, 'receipt', '--token', token!, '--outcome', 'captured', '--slug', 'inbox/test'], {
        encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
      });
      expect(forged.status).toBe(0);
      const blocked = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: '已写入。' }));
      expect(blocked.json.decision).toBe('block');
      expect(blocked.json.reason).toContain('回执证据无效');

      const token2 = String(blocked.json.reason).match(/--token ([A-Za-z0-9_-]+)/)?.[1];
      const previewReceipt = spawnSync('python3', [script, 'receipt', '--token', token2!, '--outcome', 'previewed', '--slug', 'inbox/test'], {
        encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
      });
      expect(previewReceipt.status).toBe(0);
      const preview = [
        '预分类建议：project，目标 inbox/test',
        '---\ntype: project\nstatus: draft\n---',
        '# 标题\n## 场景与目标\n## 适用条件\n## 不适用条件\n## 验证证据\n## 脱敏说明',
        '如需拒绝或修改，请在 5 分钟内回复；5 分钟没有回复将继续写入 `inbox/`。',
      ].join('\n');
      const released = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: preview }));
      expect(released.json.decision).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unattended mode is latched for a turn and never creates a continuation prompt', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const prompt = runHook(script, stateDir, event('UserPromptSubmit', { prompt: '实现一个长期训练任务' }), {
        GBRAIN_EXPERIENCE_HOOK_MODE: 'unattended',
      });
      expect(prompt.status).toBe(0);
      expect(prompt.json.decision).toBeUndefined();

      const stopped = runHook(script, stateDir, event('Stop', {
        stop_hook_active: false,
        last_assistant_message: '训练流程结束。',
      }));
      expect(stopped.status).toBe(0);
      expect(stopped.json.decision).toBeUndefined();
      expect(stopped.stdout.trim()).toBe('{}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('state stores only bounded metadata with private permissions and per-tool event files', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const secretPrompt = '修改配置，password=do-not-store';
      const secretCommand = 'deploy --token do-not-store';
      runHook(script, stateDir, event('UserPromptSubmit', { prompt: secretPrompt }));
      for (let i = 0; i < 3; i += 1) {
        runHook(script, stateDir, event('PostToolUse', {
          tool_name: 'Bash', tool_use_id: `tool-${i}`, tool_input: { command: secretCommand }, tool_response: { exit_code: 0 },
        }));
      }

      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      const files = readdirSync(stateDir, { recursive: true })
        .map(String)
        .filter((entry) => statSync(join(stateDir, entry)).isFile());
      expect(files.length).toBeGreaterThanOrEqual(4);
      const stored = files.map((entry) => readFileSync(join(stateDir, entry), 'utf8')).join('\n');
      expect(stored).not.toContain(secretPrompt);
      expect(stored).not.toContain(secretCommand);
      expect(stored).not.toContain('do-not-store');
      for (const file of files) expect(statSync(join(stateDir, file)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mode CLI supports finite unattended windows, status JSON, and enforce reset', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const env = { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir };
      const set = spawnSync('python3', [script, 'mode', 'unattended', '--for', '12h'], { encoding: 'utf8', env });
      expect(set.status).toBe(0);
      expect(JSON.parse(set.stdout).mode).toBe('unattended');
      const status = spawnSync('python3', [script, 'status', '--json'], { encoding: 'utf8', env });
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout).effective_mode).toBe('unattended');
      expect(JSON.parse(status.stdout).expires_at).toBeTruthy();
      const reset = spawnSync('python3', [script, 'mode', 'enforce'], { encoding: 'utf8', env });
      expect(reset.status).toBe(0);
      expect(JSON.parse(reset.stdout).mode).toBe('enforce');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
