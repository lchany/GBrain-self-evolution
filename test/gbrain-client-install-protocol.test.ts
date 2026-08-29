import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient, type InstallClientDeps } from '../src/commands/gbrain-client-installer.ts';
import { GBRAIN_RULES_BLOCK_END, GBRAIN_RULES_BLOCK_START } from '../src/commands/gbrain-client-installer-content.ts';
import { GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS } from '../src/commands/gbrain-codex-experience-hook-content.ts';

type Surface = {
  readonly name: 'opencode' | 'codex';
  readonly status: 'current' | 'stale' | 'not_installed';
  readonly experience_hook: boolean | null;
  readonly issues: readonly string[];
};

type ProtocolResult = {
  readonly ok: boolean;
  readonly protocol_version: number;
  readonly asset_digest: string;
  readonly surfaces: readonly Surface[];
};

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-client-protocol-'));
}

function deps(root: string, output: string[]): InstallClientDeps {
  return {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
    stdout: (text) => output.push(text),
  };
}

async function runJson(root: string, args: readonly string[]): Promise<{ code: number; result: ProtocolResult }> {
  const output: string[] = [];
  const code = await runInstallClient([...args, '--json'], deps(root, output));
  return { code, result: JSON.parse(output.join('')) as ProtocolResult };
}

function manifestPath(root: string, client: 'opencode' | 'codex'): string {
  return client === 'opencode'
    ? join(root, 'xdg', 'opencode', '.gbrain-client-install.json')
    : join(root, 'codex', '.gbrain-client-install.json');
}

function writeFixture(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('gbrain client install protocol', () => {
  test('Given a fresh home When install and check run Then both manifests and surfaces are current', async () => {
    const root = createRoot();
    try {
      const installed = await runJson(root, []);
      expect(installed.code).toBe(0);
      expect(installed.result.protocol_version).toBe(2);
      expect(installed.result.asset_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(installed.result.surfaces.map((surface) => surface.status)).toEqual(['current', 'current']);

      for (const client of ['opencode', 'codex'] as const) {
        const path = manifestPath(root, client);
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
          schema_version: number;
          protocol_version: number;
          asset_digest: string;
          experience_hook: boolean;
        };
        expect(manifest).toEqual({
          schema_version: 1,
          protocol_version: 2,
          asset_digest: installed.result.asset_digest,
          experience_hook: true,
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }

      const checked = await runJson(root, ['--check']);
      expect(checked.code).toBe(0);
      expect(checked.result).toEqual({
        ok: true,
        protocol_version: installed.result.protocol_version,
        asset_digest: installed.result.asset_digest,
        surfaces: [
          { name: 'opencode', status: 'current', experience_hook: true, issues: [] },
          { name: 'codex', status: 'current', experience_hook: true, issues: [] },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a modified managed skill When check and reinstall run Then drift is reported and repaired without touching custom rules', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, [])).code).toBe(0);
      const agents = join(root, 'xdg', 'opencode', 'AGENTS.md');
      writeFileSync(agents, `custom-before\n${readFileSync(agents, 'utf8')}custom-after\n`);
      const skill = join(root, 'xdg', 'opencode', 'skills', 'gbrain-capture', 'SKILL.md');
      writeFileSync(skill, 'drifted\n');

      const stale = await runJson(root, ['--check']);
      expect(stale.code).toBe(1);
      expect(stale.result.ok).toBe(false);
      expect(stale.result.surfaces.find((surface) => surface.name === 'opencode')).toMatchObject({
        status: 'stale', issues: ['skill_capture_drift'],
      });
      expect(readFileSync(skill, 'utf8')).toBe('drifted\n');

      expect((await runJson(root, [])).code).toBe(0);
      const repaired = await runJson(root, ['--check']);
      expect(repaired.code).toBe(0);
      expect(readFileSync(agents, 'utf8')).toContain('custom-before');
      expect(readFileSync(agents, 'utf8')).toContain('custom-after');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given experience hooks were explicitly disabled When install repeats Then the disabled choice stays current', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, ['--no-experience-hook'])).code).toBe(0);
      expect((await runJson(root, [])).code).toBe(0);
      const checked = await runJson(root, ['--check']);
      expect(checked.code).toBe(0);
      expect(checked.result.surfaces.map((surface) => surface.experience_hook)).toEqual([false, false]);
      expect(existsSync(join(root, 'codex', 'hooks', 'gbrain-experience-guard.py'))).toBe(false);
      expect(readFileSync(manifestPath(root, 'codex'), 'utf8')).toContain('"experience_hook": false');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a real legacy installation without manifests When install runs Then it replaces every old managed asset', async () => {
    const root = createRoot();
    try {
      const opencode = join(root, 'xdg', 'opencode');
      const codex = join(root, 'codex');
      const legacyRules = `${GBRAIN_RULES_BLOCK_START}\nlegacy gb_token defer rejected\n${GBRAIN_RULES_BLOCK_END}\n`;
      for (const clientRoot of [opencode, codex]) {
        writeFixture(join(clientRoot, 'AGENTS.md'), legacyRules);
        writeFixture(join(clientRoot, 'skills', 'gbrain-capture', 'SKILL.md'), 'legacy gb_token defer rejected\n');
        writeFixture(join(clientRoot, 'skills', 'gbrain-review', 'SKILL.md'), 'legacy review\n');
        writeFixture(join(clientRoot, 'hooks', 'gbrain-project-check.py'), 'legacy project hook\n');
        writeFixture(join(clientRoot, 'hooks', 'gbrain-experience-guard.py'), 'legacy gb_token defer rejected\n');
      }
      writeFixture(join(opencode, 'plugins', 'gbrain-experience-guard.ts'), 'const EXPERIENCE_ENABLED = true; // gb_token defer rejected\n');
      writeFixture(join(codex, 'hooks.json'), `${JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: `python3 '${join(codex, 'hooks', 'gbrain-project-check.py')}'` }] }],
          Stop: [{ hooks: [{ type: 'command', command: `python3 '${join(codex, 'hooks', 'gbrain-experience-guard.py')}'` }] }],
        },
      }, null, 2)}\n`);

      expect((await runJson(root, [])).code).toBe(0);
      const checked = await runJson(root, ['--check']);
      expect(checked.result.surfaces.map((surface) => surface.experience_hook)).toEqual([true, true]);
      const installed = [
        readFileSync(join(opencode, 'AGENTS.md'), 'utf8'),
        readFileSync(join(opencode, 'skills', 'gbrain-capture', 'SKILL.md'), 'utf8'),
        readFileSync(join(opencode, 'plugins', 'gbrain-experience-guard.ts'), 'utf8'),
        readFileSync(join(codex, 'hooks', 'gbrain-experience-guard.py'), 'utf8'),
      ].join('\n');
      expect(installed).not.toContain('gb_token');
      expect(installed).not.toContain('defer|rejected');
      expect(installed).toContain('gbr_');
      expect(installed).toContain('gbc_');
      expect(installed).toContain('GBRAIN_EXPERIENCE_RECALL_REQUIRED');
      expect(installed).toContain('GBRAIN_EXPERIENCE_CLOSEOUT_REQUIRED');
      expect(installed).toContain('--verified');
      expect(readFileSync(join(opencode, 'hooks', 'gbrain-experience-guard.py'), 'utf8'))
        .toBe(readFileSync(join(codex, 'hooks', 'gbrain-experience-guard.py'), 'utf8'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given an older manifest protocol When check runs Then it returns a stable version issue', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, [])).code).toBe(0);
      const path = manifestPath(root, 'opencode');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...manifest, protocol_version: 1 }, null, 2)}\n`);

      const checked = await runJson(root, ['--check']);
      expect(checked.code).toBe(1);
      expect(checked.result.surfaces[0]).toMatchObject({
        name: 'opencode', status: 'stale', experience_hook: true,
        issues: ['protocol_version_mismatch'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given an unsupported manifest schema When install runs Then live assets remain the preference authority', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, ['--experience-hook'])).code).toBe(0);
      const path = manifestPath(root, 'opencode');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...manifest, schema_version: 99, experience_hook: false }, null, 2)}\n`);

      const stale = await runJson(root, ['--check']);
      expect(stale.result.surfaces[0]).toMatchObject({
        status: 'stale', experience_hook: true, issues: ['manifest_schema_version'],
      });
      expect((await runJson(root, [])).code).toBe(0);
      expect((await runJson(root, ['--check'])).result.surfaces
        .map((entry) => entry.experience_hook)).toEqual([true, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given conflicting client preferences When check runs Then both surfaces report a stable conflict without writes', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, ['--no-experience-hook'])).code).toBe(0);
      const path = manifestPath(root, 'codex');
      const before = readFileSync(path, 'utf8');
      const manifest = JSON.parse(before) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...manifest, experience_hook: true }, null, 2)}\n`);

      const checked = await runJson(root, ['--check']);
      expect(checked.result.ok).toBe(false);
      expect(checked.result.surfaces.every((entry) => entry.issues.includes('experience_choice_conflict'))).toBe(true);
      expect((await runJson(root, [])).code).toBe(1);
      expect(readFileSync(path, 'utf8')).toContain('"experience_hook": true');
      expect((await runJson(root, ['--experience-hook'])).code).toBe(0);
      expect((await runJson(root, ['--check'])).result.surfaces
        .map((entry) => entry.experience_hook)).toEqual([true, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given malformed hooks or misplaced managed handlers When check runs Then issues are stable and safe repairs are deterministic', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, [])).code).toBe(0);
      const hooksPath = join(root, 'codex', 'hooks.json');
      writeFileSync(hooksPath, '{"hooks":[]}\n');
      const invalid = await runJson(root, ['--check']);
      expect(invalid.result.surfaces[1]?.issues).toContain('hooks_config_invalid');
      expect((await runJson(root, [])).code).toBe(1);

      expect((await runJson(root, ['--experience-hook'])).code).toBe(1);
      writeFileSync(hooksPath, '{"hooks":{"SessionStart":["bad-group"]}}\n');
      expect((await runJson(root, ['--check'])).result.surfaces[1]?.issues).toContain('hooks_config_invalid');
      writeFileSync(hooksPath, `${JSON.stringify({
        hooks: {
          Notification: [{ hooks: [{ type: 'command', command: "python3 '/tmp/gbrain-experience-guard.py'" }] }],
        },
      }, null, 2)}\n`);
      expect((await runJson(root, ['--experience-hook'])).code).toBe(0);
      const repaired = JSON.parse(readFileSync(hooksPath, 'utf8')) as { hooks: Record<string, unknown> };
      expect(repaired.hooks.Notification).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given duplicate or unclosed managed rules When install runs Then duplicates collapse and unclosed content fails closed', async () => {
    const root = createRoot();
    try {
      expect((await runJson(root, [])).code).toBe(0);
      const agents = join(root, 'xdg', 'opencode', 'AGENTS.md');
      const block = readFileSync(agents, 'utf8');
      writeFileSync(agents, `custom\n${block}${block}`);
      expect((await runJson(root, ['--check'])).result.surfaces[0]?.issues).toContain('rules_duplicate');
      expect((await runJson(root, [])).code).toBe(0);
      expect(readFileSync(agents, 'utf8').split(GBRAIN_RULES_BLOCK_START)).toHaveLength(2);

      const broken = `custom\n${GBRAIN_RULES_BLOCK_START}\nunterminated\n`;
      writeFileSync(agents, broken);
      expect((await runJson(root, ['--check'])).result.surfaces[0]?.issues).toContain('rules_unclosed');
      expect((await runJson(root, [])).code).toBe(1);
      expect(readFileSync(agents, 'utf8')).toBe(broken);

      const nested = `${GBRAIN_RULES_BLOCK_START}\n${GBRAIN_RULES_BLOCK_START}\n${GBRAIN_RULES_BLOCK_END}\n${GBRAIN_RULES_BLOCK_END}\n`;
      writeFileSync(agents, nested);
      expect((await runJson(root, ['--check'])).result.surfaces[0]?.issues).toContain('rules_unclosed');
      expect((await runJson(root, [])).code).toBe(1);
      expect(readFileSync(agents, 'utf8')).toBe(nested);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given unsafe or malformed pre-existing files in a fresh home When install runs Then it fails before writing assets', async () => {
    const root = createRoot();
    try {
      const target = join(root, 'outside.txt');
      writeFileSync(target, 'outside\n');
      const skill = join(root, 'codex', 'skills', 'gbrain-review', 'SKILL.md');
      mkdirSync(join(skill, '..'), { recursive: true });
      symlinkSync(target, skill);

      expect((await runJson(root, ['--experience-hook'])).code).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe('outside\n');
      expect(existsSync(join(root, 'xdg', 'opencode'))).toBe(false);
      expect(existsSync(join(root, 'codex', 'AGENTS.md'))).toBe(false);

      rmSync(skill);
      writeFixture(join(root, 'codex', 'hooks.json'), '{"hooks":[]}\n');
      expect((await runJson(root, ['--experience-hook'])).code).toBe(1);
      expect(existsSync(join(root, 'xdg', 'opencode'))).toBe(false);
      expect(existsSync(join(root, 'codex', 'AGENTS.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given a status-only legacy experience handler When check runs Then Codex is detected with experience enabled', async () => {
    const root = createRoot();
    try {
      writeFixture(join(root, 'codex', 'hooks.json'), `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 /old/path.py', statusMessage: GBRAIN_CODEX_EXPERIENCE_HOOK_STATUS }] }] },
      }, null, 2)}\n`);

      const checked = await runJson(root, ['--check']);
      expect(checked.result.surfaces[1]).toMatchObject({ status: 'stale', experience_hook: true });
      expect(checked.result.surfaces[1]?.issues).not.toContain('experience_choice_unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
