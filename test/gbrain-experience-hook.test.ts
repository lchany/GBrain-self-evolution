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

  test('a complete preview starts a review countdown instead of releasing Stop', async () => {
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
      const review = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: preview }));
      expect(review.json.decision).toBe('block');
      expect(review.json.reason).toContain('5 分钟');
      expect(review.json.reason).toContain(' wait --token ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('captured receipt is released only after matching successful put and get events', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('PostToolUse', {
        tool_name: 'apply_patch', tool_use_id: 'edit', tool_input: { command: 'patch' }, tool_response: 'Done!',
      }));
      const first = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '收尾。' }));
      const token = String(first.json.reason).match(/--token ([A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeTruthy();
      for (const [tool_name, tool_use_id] of [
        ['mcp__gbrain__put_page', 'put'],
        ['mcp__gbrain__get_page', 'get'],
      ]) {
        runHook(script, stateDir, event('PostToolUse', {
          tool_name, tool_use_id, tool_input: { slug: 'inbox/verified-capture' }, tool_response: { isError: false },
        }));
      }
      const receipt = spawnSync('python3', [
        script, 'receipt', '--token', token!, '--outcome', 'captured', '--slug', 'inbox/verified-capture',
      ], { encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir } });
      expect(receipt.status).toBe(0);
      const released = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: '已验证写入。' }));
      expect(released.json.decision).toBeUndefined();
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

  test('wait defaults to approval after the review deadline and capture is still required', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('UserPromptSubmit', { prompt: '实现功能并总结经验' }));
      const first = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '完成。' }));
      const receiptToken = String(first.json.reason).match(/--token ([A-Za-z0-9_-]+)/)?.[1];
      expect(receiptToken).toBeTruthy();
      const receipt = spawnSync('python3', [
        script, 'receipt', '--token', receiptToken!, '--outcome', 'previewed', '--slug', 'inbox/timeout-review',
      ], { encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir } });
      expect(receipt.status).toBe(0);
      const preview = [
        '预分类建议：project，目标 inbox/timeout-review',
        '---\ntype: project\nstatus: draft\n---',
        '# 标题\n## 场景与目标\n## 适用条件\n## 不适用条件\n## 验证证据\n## 脱敏说明',
        '如需拒绝或修改，请在 5 分钟内回复；5 分钟没有回复将继续写入 `inbox/`。',
      ].join('\n');
      const review = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: preview }), {
        GBRAIN_EXPERIENCE_HOOK_TESTING: '1',
        GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS: '1',
      });
      const reviewToken = String(review.json.reason).match(/wait --token ([A-Za-z0-9_-]+)/)?.[1];
      expect(reviewToken).toBeTruthy();
      expect(reviewToken).toStartWith('gb_');
      const waited = spawnSync('python3', [script, 'wait', '--token', reviewToken!], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir,
          GBRAIN_EXPERIENCE_HOOK_TESTING: '1',
          GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS: '1',
        },
      });
      expect(waited.status).toBe(0);
      expect(JSON.parse(waited.stdout).status).toBe('approved');

      const storedReviewState = readdirSync(stateDir, { recursive: true })
        .map(String)
        .filter((entry) => statSync(join(stateDir, entry)).isFile())
        .map((entry) => readFileSync(join(stateDir, entry), 'utf8'))
        .join('\n');
      expect(storedReviewState).not.toContain(reviewToken!);

      const uncaptured = runHook(script, stateDir, event('Stop', {
        stop_hook_active: true,
        last_assistant_message: '等待期结束。',
      }));
      expect(uncaptured.json.decision).toBe('block');
      expect(uncaptured.json.reason).toContain('写入');

      for (const [tool_name, tool_use_id] of [
        ['mcp__gbrain__put_page', 'put-after-timeout'],
        ['mcp__gbrain__get_page', 'get-after-timeout'],
      ]) {
        runHook(script, stateDir, event('PostToolUse', {
          tool_name, tool_use_id, tool_input: { slug: 'inbox/timeout-review' }, tool_response: { isError: false },
        }));
      }
      const captured = spawnSync('python3', [
        script, 'receipt', '--token', reviewToken!, '--outcome', 'captured', '--slug', 'inbox/timeout-review',
      ], { encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir } });
      expect(captured.status).toBe(0);
      const released = runHook(script, stateDir, event('Stop', {
        stop_hook_active: true,
        last_assistant_message: '草稿已写入并验证。',
      }));
      expect(released.json.decision).toBeUndefined();
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

  test('any user message before the deadline interrupts automatic approval', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-experience-guard.py');
      const stateDir = join(root, 'state');
      runHook(script, stateDir, event('UserPromptSubmit', { prompt: '实现功能并总结经验' }));
      const first = runHook(script, stateDir, event('Stop', { stop_hook_active: false, last_assistant_message: '完成。' }));
      const receiptToken = String(first.json.reason).match(/--token ([A-Za-z0-9_-]+)/)?.[1];
      spawnSync('python3', [
        script, 'receipt', '--token', receiptToken!, '--outcome', 'previewed', '--slug', 'inbox/interrupted-review',
      ], { encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir } });
      const preview = [
        '预分类建议：project，目标 inbox/interrupted-review',
        '---\ntype: project\nstatus: draft\n---',
        '# 标题\n## 场景与目标\n## 适用条件\n## 不适用条件\n## 验证证据\n## 脱敏说明',
        '如需拒绝或修改，请在 5 分钟内回复；5 分钟没有回复将继续写入 `inbox/`。',
      ].join('\n');
      const review = runHook(script, stateDir, event('Stop', { stop_hook_active: true, last_assistant_message: preview }));
      const reviewToken = String(review.json.reason).match(/wait --token ([A-Za-z0-9_-]+)/)?.[1];
      expect(reviewToken).toBeTruthy();

      const interrupted = runHook(script, stateDir, event('UserPromptSubmit', {
        turn_id: 'turn-user-response',
        prompt: '这条经验需要修改。',
      }));
      expect(interrupted.json.systemMessage).toContain('自动同意已取消');
      const waited = spawnSync('python3', [script, 'wait', '--token', reviewToken!], {
        encoding: 'utf8', env: { ...process.env, GBRAIN_EXPERIENCE_HOOK_STATE_DIR: stateDir },
      });
      expect(waited.status).toBe(0);
      expect(JSON.parse(waited.stdout).status).toBe('interrupted');
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
