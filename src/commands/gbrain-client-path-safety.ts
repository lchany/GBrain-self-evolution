import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export type ManagedPathExpectation = {
  readonly path: string;
  readonly code: string;
};

export function pathEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

export function managedPathIssues(root: string, paths: readonly ManagedPathExpectation[]): readonly string[] {
  return paths
    .filter((entry) => isUnsafeManagedPath(root, entry.path))
    .map((entry) => `${entry.code}_unsafe_type`);
}

function isUnsafeManagedPath(root: string, path: string): boolean {
  const suffix = relative(root, path);
  if (suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return true;
  const parts = suffix.split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) return false;
    if (stats.isSymbolicLink()) return true;
    const leaf = index === parts.length - 1;
    if (leaf ? !stats.isFile() : !stats.isDirectory()) return true;
  }
  return false;
}
