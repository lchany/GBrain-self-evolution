import { assessContentSanity } from './content-sanity.ts';
import { classifyForbiddenContent } from './forbidden-content.ts';
import { parseMarkdown } from './markdown.ts';
import { PROJECT_ID_RE } from './project-context.ts';

const REQUIRED_FRONTMATTER_FIELDS = [
  'type',
  'date',
  'status',
  'sensitivity',
  'verification',
  'applicability',
  'non_applicable',
  'source_refs',
  'migrated_from',
] as const;

const PAGE_TYPES = [
  'knowledge',
  'project',
  'incident',
  'runbook',
  'decision',
  'environment',
  'agent-skill',
  'legacy',
] as const;

const STATUSES = ['draft', 'reviewed', 'verified', 'migrated-legacy'] as const;
const SENSITIVITIES = ['public', 'internal', 'private'] as const;
const VERIFICATIONS = ['unverified', 'verified'] as const;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NON_LOOPBACK_IPV4_RE = /\b(?!127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)(?:\d{1,3}\.){3}\d{1,3}\b/;

type AllowedPageType = typeof PAGE_TYPES[number];
export type PutPageValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly suggestion: string };

export type PutPageValidationOptions = {
  readonly strictSchema: boolean;
};

const TYPE_PREFIXES: Record<Exclude<AllowedPageType, 'legacy'>, string> = {
  knowledge: 'knowledge/',
  project: 'projects/',
  incident: 'incidents/',
  runbook: 'runbooks/',
  decision: 'decisions/',
  environment: 'environments/',
  'agent-skill': 'agent-skills/',
};

const SCHEMA_MANAGED_PREFIXES = [
  'inbox/',
  'knowledge/',
  'projects/',
  'incidents/',
  'runbooks/',
  'decisions/',
  'environments/',
  'agent-skills/',
  'legacy-migration/',
] as const;

function fail(message: string, suggestion: string): PutPageValidationResult {
  return { ok: false, message, suggestion };
}

function valueIn(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
    ? value
    : null;
}

function validDate(value: unknown): boolean {
  return (typeof value === 'string' && DATE_RE.test(value))
    || (value instanceof Date && Number.isFinite(value.getTime()));
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function isSchemaManagedSlug(slug: string): boolean {
  return SCHEMA_MANAGED_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

function hasFrontmatterFence(content: string): boolean {
  return content.trimStart().startsWith('---');
}

function typePrefix(pageType: string): string | null {
  switch (pageType) {
    case 'knowledge':
      return TYPE_PREFIXES.knowledge;
    case 'project':
      return TYPE_PREFIXES.project;
    case 'incident':
      return TYPE_PREFIXES.incident;
    case 'runbook':
      return TYPE_PREFIXES.runbook;
    case 'decision':
      return TYPE_PREFIXES.decision;
    case 'environment':
      return TYPE_PREFIXES.environment;
    case 'agent-skill':
      return TYPE_PREFIXES['agent-skill'];
    case 'legacy':
      return null;
    default:
      return null;
  }
}

function validateSlug(slug: string): PutPageValidationResult {
  if (slug.length === 0 || slug.length > 255 || !SLUG_RE.test(slug) || slug.endsWith('.md')) {
    return fail(
      'put_page slug must be lowercase path segments using only letters, digits, and hyphens.',
      'Use a slug like inbox/example-note with no spaces, underscores, uppercase letters, CJK, or .md suffix.',
    );
  }
  return { ok: true };
}

function validateRequiredFrontmatter(frontmatter: Record<string, unknown>): PutPageValidationResult {
  const missing = REQUIRED_FRONTMATTER_FIELDS.filter((field) => !(field in frontmatter));
  if (missing.length > 0) {
    return fail(
      `put_page content is missing required frontmatter field(s): ${missing.join(', ')}.`,
      'Add exactly the nine required fields: type, date, status, sensitivity, verification, applicability, non_applicable, source_refs, migrated_from.',
    );
  }
  return { ok: true };
}

function validateFrontmatterValues(frontmatter: Record<string, unknown>): PutPageValidationResult {
  if (!valueIn(frontmatter.type, PAGE_TYPES)) {
    return fail('frontmatter type is not allowed.', 'Use one of: knowledge, project, incident, runbook, decision, environment, agent-skill, legacy.');
  }
  if (!validDate(frontmatter.date)) {
    return fail('frontmatter date must use YYYY-MM-DD.', 'Set date to an ISO calendar date such as 2026-07-26.');
  }
  if (!valueIn(frontmatter.status, STATUSES)) {
    return fail('frontmatter status is not allowed.', 'Use draft, reviewed, verified, or migrated-legacy.');
  }
  if (!valueIn(frontmatter.sensitivity, SENSITIVITIES)) {
    return fail('frontmatter sensitivity is not allowed.', 'Use public, internal, or private.');
  }
  if (!valueIn(frontmatter.verification, VERIFICATIONS)) {
    return fail('frontmatter verification is not allowed.', 'Use unverified or verified.');
  }
  if (stringList(frontmatter.applicability) === null) {
    return fail('frontmatter applicability must be a non-empty string list.', 'Set applicability to a YAML list, for example: applicability: [capture-candidate].');
  }
  if (!Array.isArray(frontmatter.non_applicable) || !frontmatter.non_applicable.every((entry) => typeof entry === 'string')) {
    return fail('frontmatter non_applicable must be a string list.', 'Set non_applicable to [] or a YAML list of excluded contexts.');
  }
  if (stringList(frontmatter.source_refs) === null) {
    return fail('frontmatter source_refs must be a non-empty string list.', 'Cite evidence pointers only, not raw logs or transcripts.');
  }
  return { ok: true };
}

function validateStatusPathAndMigration(slug: string, frontmatter: Record<string, unknown>): PutPageValidationResult {
  const status = frontmatter.status;
  const verification = frontmatter.verification;
  const pageType = typeof frontmatter.type === 'string' ? frontmatter.type : '';

  if (slug.startsWith('inbox/') && status !== 'draft') {
    return fail('inbox pages must use status: draft.', 'Keep unreviewed pages under inbox/ with status: draft and verification: unverified.');
  }
  if (status === 'draft' && (!slug.startsWith('inbox/') || verification !== 'unverified')) {
    return fail('draft pages must stay under inbox/ and use verification: unverified.', 'Write new unreviewed content to inbox/<slug> with verification: unverified.');
  }
  if (status === 'verified' && verification !== 'verified') {
    return fail('status: verified requires verification: verified.', 'Either set verification: verified with evidence or lower status to reviewed/draft.');
  }
  if (status === 'migrated-legacy') {
    if (!slug.startsWith('legacy-migration/') || verification !== 'unverified' || typeof frontmatter.migrated_from !== 'string' || frontmatter.migrated_from.trim().length === 0) {
      return fail('migrated-legacy pages must live under legacy-migration/, stay unverified, and set migrated_from.', 'Move the slug under legacy-migration/, set verification: unverified, and provide the original source path in migrated_from.');
    }
    return { ok: true };
  }
  if (!isNullish(frontmatter.migrated_from)) {
    return fail('migrated_from must be null unless status is migrated-legacy.', 'Set migrated_from: null for new or reviewed pages.');
  }
  if (slug.startsWith('legacy-migration/')) {
    return fail('legacy-migration/ pages must use status: migrated-legacy.', 'Use status: migrated-legacy with non-null migrated_from, or choose a non-legacy path.');
  }
  if (slug.startsWith('inbox/')) return { ok: true };
  if (pageType === 'legacy') {
    return fail('type: legacy is only valid for migrated-legacy pages.', 'Use status: migrated-legacy under legacy-migration/, or choose the reviewed target type.');
  }
  const expectedPrefix = typePrefix(pageType);
  if (expectedPrefix === null) {
    return fail('frontmatter type is not allowed for this slug path.', 'Choose a non-legacy type that matches the target directory.');
  }
  if (!slug.startsWith(expectedPrefix)) {
    return fail(`frontmatter type does not match slug path; expected ${expectedPrefix}.`, 'Move the page to the matching type directory or change the type before writing.');
  }
  return { ok: true };
}

function projectError(code: string, message: string, suggestion: string): PutPageValidationResult {
  return fail(`${code}: ${message}`, suggestion);
}

function validProjectIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && PROJECT_ID_RE.test(entry));
}

function validateProjectIdentity(slug: string, frontmatter: Record<string, unknown>): PutPageValidationResult {
  if ('source_project_ids' in frontmatter && !validProjectIdList(frontmatter.source_project_ids)) {
    return projectError('source_project_ids_invalid', 'source_project_ids must contain canonical project IDs.', 'Use a YAML list of prj- followed by 16 lowercase hexadecimal characters.');
  }

  if (slug.startsWith('inbox/')) {
    const binding = frontmatter.project_binding;
    if (binding !== 'pending' && binding !== 'bound') {
      return projectError('project_binding_required', 'inbox drafts must declare project_binding as pending or bound.', 'Set project_binding: pending with project_id: null, or bind a canonical project ID before writing.');
    }
    if (binding === 'pending' && !isNullish(frontmatter.project_id)) {
      return projectError('project_binding_invalid', 'pending drafts cannot carry a project_id.', 'Set project_id: null until the project is matched and confirmed.');
    }
    if (binding === 'bound' && (typeof frontmatter.project_id !== 'string' || !PROJECT_ID_RE.test(frontmatter.project_id))) {
      return projectError('project_id_invalid', 'bound drafts require a canonical project_id.', 'Use a project ID such as prj-0123456789abcdef.');
    }
    const isProjectType = frontmatter.type === 'project';
    const isProjectExperience = frontmatter.record_kind === 'project-experience';
    if (isProjectType && !isProjectExperience) {
      return projectError('record_kind_required', 'project drafts must use record_kind: project-experience.', 'Add record_kind: project-experience without changing the reviewed body.');
    }
    if (!isProjectType && isProjectExperience) {
      return projectError('record_kind_invalid', 'record_kind: project-experience requires type: project.', 'Set type: project or remove the project-experience record kind.');
    }
    if (isProjectExperience && binding !== 'bound') {
      return projectError('project_binding_required', 'project experience drafts must be bound before writing.', 'Match and confirm a canonical project, then set project_binding: bound with its project_id.');
    }
    return { ok: true };
  }

  if (!slug.startsWith('projects/')) return { ok: true };
  const segments = slug.split('/');
  const pathProjectId = segments[1] ?? '';
  if (!PROJECT_ID_RE.test(pathProjectId)) {
    return projectError('project_path_invalid', 'project pages must be nested under projects/<project_id>/.', 'Use projects/prj-0123456789abcdef/<slug>.');
  }
  if (frontmatter.project_id !== pathProjectId) {
    return projectError('project_path_mismatch', 'frontmatter project_id does not match the project directory.', `Set project_id: ${pathProjectId} or move the page to the matching project directory.`);
  }
  if (segments.length === 3 && segments[2] === 'index') {
    if (frontmatter.record_kind !== 'project-registry') {
      return projectError('record_kind_invalid', 'project index pages must be canonical registry records.', 'Set record_kind: project-registry.');
    }
    if (typeof frontmatter.project_name !== 'string' || frontmatter.project_name.trim().length === 0) {
      return projectError('project_name_required', 'project registries require project_name.', 'Set a non-empty human-readable project_name.');
    }
    for (const field of ['project_aliases', 'repository_refs', 'environment_refs'] as const) {
      if (!Array.isArray(frontmatter[field]) || !frontmatter[field].every((entry) => typeof entry === 'string')) {
        return projectError('project_registry_invalid', `project registry field ${field} must be a string list.`, `Set ${field}: [] when no values are known.`);
      }
    }
    return { ok: true };
  }
  if (frontmatter.record_kind !== 'project-experience') {
    return projectError('record_kind_invalid', 'project experience pages require record_kind: project-experience.', 'Set record_kind: project-experience.');
  }
  if (frontmatter.project_binding !== 'bound') {
    return projectError('project_binding_required', 'reviewed project experiences must be bound.', 'Set project_binding: bound after confirming the canonical project registry.');
  }
  return { ok: true };
}

function validateForbiddenContent(title: string, compiledTruth: string, timeline: string): PutPageValidationResult {
  const body = `${title}\n${compiledTruth}\n${timeline}`;
  const forbidden = classifyForbiddenContent(body);
  if (forbidden === 'sensitive') {
    return fail('put_page content appears to contain credentials, tokens, or private authentication material.', 'Remove the sensitive material and cite a redacted evidence pointer in source_refs instead.');
  }
  if (NON_LOOPBACK_IPV4_RE.test(body)) {
    return fail('put_page content contains a non-loopback IP address.', 'Replace real IP addresses with placeholders such as <SERVER_IP> before writing.');
  }
  if (forbidden === 'raw') {
    return fail('put_page content looks like raw transcript, raw tool output, or raw JSON.', 'Distill the conclusion into prose and keep only evidence pointers in source_refs.');
  }
  if (forbidden === 'dense_log') {
    return fail('put_page content looks like dense command output or an error log.', 'Summarize the finding and cite the log file path instead of storing the raw log.');
  }
  const sanity = assessContentSanity({ compiled_truth: compiledTruth, timeline, title });
  if (sanity.shouldHardBlock || sanity.shouldSkipEmbed) {
    return fail('put_page content was rejected by the content-sanity gate.', 'Remove scraper junk or split oversized content; store only distilled conclusions with evidence pointers.');
  }
  return { ok: true };
}

export function validatePutPageWrite(slug: string, content: string, opts: PutPageValidationOptions): PutPageValidationResult {
  const slugResult = validateSlug(slug);
  if (!slugResult.ok) return slugResult;
  const rawContentResult = validateForbiddenContent('', content, '');
  if (!rawContentResult.ok) return rawContentResult;
  const requiresSchema = opts.strictSchema && isSchemaManagedSlug(slug);
  if (!requiresSchema && !hasFrontmatterFence(content)) return { ok: true };
  const parsed = parseMarkdown(content, `${slug}.md`, { validate: true, expectedSlug: slug });
  const parseErrors = parsed.errors ?? [];
  if (parseErrors.length > 0) {
    return fail('put_page content must start with valid YAML frontmatter delimited by --- lines.', 'Fix the frontmatter syntax and ensure any slug field matches the target slug.');
  }
  const parsedContentResult = validateForbiddenContent(parsed.title, parsed.compiled_truth, parsed.timeline);
  if (!parsedContentResult.ok) return parsedContentResult;
  if (!requiresSchema) return { ok: true };
  const frontmatter = { ...parsed.frontmatter, type: parsed.type };
  const requiredResult = validateRequiredFrontmatter(frontmatter);
  if (!requiredResult.ok) return requiredResult;
  const valuesResult = validateFrontmatterValues(frontmatter);
  if (!valuesResult.ok) return valuesResult;
  const statusResult = validateStatusPathAndMigration(slug, frontmatter);
  if (!statusResult.ok) return statusResult;
  const projectResult = validateProjectIdentity(slug, frontmatter);
  if (!projectResult.ok) return projectResult;
  return { ok: true };
}

export function requiredProjectRegistrySlug(slug: string, content: string): string | null {
  if (slug.endsWith('/index')) return null;
  const parsed = parseMarkdown(content, `${slug}.md`, { validate: true, expectedSlug: slug });
  const projectId = parsed.frontmatter.project_id;
  return parsed.frontmatter.record_kind === 'project-experience'
    && parsed.frontmatter.project_binding === 'bound'
    && typeof projectId === 'string'
    && PROJECT_ID_RE.test(projectId)
    ? `projects/${projectId}/index`
    : null;
}
