import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  return mkdtempSync(join(tmpdir(), 'gbrain-client-installer-'));
}

function deps(root: string): InstallClientDeps {
  return {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
  };
}

function runProjectHook(script: string, cwd: string): Record<string, unknown> {
  const result = spawnSync('python3', [script], {
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'session-test',
      cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'test-model',
    }),
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runProjectHookAsync(script: string, cwd: string, sessionId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || stderr) {
        reject(new Error(`project hook failed: code=${code} stderr=${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as Record<string, unknown>);
    });
    child.stdin.end(JSON.stringify({
      session_id: sessionId,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'test-model',
    }));
  });
}

describe('gbrain install-client', () => {
  test('Given an isolated home When installer runs twice Then both client guards are idempotently installed without credentials', async () => {
    const root = tempRoot();
    try {
      const codexRoot = join(root, 'codex');
      mkdirSync(codexRoot, { recursive: true });
      writeFileSync(
        join(codexRoot, 'hooks.json'),
        JSON.stringify({
          description: 'existing hooks',
          hooks: {
            SessionStart: [{
              matcher: '^clear$',
              hooks: [{ type: 'command', command: 'printf existing-session-hook' }],
            }],
            PostToolUse: [{
              matcher: '^Bash$',
              hooks: [{ type: 'command', command: 'printf existing-post-hook' }],
            }],
          },
        }),
      );
      const output: string[] = [];
      const first = await runInstallClient(['--json'], { ...deps(root), stdout: (text) => output.push(text) });
      const second = await runInstallClient(['--json'], deps(root));

      expect(first).toBe(0);
      expect(second).toBe(0);
      expect(existsSync(join(root, 'xdg', 'gbrain'))).toBe(false);
      const opencodeRules = readFileSync(join(root, 'xdg', 'opencode', 'AGENTS.md'), 'utf8');
      const codexRules = readFileSync(join(root, 'codex', 'AGENTS.md'), 'utf8');
      expect(opencodeRules).toContain('GBRAIN_CLIENT_RULES_START');
      expect(codexRules).toContain('GBRAIN_CLIENT_RULES_START');
      expect(opencodeRules.match(/GBRAIN_CLIENT_RULES_START/g)).toHaveLength(1);
      expect(codexRules.match(/GBRAIN_CLIENT_RULES_START/g)).toHaveLength(1);
      expect(opencodeRules).toContain('默认使用中文');
      expect(opencodeRules).toContain('只读召回');
      expect(opencodeRules).toContain('主 Agent 不得直接调用 GBrain MCP 执行经验召回');
      expect(opencodeRules).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(opencodeRules).toContain('第 2 次');
      expect(opencodeRules).toContain('Closeout Worker 直接调用 `put_page`');
      expect(opencodeRules).not.toContain('5 分钟');
      expect(opencodeRules).toContain('.gbrain-project.yaml');
      expect(opencodeRules).toContain('project_id');
      expect(opencodeRules).toContain('match_project');
      expect(opencodeRules).toContain('ensure_project');
      expect(opencodeRules).toContain('gbrain project bind <project_id> --resolved');
      expect(opencodeRules).toContain('不使用 Git');
      expect(opencodeRules).toContain('不得通过远程 `put_page` 创建或修改项目登记页');
      expect(codexRules).toContain('默认使用中文');
      expect(codexRules).toContain('只读召回');
      expect(codexRules).toContain('第 2 次');
      expect(codexRules).toContain('Closeout Worker 直接调用 `put_page`');
      expect(codexRules).not.toContain('5 分钟');
      expect(codexRules).toContain('match_project');
      expect(codexRules).toContain('OpenCode 首消息守卫与 Codex `SessionStart` Hook');
      expect(codexRules).toContain('只检查会话 `cwd` 直接目录');
      expect(codexRules).toContain('不直接调用 MCP');
      expect(codexRules).toContain('GBRAIN_PROJECT_BOOTSTRAP_REQUIRED');
      expect(codexRules).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(codexRules).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');

      const opencodeCapture = readFileSync(
        join(root, 'xdg', 'opencode', 'skills', 'gbrain-capture', 'SKILL.md'),
        'utf8',
      );
      const codexCapture = readFileSync(join(root, 'codex', 'skills', 'gbrain-capture', 'SKILL.md'), 'utf8');
      const opencodeReview = readFileSync(
        join(root, 'xdg', 'opencode', 'skills', 'gbrain-review', 'SKILL.md'),
        'utf8',
      );
      const codexReview = readFileSync(join(root, 'codex', 'skills', 'gbrain-review', 'SKILL.md'), 'utf8');
      expect(opencodeCapture).toBe(codexCapture);
      expect(opencodeReview).toBe(codexReview);

      expect(opencodeCapture).toContain('put_page');
      expect(opencodeCapture).toContain('## 零、隔离执行契约');
      expect(opencodeCapture).toContain('主 Agent 不得直接执行经验召回');
      expect(opencodeCapture).toContain('可修复服务端拒绝由 Worker');
      expect(opencodeCapture).toContain('inbox/');
      expect(opencodeCapture).toContain('## 场景与目标');
      expect(opencodeCapture).toContain('## 适用条件');
      expect(opencodeCapture).toContain('## 不适用条件');
      expect(opencodeCapture).toContain('## 召回提示');
      expect(opencodeCapture).toContain('applicability');
      expect(opencodeCapture).toContain('non_applicable');
      expect(opencodeCapture).toContain('预分类建议');
      expect(opencodeCapture).toContain('## 六、同步写入');
      expect(opencodeCapture).toContain('立即调用 `put_page`');
      expect(opencodeCapture).not.toContain('5 分钟');
      expect(opencodeCapture).toContain('project_binding');
      expect(opencodeCapture).toContain('match_project');
      expect(opencodeCapture).toContain('ensure_project');
      expect(opencodeCapture).toContain('gbrain project bind <project_id> --resolved');
      expect(opencodeCapture).toMatch(/内存中的\s+`project_id`/);
      expect(opencodeCapture).toContain('不使用 Git');
      expect(opencodeCapture).not.toContain('即使只有一个候选');
      expect(opencodeCapture).not.toContain('repository_ref');
      expect(opencodeCapture).toContain('不得调用 `put_page`');
      expect(opencodeCapture).toContain('project_binding: bound');
      expect(opencodeCapture).not.toContain('project_binding: <pending|bound>');
      expect(opencodeCapture).not.toContain('本地 writer 凭据');
      expect(opencodeCapture).not.toContain('gbrain capture');

      expect(opencodeReview).toContain('list_pages');
      expect(opencodeReview).toContain('认证的管理员审核界面');
      expect(opencodeReview).toContain('只调整分类');
      expect(opencodeReview).toContain('不得修改已确认正文');
      expect(opencodeReview).toContain('拒绝或退回');
      expect(opencodeReview).toContain('projects/<project_id>/');
      expect(opencodeReview).toContain('source_project_ids');
      expect(opencodeReview).not.toContain('gbrain review');
      expect(opencodeReview).not.toContain('PROMOTE <target-slug>');

      const hookScript = join(codexRoot, 'hooks', 'gbrain-project-check.py');
      const experienceHookScript = join(codexRoot, 'hooks', 'gbrain-experience-guard.py');
      const opencodeRoot = join(root, 'xdg', 'opencode');
      const opencodeProjectHook = join(opencodeRoot, 'hooks', 'gbrain-project-check.py');
      const opencodeExperienceHook = join(opencodeRoot, 'hooks', 'gbrain-experience-guard.py');
      const opencodeExperiencePlugin = join(root, 'xdg', 'opencode', 'plugins', 'gbrain-experience-guard.ts');
      const hooksJsonPath = join(codexRoot, 'hooks.json');
      expect(existsSync(hookScript)).toBe(true);
      expect(existsSync(experienceHookScript)).toBe(true);
      expect(existsSync(opencodeProjectHook)).toBe(true);
      expect(existsSync(opencodeExperienceHook)).toBe(true);
      expect(existsSync(opencodeExperiencePlugin)).toBe(true);
      expect(statSync(hookScript).mode & 0o777).toBe(0o700);
      expect(statSync(experienceHookScript).mode & 0o777).toBe(0o700);
      expect(statSync(opencodeProjectHook).mode & 0o777).toBe(0o700);
      expect(statSync(opencodeExperienceHook).mode & 0o777).toBe(0o700);
      expect(statSync(opencodeExperiencePlugin).mode & 0o777).toBe(0o600);
      expect(statSync(hooksJsonPath).mode & 0o777).toBe(0o600);
      const hooksConfig = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as {
        description?: string;
        hooks: Record<string, Array<{
          matcher?: string;
          hooks?: Array<{ command?: string; statusMessage?: string; additionalContextLimit?: number }>;
        }>>;
      };
      expect(hooksConfig.description).toBe('existing hooks');
      expect(hooksConfig.hooks.PostToolUse[0].hooks?.[0].command).toBe('printf existing-post-hook');
      expect(hooksConfig.hooks.SessionStart.some((entry) => entry.matcher === '^clear$')).toBe(true);
      const gbrainHandlers = hooksConfig.hooks.SessionStart.flatMap((entry) => entry.hooks ?? [])
        .filter((handler) => handler.statusMessage === '检查当前目录的 GBrain 项目 ID');
      expect(gbrainHandlers).toHaveLength(1);
      expect(gbrainHandlers[0].command).toContain('gbrain-project-check.py');
      for (const eventName of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
        const handlers = hooksConfig.hooks[eventName].flatMap((entry) => entry.hooks ?? [])
          .filter((handler) => handler.statusMessage === 'GBrain 经验 Worker 守卫');
        expect(handlers).toHaveLength(1);
        expect(handlers[0].command).toContain('gbrain-experience-guard.py');
        if (eventName !== 'Stop') expect(handlers[0].additionalContextLimit).toBe(2048);
      }

      const summary = JSON.parse(output.join('')) as {
        ok: boolean;
        surfaces: Array<{
          name: string;
          hook?: { script: string; config: string; trust_required: boolean };
          experience_hook?: { script?: string; plugin?: string; mode: string } | null;
        }>;
      };
      expect(summary.ok).toBe(true);
      expect(summary.surfaces.find((surface) => surface.name === 'codex')?.hook).toEqual({
        script: hookScript,
        config: hooksJsonPath,
        trust_required: true,
      });
      expect(summary.surfaces.find((surface) => surface.name === 'codex')?.experience_hook).toEqual({
        script: experienceHookScript,
        mode: 'isolated_subagent_capture',
      });
      expect(summary.surfaces.find((surface) => surface.name === 'opencode')?.hook).toEqual({
        script: opencodeProjectHook,
        config: opencodeExperiencePlugin,
        trust_required: false,
      });
      expect(summary.surfaces.find((surface) => surface.name === 'opencode')?.experience_hook).toEqual({
        script: opencodeExperienceHook,
        plugin: opencodeExperiencePlugin,
        mode: 'isolated_subagent_capture',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given no-experience-hook When installer runs Then only managed experience handlers are removed', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      expect(await runInstallClient(['--json', '--no-experience-hook'], deps(root))).toBe(0);
      const opencodeRoot = join(root, 'xdg', 'opencode');
      expect(existsSync(join(opencodeRoot, 'plugins', 'gbrain-experience-guard.ts'))).toBe(true);
      expect(existsSync(join(opencodeRoot, 'hooks', 'gbrain-project-check.py'))).toBe(true);
      expect(existsSync(join(opencodeRoot, 'hooks', 'gbrain-experience-guard.py'))).toBe(false);
      expect(existsSync(join(root, 'codex', 'hooks', 'gbrain-experience-guard.py'))).toBe(false);
      expect(readFileSync(join(opencodeRoot, 'plugins', 'gbrain-experience-guard.ts'), 'utf8'))
        .toContain('const EXPERIENCE_ENABLED = false');
      const config = JSON.parse(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8')) as {
        hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      expect(JSON.stringify(config.hooks.SessionStart)).toContain('gbrain-project-check.py');
      expect(JSON.stringify(config.hooks)).not.toContain('gbrain-experience-guard.py');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given parent and child directories When the Codex hook runs Then it checks only cwd and never inherits the parent project ID', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-project-check.py');
      const project = join(root, 'project');
      const child = join(project, 'child');
      mkdirSync(child, { recursive: true });
      writeFileSync(
        join(project, '.gbrain-project.yaml'),
        'schema_version: 1\nproject_id: prj-0123456789abcdef\n',
        { mode: 0o600 },
      );

      const parentResult = runProjectHook(script, project);
      expect(JSON.stringify(parentResult)).toContain('prj-0123456789abcdef');
      expect(JSON.stringify(parentResult)).toContain('已绑定');

      const childResult = runProjectHook(script, child);
      expect(JSON.stringify(childResult)).toContain('当前目录未找到');
      expect(JSON.stringify(childResult)).toContain('GBRAIN_PROJECT_BOOTSTRAP_REQUIRED');
      expect(JSON.stringify(childResult)).toContain('GBRAIN_PROJECT_BOOTSTRAP_WORKER');
      expect(JSON.stringify(childResult)).toContain('独立子 Agent');
      expect(JSON.stringify(childResult)).not.toContain('prj-0123456789abcdef');
      expect(childResult.continue).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given concurrent unbound sessions When SessionStart runs Then both bootstrap workers reuse one creation key', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-project-check.py');
      const project = join(root, 'project');
      mkdirSync(project, { recursive: true });

      const results = await Promise.all([
        runProjectHookAsync(script, project, 'session-a'),
        runProjectHookAsync(script, project, 'session-b'),
      ]);
      const keys = results.map((result) => JSON.stringify(result)
        .match(/GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY=([A-Za-z0-9_-]+)/)?.[1]);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);

      const context = JSON.stringify(results[0]);
      const complete = context.match(/python3 ([^ ]+) complete-bootstrap --cwd ([^ ]+) --creation-key ([A-Za-z0-9_-]+)/);
      expect(complete).toBeTruthy();
      const premature = spawnSync('sh', ['-c', complete![0]], { encoding: 'utf8' });
      expect(premature.status).not.toBe(0);
      expect(JSON.parse(premature.stdout).status).toBe('marker_missing');
      const beforeBinding = runProjectHook(script, project);
      expect(JSON.stringify(beforeBinding)).toContain(`GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY=${keys[0]}`);

      writeFileSync(
        join(project, '.gbrain-project.yaml'),
        'schema_version: 1\nproject_id: prj-0123456789abcdef\n',
        { mode: 0o600 },
      );
      const completed = spawnSync('sh', ['-c', complete![0]], { encoding: 'utf8' });
      expect(completed.status).toBe(0);
      expect(JSON.parse(completed.stdout).status).toBe('completed');
      const repeated = spawnSync('sh', ['-c', complete![0]], { encoding: 'utf8' });
      expect(repeated.status).toBe(0);
      expect(JSON.parse(repeated.stdout).status).toBe('already_completed');

      rmSync(join(project, '.gbrain-project.yaml'));
      const afterCompletion = runProjectHook(script, project);
      const nextKey = JSON.stringify(afterCompletion)
        .match(/GBRAIN_PROJECT_BOOTSTRAP_CREATION_KEY=([A-Za-z0-9_-]+)/)?.[1];
      expect(nextKey).toBeTruthy();
      expect(nextKey).not.toBe(keys[0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a repository project reference at cwd When the Codex hook runs Then it reports the recorded ID without warning', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-project-check.py');
      mkdirSync(join(root, '.gbrain'), { recursive: true });
      writeFileSync(
        join(root, '.gbrain', 'project.yaml'),
        'schema_version: 1\nproject_id: prj-0123456789abcdef\n',
      );

      const result = runProjectHook(script, root);
      expect(JSON.stringify(result)).toContain('prj-0123456789abcdef');
      expect(JSON.stringify(result)).toContain('仓库项目身份记录');
      expect(JSON.stringify(result)).toContain('GBRAIN_PROJECT_BOOTSTRAP_REQUIRED');
      expect(JSON.stringify(result)).toContain('GBRAIN_PROJECT_BOOTSTRAP_WORKER');
      expect(result.systemMessage).toBeUndefined();
      expect(result.continue).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given invalid or untrusted markers When the Codex hook runs Then it warns without blocking or executing cwd text', async () => {
    const root = tempRoot();
    try {
      expect(await runInstallClient(['--json'], deps(root))).toBe(0);
      const script = join(root, 'codex', 'hooks', 'gbrain-project-check.py');
      const sentinel = join(root, 'must-not-exist');
      const hostile = join(root, 'project-$(touch must-not-exist)');
      mkdirSync(hostile, { recursive: true });

      writeFileSync(
        join(hostile, '.gbrain-project.yaml'),
        'schema_version: 1\nproject_id: PRJ-0123456789ABCDEF\n',
        { mode: 0o600 },
      );
      const invalidResult = runProjectHook(script, hostile);
      expect(JSON.stringify(invalidResult)).toContain('格式无效');
      expect(invalidResult.continue).toBe(true);
      expect(existsSync(sentinel)).toBe(false);

      rmSync(join(hostile, '.gbrain-project.yaml'));
      const target = join(root, 'marker-target');
      writeFileSync(target, 'schema_version: 1\nproject_id: prj-0123456789abcdef\n', { mode: 0o600 });
      symlinkSync(target, join(hostile, '.gbrain-project.yaml'));
      const symlinkResult = runProjectHook(script, hostile);
      expect(JSON.stringify(symlinkResult)).toContain('不可信');
      expect(JSON.stringify(symlinkResult)).not.toContain('prj-0123456789abcdef');

      rmSync(join(hostile, '.gbrain-project.yaml'));
      writeFileSync(
        join(hostile, '.gbrain-project.yaml'),
        'schema_version: 1\nproject_id: prj-0123456789abcdef\n',
        { mode: 0o600 },
      );
      chmodSync(join(hostile, '.gbrain-project.yaml'), 0o606);
      const writableResult = runProjectHook(script, hostile);
      expect(JSON.stringify(writableResult)).toContain('不可信');
      expect(JSON.stringify(writableResult)).not.toContain('prj-0123456789abcdef');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given CODEX_HOME contains a shell metacharacter When the installed command runs Then the hook path stays one literal argument', async () => {
    const root = tempRoot();
    try {
      const quotedCodexHome = join(root, "codex'quoted");
      expect(await runInstallClient(['--json'], {
        env: {
          HOME: join(root, 'home'),
          XDG_CONFIG_HOME: join(root, 'xdg'),
          CODEX_HOME: quotedCodexHome,
        },
      })).toBe(0);
      const config = JSON.parse(readFileSync(join(quotedCodexHome, 'hooks.json'), 'utf8')) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string; statusMessage: string }> }> };
      };
      const handler = config.hooks.SessionStart.flatMap((group) => group.hooks)
        .find((candidate) => candidate.statusMessage === '检查当前目录的 GBrain 项目 ID');
      expect(handler).toBeDefined();

      const result = spawnSync('sh', ['-c', handler!.command], {
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 'session-test',
          cwd: root,
          hook_event_name: 'SessionStart',
          source: 'startup',
          model: 'test-model',
        }),
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('当前目录未找到');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a credential-related flag When installer runs Then it rejects the obsolete credential workflow', async () => {
    const root = tempRoot();
    try {
      const errors: string[] = [];
      const code = await runInstallClient(['--read-env-source', join(root, 'missing.env')], {
        ...deps(root),
        stderr: (text) => errors.push(text),
      });

      expect(code).toBe(1);
      expect(errors.join('')).toContain('unknown install-client argument');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
