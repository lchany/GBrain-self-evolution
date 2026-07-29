import type { Operation, ParamDef } from '../core/operations.ts';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  annotations: ToolAnnotations;
}

/**
 * Convert a single ParamDef to a JSON Schema fragment. Recursive on `items`.
 *
 * Single source of truth for ParamDef→JSON Schema mapping. Consumed by:
 * - buildToolDefs (stdio MCP server.ts via tool-defs.ts)
 * - serve-http.ts tools/list handler (HTTP MCP path)
 * - brain-allowlist.ts paramsToInputSchema (subagent tool registry)
 *
 * The three call sites previously each had their own inline destructure that
 * drifted from each other (live HTTP MCP path dropped `items` entirely in
 * v0.32 PR review). Centralizing here closes the bug class at the
 * architecture level instead of patching one site at a time.
 *
 * Key ordering (type, description, enum, default, items) is intentional —
 * matches the pre-v0.34 inline mappers so JSON.stringify output stays
 * byte-stable for the byte-equality regression test.
 */
export function paramDefToSchema(p: ParamDef): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.minimum !== undefined ? { minimum: p.minimum } : {}),
    ...(p.maximum !== undefined ? { maximum: p.maximum } : {}),
    ...(p.minLength !== undefined ? { minLength: p.minLength } : {}),
    ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
    ...(p.minItems !== undefined ? { minItems: p.minItems } : {}),
    ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
    ...(p.pattern ? { pattern: p.pattern } : {}),
    ...(p.items ? { items: paramDefToSchema(p.items) } : {}),
  };
}

function toolAnnotations(op: Operation): ToolAnnotations {
  const readOnly = (op.scope ?? 'read') === 'read' || op.mutating === false;
  const destructive = op.mutating === true || op.scope === 'write' || op.name === 'delete_page';
  const idempotent = op.name === 'get_page'
    || op.name === 'list_pages'
    || op.name === 'delete_page'
    || (readOnly && op.name !== 'search' && op.name !== 'query');
  const openWorld = op.name === 'search' || op.name === 'query';
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map(op => {
    return {
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
      annotations: toolAnnotations(op),
    };
  });
}
