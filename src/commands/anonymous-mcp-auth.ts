import type { RequestHandler } from 'express';
import type { AuthInfo } from '../core/operations.ts';

/**
 * Preserve firewall-gated anonymous access only for callers that did not
 * present credentials. A supplied Authorization header always takes the
 * normal verifier path; rejection must never downgrade to anonymous access.
 */
export function createAnonymousOrBearerAuthMiddleware(
  anonymousAuthInfo: AuthInfo,
  bearerAuth: RequestHandler,
): RequestHandler {
  return (req, res, next) => {
    if (req.headers.authorization !== undefined) {
      bearerAuth(req, res, next);
      return;
    }
    req.auth = anonymousAuthInfo;
    next();
  };
}
