import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient, type InstallClientDeps } from '../src/commands/gbrain-client-installer.ts';
import { runClientRepairForPostUpgrade } from '../src/commands/upgrade.ts';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-upgrade-client-repair-'));
}

function deps(path: string): InstallClientDeps {
  return {
    env: { HOME: join(path, 'home'), XDG_CONFIG_HOME: join(path, 'xdg'), CODEX_HOME: join(path, 'codex') },
  };
}

describe('post-upgrade client repair', () => {
  test('Given no managed client installation When post-upgrade repair runs Then it skips without creating files', async () => {
    const path = root();
    try {
      const warnings: string[] = [];
      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: (message) => warnings.push(message) });
      expect(result.status).toBe('skipped');
      expect(warnings).toEqual([]);
      expect(existsSync(join(path, 'xdg', 'opencode'))).toBe(false);
      expect(existsSync(join(path, 'codex'))).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('Given only custom client AGENTS files When post-upgrade repair runs Then it skips and a later install uses defaults', async () => {
    const path = root();
    try {
      const opencodeAgents = join(path, 'xdg', 'opencode', 'AGENTS.md');
      const codexAgents = join(path, 'codex', 'AGENTS.md');
      mkdirSync(join(opencodeAgents, '..'), { recursive: true });
      mkdirSync(join(codexAgents, '..'), { recursive: true });
      writeFileSync(opencodeAgents, 'custom opencode\n');
      writeFileSync(codexAgents, 'custom codex\n');
      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: () => undefined });
      expect(result.status).toBe('skipped');

      expect(await runInstallClient(['--json'], deps(path))).toBe(0);
      expect(readFileSync(opencodeAgents, 'utf8')).toContain('custom opencode');
      expect(readFileSync(codexAgents, 'utf8')).toContain('custom codex');
      expect(readFileSync(join(path, 'codex', '.gbrain-client-install.json'), 'utf8')).toContain('"experience_hook": true');
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('Given a current installation When post-upgrade repair runs Then it performs no writes', async () => {
    const path = root();
    try {
      expect(await runInstallClient(['--json'], deps(path))).toBe(0);
      const manifest = join(path, 'codex', '.gbrain-client-install.json');
      const content = readFileSync(manifest, 'utf8');
      const modified = statSync(manifest).mtimeMs;

      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: () => undefined });
      expect(result.status).toBe('current');
      expect(readFileSync(manifest, 'utf8')).toBe(content);
      expect(statSync(manifest).mtimeMs).toBe(modified);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('Given a stale disabled installation When post-upgrade repair runs Then it repairs assets and preserves the choice', async () => {
    const path = root();
    try {
      expect(await runInstallClient(['--json', '--no-experience-hook'], deps(path))).toBe(0);
      const skill = join(path, 'codex', 'skills', 'gbrain-review', 'SKILL.md');
      writeFileSync(skill, 'stale\n');

      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: () => undefined });
      expect(result.status).toBe('repaired');
      expect(result.check.ok).toBe(true);
      expect(result.check.surfaces.map((surface) => surface.experience_hook)).toEqual([false, false]);
      expect(readFileSync(join(path, 'codex', '.gbrain-client-install.json'), 'utf8'))
        .toContain('"experience_hook": false');
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('Given conflicting manifest choices When post-upgrade repair runs Then it warns without changing the installation', async () => {
    const path = root();
    try {
      expect(await runInstallClient(['--json', '--no-experience-hook'], deps(path))).toBe(0);
      const codexManifest = join(path, 'codex', '.gbrain-client-install.json');
      const before = JSON.parse(readFileSync(codexManifest, 'utf8')) as Record<string, unknown>;
      writeFileSync(codexManifest, `${JSON.stringify({ ...before, experience_hook: true }, null, 2)}\n`);
      const warnings: string[] = [];

      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: (message) => warnings.push(message) });
      expect(result.status).toBe('unrecoverable');
      expect(result.check.surfaces.every((surface) => surface.issues.includes('experience_choice_conflict'))).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('client_guard_repair_failed');
      expect(warnings[0]).not.toContain(path);
      expect(readFileSync(codexManifest, 'utf8')).toContain('"experience_hook": true');
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('Given a managed leaf symlink When post-upgrade repair runs Then it fails closed without touching the target', async () => {
    const path = root();
    try {
      expect(await runInstallClient(['--json', '--no-experience-hook'], deps(path))).toBe(0);
      const skill = join(path, 'codex', 'skills', 'gbrain-review', 'SKILL.md');
      const target = join(path, 'outside.txt');
      writeFileSync(target, 'outside\n');
      unlinkSync(skill);
      symlinkSync(target, skill);
      const warnings: string[] = [];

      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: (message) => warnings.push(message) });
      expect(result.status).toBe('unrecoverable');
      expect(result.check.surfaces[1]?.issues).toContain('skill_review_unsafe_type');
      expect(readFileSync(target, 'utf8')).toBe('outside\n');
      expect(lstatSync(skill).isSymbolicLink()).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain(path);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('Given a dangling disabled experience hook When post-upgrade repair runs Then it does not unlink the symlink', async () => {
    const path = root();
    try {
      expect(await runInstallClient(['--json', '--no-experience-hook'], deps(path))).toBe(0);
      const hook = join(path, 'codex', 'hooks', 'gbrain-experience-guard.py');
      symlinkSync(join(path, 'missing-target'), hook);

      const result = await runClientRepairForPostUpgrade({ ...deps(path), warn: () => undefined });
      expect(result.status).toBe('unrecoverable');
      expect(result.check.surfaces[1]?.issues).toContain('experience_hook_unsafe_type');
      expect(lstatSync(hook).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
