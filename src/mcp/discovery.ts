import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ReadResourceResult,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

export const GBRAIN_SERVER_CAPABILITIES = {
  tools: {},
  prompts: {},
  resources: {},
} as const satisfies ServerCapabilities;

export const GBRAIN_SERVER_INSTRUCTIONS =
  'GBrain is a scoped knowledge base. Search before reading or writing. Use search or query to find candidates, then get_page for canonical content. Before put_page, search for an existing page and update it instead of creating a duplicate. Never write credentials or secrets. Read gbrain://guide/workflows and gbrain://schema/page for the operating contract.';

const PROMPTS = [
  {
    name: 'search_knowledge',
    title: 'Search GBrain knowledge',
    description: 'Search the brain, inspect canonical pages, and report source slugs.',
    arguments: [
      { name: 'query', description: 'Question or topic to retrieve.', required: true },
    ],
  },
  {
    name: 'capture_knowledge',
    title: 'Capture verified knowledge',
    description: 'Search before writing, then create or update one canonical page.',
    arguments: [
      { name: 'content', description: 'Verified knowledge to preserve.', required: true },
      { name: 'slug', description: 'Optional target slug when already known.' },
    ],
  },
] as const satisfies ListPromptsResult['prompts'];

const WORKFLOW_URI = 'gbrain://guide/workflows';
const PAGE_SCHEMA_URI = 'gbrain://schema/page';

const RESOURCES = [
  {
    uri: WORKFLOW_URI,
    name: 'gbrain-workflows',
    title: 'GBrain operating workflows',
    description: 'Read, write, and permission workflow for MCP clients.',
    mimeType: 'text/markdown',
  },
  {
    uri: PAGE_SCHEMA_URI,
    name: 'gbrain-page-schema',
    title: 'GBrain page schema',
    description: 'Canonical Markdown frontmatter contract for put_page.',
    mimeType: 'text/markdown',
  },
] as const satisfies ListResourcesResult['resources'];

const WORKFLOW_TEXT = `# GBrain MCP workflow

1. Call \`search\` or \`query\` before external research or writing.
2. Call \`get_page\` for each relevant slug before answering or updating.
3. Use \`put_page\` only with write scope. Update an existing canonical slug instead of duplicating it.
4. Treat permission errors as credential-scope problems; do not work around them.
5. Never send credentials, tokens, private keys, or raw authentication files to GBrain.
6. Before project work, resolve the nearest \`.gbrain-project.yaml\`. Match is read-only; creation and binding require explicit confirmation.
`;

const PAGE_SCHEMA_TEXT = `# GBrain page schema

Canonical pages are Markdown with frontmatter fields:

- type
- date
- status
- sensitivity
- verification
- applicability
- non_applicable
- source_refs
- migrated_from

Every inbox draft also declares:

- \`project_binding: pending\` with \`project_id: null\`; or
- \`project_binding: bound\` with a canonical \`project_id\` matching \`^prj-[0-9a-f]{16}$\`.

Project registries live at \`projects/<project_id>/index\` with
\`record_kind: project-registry\`. Project experiences use
\`type: project\` and \`record_kind: project-experience\`.
Project identity is matched only by exact \`project_id\`; Git, paths, names,
aliases, and semantic similarity are never identity inputs. Use
\`match_project\` for exact read-only verification and \`ensure_project\` to
reuse or create the registry in the current source.
Project experience drafts must be bound before \`put_page\`; pending project
experience drafts are rejected. The canonical registry must exist in the
current write source and carry the same project ID.
Cross-project promotion keeps \`source_project_ids\`.

Use \`source_refs\` for evidence pointers. New analysis remains unverified until tested.
`;

function requiredArgument(
  promptName: string,
  args: Record<string, string> | undefined,
  argumentName: string,
): string {
  const value = args?.[argumentName]?.trim();
  if (value) return value;
  throw new McpError(
    ErrorCode.InvalidParams,
    `Prompt "${promptName}" requires argument "${argumentName}". Call prompts/list for its argument schema.`,
  );
}

export function listPrompts(): ListPromptsResult {
  return { prompts: [...PROMPTS] };
}

export function getPrompt(name: string, args: Record<string, string> | undefined): GetPromptResult {
  switch (name) {
    case 'search_knowledge': {
      const query = requiredArgument(name, args, 'query');
      return {
        description: 'Retrieve canonical GBrain knowledge.',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Search GBrain for: ${query}\nRead the relevant canonical pages and cite their slugs.`,
          },
        }],
      };
    }
    case 'capture_knowledge': {
      const content = requiredArgument(name, args, 'content');
      const slug = args?.slug?.trim();
      return {
        description: 'Capture one verified knowledge item.',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Search for an existing canonical page before writing.${slug ? ` Prefer slug: ${slug}.` : ''}\nKnowledge to preserve:\n${content}`,
          },
        }],
      };
    }
    default:
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown prompt "${name}". Call prompts/list and use one of the returned names.`,
      );
  }
}

export function listResources(): ListResourcesResult {
  return { resources: [...RESOURCES] };
}

export function readResource(uri: string): ReadResourceResult {
  switch (uri) {
    case WORKFLOW_URI:
      return { contents: [{ uri, mimeType: 'text/markdown', text: WORKFLOW_TEXT }] };
    case PAGE_SCHEMA_URI:
      return { contents: [{ uri, mimeType: 'text/markdown', text: PAGE_SCHEMA_TEXT }] };
    default:
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown resource URI "${uri}". Call resources/list and use one of the returned URIs.`,
      );
  }
}

export function registerDiscoveryHandlers(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async request => (
    getPrompt(request.params.name, request.params.arguments)
  ));
  server.setRequestHandler(ListResourcesRequestSchema, async () => listResources());
  server.setRequestHandler(ReadResourceRequestSchema, async request => (
    readResource(request.params.uri)
  ));
}
