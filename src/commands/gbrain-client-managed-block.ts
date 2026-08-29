import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GBRAIN_CLIENT_RULES,
  GBRAIN_RULES_BLOCK_END,
  GBRAIN_RULES_BLOCK_START,
} from './gbrain-client-installer-content.ts';

export type ManagedBlockState = 'missing' | 'current' | 'drift' | 'duplicate' | 'unclosed';

export function managedBlockState(content: string | null): ManagedBlockState {
  if (content === null) return 'missing';
  let cursor = 0;
  let open = false;
  let blocks = 0;
  while (cursor < content.length) {
    const start = content.indexOf(GBRAIN_RULES_BLOCK_START, cursor);
    const end = content.indexOf(GBRAIN_RULES_BLOCK_END, cursor);
    if (start < 0 && end < 0) break;
    if (start >= 0 && (end < 0 || start < end)) {
      if (open) return 'unclosed';
      open = true;
      blocks += 1;
      cursor = start + GBRAIN_RULES_BLOCK_START.length;
      continue;
    }
    if (!open) return 'unclosed';
    open = false;
    cursor = end + GBRAIN_RULES_BLOCK_END.length;
  }
  if (open) return 'unclosed';
  if (blocks === 0) return 'missing';
  if (blocks > 1) return 'duplicate';
  const match = content.match(managedBlockPattern());
  return match?.[0] === normalizedRules() ? 'current' : 'drift';
}

export function writeManagedBlock(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const state = managedBlockState(existing);
  if (state === 'unclosed') throw new Error(`cannot repair unclosed GBrain managed block: ${path}`);
  let replaced = false;
  const normalized = existing.replace(managedBlockPattern('gm'), () => {
    if (replaced) return '';
    replaced = true;
    return GBRAIN_CLIENT_RULES;
  });
  const next = replaced
    ? normalized
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${GBRAIN_CLIENT_RULES}`;
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`);
}

function normalizedRules(): string {
  return GBRAIN_CLIENT_RULES.endsWith('\n') ? GBRAIN_CLIENT_RULES : `${GBRAIN_CLIENT_RULES}\n`;
}

function managedBlockPattern(flags = 'm'): RegExp {
  return new RegExp(`${escapeRegExp(GBRAIN_RULES_BLOCK_START)}[\\s\\S]*?${escapeRegExp(GBRAIN_RULES_BLOCK_END)}\\n?`, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
