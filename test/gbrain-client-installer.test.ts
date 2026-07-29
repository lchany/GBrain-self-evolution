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
      expect(readFileSync(join(root, 'xdg', 'opencode', 'AGENTS.md'), 'utf8')).toContain('GBRAIN_CLIENT_RULES_START');
      expect(readFileSync(join(root, 'codex', 'AGENTS.md'), 'utf8')).toContain('GBRAIN_CLIENT_RULES_START');
      const captureSkill = readFileSync(join(root, 'xdg', 'opencode', 'skills', 'gbrain-capture', 'SKILL.md'), 'utf8');
      const reviewSkill = readFileSync(join(root, 'codex', 'skills', 'gbrain-review', 'SKILL.md'), 'utf8');
      expect(captureSkill).toContain('put_page');
      expect(captureSkill).toContain('inbox/');
      expect(captureSkill).not.toContain('gbrain capture');
      expect(reviewSkill).toContain('list_pages');
      expect(reviewSkill).toContain('authenticated admin review');
      expect(reviewSkill).not.toContain('gbrain review');
      expect(reviewSkill).not.toContain('PROMOTE <target-slug>');
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
