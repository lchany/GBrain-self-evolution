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
  test('Given ordinary work prompts When turns start Then recall stays silent', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');

      for (const [index, prompt] of [
        '请修复按钮样式',
        '实现一个普通查询接口',
        '部署当前已经验证的构建',
        '帮我排查这个日志报错',
        '总结这段代码',
      ].entries()) {
        const started = runHook(script, stateDir, event('UserPromptSubmit', {
          session_id: `session-ordinary-${index}`, turn_id: `turn-ordinary-${index}`, prompt,
        }));
        expect(started.json).toEqual({});
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a high-impact decision or explicit request When the turn starts Then decision recall is armed', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      for (const [index, prompt] of [
        '请在 PostgreSQL 和 SQLite 之间选型并决定生产数据库架构',
        '是否应该改变认证和权限边界？请给出方案取舍',
        '生产数据库要不要切换到 PostgreSQL？',
        'Should we switch the production database architecture?',
        '请召回历史经验后再处理这个问题',
      ].entries()) {
        const started = runHook(script, stateDir, event('UserPromptSubmit', {
          session_id: `session-decision-${index}`, turn_id: `turn-decision-${index}`, prompt,
        }));
        const context = JSON.stringify(started.json);
        expect(context).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
        expect(context).toContain('重大决策');
        expect(context).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=gbr_');
        expect(context).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      }
      const mentionOnly = runHook(script, stateDir, event('UserPromptSubmit', {
        session_id: 'session-mention', turn_id: 'turn-mention', prompt: '修改认证接口的一个返回字段',
      }));
      expect(mentionOnly.json).toEqual({});
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
      const started = runHook(script, stateDir, event('UserPromptSubmit', {
        prompt: '请在两种数据库之间选型并决定生产架构',
      }));
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
        session_id: 'session-race', turn_id: 'turn-race', prompt: '请决定生产认证架构的技术选型',
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

  test('Given tool outcomes When observed Then only the first unexpected failure arms failure recall', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      expect(runHook(script, stateDir, event('UserPromptSubmit', { prompt: '请修复一个普通问题' })).json).toEqual({});
      const success = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'success', tool_input: { command: 'custom-command' },
        tool_response: { exit_code: 0 },
      }));
      const expectedTest = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'expected-test', tool_input: { command: 'bun test focused.test.ts' },
        tool_response: { exit_code: 1 },
      }));
      const cancelled = runHook(script, stateDir, event('PostToolUse', {
        session_id: 'session-cancelled', turn_id: 'turn-cancelled', tool_name: 'exec_command',
        tool_input: { cmd: 'custom-command' }, tool_response: { exit_code: 1, error: 'cancelled by user' },
      }));
      const failure = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'failure', tool_input: { command: 'custom-command' },
        tool_response: { exit_code: 2, error: 'secret failure details' },
      }));
      const repeated = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'failure-2', tool_input: { command: 'different-command' },
        tool_response: { exit_code: 3 },
      }));
      const stopped = runHook(script, stateDir, event('Stop', { stop_hook_active: false }));
      expect(success.json).toEqual({});
      expect(expectedTest.json).toEqual({});
      expect(cancelled.json).toEqual({});
      expect(JSON.stringify(failure.json)).toContain('当前方案出现非预期错误');
      expect(JSON.stringify(failure.json)).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=gbr_');
      expect(repeated.json).toEqual({});
      expect(stopped.json.decision).toBeUndefined();
      expect(JSON.stringify([failure.json, stopped.json])).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given completed decision recall When execution later fails Then failure recall gets a distinct token', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const decision = runHook(script, stateDir, event('UserPromptSubmit', {
        prompt: '请在两种数据库之间选型并决定生产架构',
      }));
      const decisionToken = tokenFrom(decision.json, 'RECALL');
      expect(completeRecall(script, stateDir, decisionToken).status).toBe(0);
      const failure = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'failure-after-decision', tool_input: { command: 'apply-plan' },
        tool_response: { exit_code: 2 },
      }));
      const failureToken = tokenFrom(failure.json, 'RECALL');
      expect(failureToken).not.toBe(decisionToken);
      expect(JSON.stringify(failure.json)).toContain('当前方案出现非预期错误');
      expect(completeRecall(script, stateDir, failureToken).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a recall worker turn When its tool fails Then the guard does not recursively request recall', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const parent = runHook(script, stateDir, event('UserPromptSubmit', {
        prompt: '请决定生产数据库架构的技术选型',
      }));
      const token = tokenFrom(parent.json, 'RECALL');
      const worker = runHook(script, stateDir, event('UserPromptSubmit', {
        session_id: 'worker-session', turn_id: 'worker-turn',
        prompt: `GBRAIN_EXPERIENCE_RECALL_WORKER_TOKEN=${token}\n`,
      }));
      expect(JSON.stringify(worker.json)).toContain('GBRAIN_EXPERIENCE_RECALL_WORKER');
      const failure = runHook(script, stateDir, event('PostToolUse', {
        session_id: 'worker-session', turn_id: 'worker-turn', tool_name: 'Bash',
        tool_input: { command: 'lookup-experience' }, tool_response: { exit_code: 2 },
      }));
      expect(failure.json).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('state stores only bounded private metadata without prompt, command, or error text', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const secretPrompt = '修复普通配置，password=do-not-store';
      const secretCommand = 'deploy --token do-not-store';
      runHook(script, stateDir, event('UserPromptSubmit', { prompt: secretPrompt }));
      for (let i = 0; i < 3; i += 1) {
        runHook(script, stateDir, event('PostToolUse', {
          tool_name: 'Bash', tool_use_id: `tool-${i}`, tool_input: { command: secretCommand },
          tool_response: i === 0 ? { exit_code: 2, error: 'secret-error-do-not-store' } : { exit_code: 0 },
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
      expect(stored).not.toContain('secret-error');
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
