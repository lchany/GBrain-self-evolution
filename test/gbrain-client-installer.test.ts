import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient, type InstallClientDeps } from '../src/commands/gbrain-client-installer.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-client-installer-'));
}

function writeEnv(path: string, scope: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [
    'export GBRAIN_MCP_URL=http://server.example/mcp',
    'export GBRAIN_TOKEN_ENDPOINT=http://server.example/token',
    'export GBRAIN_CLIENT_ID=client-example',
    'export GBRAIN_CLIENT_SECRET=secret-example',
    `export GBRAIN_SCOPES=${scope}`,
  ].join('\n') + '\n');
}

function deps(root: string, calls: string[]): InstallClientDeps {
  return {
    env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
    now: () => new Date('2026-07-26T00:00:00Z'),
    callReadTool: async (name) => { calls.push(`read:${name}`); return { ok: true }; },
    callWriteTool: async (name, args) => { calls.push(`write:${name}:${String(args.slug ?? '')}`); return { ok: true }; },
  };
}

describe('gbrain install-client', () => {
  test('Given credential bundle When installer runs twice Then env files, rules, skills, and probes are idempotent', async () => {
    // given
    const root = tempRoot();
    try {
      const readSource = join(root, 'source', 'local-read.env');
      const writerSource = join(root, 'source', 'local-writer.env');
      writeEnv(readSource, 'read');
      writeEnv(writerSource, 'read write');
      const calls: string[] = [];
      const output: string[] = [];

      // when
      const first = await runInstallClient(['--read-env-source', readSource, '--writer-env-source', writerSource, '--json'], { ...deps(root, calls), stdout: (text) => output.push(text) });
      const second = await runInstallClient(['--read-env-source', readSource, '--writer-env-source', writerSource, '--json'], { ...deps(root, calls), stdout: (text) => output.push(text) });

      // then
      expect(first).toBe(0);
      expect(second).toBe(0);
      const readTarget = join(root, 'xdg', 'gbrain', 'local-read.env');
      const writerTarget = join(root, 'xdg', 'gbrain', 'local-writer.env');
      expect((statSync(readTarget).mode & 0o777).toString(8)).toBe('600');
      expect((statSync(writerTarget).mode & 0o777).toString(8)).toBe('600');
      expect(readFileSync(writerTarget, 'utf8')).toContain("export GBRAIN_SCOPES='read write'");
      const opencodeAgents = readFileSync(join(root, 'xdg', 'opencode', 'AGENTS.md'), 'utf8');
      const codexAgents = readFileSync(join(root, 'codex', 'AGENTS.md'), 'utf8');
      expect(opencodeAgents.match(/GBRAIN_CLIENT_RULES_START/g)?.length).toBe(1);
      expect(codexAgents.match(/GBRAIN_CLIENT_RULES_START/g)?.length).toBe(1);
      expect(readFileSync(join(root, 'xdg', 'opencode', 'skills', 'gbrain-capture', 'SKILL.md'), 'utf8')).toContain('gbrain capture');
      expect(readFileSync(join(root, 'codex', 'skills', 'gbrain-review', 'SKILL.md'), 'utf8')).toContain('PROMOTE <target-slug>');
      expect(calls).toEqual([
        'read:get_brain_identity',
        'write:put_page:inbox/gbrain-client-install-probe-2026-07-26T00-00-00-000Z',
        'write:get_page:inbox/gbrain-client-install-probe-2026-07-26T00-00-00-000Z',
        'write:delete_page:inbox/gbrain-client-install-probe-2026-07-26T00-00-00-000Z',
        'read:get_brain_identity',
        'write:put_page:inbox/gbrain-client-install-probe-2026-07-26T00-00-00-000Z',
        'write:get_page:inbox/gbrain-client-install-probe-2026-07-26T00-00-00-000Z',
        'write:delete_page:inbox/gbrain-client-install-probe-2026-07-26T00-00-00-000Z',
      ]);
      expect(output.join('\n')).not.toContain('secret-example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Given missing writer env source When installer runs Then it fails before leaking secrets', async () => {
    // given
    const root = tempRoot();
    try {
      const readSource = join(root, 'source', 'local-read.env');
      writeEnv(readSource, 'read');
      const stdout: string[] = [];
      const stderr: string[] = [];

      // when
      const code = await runInstallClient(['--read-env-source', readSource, '--writer-env-source', join(root, 'missing.env')], {
        ...deps(root, []),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });

      // then
      expect(code).toBe(1);
      expect(stderr.join('\n')).toContain('missing writer env source');
      expect(stdout.join('\n') + stderr.join('\n')).not.toContain('secret-example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
