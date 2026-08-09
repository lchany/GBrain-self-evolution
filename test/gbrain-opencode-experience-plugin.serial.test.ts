import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallClient } from '../src/commands/gbrain-client-installer.ts';

describe('OpenCode synchronous experience capture installation', () => {
  test('removes the legacy review timer plugin instead of installing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-opencode-sync-'));
    try {
      const pluginPath = join(root, 'xdg', 'opencode', 'plugins', 'gbrain-experience-guard.ts');
      mkdirSync(join(root, 'xdg', 'opencode', 'plugins'), { recursive: true });
      writeFileSync(pluginPath, 'legacy timer');
      expect(await runInstallClient(['--json'], {
        env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), CODEX_HOME: join(root, 'codex') },
      })).toBe(0);
      expect(existsSync(pluginPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
