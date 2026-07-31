import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient, type InstallClientDeps } from '../src/commands/gbrain-client-installer.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-client-installer-'));
}

function deps(root: string): InstallClientDeps {
  return {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
  };
}

describe('gbrain install-client', () => {
  test('Given an isolated home When installer runs twice Then rules and skills are idempotently installed without credentials', async () => {
    const root = tempRoot();
    try {
      const first = await runInstallClient(['--json'], deps(root));
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
      expect(opencodeRules).toContain('不得调用 MCP `put_page`');
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
      expect(opencodeCapture).toContain('gbrain project match');
      expect(opencodeCapture).toContain('match_project');
      expect(opencodeCapture).toContain('ensure_project');
      expect(opencodeCapture).toContain('gbrain project bind <project_id> --resolved');
      expect(opencodeCapture).toContain('内存中的 `project_id`');
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
