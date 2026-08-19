import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_ID_RE,
  buildProjectMarker,
  generateProjectId,
  normalizeRepositoryRef,
  readProjectMarker,
  writeProjectMarker,
} from '../src/core/project-context.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-project-context-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('project identity context', () => {
  test('generates opaque stable project ids', () => {
    const projectId = generateProjectId();
    expect(projectId).toMatch(PROJECT_ID_RE);
    expect(projectId).toHaveLength(20);
  });

  test('normalizes HTTPS and SCP-style GitHub remotes to one repository ref', () => {
    expect(normalizeRepositoryRef('https://github.com/Example/Widget.git')).toBe('github.com/example/widget');
    expect(normalizeRepositoryRef('git@github.com:Example/Widget.git')).toBe('github.com/example/widget');
    expect(normalizeRepositoryRef('github.com/Example/Widget')).toBe('github.com/example/widget');
  });

  test('walks ancestors for a trusted project marker', () => {
    writeFileSync(join(root, '.gbrain-project.yaml'), buildProjectMarker('prj-0123456789abcdef'));
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    expect(readProjectMarker(nested)).toEqual({
      schema_version: 1,
      project_id: 'prj-0123456789abcdef',
      marker_path: join(root, '.gbrain-project.yaml'),
    });
  });

  test('an invalid nearer marker fails closed instead of inheriting a parent binding', () => {
    writeFileSync(join(root, '.gbrain-project.yaml'), buildProjectMarker('prj-0123456789abcdef'));
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'packages', '.gbrain-project.yaml'), 'project_id: malformed\n');
    expect(readProjectMarker(nested)).toBeNull();
  });

  test('repository normalization rejects credential-bearing URLs', () => {
    expect(normalizeRepositoryRef('https://user:secret@github.com/example/widget.git')).toBeNull();
  });

  test('writes a minimal marker atomically and refuses a conflicting binding', () => {
    const markerPath = writeProjectMarker(root, 'prj-0123456789abcdef');
    expect(readFileSync(markerPath, 'utf8')).toBe('schema_version: 1\nproject_id: prj-0123456789abcdef\n');
    expect(() => writeProjectMarker(root, 'prj-fedcba9876543210')).toThrow(/project_binding_conflict/);
  });
});
