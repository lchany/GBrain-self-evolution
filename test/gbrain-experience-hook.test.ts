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

function completeCloseout(
  script: string,
  stateDir: string,
  token: string,
  outcome: 'captured' | 'no_candidate' = 'no_candidate',
  slug?: string,
  candidateBasis = 'verified_reusable_knowledge',
) {
  return receipt(script, stateDir, [
    '--token', token,
    '--outcome', outcome,
    '--verified',
    ...(slug ? ['--slug', slug] : []),
    ...(outcome === 'captured' ? ['--candidate-basis', candidateBasis] : []),
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

  test('Given explicit cross-turn worker receipts When the parent stops Then the first Stop releases without child tool events', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const started = runHook(script, stateDir, event('UserPromptSubmit', { prompt: '请记住并保存为经验：部署前先验证配置' }));
      const recallToken = tokenFrom(started.json, 'RECALL');
      const closeoutToken = tokenFrom(started.json, 'CLOSEOUT');
      expect(JSON.stringify(started.json)).toContain(`python3 ${script} receipt --token ${recallToken}`);
      expect(JSON.stringify(started.json)).toContain(`python3 ${script} receipt --token ${closeoutToken}`);

      const workerEvent = (eventName: string, extra: Record<string, unknown> = {}) => event(eventName, {
        session_id: 'session-worker',
        turn_id: 'turn-worker',
        ...extra,
      });
      const workerStarted = runHook(script, stateDir, workerEvent('UserPromptSubmit', {
        prompt: `GBRAIN_EXPERIENCE_CLOSEOUT_WORKER_TOKEN=${closeoutToken}\n完成经验收尾。`,
      }));
      expect(JSON.stringify(workerStarted.json)).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_WORKER');
      const recallReceipt = completeRecall(script, stateDir, recallToken, ['使用显式跨 turn receipt']);
      expect(recallReceipt.status).toBe(0);
      expect(JSON.parse(recallReceipt.stdout)).toEqual({
        phase: 'recall', classification: 'direct', constraints: ['使用显式跨 turn receipt'], receipt_status: 'accepted',
      });
      const closeoutReceipt = completeCloseout(
        script, stateDir, closeoutToken, 'captured', 'inbox/isolated-capture', 'explicit_retention_request',
      );
      expect(closeoutReceipt.status).toBe(0);
      expect(JSON.parse(closeoutReceipt.stdout)).toEqual({
        phase: 'closeout', outcome: 'captured', slug: 'inbox/isolated-capture', verified: true,
        receipt_status: 'accepted', blocker_code: null, candidate_basis: 'explicit_retention_request',
      });
      expect(runHook(script, stateDir, workerEvent('Stop')).json.decision).toBeUndefined();

      const released = runHook(script, stateDir, event('Stop', { stop_hook_active: false }));
      expect(released.json.decision).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('simple questions, repeated read-only tools, and subagents do not arm closeout', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');

      expect(runHook(script, stateDir, event('UserPromptSubmit', { prompt: '你是什么模型' })).json).toEqual({});
      for (let index = 0; index < 4; index += 1) {
        const result = runHook(script, stateDir, event('PostToolUse', {
          tool_name: index === 3 ? 'spawn_agent' : 'Read',
          tool_use_id: `read-${index}`,
          tool_input: { path: `/tmp/doc-${index}` },
          tool_response: { content: 'ok' },
        }));
        expect(JSON.stringify(result.json)).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      }
      expect(runHook(script, stateDir, event('Stop')).json).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('explicit retention requests arm recall and closeout together', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const started = runHook(script, stateDir, event('UserPromptSubmit', {
        prompt: '请保存为经验：发布前运行版本一致性检查',
      }));
      const context = JSON.stringify(started.json);
      expect(context).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(context).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(context).toContain('--candidate-basis');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('diagnosis and summary wording arms recall without closeout', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      for (const [index, prompt] of [
        '请诊断 additionalContextLimit 警告是什么意思',
        '请总结当前实现，但不要修改代码',
      ].entries()) {
        const result = runHook(script, join(root, `state-${index}`), event('UserPromptSubmit', {
          session_id: `session-${index}`, turn_id: `turn-${index}`, prompt,
        }));
        const context = JSON.stringify(result.json);
        expect(context).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
        expect(context).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('generic successful writes do not arm closeout', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      expect(runHook(script, stateDir, event('UserPromptSubmit', { prompt: 'please take care of it' })).json).toEqual({});

      const tool = runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'apply_patch', tool_use_id: 'edit', tool_input: { command: 'patch' }, tool_response: 'Done!',
      }));
      expect(JSON.stringify(tool.json)).not.toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(runHook(script, stateDir, event('Stop', { stop_hook_active: false })).json.decision).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('enforce blocks a nontrivial read-only turn only until a valid recall receipt is recorded', async () => {
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
      expect(stopped.json.reason).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      const recallToken = tokenFrom(stopped.json, 'RECALL');

      expect(completeRecall(script, stateDir, recallToken).status).toBe(0);

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

  test('captured receipt requires an explicit verified claim and does not depend on parent-turn MCP events', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'failure', tool_input: { command: 'custom-command' },
        tool_response: 'Process exited with code 2',
      }));
      const first = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '收尾。' }));
      const token = tokenFrom(first.json, 'CLOSEOUT');
      const unverified = receipt(script, stateDir, [
        '--token', token, '--outcome', 'captured', '--slug', 'inbox/verified-capture',
        '--candidate-basis', 'verified_reusable_knowledge',
      ]);
      expect(unverified.status).toBe(1);
      expect(JSON.parse(unverified.stdout).error).toContain('verified inbox slug and valid candidate basis');

      const missingBasis = receipt(script, stateDir, [
        '--token', token, '--outcome', 'captured', '--verified', '--slug', 'inbox/verified-capture',
      ]);
      expect(missingBasis.status).toBe(1);
      expect(JSON.parse(missingBasis.stdout).error).toContain('valid candidate basis');

      const invalidBasis = receipt(script, stateDir, [
        '--token', token, '--outcome', 'captured', '--verified', '--slug', 'inbox/verified-capture',
        '--candidate-basis', 'ordinary_task_summary',
      ]);
      expect(invalidBasis.status).not.toBe(0);

      const basisOnNoCandidate = receipt(script, stateDir, [
        '--token', token, '--outcome', 'no_candidate', '--verified',
        '--candidate-basis', 'verified_reusable_knowledge',
      ]);
      expect(basisOnNoCandidate.status).toBe(1);
      expect(JSON.parse(basisOnNoCandidate.stdout).error).toContain('no-candidate');
      const completed = completeCloseout(script, stateDir, token, 'captured', 'inbox/verified-capture');
      expect(completed.status).toBe(0);
      const released = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: '已验证写入。' }));
      expect(released.json.decision).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('phase tokens reject mixed, oversized, incomplete, and replayed envelopes without consuming a valid retry', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      const started = runHook(script, stateDir, event('UserPromptSubmit', { prompt: '请保存为经验：已实现并验证功能' }));
      const recallToken = tokenFrom(started.json, 'RECALL');
      const closeoutToken = tokenFrom(started.json, 'CLOSEOUT');

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

      const incompleteBlocked = receipt(script, stateDir, [
        '--token', closeoutToken, '--outcome', 'blocked',
      ]);
      expect(incompleteBlocked.status).toBe(1);
      expect(JSON.parse(incompleteBlocked.stdout).error).toContain('blocker code');
      expect(completeCloseout(script, stateDir, closeoutToken).status).toBe(0);
      expect(runHook(script, stateDir, event('Stop')).json.decision).toBeUndefined();

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

  test('invalid receipts fail open after two continuation prompts', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('UserPromptSubmit', { prompt: '实现功能' }));
      const first = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '完成' }));
      expect(first.json.decision).toBe('block');
      const second = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: '仍未检查' }));
      expect(second.json.decision).toBe('block');
      const third = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: '仍未检查' }));
      expect(third.json.decision).toBeUndefined();
      expect(third.json.systemMessage).toContain('fail-open');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unexpected string-shaped failures trigger closeout while expected test failures do not', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'failure', tool_input: { command: 'custom-command' },
        tool_response: 'Process exited with code 2',
      }));
      const unexpected = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '失败。' }));
      expect(unexpected.json.decision).toBe('block');

      const secondState = join(root, 'expected-state');
      runHook(script, secondState, event('PostToolUse', {
        tool_name: 'Bash', tool_use_id: 'expected', tool_input: { command: 'bun run test --filter expected-red' },
        tool_response: 'Process exited with code 1',
      }));
      const expected = runHook(script, secondState, event('Stop', { stop_hook_active: false, last_assistant_message: 'RED 已确认。' }));
      expect(expected.json.decision).toBeUndefined();
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
