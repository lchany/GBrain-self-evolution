import matter from 'gray-matter';

export const SUGGESTED_TYPES = [
  'knowledge',
  'project',
  'incident',
  'runbook',
  'decision',
  'environment',
  'agent-skill',
] as const;

export type SuggestedType = typeof SUGGESTED_TYPES[number];
export type Sensitivity = 'public' | 'internal' | 'private';
export type Verification = 'verified' | 'unverified';

export interface CaptureCandidate {
  readonly schema_version: 1;
  readonly title: string;
  readonly suggested_type: SuggestedType;
  readonly summary: string;
  readonly evidence_refs: readonly string[];
  readonly requested_verification: Verification;
  readonly verification: 'unverified';
  readonly sensitivity: Sensitivity;
  readonly project_id?: string;
  readonly created_at: string;
  readonly slug: string;
}

export interface BuildCandidateInput {
  readonly title: string;
  readonly suggestedType: SuggestedType;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly requestedVerification: Verification;
  readonly sensitivity: Sensitivity;
  readonly projectId?: string;
  readonly now: Date;
}

const SUGGESTED_TYPE_SET: ReadonlySet<string> = new Set(SUGGESTED_TYPES);
const SENSITIVITY_SET: ReadonlySet<string> = new Set(['public', 'internal', 'private']);
const VERIFICATION_SET: ReadonlySet<string> = new Set(['verified', 'unverified']);

export function parseSuggestedType(value: string | undefined): SuggestedType {
  const resolved = value ?? 'knowledge';
  if (SUGGESTED_TYPE_SET.has(resolved)) return resolved as SuggestedType;
  throw new Error(`unsupported suggested type: ${resolved}`);
}

export function parseSensitivity(value: string | undefined): Sensitivity {
  const resolved = value ?? 'internal';
  if (SENSITIVITY_SET.has(resolved)) return resolved as Sensitivity;
  throw new Error(`unsupported sensitivity: ${resolved}`);
}

export function parseVerification(value: string | undefined): Verification {
  const resolved = value ?? 'unverified';
  if (VERIFICATION_SET.has(resolved)) return resolved as Verification;
  throw new Error(`unsupported verification: ${resolved}`);
}

export function slugTailFromTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'capture';
}

export function assertInboxSlug(slug: string): string {
  if (!/^inbox\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`capture slug must stay under inbox/ and use lowercase alphanumeric hyphens: ${slug}`);
  }
  return slug;
}

export function buildCandidate(input: BuildCandidateInput): CaptureCandidate {
  const evidenceRefs = input.evidenceRefs.map((ref) => ref.trim()).filter((ref) => ref.length > 0);
  if (!input.title.trim()) throw new Error('title is required');
  if (!input.summary.trim()) throw new Error('summary is required');
  if (evidenceRefs.length === 0) throw new Error('at least one evidence ref is required');
  const candidate: CaptureCandidate = {
    schema_version: 1,
    title: input.title.trim(),
    suggested_type: input.suggestedType,
    summary: input.summary.trim(),
    evidence_refs: evidenceRefs,
    requested_verification: input.requestedVerification,
    verification: 'unverified',
    sensitivity: input.sensitivity,
    ...(input.projectId ? { project_id: input.projectId } : {}),
    created_at: input.now.toISOString(),
    slug: assertInboxSlug(`inbox/${slugTailFromTitle(input.title)}`),
  };
  assertSafeCandidate(candidate);
  return candidate;
}

export function buildCandidateMarkdown(candidate: CaptureCandidate): string {
  const bodyLines = [
    `# ${candidate.title}`,
    '',
    '## Summary',
    '',
    candidate.summary,
    '',
    '## Capture suggestion',
    '',
    `- suggested_type: ${candidate.suggested_type}`,
    `- requested_verification: ${candidate.requested_verification}`,
    ...(candidate.project_id ? [`- project_id: ${candidate.project_id}`] : []),
    '- note: inbox draft only; not reviewed or promoted',
    '',
    '## Evidence refs',
    '',
    ...candidate.evidence_refs.map((ref) => `- ${ref}`),
  ];
  return matter.stringify(`${bodyLines.join('\n')}\n`, {
    type: candidate.suggested_type,
    date: candidate.created_at.slice(0, 10),
    status: 'draft',
    sensitivity: candidate.sensitivity,
    verification: 'unverified',
    applicability: candidate.project_id ? [`project:${candidate.project_id}`] : ['capture-candidate'],
    non_applicable: [],
    source_refs: [...candidate.evidence_refs],
    migrated_from: null,
  });
}

export function assertSafeCandidate(candidate: CaptureCandidate): void {
  const text = [candidate.title, candidate.summary, ...candidate.evidence_refs, candidate.project_id ?? ''].join('\n');
  if (/(sk-[a-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|github_pat_[a-z0-9_]+|xox[a-z]-[a-z0-9-]+|gbrain_[a-z0-9_-]{8,})/i.test(text)) {
    throw new Error('capture candidate appears to contain a secret-like token');
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw new Error('capture candidate contains private-key material');
  }
  if (/raw transcript|full transcript|raw tool output|dense log/i.test(text)) {
    throw new Error('capture candidate contains forbidden raw transcript or log markers');
  }
  const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
  if (ips.some((ip) => ip !== '127.0.0.1')) {
    throw new Error('capture candidate contains a non-loopback IPv4 address');
  }
}
