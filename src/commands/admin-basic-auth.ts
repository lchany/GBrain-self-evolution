import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type AdminBasicAuthCredentials = {
  readonly username: string;
  readonly password: string;
};

export type AdminBasicAuthResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'enabled'; readonly credentials: AdminBasicAuthCredentials }
  | { readonly kind: 'error'; readonly message: string };

export type AdminOriginResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'enabled'; readonly origin: URL }
  | { readonly kind: 'error'; readonly message: string };

type AdminBasicAuthEnv = Readonly<Record<string, string | undefined>>;

export function resolveAdminBasicAuth(env: AdminBasicAuthEnv): AdminBasicAuthResolution {
  const username = env.GBRAIN_ADMIN_BASIC_USER;
  const password = env.GBRAIN_ADMIN_BASIC_PASSWORD;
  if (username === undefined && password === undefined) return { kind: 'disabled' };
  if (username === undefined || password === undefined) {
    return {
      kind: 'error',
      message: 'GBRAIN_ADMIN_BASIC_USER and GBRAIN_ADMIN_BASIC_PASSWORD must be set together',
    };
  }
  if (username.trim().length === 0 || password.length === 0) {
    return { kind: 'error', message: 'Admin Basic-auth username and password must not be empty' };
  }
  return { kind: 'enabled', credentials: { username, password } };
}

export function resolveAdminOrigin(rawOrigin: string | undefined): AdminOriginResolution {
  if (rawOrigin === undefined) return { kind: 'disabled' };
  try {
    const origin = new URL(rawOrigin);
    if (
      (origin.protocol !== 'http:' && origin.protocol !== 'https:')
      || origin.username.length > 0
      || origin.password.length > 0
      || origin.pathname !== '/'
      || origin.search.length > 0
      || origin.hash.length > 0
    ) {
      return {
        kind: 'error',
        message: 'GBRAIN_ADMIN_ORIGIN must contain only scheme, host, and optional port',
      };
    }
    return { kind: 'enabled', origin };
  } catch {
    return { kind: 'error', message: 'GBRAIN_ADMIN_ORIGIN must be a valid HTTP or HTTPS origin' };
  }
}

function matchesCredential(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function parseBasicAuthorization(header: string | undefined): AdminBasicAuthCredentials | null {
  const match = header?.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/);
  if (match === undefined || match === null) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export function createAdminBasicAuthMiddleware(expected: AdminBasicAuthCredentials): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actual = parseBasicAuthorization(req.headers.authorization);
    if (
      actual !== null
      && matchesCredential(actual.username, expected.username)
      && matchesCredential(actual.password, expected.password)
    ) {
      next();
      return;
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="GBrain Admin", charset="UTF-8"');
    res.status(401).json({ error: 'Admin authentication required' });
  };
}
