import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
import { runGbrainProject, type ProjectToolCaller } from '../src/commands/gbrain-project.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-project-command-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gbrain project command', () => {
  test('reports an unbound local project without writing', async () => {
    const output: string[] = [];
    const code = await runGbrainProject(['current', '--json'], {
      cwd: root,
      stdout: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ status: 'unbound', code: 'project_unbound' });
  });

  test('bind verifies the canonical registry before writing the marker', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ProjectToolCaller = async (name, args) => {
      calls.push({ name, args });
      return {
        slug: 'projects/prj-0123456789abcdef/index',
        frontmatter: { record_kind: 'project-registry', project_id: 'prj-0123456789abcdef' },
      };
    };
    const code = await runGbrainProject(['bind', 'prj-0123456789abcdef', '--json'], {
      cwd: root,
      projectRoot: root,
      callTool,
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{
      name: 'get_page',
      args: { slug: 'projects/prj-0123456789abcdef/index' },
    }]);
    expect(readFileSync(join(root, '.gbrain-project.yaml'), 'utf8')).toContain('prj-0123456789abcdef');
  });

  test('init writes the registry before creating the local binding', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ProjectToolCaller = async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_pages') return [];
      return { slug: args.slug };
    };
    const code = await runGbrainProject([
      'init', '--name', 'Example Widget', '--repo', 'git@github.com:Example/Widget.git', '--json',
    ], {
      cwd: root,
      projectRoot: root,
      callTool,
      generateId: () => 'prj-0123456789abcdef',
      now: () => new Date('2026-07-30T00:00:00Z'),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(calls.map((call) => call.name)).toEqual(['list_pages', 'put_page']);
    const markdown = String(calls[1]?.args.content);
    const parsed = matter(markdown);
    expect(calls[1]?.args.slug).toBe('projects/prj-0123456789abcdef/index');
    expect(parsed.data.record_kind).toBe('project-registry');
    expect(parsed.data.repository_refs).toEqual(['github.com/example/widget']);
    expect(readFileSync(join(root, '.gbrain-project.yaml'), 'utf8')).toContain('prj-0123456789abcdef');
  });

  test('match lists the canonical prefix and hydrates registry frontmatter read-only', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ProjectToolCaller = async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_pages') {
        return {
          items: [{ slug: 'projects/prj-0123456789abcdef/index', title: 'Example Widget' }],
          has_more: false,
          next_offset: null,
        };
      }
      return {
        slug: String(args.slug),
        frontmatter: {
          record_kind: 'project-registry',
          project_id: 'prj-0123456789abcdef',
          project_name: 'Example Widget',
          project_aliases: [basename(root)],
          repository_refs: [],
        },
      };
    };
    const output: string[] = [];
    const code = await runGbrainProject(['match', '--json'], {
      cwd: root,
      callTool,
      stdout: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      name: 'list_pages',
      args: { type: 'project', include_prefixes: ['projects/'], limit: 100, offset: 0 },
    });
    expect(calls[1]).toEqual({
      name: 'get_page',
      args: { slug: 'projects/prj-0123456789abcdef/index' },
    });
    expect(JSON.parse(output.join(''))).toMatchObject({
      status: 'confirmation_required',
      candidates: [{ project_id: 'prj-0123456789abcdef' }],
    });
  });

  test('rejects unexpected positional arguments', async () => {
    const output: string[] = [];
    const code = await runGbrainProject(['current', 'surprise', '--json'], {
      cwd: root,
      stdout: (text) => output.push(text),
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.join('')).code).toBe('project_argument_invalid');
  });
});
