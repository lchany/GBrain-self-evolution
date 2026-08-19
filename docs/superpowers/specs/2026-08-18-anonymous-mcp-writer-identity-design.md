# Anonymous MCP Writer Identity Repair

## Problem

The production server runs with `--allow-anonymous-mcp` so cloud-firewall-allowed clients can use read/write MCP operations without registering credentials. The current `/mcp` middleware assigns the anonymous identity to every request in this mode, including requests carrying a valid OAuth Bearer token.

The admin review writer intentionally uses an OAuth client bound to a source and calls `whoami` on the same session before writing. Because its bearer identity is overwritten, `whoami` returns no `source_id`; source attestation fails before both single-item and batch review writes.

## Approved Behavior

The `/mcp` identity selection rule is:

1. If the request has no `Authorization` header, use the existing anonymous firewall identity.
2. If the request has an `Authorization` header, run the existing bearer verifier and use the verified identity.
3. If the supplied authorization is malformed, invalid, expired, or insufficient, return the verifier's authentication failure. Never downgrade that request to anonymous.

Anonymous clients remain registration-free. Admin routes, MCP operation scope filtering, source routing, writer credentials, and review `whoami.source_id` attestation remain unchanged.

## Implementation Boundary

Add a small exported middleware selector in a focused command helper and use it from the existing anonymous MCP identity setup in `serve-http.ts`. It chooses between the already-existing anonymous identity and `requireBearerAuth` based only on whether an Authorization header was supplied. Even an empty or malformed supplied header must take the verifier path and fail closed. Mount this selector at `/mcp` when anonymous mode is enabled.

Do not change `whoami`, accept anonymous identity as writer attestation, add a second listener, or expose writer credentials to the browser.

## Security Properties

- Valid bearer credentials gain no scopes beyond their stored grants.
- Invalid credentials cannot exploit anonymous fallback.
- Requests without credentials retain only the existing anonymous read/write surface; admin, agent, source-admin, user-admin, and local-only operations stay excluded.
- Review writes continue to require an attested source on the same writer session.
- Browser and server logs continue to avoid token, secret, stack, and raw error disclosure.

## Verification

Failure-first tests must cover:

- no Authorization header selects the anonymous identity;
- valid Bearer authorization invokes the verifier and preserves its source-bound identity;
- malformed or rejected authorization does not invoke anonymous fallback;
- existing anonymous MCP operation filtering remains unchanged;
- a real review writer session can call `whoami` and receive the configured review source.

After focused tests, typecheck, module-size checks, and build pass, deploy atomically with a rollback backup. Production smoke checks must verify anonymous MCP initialization still succeeds, invalid bearer fails, writer `whoami` returns the expected source, and one explicitly disposable review fixture completes and is cleaned up.
