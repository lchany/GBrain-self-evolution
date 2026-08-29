import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GBrainConfig } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { mintClientCredentialsToken } from '../core/remote-mcp-probe.ts';

export class MissingWriterCredentialsError extends Error {
  constructor() {
    super('missing local writer credentials');
    this.name = 'MissingWriterCredentialsError';
  }
}

export type WriterToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface WriterToolSession {
  readonly callTool: WriterToolCaller;
  readonly close: () => Promise<void>;
}

export type WriterSessionFactory = (expectedMcpUrl: string) => Promise<WriterToolSession>;
export type WriterSessionOpener = (mcpUrl: string, bearer: string) => Promise<WriterToolSession>;

export class WriterAttestationError extends Error {
  constructor() {
    super('writer attestation failed');
    this.name = 'WriterAttestationError';
  }
}

const SYSTEMD_WRITER_CREDENTIAL = 'gbrain-local-writer.env';

export function localWriterEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const explicitPath = env.GBRAIN_REVIEW_WRITER_ENV_PATH?.trim();
  if (explicitPath) return explicitPath;

  const credentialsDirectory = env.CREDENTIALS_DIRECTORY?.trim();
  if (credentialsDirectory) {
    const credentialPath = join(credentialsDirectory, SYSTEMD_WRITER_CREDENTIAL);
    if (existsSync(credentialPath)) return credentialPath;
  }

  return join(home, '.config', 'gbrain', 'local-writer.env');
}

export function createLocalWriterToolCaller(envPath = localWriterEnvPath()): WriterToolCaller {
  return async (name, args) => {
    const env = readWriterEnv(envPath);
    const mcpUrl = firstEnv(env, ['GBRAIN_MCP_URL', 'GBRAIN_REMOTE_MCP_URL', 'GBRAIN_WRITER_MCP_URL', 'MCP_URL']);
    const bearer = firstEnv(env, ['GBRAIN_REMOTE_TOKEN', 'GBRAIN_WRITER_TOKEN', 'GBRAIN_BEARER_TOKEN', 'BEARER_TOKEN']);
    const tokenEndpoint = firstEnv(env, ['GBRAIN_TOKEN_ENDPOINT', 'GBRAIN_REMOTE_TOKEN_ENDPOINT', 'TOKEN_ENDPOINT']);
    const clientId = firstEnv(env, ['GBRAIN_CLIENT_ID', 'GBRAIN_OAUTH_CLIENT_ID', 'GBRAIN_REMOTE_OAUTH_CLIENT_ID', 'OAUTH_CLIENT_ID']);
    const clientSecret = firstEnv(env, ['GBRAIN_CLIENT_SECRET', 'GBRAIN_OAUTH_CLIENT_SECRET', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_REMOTE_OAUTH_CLIENT_SECRET', 'OAUTH_CLIENT_SECRET']);
    const scope = firstEnv(env, ['GBRAIN_SCOPES', 'GBRAIN_SCOPE', 'OAUTH_SCOPE']);
    if (mcpUrl && bearer) {
      try {
        return await callBearerTool(mcpUrl, bearer, name, args);
      } catch (error) {
        if (!(mcpUrl && tokenEndpoint && clientId && clientSecret)) throw error;
      }
    }
    if (mcpUrl && tokenEndpoint && clientId && clientSecret) {
      return callTokenEndpointTool(mcpUrl, tokenEndpoint, clientId, clientSecret, scope, name, args);
    }
    const issuerUrl = firstEnv(env, ['GBRAIN_ISSUER_URL', 'GBRAIN_REMOTE_ISSUER_URL', 'GBRAIN_WRITER_ISSUER_URL', 'ISSUER_URL']);
    if (mcpUrl && issuerUrl && clientId && clientSecret) {
      const cfg: GBrainConfig = {
        engine: 'postgres',
        remote_mcp: {
          issuer_url: issuerUrl,
          mcp_url: mcpUrl,
          oauth_client_id: clientId,
          oauth_client_secret: clientSecret,
        },
      };
      return unpackToolResult(await callRemoteTool(cfg, name, args, { timeoutMs: 30_000 }));
    }
    throw new MissingWriterCredentialsError();
  };
}

/**
 * Opens one writer session from one immutable environment snapshot. The caller
 * owns its lifetime and performs source attestation before any write.
 */
export function createLocalWriterSessionFactory(
  envPath = localWriterEnvPath(),
  openSession: WriterSessionOpener = openWriterSession,
): WriterSessionFactory {
  return async (expectedMcpUrl) => {
    const env = readWriterEnv(envPath);
    const mcpUrl = normalizeMcpUrl(firstEnv(env, ['GBRAIN_LOOPBACK_MCP_URL', 'GBRAIN_MCP_URL', 'GBRAIN_REMOTE_MCP_URL', 'GBRAIN_WRITER_MCP_URL', 'MCP_URL']));
    if (mcpUrl === null || mcpUrl !== normalizeMcpUrl(expectedMcpUrl)) throw new WriterAttestationError();

    const bearer = firstEnv(env, ['GBRAIN_REMOTE_TOKEN', 'GBRAIN_WRITER_TOKEN', 'GBRAIN_BEARER_TOKEN', 'BEARER_TOKEN']);
    if (bearer !== undefined) return openSession(mcpUrl, bearer);

    const tokenEndpoint = firstEnv(env, ['GBRAIN_TOKEN_ENDPOINT', 'GBRAIN_REMOTE_TOKEN_ENDPOINT', 'TOKEN_ENDPOINT']);
    const clientId = firstEnv(env, ['GBRAIN_CLIENT_ID', 'GBRAIN_OAUTH_CLIENT_ID', 'GBRAIN_REMOTE_OAUTH_CLIENT_ID', 'OAUTH_CLIENT_ID']);
    const clientSecret = firstEnv(env, ['GBRAIN_CLIENT_SECRET', 'GBRAIN_OAUTH_CLIENT_SECRET', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_REMOTE_OAUTH_CLIENT_SECRET', 'OAUTH_CLIENT_SECRET']);
    const scope = firstEnv(env, ['GBRAIN_SCOPES', 'GBRAIN_SCOPE', 'OAUTH_SCOPE']);
    if (tokenEndpoint === undefined || clientId === undefined || clientSecret === undefined) throw new MissingWriterCredentialsError();

    const token = await mintClientCredentialsToken(tokenEndpoint, clientId, clientSecret, { ...(scope ? { scope } : {}), timeoutMs: 10_000 });
    if (!token.ok) throw new WriterAttestationError();
    return openSession(mcpUrl, token.token.access_token);
  };
}

function readWriterEnv(envPath: string): ReadonlyMap<string, string> {
  if (!existsSync(envPath)) throw new MissingWriterCredentialsError();
  const pairs = new Map<string, string>();
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    const rawValue = body.slice(eq + 1).trim();
    pairs.set(key, rawValue.replace(/^['"]|['"]$/g, ''));
  }
  return pairs;
}

function firstEnv(env: ReadonlyMap<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env.get(name);
    if (value) return value;
  }
  return undefined;
}

async function callBearerTool(mcpUrl: string, bearer: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const session = await openWriterSession(mcpUrl, bearer);
  try {
    return await session.callTool(name, args);
  } finally {
    await session.close();
  }
}

async function openWriterSession(mcpUrl: string, bearer: string): Promise<WriterToolSession> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'gbrain-capture-cli', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  return {
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) {
        const message = Array.isArray(result.content)
          ? result.content.map((item: unknown) => isTextContent(item) ? item.text : '').join('\n')
          : 'unknown tool error';
        throw new Error(`writer tool ${name} failed: ${message}`);
      }
      return unpackToolResult(result);
    },
    close: async () => client.close(),
  };
}

function normalizeMcpUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function callTokenEndpointTool(
  mcpUrl: string,
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  scope: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const token = await mintClientCredentialsToken(tokenEndpoint, clientId, clientSecret, { ...(scope ? { scope } : {}), timeoutMs: 10_000 });
  if (!token.ok) throw new Error(`writer token mint failed: ${token.reason}`);
  return callBearerTool(mcpUrl, token.token.access_token, name, args);
}

function isTextContent(value: unknown): value is { readonly text: string } {
  return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string';
}
