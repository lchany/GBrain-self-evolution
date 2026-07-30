# GBrain project identity TDD evidence

Implementation follows
`2026-07-30-gbrain-project-identity-design.md`.

## RED

Checkpoint: `fb81fef test: pin project identity contracts`

Command:

```bash
bun test \
  test/project-context.test.ts \
  test/gbrain-capture.test.ts \
  test/put-page-validation.test.ts \
  test/gbrain-client-installer.test.ts
```

Observed failures before production changes:

- `project-context.ts` did not exist.
- capture Markdown omitted `project_binding`, `project_id`, and `record_kind`.
- malformed project IDs were accepted.
- `put_page` accepted cross-project paths and unbound project drafts.
- installed client rules and skills did not describe project detection or binding.

A second RED pass pinned CLI initialization/binding, review path isolation,
global-promotion provenance, and server-side registry existence.

## GREEN

Targeted command:

```bash
bun test \
  test/project-context.test.ts \
  test/gbrain-project.test.ts \
  test/gbrain-capture.test.ts \
  test/put-page-validation.test.ts \
  test/review-core.test.ts \
  test/gbrain-client-installer.test.ts \
  test/mcp-discovery.test.ts
```

The targeted suite passes after implementation. `bun run typecheck` also
passes. Full repository verification is recorded in the delivery summary.
