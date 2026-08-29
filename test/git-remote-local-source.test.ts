import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRepoState } from '../src/core/git-remote.ts';

describe('validateRepoState for a local-only source', () => {
  test('treats a valid Git repository without an origin as healthy', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-local-source-'));
    try {
      execFileSync('git', ['init', '--quiet', repo]);

      expect(validateRepoState(repo)).toBe('healthy');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
