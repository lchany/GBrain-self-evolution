import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('bind requires explicit confirmation before writing the marker', async () => {
    const output: string[] = [];
    const code = await runGbrainProject(['bind', 'prj-0123456789abcdef', '--json'], {
      cwd: root,
      projectRoot: root,
      stdout: (text) => output.push(text),
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.join(''))).toMatchObject({
      ok: false,
      code: 'project_confirmation_required',
    });
    expect(existsSync(join(root, '.gbrain-project.yaml'))).toBe(false);
  });

  test('confirmed bind writes locally without calling MCP or local writer', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ProjectToolCaller = async (name, args) => {
      calls.push({ name, args });
      throw new Error('network caller must not run');
    };
    const code = await runGbrainProject(['bind', 'prj-0123456789abcdef', '--confirmed', '--json'], {
      cwd: root,
      projectRoot: root,
      callTool,
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
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

  test('match returns a sanitized MCP handoff without calling MCP or local writer', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Widget.git'], {
      cwd: root,
      stdio: 'ignore',
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: ProjectToolCaller = async (name, args) => {
      calls.push({ name, args });
      throw new Error('network caller must not run');
    };
    const output: string[] = [];
    const code = await runGbrainProject(['match', '--json'], {
      cwd: root,
      callTool,
      stdout: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(output.join(''))).toMatchObject({
      status: 'mcp_required',
      code: 'project_match_via_mcp',
      tool: 'match_project',
      arguments: {
        repository_ref: 'github.com/example/widget',
        project_name: expect.any(String),
      },
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
