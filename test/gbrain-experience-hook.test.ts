import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
    env: {
      ...process.env,
      GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir,
      GBRAIN_EXPERIENCE_HOOK_TESTING: '1',
      ...extraEnv,
    },
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

function tokenFrom(value: unknown, marker: 'RECALL' | 'CLOSEOUT'): string {
  const token = JSON.stringify(value).match(
    new RegExp(`GBRAIN_EXPERIENCE_${marker}_WORKER_TOKEN=([A-Za-z0-9_-]+)`),
  )?.[1];
  if (!token) throw new Error(`missing ${marker.toLowerCase()} worker token`);
  return token;
}

function receipt(script: string, stateDir: string, args: string[]) {
  return spawnSync('python3', [script, 'receipt', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
  });
}

function receiptAsync(script: string, stateDir: string, args: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', [script, 'receipt', ...args], {
      env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

function completeRecall(script: string, stateDir: string, token: string, constraints: string[] = []) {
  return receipt(script, stateDir, [
    '--token', token,
    '--classification', constraints.length > 0 ? 'direct' : 'none',
    '--constraints-json', JSON.stringify(constraints),
  ]);
}

describe('Codex GBrain experience guard', () => {
  test('Given a nontrivial prompt When the turn starts Then only recall is armed', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');

      const started = runHook(script, stateDir, event('UserPromptSubmit', { prompt: '请修改代码并完成部署配置' }));
      const context = JSON.stringify(started.json);
      expect(context).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(context).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=gbr_');
      expect(context).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(context).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=gbc_');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a recall token When a worker submits a receipt Then phase validation and replay protection remain enforced', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const started = runHook(script, stateDir, event('UserPromptSubmit', { prompt: '请修改代码并完成部署配置' }));
      const recallToken = tokenFrom(started.json, 'RECALL');
      expect(JSON.stringify(started.json)).toContain(`python3 ${script} receipt --token ${recallToken}`);
      const mixed = receipt(script, stateDir, [
        '--token', recallToken, '--outcome', 'no_candidate', '--verified',
      ]);
      expect(mixed.status).toBe(1);
      expect(JSON.parse(mixed.stdout).error).toBe('phase_argument_mismatch');

      const oversized = receipt(script, stateDir, [
        '--token', recallToken, '--classification', 'direct',
        '--constraints-json', JSON.stringify(['one', 'two', 'three', 'four']),
      ]);
      expect(oversized.status).toBe(1);
      expect(JSON.parse(oversized.stdout).error).toContain('at most three');
      expect(completeRecall(script, stateDir, recallToken).status).toBe(0);
      expect(completeRecall(script, stateDir, recallToken).status).toBe(1);

      const raced = runHook(script, stateDir, event('UserPromptSubmit', {
        session_id: 'session-race', turn_id: 'turn-race', prompt: '请实现并验证另一个功能',
      }));
      const racedToken = tokenFrom(raced.json, 'RECALL');
      const raceArgs = ['--token', racedToken, '--classification', 'none', '--constraints-json', '[]'];
      const results = await Promise.all(Array.from({ length: 4 }, () => (
        receiptAsync(script, stateDir, raceArgs)
      )));
      expect(results.filter((result) => result.status === 0)).toHaveLength(1);
      expect(results.filter((result) => result.status === 1)).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given stale PostToolUse and Stop registrations When invoked Then both fail open without closeout context', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const tool = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'failure', tool_input: { command: 'custom-command' },
        tool_response: 'Process exited with code 2',
      }));
      const stopped = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '失败。' }));
      expect(tool.json).toEqual({});
      expect(stopped.json.decision).toBeUndefined();
      expect(JSON.stringify([tool.json, stopped.json])).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
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
      expect(files.length).toBeGreaterThanOrEqual(1);
      const stored = files.map((entry) => readFileSync(join(stateDir, entry), 'utf8')).join('\n');
      expect(stored).not.toContain(secretPrompt);
      expect(stored).not.toContain(secretCommand);
      expect(stored).not.toContain('do-not-store');
      expect(stored).not.toContain('session-test');
      for (const file of files) expect(statSync(join(stateDir, file)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mode commands are removed and symlink state roots fail open without following the link', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      mkdirSync(stateDir, { mode: 0o700 });
      const legacyMode = join(stateDir, 'mode.json');
      writeFileSync(legacyMode, JSON.stringify({ mode: 'unattended', expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 });
      const removed = spawnSync('python3', [script, 'mode', 'unattended', '--for', '12h'], {
        encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
      });
      expect(removed.status).not.toBe(0);
      expect(existsSync(legacyMode)).toBe(false);

      const target = join(root, 'outside');
      mkdirSync(target, { mode: 0o700 });
      const linked = join(root, 'linked-state');
      symlinkSync(target, linked);
      const failedOpen = runHook(script, linked, event('Stop', { stop_hook_active: false, last_assistant_message: '完成' }));
      expect(failedOpen.status).toBe(0);
      expect(failedOpen.json.systemMessage).toContain('fail-open');
      expect(readdirSync(target)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
