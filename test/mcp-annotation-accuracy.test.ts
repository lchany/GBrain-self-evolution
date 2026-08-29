import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

const toolDefs = buildToolDefs(operations);

function annotationsFor(name: string) {
  const tool = toolDefs.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing MCP tool definition for ${name}`);
  return tool.annotations;
}

describe('MCP annotation accuracy', () => {
  test('read-only diagnostic and status tools keep readOnlyHint', () => {
    // given
    const readOnlyTools = [
      'get_stats',
      'get_health',
      'run_doctor',
      'get_status_snapshot',
      'get_job',
      'list_jobs',
      'get_job_progress',
      'file_list',
      'file_url',
    ];

    // when / then
    for (const name of readOnlyTools) {
      expect(annotationsFor(name), name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
  });

  test('job lifecycle state changes keep destructive marking', () => {
    // given
    const stateChangingTools = [
      'cancel_job',
      'retry_job',
      'pause_job',
      'resume_job',
      'replay_job',
      'send_job_message',
      'reload_schema_pack',
    ];

    // when / then
    for (const name of stateChangingTools) {
      expect(annotationsFor(name), name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    }
  });
});
