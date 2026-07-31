import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import type { Page, PageInput } from '../src/core/types.ts';

const ensureProject = operationsByName.ensure_project;

class ProjectEngine {
  readonly pages = new Map<string, Page>();
  readonly writes: Array<{ slug: string; sourceId: string; page: PageInput }> = [];
  readonly events: string[] = [];

  key(sourceId: string, slug: string): string {
    return `${sourceId}:${slug}`;
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    this.events.push('transaction');
    return fn(this as unknown as BrainEngine);
  }

  async executeRaw(): Promise<unknown[]> {
    this.events.push('lock');
    return [];
  }

  async getPage(slug: string, opts?: { sourceId?: string }): Promise<Page | null> {
    const sourceId = opts?.sourceId ?? 'default';
    this.events.push(`get:${sourceId}:${slug}`);
    return this.pages.get(this.key(sourceId, slug)) ?? null;
  }

  async putPage(slug: string, input: PageInput, opts?: { sourceId?: string }): Promise<Page> {
    const sourceId = opts?.sourceId ?? 'default';
    this.events.push(`put:${sourceId}:${slug}`);
    this.writes.push({ slug, sourceId, page: input });
    const stored = {
      id: this.pages.size + 1,
      slug,
      title: input.title,
      type: input.type,
      compiled_truth: input.compiled_truth,
      timeline: input.timeline ?? '',
      frontmatter: input.frontmatter ?? {},
      content_hash: input.content_hash ?? '',
      file_path: '',
      created_at: new Date('2026-07-31T00:00:00Z'),
      updated_at: new Date('2026-07-31T00:00:00Z'),
      source_id: sourceId,
    } as Page;
    this.pages.set(this.key(sourceId, slug), stored);
    return stored;
  }
}

class SerialProjectEngine extends ProjectEngine {
  private tail = Promise.resolve();

  override async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.events.push('transaction');
      return await fn(this as unknown as BrainEngine);
    } finally {
      release();
    }
  }
}

function context(
  engine: ProjectEngine,
  options: { sourceId?: string; dryRun?: boolean } = {},
): OperationContext {
  const sourceId = options.sourceId ?? 'source-a';
  return {
    engine: engine as unknown as BrainEngine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: options.dryRun ?? false,
    remote: true,
    sourceId,
    auth: {
      token: 'test-token',
      clientId: 'client-a',
      scopes: ['read', 'write'],
      sourceId,
      allowedSources: [sourceId, 'shared'],
    },
  } as OperationContext;
}

describe('ensure_project MCP operation', () => {
  test('is exposed as a write-scoped mutating operation', () => {
    expect(ensureProject).toBeDefined();
    expect(ensureProject.scope).toBe('write');
    expect(ensureProject.mutating).toBe(true);
    expect(ensureProject.localOnly).not.toBe(true);
    expect(ensureProject.params.project_id.pattern).toBe('^prj-[0-9a-f]{16}$');
    expect(ensureProject.params.creation_key.maxLength).toBe(200);
    expect(ensureProject.params.repository_ref).toBeUndefined();
  });

  test('reuses an exact valid registry without scanning other projects', async () => {
    const engine = new ProjectEngine();
    await engine.putPage(
      'projects/prj-0123456789abcdef/index',
      {
        type: 'project',
        title: 'Existing',
        compiled_truth: 'Canonical project registry.',
        frontmatter: {
          record_kind: 'project-registry',
          project_id: 'prj-0123456789abcdef',
          project_name: 'Existing',
        },
      },
      { sourceId: 'source-a' },
    );
    engine.writes.length = 0;
    engine.events.length = 0;

    const result = await ensureProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
      project_name: 'Ignored new display name',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'matched',
      project_id: 'prj-0123456789abcdef',
      registry_slug: 'projects/prj-0123456789abcdef/index',
    });
    expect(engine.writes).toHaveLength(0);
    expect(engine.events[0]).toBe('transaction');
    expect(engine.events[1]).toBe('lock');
  });

  test('creates a missing registry with the caller-provided canonical ID', async () => {
    const engine = new ProjectEngine();

    const result = await ensureProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
      project_name: 'Display only',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'created',
      project_id: 'prj-0123456789abcdef',
      registry_slug: 'projects/prj-0123456789abcdef/index',
    });
    expect(engine.writes).toHaveLength(1);
    expect(engine.writes[0]).toMatchObject({
      slug: 'projects/prj-0123456789abcdef/index',
      sourceId: 'source-a',
      page: {
        type: 'project',
        frontmatter: {
          record_kind: 'project-registry',
          project_id: 'prj-0123456789abcdef',
          project_name: 'Display only',
          repository_refs: [],
        },
      },
    });
  });

  test('derives one stable ID from a creation key and never stores the key', async () => {
    const engine = new ProjectEngine();

    const first = await ensureProject.handler(context(engine), {
      creation_key: '4df18f36-2030-48a3-af37-6f5f9dd487de',
    }) as Record<string, unknown>;
    const second = await ensureProject.handler(context(engine), {
      creation_key: '4df18f36-2030-48a3-af37-6f5f9dd487de',
    }) as Record<string, unknown>;

    expect(first.project_id).toMatch(/^prj-[0-9a-f]{16}$/);
    expect(second.project_id).toBe(first.project_id);
    expect(first.status).toBe('created');
    expect(second.status).toBe('matched');
    expect(engine.writes).toHaveLength(1);
    expect(JSON.stringify(engine.writes[0])).not.toContain('4df18f36-2030-48a3-af37-6f5f9dd487de');
  });

  test('uses the current source for identity derivation, reads, and writes', async () => {
    const engine = new ProjectEngine();
    const sourceA = await ensureProject.handler(context(engine, { sourceId: 'source-a' }), {
      creation_key: '8b054188-9c23-4d8d-93ca-cf1a75b85519',
    }) as Record<string, unknown>;
    const sourceB = await ensureProject.handler(context(engine, { sourceId: 'source-b' }), {
      creation_key: '8b054188-9c23-4d8d-93ca-cf1a75b85519',
    }) as Record<string, unknown>;

    expect(sourceA.project_id).not.toBe(sourceB.project_id);
    expect(engine.writes.map((write) => write.sourceId)).toEqual(['source-a', 'source-b']);
  });

  test('serializes concurrent retries so only one registry is created', async () => {
    const engine = new SerialProjectEngine();
    const args = { creation_key: 'ce8f93d8-385c-47ce-a6a6-57fe24ce9e83' };
    const [first, second] = await Promise.all([
      ensureProject.handler(context(engine), args) as Promise<Record<string, unknown>>,
      ensureProject.handler(context(engine), args) as Promise<Record<string, unknown>>,
    ]);

    expect(first.project_id).toBe(second.project_id);
    expect([first.status, second.status].sort()).toEqual(['created', 'matched']);
    expect(engine.writes).toHaveLength(1);
  });

  test('rejects an occupied exact slug instead of overwriting it', async () => {
    const engine = new ProjectEngine();
    await engine.putPage(
      'projects/prj-0123456789abcdef/index',
      {
        type: 'project',
        title: 'Wrong record',
        compiled_truth: 'Not a registry.',
        frontmatter: {
          record_kind: 'project-experience',
          project_id: 'prj-0123456789abcdef',
        },
      },
      { sourceId: 'source-a' },
    );
    engine.writes.length = 0;

    await expect(ensureProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('project_registry_conflict'),
    });
    expect(engine.writes).toHaveLength(0);
  });

  test('treats a soft-deleted registry as an occupied conflict', async () => {
    const engine = new ProjectEngine();
    const slug = 'projects/prj-0123456789abcdef/index';
    await engine.putPage(
      slug,
      {
        type: 'project',
        title: 'Deleted registry',
        compiled_truth: 'Canonical project registry.',
        frontmatter: {
          record_kind: 'project-registry',
          project_id: 'prj-0123456789abcdef',
          project_name: 'Deleted registry',
        },
      },
      { sourceId: 'source-a' },
    );
    const deleted = engine.pages.get(engine.key('source-a', slug));
    if (deleted !== undefined) deleted.deleted_at = new Date('2026-07-31T01:00:00Z');
    engine.writes.length = 0;

    await expect(ensureProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('project_registry_conflict'),
    });
    expect(engine.writes).toHaveLength(0);
  });

  test('requires exactly one of project_id or creation_key and validates both', async () => {
    const engine = new ProjectEngine();
    await expect(ensureProject.handler(context(engine), {})).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(ensureProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
      creation_key: '4df18f36-2030-48a3-af37-6f5f9dd487de',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(ensureProject.handler(context(engine), {
      creation_key: 'unsafe key with spaces',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(ensureProject.handler(context(engine), {
      project_id: 'prj-0123456789abcdef',
      repository_ref: 'example.invalid/owner/repo',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  test('dry-run reports creation without writing a registry', async () => {
    const engine = new ProjectEngine();
    const result = await ensureProject.handler(context(engine, { dryRun: true }), {
      project_id: 'prj-0123456789abcdef',
    });

    expect(result).toMatchObject({
      dry_run: true,
      action: 'ensure_project',
      project_id: 'prj-0123456789abcdef',
      status: 'would_create',
    });
    expect(engine.writes).toHaveLength(0);
  });
});
