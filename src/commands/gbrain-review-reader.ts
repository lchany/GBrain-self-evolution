import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GBrainConfig } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { mintClientCredentialsToken } from '../core/remote-mcp-probe.ts';
import type { ToolCaller } from './gbrain-review.ts';

export class MissingReadCredentialsError extends Error {
  constructor() {
    super('missing local read credentials');
    this.name = 'MissingReadCredentialsError';
  }
}

export function localReadEnvPath(): string {
  return join(homedir(), '.config', 'gbrain', 'local-read.env');
}

export function createLocalReadToolCaller(envPath = localReadEnvPath()): ToolCaller {
  return async (name, args) => {
    const env = readReadEnv(envPath);
    const mcpUrl = firstEnv(env, ['GBRAIN_MCP_URL', 'GBRAIN_REMOTE_MCP_URL', 'GBRAIN_READ_MCP_URL', 'MCP_URL']);
    const bearer = firstEnv(env, ['GBRAIN_REMOTE_TOKEN', 'GBRAIN_READ_TOKEN', 'GBRAIN_BEARER_TOKEN', 'BEARER_TOKEN']);
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
    const issuerUrl = firstEnv(env, ['GBRAIN_ISSUER_URL', 'GBRAIN_REMOTE_ISSUER_URL', 'GBRAIN_READ_ISSUER_URL', 'ISSUER_URL']);
    if (mcpUrl && issuerUrl && clientId && clientSecret) {
      const cfg: GBrainConfig = {
        engine: 'postgres',
        remote_mcp: { issuer_url: issuerUrl, mcp_url: mcpUrl, oauth_client_id: clientId, oauth_client_secret: clientSecret },
      };
      return unpackToolResult(await callRemoteTool(cfg, name, args, { timeoutMs: 30_000 }));
    }
    throw new MissingReadCredentialsError();
  };
}

function readReadEnv(envPath: string): ReadonlyMap<string, string> {
  if (!existsSync(envPath)) throw new MissingReadCredentialsError();
  const pairs = new Map<string, string>();
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    const rawValue = body.slice(eq + 1).trim();
    pairs.set(key, rawValue.replace(/^["']|["']$/g, ''));
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
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'gbrain-review-cli', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`read tool ${name} failed`);
    return unpackToolResult(result);
  } finally {
    await client.close();
  }
}

async function callTokenEndpointTool(mcpUrl: string, tokenEndpoint: string, clientId: string, clientSecret: string, scope: string | undefined, name: string, args: Record<string, unknown>): Promise<unknown> {
  const token = await mintClientCredentialsToken(tokenEndpoint, clientId, clientSecret, { ...(scope ? { scope } : {}), timeoutMs: 10_000 });
  if (!token.ok) throw new Error(`read token mint failed: ${token.reason}`);
  return callBearerTool(mcpUrl, token.token.access_token, name, args);
}
