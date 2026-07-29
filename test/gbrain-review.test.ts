import { describe, expect, test } from 'bun:test';
import { runGbrainReview, type ToolCaller } from '../src/commands/gbrain-review.ts';

const REVIEW_DATE = '2026-07-26';

function draft(slug: string, verification = 'verified'): Record<string, unknown> {
  return {
    slug,
    type: 'runbook',
    title: slug.split('/').at(-1) ?? slug,
    tags: [],
    compiled_truth: '## 结论\n\n可复用步骤已验证。',
    timeline: '',
    frontmatter: {
      type: 'runbook',
      date: '2026-07-26',
      status: 'draft',
      sensitivity: 'internal',
      verification,
      applicability: ['all'],
      non_applicable: [],
      source_refs: ['file:<EVIDENCE_POINTER>'],
      migrated_from: null,
    },
  };
}

function captureOutput(): { readonly lines: string[]; readonly write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text) => { lines.push(text); } };
}

describe('gbrain review CLI adapter', () => {
  test('Given read-only subcommands When list/show/plan/verify run Then only read caller is used', async () => {
    // given
    const readCalls: string[] = [];
    const writeCalls: string[] = [];
    const read: ToolCaller = async (name, args) => {
      readCalls.push(name);
      if (name === 'list_pages') return { items: [draft('inbox/read-only')] };
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const write: ToolCaller = async (name) => {
      writeCalls.push(name);
      return { ok: true };
    };
    const output = captureOutput();

    // when
    await runGbrainReview(['list', '--json'], { callReadTool: read, callWriteTool: write, stdout: output.write });
    await runGbrainReview(['show', 'inbox/read-only', '--json'], { callReadTool: read, callWriteTool: write, stdout: output.write });
    await runGbrainReview(['plan', 'inbox/read-only', '--target', 'incidents/read-only', '--type', 'incident', '--json'], { callReadTool: read, callWriteTool: write, stdout: output.write });
    await runGbrainReview(['verify', 'incidents/read-only', '--json'], { callReadTool: read, callWriteTool: write, stdout: output.write });

    // then
    expect(readCalls).toEqual(['list_pages', 'get_page', 'get_page', 'search', 'get_page', 'search']);
    expect(writeCalls).toEqual([]);
  });

  test('Given missing reason When reject or needs-evidence runs Then the CLI blocks before writing', async () => {
    // given
    const writeCalls: string[] = [];
    const write: ToolCaller = async (name) => {
      writeCalls.push(name);
      return { ok: true };
    };
    const output = captureOutput();

    // when
    const rejectCode = await runGbrainReview(['reject', 'inbox/no-reason', '--json'], { callWriteTool: write, stdout: output.write });
    const evidenceCode = await runGbrainReview(['needs-evidence', 'inbox/no-reason', '--json'], { callWriteTool: write, stdout: output.write });

    // then
    expect(rejectCode).toBe(1);
    expect(evidenceCode).toBe(1);
    expect(writeCalls).toEqual([]);
  });

  test('Given a whitespace-only reason When reject or needs-evidence is planned or written Then the CLI blocks before reading or writing', async () => {
    // given
    const readCalls: string[] = [];
    const writeCalls: string[] = [];
    const output = captureOutput();
    const read: ToolCaller = async (name) => {
      readCalls.push(name);
      return draft('inbox/blank-reason');
    };
    const write: ToolCaller = async (name) => {
      writeCalls.push(name);
      return { ok: true };
    };

    // when
    const planCode = await runGbrainReview(['plan', 'inbox/blank-reason', '--action', 'reject', '--reason', '   ', '--json'], { callReadTool: read, callWriteTool: write, stdout: output.write });
    const writeCode = await runGbrainReview(['needs-evidence', 'inbox/blank-reason', '--reason', '   ', '--json'], { callReadTool: read, callWriteTool: write, stdout: output.write });

    // then
    expect(planCode).toBe(1);
    expect(writeCode).toBe(1);
    expect(readCalls).toEqual([]);
    expect(writeCalls).toEqual([]);
    expect(output.lines.join('\n')).toContain('reason_required');
  });

  test('Given wrong promote confirmation When promote runs Then core gate code blocks and source is not deleted', async () => {
    // given
    const read: ToolCaller = async (name, args) => {
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const writeCalls: string[] = [];
    const write: ToolCaller = async (name) => {
      writeCalls.push(name);
      return { ok: true };
    };
    const output = captureOutput();

    // when
    const code = await runGbrainReview([
      'promote', 'inbox/promote-one', '--target', 'knowledge/promote-one', '--type', 'knowledge', '--confirm', 'PROMOTE wrong', '--json',
    ], { callReadTool: read, callWriteTool: write, stdout: output.write });

    // then
    expect(code).toBe(1);
    expect(output.lines.join('\n')).toContain('promote_confirmation_required');
    expect(writeCalls).toEqual([]);
  });

  test('Given a bare target slug or wrong prefix When a non-interactive merge runs Then it rejects both before writing', async () => {
    // given
    const read: ToolCaller = async (name, args) => {
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const writeCalls: string[] = [];
    const write: ToolCaller = async (name, args) => {
      writeCalls.push(`${name}:${String(args.slug)}`);
      return { ok: true };
    };
    const output = captureOutput();

    // when
    const bareCode = await runGbrainReview([
      'merge', 'inbox/merge-one', '--target', 'incidents/merge-one', '--type', 'incident', '--confirm', 'incidents/merge-one', '--json',
    ], { callReadTool: read, callWriteTool: write, stdout: output.write, now: () => new Date(`${REVIEW_DATE}T12:00:00Z`) });
    const wrongPrefixCode = await runGbrainReview([
      'merge', 'inbox/merge-one', '--target', 'incidents/merge-one', '--type', 'incident', '--confirm', 'PROMOTE incidents/merge-one', '--json',
    ], { callReadTool: read, callWriteTool: write, stdout: output.write, now: () => new Date(`${REVIEW_DATE}T12:00:00Z`) });

    // then
    expect(bareCode).toBe(1);
    expect(wrongPrefixCode).toBe(1);
    expect(writeCalls).toEqual([]);
  });

  test('Given an exact MERGE phrase When a non-interactive merge runs Then it writes the selected target', async () => {
    // given
    const read: ToolCaller = async (name, args) => {
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const writeCalls: string[] = [];
    const write: ToolCaller = async (name, args) => {
      writeCalls.push(`${name}:${String(args.slug)}`);
      return { ok: true };
    };

    // when
    const code = await runGbrainReview([
      'merge', 'inbox/merge-one', '--target', 'incidents/merge-one', '--type', 'incident', '--confirm', 'MERGE incidents/merge-one', '--json',
    ], { callReadTool: read, callWriteTool: write, now: () => new Date(`${REVIEW_DATE}T12:00:00Z`) });

    // then
    expect(code).toBe(0);
    expect(writeCalls).toContain('put_page:incidents/merge-one');
  });

  test('Given an interactive merge When prompted Then it requires the exact MERGE phrase instead of auto-confirming a target slug', async () => {
    // given
    const read: ToolCaller = async (name, args) => {
      if (name === 'list_pages') return { items: [draft('inbox/interactive-merge')] };
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const writes: string[] = [];
    const output = captureOutput();

    // when
    const code = await runGbrainReview([], {
      callReadTool: read,
      callWriteTool: async (name, args) => {
        writes.push(`${name}:${String(args.slug)}`);
        return { ok: true };
      },
      inputLines: ['1', 'merge', 'incidents/interactive-merge', 'incident', 'MERGE incidents/interactive-merge'],
      now: () => new Date(`${REVIEW_DATE}T12:00:00Z`),
      stdout: output.write,
    });

    // then
    expect(code).toBe(0);
    expect(output.lines.join('\n')).toContain('请输入确认短语：MERGE incidents/interactive-merge');
    expect(writes).toContain('put_page:incidents/interactive-merge');
  });

  test('CURRENT BASELINE (Todos 6/7 intentionally change later): CLI review reads omit source scope', async () => {
    // given
    const readCalls: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
    const read: ToolCaller = async (name, args) => {
      readCalls.push({ name, args });
      if (name === 'get_page') return draft(String(args.slug));
      throw new Error(`unexpected read tool ${name}`);
    };
    const output = captureOutput();

    // when
    const code = await runGbrainReview(['show', 'inbox/unscoped', '--json'], { callReadTool: read, stdout: output.write });

    // then
    expect(code).toBe(0);
    expect(readCalls).toEqual([{ name: 'get_page', args: { slug: 'inbox/unscoped' } }]);
  });

  test('Given duplicate or unverified promote When promote runs Then core machine codes block writes', async () => {
    // given
    const duplicateRead: ToolCaller = async (name, args) => {
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [{ slug: 'knowledge/duplicate-one', title: 'duplicate-one' }];
      throw new Error(`unexpected read tool ${name}`);
    };
    const unverifiedRead: ToolCaller = async (name, args) => {
      if (name === 'get_page') return draft(String(args.slug), 'unverified');
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const output = captureOutput();

    // when
    const duplicateCode = await runGbrainReview([
      'promote', 'inbox/duplicate-one', '--target', 'knowledge/duplicate-one', '--type', 'knowledge', '--confirm', 'PROMOTE knowledge/duplicate-one', '--json',
    ], { callReadTool: duplicateRead, stdout: output.write });
    const unverifiedCode = await runGbrainReview([
      'promote', 'inbox/unverified-one', '--target', 'knowledge/unverified-one', '--type', 'knowledge', '--confirm', 'PROMOTE knowledge/unverified-one', '--json',
    ], { callReadTool: unverifiedRead, stdout: output.write });

    // then
    expect(duplicateCode).toBe(1);
    expect(unverifiedCode).toBe(1);
    expect(output.lines.join('\n')).toContain('duplicate_target');
    expect(output.lines.join('\n')).toContain('unverified_promote');
  });

  test('Given Chinese interactive inputs When keep then promote run Then labels and apply order are visible', async () => {
    // given
    const read: ToolCaller = async (name, args) => {
      if (name === 'list_pages') return { items: [draft('inbox/interactive-one')] };
      if (name === 'get_page') return draft(String(args.slug));
      if (name === 'search') return [];
      throw new Error(`unexpected read tool ${name}`);
    };
    const writeCalls: string[] = [];
    const write: ToolCaller = async (name, args) => {
      writeCalls.push(`${name}:${String(args.slug)}`);
      return { ok: true, slug: args.slug };
    };
    const output = captureOutput();

    // when
    const keepCode = await runGbrainReview([], {
      callReadTool: read,
      callWriteTool: write,
      inputLines: ['1', 'keep', 'incidents/interactive-one', 'incident'],
      stdout: output.write,
      now: () => new Date(`${REVIEW_DATE}T12:00:00Z`),
    });
    const promoteCode = await runGbrainReview([], {
      callReadTool: read,
      callWriteTool: write,
      inputLines: ['1', 'promote', 'runbooks/interactive-one', 'runbook', 'PROMOTE runbooks/interactive-one'],
      stdout: output.write,
      now: () => new Date(`${REVIEW_DATE}T12:00:00Z`),
    });

    // then
    expect(keepCode).toBe(0);
    expect(promoteCode).toBe(0);
    expect(output.lines.join('\n')).toContain('待审核草稿');
    expect(output.lines.join('\n')).toContain('选择处置动作');
    expect(writeCalls).toEqual([
      'put_page:incidents/interactive-one',
      'get_page:incidents/interactive-one',
      'put_page:decisions/reviews/interactive-one-review-20260726',
      'delete_page:inbox/interactive-one',
      'put_page:runbooks/interactive-one',
      'get_page:runbooks/interactive-one',
      'put_page:decisions/reviews/interactive-one-review-20260726',
      'delete_page:inbox/interactive-one',
    ]);
  });
});
