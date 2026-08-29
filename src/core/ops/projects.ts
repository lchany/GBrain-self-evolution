import type { Page, PageInput } from '../types.ts';
import { deriveProjectIdFromCreationKey, PROJECT_ID_RE } from '../project-context.ts';
import { writePageThrough } from '../write-through.ts';
import { OperationError, type Operation } from './contract.ts';

function projectRegistryIdentity(page: Page): { project_id: string; project_name: string } | null {
  const match = /^projects\/(prj-[0-9a-f]{16})\/index$/.exec(page.slug);
  const frontmatter = page.frontmatter as Record<string, unknown>;
  if (!match || page.deleted_at != null || page.type !== 'project' || frontmatter.record_kind !== 'project-registry') return null;
  const projectId = frontmatter.project_id;
  const projectName = frontmatter.project_name;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId) || projectId !== match[1]
    || typeof projectName !== 'string' || projectName.trim().length === 0) return null;
  return { project_id: projectId, project_name: projectName.trim() };
}

function assertCanonicalProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_RE.test(value)) {
    throw new OperationError('invalid_params', 'project_id_invalid: project_id 必须是 prj- 加 16 位小写十六进制。');
  }
  return value;
}

function resolveProjectId(sourceId: string, projectId: unknown, creationKey: unknown): string {
  if (projectId !== undefined) return assertCanonicalProjectId(projectId);
  if (typeof creationKey !== 'string'
    || creationKey.length < 8
    || creationKey.length > 200
    || !/^[A-Za-z0-9._:-]+$/.test(creationKey)) {
    throw new OperationError('invalid_params', 'project_creation_key_invalid: creation_key 必须是 8 到 200 位安全随机标识符。');
  }
  return deriveProjectIdFromCreationKey(sourceId, creationKey);
}

function assertValidProjectRegistry(page: Page, projectId: string): void {
  if (projectRegistryIdentity(page)?.project_id !== projectId) {
    throw new OperationError(
      'invalid_params',
      `project_registry_conflict: projects/${projectId}/index 已存在，但不是该 ID 的合法项目登记页。`,
      '请人工检查冲突页面；服务端不会覆盖或改用其他项目 ID。',
      'gbrain://schema/page',
    );
  }
}

function projectRegistryInput(projectId: string, projectName: string): PageInput {
  return {
    type: 'project',
    title: projectName,
    compiled_truth: '# Project registry\n\nCanonical project registry.\n',
    timeline: '',
    frontmatter: {
      type: 'project', date: new Date().toISOString().slice(0, 10), status: 'reviewed',
      sensitivity: 'internal', verification: 'verified', applicability: [`project:${projectId}`],
      non_applicable: [], source_refs: ['mcp:ensure_project'], migrated_from: null,
      record_kind: 'project-registry', project_id: projectId, project_name: projectName,
      project_aliases: [], repository_refs: [], environment_refs: [],
    },
  };
}

const match_project: Operation = {
  name: 'match_project',
  description: '只按规范 project_id 在当前 source 精确检查项目登记页；不使用 Git、目录、名称、别名或语义匹配。',
  params: { project_id: { type: 'string', required: true, pattern: '^prj-[0-9a-f]{16}$', description: '要精确检查的规范项目 ID。' } },
  scope: 'read',
  handler: async (ctx, p) => {
    if (p.repository_ref !== undefined || p.project_name !== undefined) {
      throw new OperationError('invalid_params', 'project_match_input_invalid: match_project 只接受 project_id。');
    }
    const projectId = assertCanonicalProjectId(p.project_id);
    const registrySlug = `projects/${projectId}/index`;
    const page = await ctx.engine.getPage(registrySlug, { sourceId: ctx.sourceId ?? 'default', includeDeleted: true });
    if (page === null) return { ok: true, status: 'unmatched', code: 'project_match_not_found', project_id: projectId };
    assertValidProjectRegistry(page, projectId);
    return { ok: true, status: 'matched', code: 'ok', project_id: projectId, registry_slug: registrySlug };
  },
};

const ensure_project: Operation = {
  name: 'ensure_project',
  description: '在当前 source 按精确 project_id 复用或原子创建项目登记页；无 ID 时使用随机 creation_key 幂等生成新 ID。',
  params: {
    project_id: { type: 'string', pattern: '^prj-[0-9a-f]{16}$', description: '已有本地绑定时传入的规范项目 ID；与 creation_key 二选一。' },
    creation_key: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9._:-]{8,200}$', description: '无本地 ID 时为本次创建生成的随机幂等键；不保存为项目身份。' },
    project_name: { type: 'string', maxLength: 200, pattern: '^[^\\u0000-\\u001F\\u007F]*$', description: '可选显示名称；不参与项目身份匹配。' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (p.repository_ref !== undefined) throw new OperationError('invalid_params', 'project_identity_input_invalid: ensure_project 不接受仓库引用。');
    const hasProjectId = p.project_id !== undefined;
    const hasCreationKey = p.creation_key !== undefined;
    if (hasProjectId === hasCreationKey) throw new OperationError('invalid_params', 'project_identity_input_invalid: project_id 与 creation_key 必须且只能提供一个。');
    const sourceId = ctx.sourceId ?? 'default';
    const projectId = resolveProjectId(sourceId, p.project_id, p.creation_key);
    const rawName = p.project_name;
    if (rawName !== undefined && (typeof rawName !== 'string' || rawName.trim().length === 0 || rawName.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(rawName))) {
      throw new OperationError('invalid_params', 'project_name_invalid: project_name 必须是 1 到 200 个不含控制字符的显示文本。');
    }
    const projectName = typeof rawName === 'string' ? rawName.trim() : projectId;
    const registrySlug = `projects/${projectId}/index`;
    let created = false;
    const result = await ctx.engine.transaction(async (tx) => {
      if (tx.kind !== 'pglite') await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`ensure_project:${sourceId}:${projectId}`]);
      const existing = await tx.getPage(registrySlug, { sourceId, includeDeleted: true });
      if (existing !== null) {
        assertValidProjectRegistry(existing, projectId);
        return { ok: true, status: 'matched', code: 'ok', project_id: projectId, registry_slug: registrySlug };
      }
      if (ctx.dryRun) return { dry_run: true, action: 'ensure_project', status: 'would_create', project_id: projectId, registry_slug: registrySlug };
      await tx.putPage(registrySlug, projectRegistryInput(projectId, projectName), { sourceId });
      created = true;
      return { ok: true, status: 'created', code: 'ok', project_id: projectId, registry_slug: registrySlug };
    });
    if (!created) return result;
    return { ...result, write_through: await writePageThrough(ctx.engine, registrySlug, { sourceId, logger: ctx.logger }) };
  },
};

export const projectOperations: Operation[] = [match_project, ensure_project];
