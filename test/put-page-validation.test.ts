import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const fakeEngine = {} as BrainEngine;
const FAKE_SECRET = 'sk-FAKEFAKEFAKE';
const NON_LOOPBACK_IP = ['203', '0', '113', '9'].join('.');

function validInboxContent(overrides: readonly string[] = [], body = 'Distilled conclusion with evidence pointer only.'): string {
  const frontmatter = [
    '---',
    'type: knowledge',
    'date: 2026-07-26',
    'status: draft',
    'sensitivity: internal',
    'verification: unverified',
    'applicability:',
    '  - capture-candidate',
    'non_applicable: []',
    'source_refs:',
    '  - test:evidence-pointer',
    'migrated_from: null',
    'project_binding: pending',
    'project_id: null',
    ...overrides,
    '---',
  ];
  return `${frontmatter.join('\n')}\n\n# Safe draft\n\n${body}\n`;
}

function migratedFromContent(status: string, migratedFrom: string | null): string {
  return [
    '---',
    'type: knowledge',
    'date: 2026-07-26',
    `status: ${status}`,
    'sensitivity: internal',
    'verification: unverified',
    'applicability:',
    '  - capture-candidate',
    'non_applicable: []',
    'source_refs:',
    '  - test:evidence-pointer',
    `migrated_from: ${migratedFrom ?? 'null'}`,
    '---',
    '',
    '# Safe draft',
    '',
    'Distilled conclusion.',
  ].join('\n');
}

function projectContent(lines: readonly string[], status = 'reviewed', verification = 'verified'): string {
  return [
    '---',
    'type: project',
    'date: 2026-07-26',
    `status: ${status}`,
    'sensitivity: internal',
    `verification: ${verification}`,
    'applicability: [project-scoped]',
    'non_applicable: []',
    'source_refs: [test:evidence-pointer]',
    'migrated_from: null',
    ...lines,
    '---',
    '',
    '# Safe project record',
    '',
    'Distilled conclusion.',
  ].join('\n');
}

async function putPage(slug: string, content: string): Promise<unknown> {
  const result = await dispatchToolCall(fakeEngine, 'put_page', { slug, content, dry_run: true }, { remote: true, sourceId: 'default' });
  return JSON.parse(result.content[0]?.text ?? '{}');
}

async function putPageError(slug: string, content: string): Promise<Record<string, unknown>> {
  const result = await dispatchToolCall(fakeEngine, 'put_page', { slug, content, dry_run: true }, { remote: true, sourceId: 'default' });
  expect(result.isError).toBe(true);
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  expect(payload.error).toBe('invalid_params');
  return payload;
}

function expectSafeError(payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(FAKE_SECRET);
  expect(text).not.toContain('Assistant: here is the raw tool output');
  expect(text).not.toContain('postgres://user:pass@example');
  expect(typeof payload.message).toBe('string');
  expect(typeof payload.suggestion).toBe('string');
  expect(text).not.toContain('stack');
  expect(text).not.toContain('at validate');
}

describe('put_page validation gate', () => {
  test('accepts a valid inbox draft when dry-running through dispatch', async () => {
    const payload = await putPage('inbox/safe-draft', validInboxContent());
    expect(payload).toMatchObject({ dry_run: true, action: 'put_page', slug: 'inbox/safe-draft' });
  });

  test('rejects missing required nine-field frontmatter', async () => {
    const payload = await putPageError('inbox/missing-frontmatter', '---\ntype: knowledge\n---\n\n# Missing\n');
    expect(String(payload.message)).toContain('missing required frontmatter');
    expectSafeError(payload);
  });

  test('rejects illegal slug shape', async () => {
    const payload = await putPageError('inbox/Bad_Slug', validInboxContent());
    expect(String(payload.message)).toContain('slug');
    expectSafeError(payload);
  });

  test('rejects draft status outside inbox', async () => {
    const payload = await putPageError('knowledge/safe-draft', validInboxContent());
    expect(String(payload.message)).toContain('draft pages');
    expectSafeError(payload);
  });

  test('rejects migrated_from on non-migrated pages', async () => {
    const content = migratedFromContent('draft', 'legacy/path.md');
    const payload = await putPageError('inbox/migrated-from-new-page', content);
    expect(String(payload.message)).toContain('migrated_from');
    expectSafeError(payload);
  });

  test('rejects migrated-legacy outside legacy-migration', async () => {
    const content = migratedFromContent('migrated-legacy', 'old/path.md');
    const payload = await putPageError('inbox/bad-migrated-path', content);
    expect(String(payload.message)).toContain('inbox pages');
    expectSafeError(payload);
  });

  test('rejects fake secret-like content without echoing it', async () => {
    const payload = await putPageError('inbox/secret-probe', validInboxContent([], `Do not store ${FAKE_SECRET}.`));
    expect(String(payload.message)).toContain('credentials');
    expectSafeError(payload);
  });

  test('rejects private key blocks without echoing the key material', async () => {
    const privateKeyBlock = [
      '-----BEGIN FAKE PRIVATE KEY-----',
      'ZmFrZS1rZXktbWF0ZXJpYWw=',
      '-----END FAKE PRIVATE KEY-----',
    ].join('\n');
    const payload = await putPageError('inbox/private-key-probe', validInboxContent([], `Store this only in tests:\n${privateKeyBlock}`));
    expect(String(payload.message)).toContain('credentials');
    expect(String(payload.message)).not.toContain('-----BEGIN FAKE PRIVATE KEY-----');
    expectSafeError(payload);
  });

  test('rejects non-loopback IP addresses', async () => {
    const payload = await putPageError('inbox/ip-probe', validInboxContent([], `The host was ${NON_LOOPBACK_IP} during testing.`));
    expect(String(payload.message)).toContain('IP address');
    expectSafeError(payload);
  });

  test('rejects raw transcript markers without echoing content', async () => {
    const body = 'Assistant: here is the raw tool output\nUser: continue\nConclusion was not distilled.';
    const payload = await putPageError('inbox/raw-transcript-probe', validInboxContent([], body));
    expect(String(payload.message)).toContain('raw transcript');
    expectSafeError(payload);
  });

  test('rejects raw JSON transcript lines without echoing the JSON', async () => {
    const rawJsonLine = '{"role": "user", "content": "keep this out of storage"}';
    const payload = await putPageError('inbox/raw-json-probe', validInboxContent([], `Raw transcript line:\n${rawJsonLine}`));
    expect(String(payload.message)).toContain('raw JSON');
    expect(String(payload.message)).not.toContain(rawJsonLine);
    expectSafeError(payload);
  });

  test('rejects dense logs', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `2026-07-26T00:00:${String(i).padStart(2, '0')}Z ERROR worker failed with repeated diagnostic details`);
    const payload = await putPageError('inbox/dense-log-probe', validInboxContent([], lines.join('\n')));
    expect(String(payload.message)).toContain('dense command output');
    expectSafeError(payload);
  });

  test('rejects combined fake transcript and fake secret probe with non-revealing error', async () => {
    const body = `Assistant: here is the raw tool output\nThe fake token is ${FAKE_SECRET}.`;
    const payload = await putPageError('inbox/combined-unsafe-probe', validInboxContent([], body));
    expectSafeError(payload);
  });

  test('accepts a canonical project registry page', async () => {
    const content = projectContent([
      'record_kind: project-registry',
      'project_id: prj-0123456789abcdef',
      'project_name: Example Widget',
      'project_aliases: [widget]',
      'repository_refs: [github.com/example/widget]',
      'environment_refs: []',
    ]);
    const payload = await putPage('projects/prj-0123456789abcdef/index', content);
    expect(payload).toMatchObject({ dry_run: true, slug: 'projects/prj-0123456789abcdef/index' });
  });

  test('rejects project experience outside its project id directory', async () => {
    const content = projectContent([
      'record_kind: project-experience',
      'project_binding: bound',
      'project_id: prj-0123456789abcdef',
    ]);
    const payload = await putPageError('projects/prj-fedcba9876543210/retry-rule', content);
    expect(String(payload.message)).toContain('project_path_mismatch');
  });

  test('requires explicit pending or bound project state for inbox drafts', async () => {
    const content = projectContent([
      'project_binding: null',
      'project_id: null',
    ], 'draft', 'unverified');
    const payload = await putPageError('inbox/unbound-project-note', content);
    expect(String(payload.message)).toContain('project_binding_required');
  });
});
