import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

describe('gbrain install-client', () => {
  test('Given an isolated home When installer runs twice Then rules, skills and the Codex hook are idempotently installed without credentials', async () => {
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
      expect(opencodeRules).toContain('第 2 次');
      expect(opencodeRules).toContain('5 分钟');
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
      expect(codexRules).toContain('5 分钟');
      expect(codexRules).toContain('match_project');

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
      expect(opencodeCapture).toContain('inbox/');
      expect(opencodeCapture).toContain('## 场景与目标');
      expect(opencodeCapture).toContain('## 适用条件');
      expect(opencodeCapture).toContain('## 不适用条件');
      expect(opencodeCapture).toContain('## 召回提示');
      expect(opencodeCapture).toContain('applicability');
      expect(opencodeCapture).toContain('non_applicable');
      expect(opencodeCapture).toContain('预分类建议');
      expect(opencodeCapture).toContain('5 分钟没有任何回复');
      expect(opencodeCapture).toContain('重新计算 5 分钟');
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
      const hooksJsonPath = join(codexRoot, 'hooks.json');
      expect(existsSync(hookScript)).toBe(true);
      const hooksConfig = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as {
        description?: string;
        hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; statusMessage?: string }> }>>;
      };
      expect(hooksConfig.description).toBe('existing hooks');
      expect(hooksConfig.hooks.PostToolUse[0].hooks?.[0].command).toBe('printf existing-post-hook');
      expect(hooksConfig.hooks.SessionStart.some((entry) => entry.matcher === '^clear$')).toBe(true);
      const gbrainHandlers = hooksConfig.hooks.SessionStart.flatMap((entry) => entry.hooks ?? [])
        .filter((handler) => handler.statusMessage === '检查当前目录的 GBrain 项目 ID');
      expect(gbrainHandlers).toHaveLength(1);
      expect(gbrainHandlers[0].command).toContain('gbrain-project-check.py');

      const summary = JSON.parse(output.join('')) as {
        ok: boolean;
        surfaces: Array<{ name: string; hook?: { script: string; config: string; trust_required: boolean } }>;
      };
      expect(summary.ok).toBe(true);
      expect(summary.surfaces.find((surface) => surface.name === 'codex')?.hook).toEqual({
        script: hookScript,
        config: hooksJsonPath,
        trust_required: true,
      });
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
      expect(JSON.stringify(childResult)).not.toContain('prj-0123456789abcdef');
      expect(childResult.continue).toBe(true);
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
