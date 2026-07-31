import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  __testing as structuredCaptureTesting,
  runGbrainCapture,
  type ToolCaller,
} from '../src/commands/gbrain-capture.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-structured-capture-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function offlineFiles(): string[] {
  return readdirSync(join(tmpRoot, '.omo', 'gbrain-capture', 'offline'));
}

describe('gbrain capture structured candidate', () => {
  test('builds inbox-only markdown with draft and unverified defaults', () => {
    // given
    const candidate = structuredCaptureTesting.buildCandidate({
      title: 'Do Not Use Direct Markdown Writes',
      suggestedType: 'runbook',
      summary: 'Use the writer API instead of editing source markdown directly.',
      evidenceRefs: ['session:example-safe'],
      requestedVerification: 'verified',
      sensitivity: 'internal',
      now: new Date('2026-07-26T00:00:00Z'),
    });

    // when
    const markdown = structuredCaptureTesting.buildCandidateMarkdown(candidate);
    const parsed = matter(markdown);

    // then
    expect(candidate.slug).toBe('inbox/do-not-use-direct-markdown-writes');
    expect(parsed.data.type).toBe('runbook');
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.verification).toBe('unverified');
    expect(parsed.data.sensitivity).toBe('internal');
    expect(parsed.data.source_refs).toEqual(['session:example-safe']);
    expect(parsed.data.project_binding).toBe('pending');
    expect(parsed.data.project_id).toBeNull();
    expect(parsed.content).toContain('requested_verification: verified');
  });

  test('binds a project candidate in machine-readable frontmatter', () => {
    const candidate = structuredCaptureTesting.buildCandidate({
      title: 'Project Scoped Retry Rule',
      suggestedType: 'project',
      summary: 'Apply only inside the bound project.',
      evidenceRefs: ['session:project-safe'],
      requestedVerification: 'verified',
      sensitivity: 'internal',
      projectId: 'prj-0123456789abcdef',
      now: new Date('2026-07-26T00:00:00Z'),
    });
    const parsed = matter(structuredCaptureTesting.buildCandidateMarkdown(candidate));
    expect(parsed.data.record_kind).toBe('project-experience');
    expect(parsed.data.project_binding).toBe('bound');
    expect(parsed.data.project_id).toBe('prj-0123456789abcdef');
  });

  test('rejects an unbound project candidate before any MCP call', async () => {
    const calls: string[] = [];
    const callTool: ToolCaller = async (name) => {
      calls.push(name);
      return [];
    };

    await expect(runGbrainCapture([
      '--title', 'Unbound Project Summary',
      '--type', 'project',
      '--summary', 'Must not enter the MCP write workflow without a project ID.',
      '--evidence', 'session:project-safe',
      '--json',
    ], {
      cwd: tmpRoot,
      now: () => new Date('2026-07-26T00:00:00Z'),
      callTool,
    })).rejects.toThrow(/project_binding_required/);

    expect(calls).toEqual([]);
  });

  test('rejects project binding metadata on a non-project candidate', () => {
    expect(() => structuredCaptureTesting.buildCandidate({
      title: 'Misclassified Project Experience',
      suggestedType: 'knowledge',
      summary: 'A project ID must use the project experience type.',
      evidenceRefs: ['session:project-safe'],
      requestedVerification: 'unverified',
      sensitivity: 'internal',
      projectId: 'prj-0123456789abcdef',
      now: new Date('2026-07-26T00:00:00Z'),
    })).toThrow(/project_type_required/);
  });

  test('rejects malformed project ids before capture', () => {
    expect(() => structuredCaptureTesting.buildCandidate({
      title: 'Invalid Project Binding',
      suggestedType: 'project',
      summary: 'Must fail before any writer call.',
      evidenceRefs: ['session:project-safe'],
      requestedVerification: 'unverified',
      sensitivity: 'internal',
      projectId: 'project-widget',
      now: new Date('2026-07-26T00:00:00Z'),
    })).toThrow(/project_id_invalid/);
  });

  test('rejects any explicit slug outside inbox', () => {
    expect(() => structuredCaptureTesting.assertInboxSlug('knowledge/direct-write')).toThrow(/inbox/);
    expect(structuredCaptureTesting.assertInboxSlug('inbox/direct-write')).toBe('inbox/direct-write');
  });

  test('writes an offline structured candidate when writer call is unavailable', async () => {
    // given
    const calls: string[] = [];
    const callTool: ToolCaller = async (name) => {
      calls.push(name);
      throw new Error('writer unavailable');
    };

    // when
    await runGbrainCapture([
      '--title', 'Offline Safe Draft',
      '--type', 'incident',
      '--summary', 'A safe distilled finding for later replay.',
      '--evidence', 'file:evidence-safe.txt',
      '--json',
    ], { cwd: tmpRoot, now: () => new Date('2026-07-26T00:00:00Z'), callTool });

    // then
    expect(calls).toEqual(['search']);
    const [file] = offlineFiles();
    expect(file).toMatch(/offline-safe-draft/);
    const raw = readFileSync(join(tmpRoot, '.omo', 'gbrain-capture', 'offline', file), 'utf8');
    const queued = JSON.parse(raw);
    expect(JSON.stringify(Object.keys(queued))).not.toMatch(/raw|transcript|chat|tool_output/i);
    expect(JSON.stringify(queued)).toContain('Offline Safe Draft');
  });

  test('retry replays offline candidates and removes successful queue files', async () => {
    // given
    const calls: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
    const unavailable: ToolCaller = async () => { throw new Error('writer unavailable'); };
    await runGbrainCapture([
      '--title', 'Retryable Draft',
      '--type', 'decision',
      '--summary', 'Retry should replay this safe candidate.',
      '--evidence', 'session:retry-safe',
    ], { cwd: tmpRoot, now: () => new Date('2026-07-26T00:00:00Z'), callTool: unavailable });
    expect(offlineFiles().length).toBe(1);
    const available: ToolCaller = async (name, args) => {
      calls.push({ name, args });
      return name === 'search' ? [] : { slug: args.slug };
    };

    // when
    await runGbrainCapture(['retry', '--json'], {
      cwd: tmpRoot,
      now: () => new Date('2026-07-26T00:00:01Z'),
      callTool: available,
    });

    // then
    expect(calls.map((c) => c.name)).toEqual(['search', 'put_page']);
    expect(calls[1]?.args.slug).toBe('inbox/retryable-draft');
    expect(offlineFiles().length).toBe(0);
  });

  test('CLI structured capture queues offline without connecting a local brain', () => {
    // given
    const home = join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });

    // when
    const result = spawnSync('bun', [
      'run', CLI,
      'capture',
      '--title', 'CLI Offline Draft',
      '--type', 'knowledge',
      '--summary', 'Safe CLI structured draft.',
      '--evidence', 'session:cli-safe',
      '--json',
    ], {
      cwd: tmpRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GBRAIN_HOME: join(tmpRoot, 'gbrain-home'), DATABASE_URL: '' },
    });

    // then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"mode": "offline"');
    expect(offlineFiles().length).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('Schema version');
  });
});
