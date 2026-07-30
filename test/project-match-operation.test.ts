import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import type { Page, PageFilters } from '../src/core/types.ts';

const matchProject = operationsByName.match_project;

function registry(
  projectId: string,
  projectName: string,
  options: { aliases?: string[]; repositoryRefs?: string[]; slug?: string; recordKind?: string } = {},
): Page {
  return {
    id: Number.parseInt(projectId.slice(-4), 16),
    slug: options.slug ?? `projects/${projectId}/index`,
    title: projectName,
    type: 'project',
    compiled_truth: '',
    timeline: '',
    frontmatter: {
      record_kind: options.recordKind ?? 'project-registry',
      project_id: projectId,
      project_name: projectName,
      project_aliases: options.aliases ?? [],
      repository_refs: options.repositoryRefs ?? [],
    },
    content_hash: '',
    file_path: '',
    created_at: new Date('2026-07-30T00:00:00Z'),
    updated_at: new Date('2026-07-30T00:00:00Z'),
    source_id: 'source-a',
  } as Page;
}

function context(pages: Page[], calls: PageFilters[]): OperationContext {
  const engine = {
    listPages: async (filters: PageFilters) => {
      calls.push(filters);
      const offset = filters.offset ?? 0;
      return pages.slice(offset, offset + (filters.limit ?? pages.length));
    },
  } as unknown as BrainEngine;
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId: 'source-a',
    auth: {
      token: 'test-token',
      clientId: 'client-a',
      scopes: ['read'],
      sourceId: 'source-a',
      allowedSources: ['source-a', 'shared'],
    },
  } as OperationContext;
}

describe('match_project MCP operation', () => {
  test('is exposed as a read-only MCP operation', () => {
    expect(matchProject).toBeDefined();
    expect(matchProject.scope).toBe('read');
    expect(matchProject.mutating).not.toBe(true);
    expect(matchProject.localOnly).not.toBe(true);
    expect(matchProject.params.repository_ref.maxLength).toBe(2048);
    expect(typeof matchProject.params.repository_ref.pattern).toBe('string');
    expect(matchProject.params.project_name.maxLength).toBe(200);
    expect(typeof matchProject.params.project_name.pattern).toBe('string');
  });

  test('prefers exact repository matches over name and alias matches', async () => {
    const calls: PageFilters[] = [];
    const result = await matchProject.handler(context([
      registry('prj-0000000000000001', 'Widget', {
        repositoryRefs: ['github.com/acme/widget'],
      }),
      registry('prj-0000000000000002', 'Other', {
        aliases: ['widget'],
      }),
    ], calls), {
      repository_ref: 'git@github.com:Acme/Widget.git',
      project_name: 'widget',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'confirmation_required',
      code: 'project_match_confirmation_required',
      candidates: [{
        project_id: 'prj-0000000000000001',
        match_reason: 'repository_ref',
      }],
    });
    expect(calls[0]).toMatchObject({
      type: 'project',
      limit: 100,
      offset: 0,
      sourceIds: ['source-a', 'shared'],
    });
  });

  test('falls back to project name and aliases, ignores invalid registries, and sorts candidates', async () => {
    const result = await matchProject.handler(context([
      registry('prj-0000000000000002', 'Second', { aliases: ['widget'] }),
      registry('prj-0000000000000001', 'Widget'),
      registry('prj-0000000000000003', 'Widget', { recordKind: 'project-experience' }),
      registry('prj-0000000000000004', 'Widget', {
        slug: 'projects/prj-ffffffffffffffff/index',
      }),
    ], []), { project_name: ' WIDGET ' });

    expect(result).toMatchObject({
      status: 'confirmation_required',
      candidates: [
        { project_id: 'prj-0000000000000001', match_reason: 'name_or_alias' },
        { project_id: 'prj-0000000000000002', match_reason: 'name_or_alias' },
      ],
    });
  });

  test('returns unmatched without creating a project', async () => {
    const result = await matchProject.handler(context([], []), {
      repository_ref: 'https://github.com/acme/missing.git',
    });
    expect(result).toEqual({
      ok: true,
      status: 'unmatched',
      code: 'project_match_not_found',
      candidates: [],
    });
  });

  test('continues pagination until it finds a candidate', async () => {
    const pages = Array.from({ length: 100 }, (_, index) => {
      const projectId = `prj-${index.toString(16).padStart(16, '0')}`;
      return registry(projectId, `Other ${index}`);
    });
    pages.push(registry('prj-ffffffffffffffff', 'Widget'));
    const calls: PageFilters[] = [];

    const result = await matchProject.handler(context(pages, calls), {
      project_name: 'widget',
    });

    expect(result).toMatchObject({
      candidates: [{ project_id: 'prj-ffffffffffffffff' }],
    });
    expect(calls.map((call) => call.offset)).toEqual([0, 100]);
  });

  test('rejects empty input and unsafe repository references', async () => {
    await expect(matchProject.handler(context([], []), {})).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('project_match_input_required'),
    });
    await expect(matchProject.handler(context([], []), {
      repository_ref: 'https://user:secret@example.com/acme/widget.git',
    })).rejects.toBeInstanceOf(OperationError);
    await expect(matchProject.handler(context([], []), {
      project_name: 'widget\u0000hidden',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('project_match_input_invalid'),
    });
  });
});
