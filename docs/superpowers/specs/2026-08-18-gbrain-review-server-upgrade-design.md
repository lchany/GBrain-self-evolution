# GBrain review server upgrade design

## Objective

Upgrade the review server from `0.42.64.0` to the official `v0.46.18.0` release while preserving the existing review UI and writer fixes. The deployment must leave the current source tree intact and provide a tested rollback path.

## Current state

Systemd runs `/usr/local/bin/gbrain` as the `gbrain` service user. The binary does not include the writer credential and loopback routing changes present in `/opt/gbrain`.

The `/opt/gbrain` worktree contains nine modified files. Those changes add the review UI, route server-side review writes through the loopback MCP endpoint, and load writer credentials through systemd. The worktree has no commit that can be merged as one unit.

## Upgrade strategy

The upgrade uses an isolated build tree:

1. Export the nine-file customization as a patch and record its checksum.
2. Create a separate build directory from the official `v0.46.18.0` tag.
3. Apply the patch there and resolve conflicts against the new release.
4. Review the resulting diff against both the original customization and upstream behavior.
5. Run focused tests, type checks, and the project build before creating a candidate binary.

The process does not reset, stash, rebase, or modify `/opt/gbrain`.

## Compatibility work

The integration must preserve these contracts:

- The service reads `gbrain-local-writer.env` from systemd's credentials directory.
- The review writer connects to `http://127.0.0.1:<port>/mcp` unless an explicit loopback writer URL overrides it.
- Writer startup verifies the MCP URL and source identity before any write.
- Browser responses keep generic error text. The server journal records a redacted error code and operation stage.
- Review routes keep admin authentication, same-origin checks, input validation, and browser-safe rendering.

Upstream behavior wins when the new release implements an equivalent contract with stricter validation or better isolation. The integration retains custom code only where upstream lacks the required behavior or UI.

## Verification

The candidate must pass these gates before production replacement:

- Review route and deployment tests.
- Type checking and the build command defined by `package.json`.
- Binary version check for `0.46.18.0`.
- Static confirmation that the candidate includes systemd credential discovery and the loopback writer URL option.
- Side-port health check on a loopback-only listener.
- Authenticated MCP initialization, `get_brain_identity`, and one read operation.
- Review preflight through the admin route.
- One controlled review write against a temporary diagnostic draft, followed by verification and cleanup through supported operations.

The side process must use a separate port and must not bind to a public interface.

## Deployment and rollback

Before replacement, copy the production binary to a timestamped backup in a root-owned directory and record SHA-256 checksums for both binaries.

Deployment uses these steps:

1. Install the candidate at a temporary path on the same filesystem as `/usr/local/bin/gbrain`.
2. Set the production owner and mode on the temporary file.
3. Rename the temporary file over the production path.
4. Restart `gbrain-serve-http.service`.
5. Verify service state, version, health, review authentication, writer initialization, and journal output.

If restart or verification fails, rename the backup over the production path, restart the service, and repeat the health check. The source worktree remains available for investigation in either outcome.

## Security boundary

The deployment must not print or copy credentials into build logs, patches, design files, or shell history. Tests may report token presence, scopes, and expiry without reporting token values.

The current service binds to a public interface, serves cleartext HTTP, and allows anonymous MCP writes. This upgrade will report those risks but will not change network policy without separate authorization. The review fix must retain admin authentication and same-origin enforcement.

## Completion criteria

The task completes when production reports `0.46.18.0`, the review confirmation flow succeeds, the journal records redacted failures, and the rollback binary remains available with a checksum. The final handoff will list the deployed checksum, backup path, test results, and unresolved security risks.
