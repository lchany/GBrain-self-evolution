import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthInfo } from '../src/core/operations.ts';
import { createAnonymousOrBearerAuthMiddleware } from '../src/commands/anonymous-mcp-auth.ts';
import { selectMcpOperations } from '../src/commands/serve-http.ts';

const anonymousIdentity: AuthInfo = {
  token: '',
  clientId: 'cloud-firewall-allowlist',
  scopes: ['read', 'write'],
  sourceId: 'default',
};

function invokeAuthMiddleware(
  middleware: RequestHandler,
  authorization?: string,
): { req: Request; nextCalls: number } {
  const req = {
    headers: authorization === undefined ? {} : { authorization },
  } as Request;
  let nextCalls = 0;
  middleware(req, {} as Response, (() => { nextCalls += 1; }) as NextFunction);
  return { req, nextCalls };
}

describe('anonymous MCP operation surface', () => {
  test('Given cloud-firewall access When anonymous MCP operations are selected Then only remote read and write operations remain', () => {
    const operations = selectMcpOperations(true);
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.scope === 'read' || operation.scope === 'write')).toBe(true);
    expect(operations.some((operation) => operation.scope === 'admin')).toBe(false);
    expect(operations.some((operation) => operation.scope === 'agent')).toBe(false);
    expect(operations.some((operation) => operation.scope === 'sources_admin')).toBe(false);
    expect(operations.some((operation) => operation.scope === 'users_admin')).toBe(false);
    expect(operations.some((operation) => operation.localOnly === true)).toBe(false);
  });

  test('Given bearer-auth mode When operations are selected Then non-local privileged operations remain available to scoped callers', () => {
    const operations = selectMcpOperations(false);
    expect(operations.some((operation) => operation.scope === 'admin')).toBe(true);
    expect(operations.some((operation) => operation.localOnly === true)).toBe(false);
  });

  test('Given no Authorization header When anonymous mode authenticates a request Then it uses the firewall identity', () => {
    let bearerCalls = 0;
    const middleware = createAnonymousOrBearerAuthMiddleware(
      anonymousIdentity,
      ((_req, _res, _next) => { bearerCalls += 1; }) as RequestHandler,
    );

    const { req, nextCalls } = invokeAuthMiddleware(middleware);

    expect(req.auth).toBe(anonymousIdentity);
    expect(nextCalls).toBe(1);
    expect(bearerCalls).toBe(0);
  });

  test('Given a valid Bearer header When anonymous mode authenticates a request Then it preserves the verified source identity', () => {
    const verifiedIdentity: AuthInfo = {
      token: 'redacted-test-token',
      clientId: 'gbrain_cl_test',
      scopes: ['read', 'write'],
      sourceId: 'project-source',
    };
    const bearer: RequestHandler = (req, _res, next) => {
      req.auth = verifiedIdentity;
      next();
    };
    const middleware = createAnonymousOrBearerAuthMiddleware(anonymousIdentity, bearer);

    const { req, nextCalls } = invokeAuthMiddleware(middleware, 'Bearer redacted-test-token');

    expect(req.auth).toBe(verifiedIdentity);
    expect(nextCalls).toBe(1);
  });

  test('Given a rejected or empty Authorization header When anonymous mode authenticates a request Then it never falls back to anonymous', () => {
    for (const authorization of ['Bearer rejected-test-token', '']) {
      let bearerCalls = 0;
      const rejectingBearer: RequestHandler = () => {
        bearerCalls += 1;
      };
      const middleware = createAnonymousOrBearerAuthMiddleware(anonymousIdentity, rejectingBearer);

      const { req, nextCalls } = invokeAuthMiddleware(middleware, authorization);

      expect(req.auth).toBeUndefined();
      expect(nextCalls).toBe(0);
      expect(bearerCalls).toBe(1);
    }
  });
});
