import { describe, expect, test } from 'bun:test';
import express from 'express';
import {
  createAdminBasicAuthMiddleware,
  resolveAdminBasicAuth,
  resolveAdminOrigin,
} from '../src/commands/admin-basic-auth.ts';

async function requestAdmin(
  authorization: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Response> {
  const resolved = resolveAdminBasicAuth(env);
  if (resolved.kind !== 'enabled') throw new Error('test credentials must resolve');

  const app = express();
  app.get('/admin/review', createAdminBasicAuthMiddleware(resolved.credentials), (_req, res) => {
    res.status(200).send('review');
  });
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');

  try {
    return await fetch(`http://127.0.0.1:${address.port}/admin/review`, {
      headers: authorization === undefined ? {} : { authorization },
    });
  } finally {
    server.close();
  }
}

const credentialsEnv = {
  GBRAIN_ADMIN_BASIC_USER: 'review-admin',
  GBRAIN_ADMIN_BASIC_PASSWORD: 'correct-password',
} as const;

describe('admin Basic authentication', () => {
  test('Given correct username and password When requesting admin review Then access is granted', async () => {
    const authorization = `Basic ${Buffer.from('review-admin:correct-password').toString('base64')}`;

    const response = await requestAdmin(authorization, credentialsEnv);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('review');
  });

  test('Given missing credentials When requesting admin review Then a Basic challenge is returned', async () => {
    const response = await requestAdmin(undefined, credentialsEnv);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="GBrain Admin", charset="UTF-8"');
  });

  test('Given wrong credentials When requesting admin review Then access is denied', async () => {
    const authorization = `Basic ${Buffer.from('review-admin:wrong-password').toString('base64')}`;

    const response = await requestAdmin(authorization, credentialsEnv);

    expect(response.status).toBe(401);
  });

  test('Given only one Basic-auth environment value When resolving config Then startup fails closed', () => {
    expect(resolveAdminBasicAuth({ GBRAIN_ADMIN_BASIC_USER: 'review-admin' })).toEqual({
      kind: 'error',
      message: 'GBRAIN_ADMIN_BASIC_USER and GBRAIN_ADMIN_BASIC_PASSWORD must be set together',
    });
  });

  test('Given a public HTTP origin When resolving admin origin Then the exact origin is retained', () => {
    const resolved = resolveAdminOrigin('http://203.0.113.10:3131');

    expect(resolved.kind).toBe('enabled');
    if (resolved.kind === 'enabled') expect(resolved.origin.toString()).toBe('http://203.0.113.10:3131/');
  });

  test('Given an admin origin with a path When resolving admin origin Then startup fails closed', () => {
    expect(resolveAdminOrigin('http://203.0.113.10:3131/admin')).toEqual({
      kind: 'error',
      message: 'GBRAIN_ADMIN_ORIGIN must contain only scheme, host, and optional port',
    });
  });
});
