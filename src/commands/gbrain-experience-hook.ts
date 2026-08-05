import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME } from './gbrain-codex-experience-hook-content.ts';

const HELP = `gbrain experience-hook — control the installed Codex experience guard

Usage:
  gbrain experience-hook mode unattended --for <30m|12h|2d>
  gbrain experience-hook mode unattended --until <RFC3339>
  gbrain experience-hook mode enforce
  gbrain experience-hook status --json

Environment override (highest precedence):
  GBRAIN_EXPERIENCE_HOOK_MODE=enforce|unattended
`;

export function runExperienceHook(args: readonly string[]): number {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const codexHome = resolve(process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex'));
  const script = join(codexHome, 'hooks', GBRAIN_CODEX_EXPERIENCE_HOOK_FILENAME);
  if (!existsSync(script)) {
    process.stderr.write('GBrain experience hook is not installed; run `gbrain install-client`.\n');
    return 1;
  }
  const result = spawnSync('python3', [script, ...args], { stdio: 'inherit', env: process.env });
  if (result.error) {
    process.stderr.write(`failed to run GBrain experience hook: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
