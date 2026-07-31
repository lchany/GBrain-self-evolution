import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import type { Page } from '../src/core/types.ts';

const matchProject = operationsByName.match_project;

function registry(
  projectId: string,
  overrides: {
    sourceId?: string;
    slug?: string;
    recordKind?: string;
    frontmatterProjectId?: string;
  } = {},
): Page {
  return {
    id: Number.parseInt(projectId.slice(-4), 16),
    slug: overrides.slug ?? `projects/${projectId}/index`,
    title: projectId,
    type: 'project',
    compiled_truth: 'Canonical project registry.',
    timeline: '',
    frontmatter: {
      record_kind: overrides.recordKind ?? 'project-registry',
      project_id: overrides.frontmatterProjectId ?? projectId,
      project_name: projectId,
      project_aliases: [],
      repository_refs: [],
      environment_refs: [],
    },
    content_hash: '',
    file_path: '',
    created_at: new Date('2026-07-31T00:00:00Z'),
    updated_at: new Date('2026-07-31T00:00:00Z'),
    source_id: overrides.sourceId ?? 'source-a',
  } as Page;
}

function context(engine: BrainEngine, sourceId = 'source-a'): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'test-token',
      clientId: 'client-a',
      scopes: ['read'],
      sourceId,
      allowedSources: [sourceId, 'shared'],
    },
  } as OperationContext;
}

describe('match_project MCP operation', () => {
  test('is a read-only exact-ID operation without repository or name inputs', () => {
    expect(matchProject).toBeDefined();
    expect(matchProject.scope).toBe('read');
    expect(matchProject.mutating).not.toBe(true);
    expect(matchProject.localOnly).not.toBe(true);
    expect(matchProject.params.project_id).toMatchObject({
      type: 'string',
      required: true,
      pattern: '^prj-[0-9a-f]{16}$',
    });
    expect(matchProject.params.repository_ref).toBeUndefined();
    expect(matchProject.params.project_name).toBeUndefined();
  });

  test('reads only the exact registry slug in the current source', async () => {
    const calls: Array<{ slug: string; sourceId: string | undefined }> = [];
    const page = registry('prj-0123456789abcdef');
    const engine = {
      getPage: async (slug: string, opts?: { sourceId?: string }) => {
        calls.push({ slug, sourceId: opts?.sourceId });
        return page;
      },
      listPages: async () => {
        throw new Error('strict matching must not scan project registries');
      },
    } as unknown as BrainEngine;

    const result = await matchProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
    });

    expect(result).toEqual({
      ok: true,
      status: 'matched',
      code: 'ok',
      project_id: 'prj-0123456789abcdef',
      registry_slug: 'projects/prj-0123456789abcdef/index',
    });
    expect(calls).toEqual([{
      slug: 'projects/prj-0123456789abcdef/index',
      sourceId: 'source-a',
    }]);
  });

  test('returns unmatched when the exact registry does not exist', async () => {
    const engine = {
      getPage: async () => null,
    } as unknown as BrainEngine;

    const result = await matchProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
    });

    expect(result).toEqual({
      ok: true,
      status: 'unmatched',
      code: 'project_match_not_found',
      project_id: 'prj-0123456789abcdef',
    });
  });

  test('rejects an occupied exact slug with inconsistent registry identity', async () => {
    const engine = {
      getPage: async () => registry('prj-0123456789abcdef', {
        recordKind: 'project-experience',
      }),
    } as unknown as BrainEngine;

    await expect(matchProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('project_registry_conflict'),
    });
  });

  test('rejects malformed IDs before accessing storage', async () => {
    let reads = 0;
    const engine = {
      getPage: async () => {
        reads += 1;
        return null;
      },
    } as unknown as BrainEngine;

    await expect(matchProject.handler(context(engine), {
      project_id: 'project-widget',
    })).rejects.toBeInstanceOf(OperationError);
    expect(reads).toBe(0);
  });
});
