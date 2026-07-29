# Experience Vault to GBrain Cutover Design

## Outcome

GBrain becomes the only active experience system. The legacy Markdown vault is
frozen after one final GitHub archival commit, remains available locally for a
seven-day observation period, and is deleted only after a separate human
decision. The GitHub repository remains as inactive historical evidence.

Future agents read and write experience through the existing MCP connection.
They do not invoke the legacy vault script or depend on a local GBrain CLI.

## Source Baseline

The migration baseline is the final validated working tree of the legacy
repository, not merely its pre-existing `HEAD`.

Before migration:

1. Confirm the remote default branch and local `HEAD` agree.
2. Validate the legacy vault.
3. Review tracked and untracked changes.
4. Scan candidate files for credentials, private authentication material, raw
   logs, non-loopback addresses, personal identifiers, and environment-bound
   configuration.
5. Create a selective final archival commit. Do not use a blanket staging
   command.
6. Push the archival commit and record its SHA.

The final archival commit is the source of truth for migration reconciliation.

## Migration Scope

Import these legacy content families:

- `projects/`
- `incidents/`
- `knowledge/`
- `runbooks/`

Import pending share candidates as GBrain `inbox/` drafts.

Do not import:

- the legacy vault implementation;
- legacy skills or skill candidates;
- templates, tests, indexes, or restore documents;
- raw reference configurations or operational scripts;
- the legacy system's own project-memory file.

These excluded assets remain available in the inactive GitHub archive.

## Page Mapping

All migrated history stays in the current GBrain source. No source-level or
query-prefix isolation is added.

Core records use:

- slug prefix: `legacy-migration/`;
- original page type when it is one of the supported experience types;
- status: `migrated-legacy`;
- verification: `unverified`;
- sensitivity: `internal`;
- applicability: `legacy-migration`;
- a sanitized legacy relative path in `migrated_from`;
- the final archival commit and sanitized source pointer in `source_refs`.

Pending share candidates use `inbox/`, status `draft`, and verification
`unverified`. Migration never promotes them.

## Reconciliation

The final active legacy set must correspond one-to-one with the final archival
snapshot.

Reconcile with deterministic identities:

1. Exact source path and exact content hash: reuse the existing page.
2. Exact source path and changed content hash: update the existing page.
3. Changed path and exact content hash: create the final-path page and
   soft-delete the old-path page.
4. Source file absent from the final snapshot: soft-delete the stale page.
5. Different path and different content: create a new page. Never merge by
   fuzzy title.

The operation must be idempotent. A repeated run against the same archival
commit produces no additional active pages.

## Redaction

The GitHub archive preserves the validated source. GBrain receives a derived,
automatically redacted copy.

Redaction is deterministic and covers at least:

- credentials, bearer material, tokens, passwords, and private-key blocks;
- non-loopback IPv4 and IPv6 addresses;
- personal, organization, account, employee, project, machine, container, and
  dataset identifiers detected by the legacy policy or migration rules;
- sensitive absolute paths and concrete endpoint bindings;
- dense raw logs and raw tool output, which are summarized rather than copied.

The page records redaction categories and counts, never the original values. It
also records the source content SHA-256 for integrity. If the derived page still
fails GBrain's server-side validation, the migration stops and reports the
record; it never bypasses validation.

## Reference Conversion

Resolve legacy record references against the final migration inventory.

- A reference to an imported record becomes a GBrain page link.
- A reference absent from the final inventory becomes a sanitized GitHub
  archive evidence pointer.
- Similar titles are not treated as proof of identity.

The migration report records resolved and unresolved reference counts.

## Client Cutover

Cutover begins by disabling the old read path:

1. Move the installed legacy experience skill to a disabled location without
   deleting it.
2. Remove the legacy Experience Vault block from the global agent rules.
3. Update project-memory instructions so long-term experience uses GBrain.
4. Keep the legacy repository itself unchanged during the observation period.

The active GBrain client workflow is MCP-native:

- retrieval: `search`, `query`, and `get_page`;
- capture: search before creation, then `put_page` to `inbox/`;
- review inspection: `list_pages` and `get_page`;
- promotion: the authenticated admin review interface.

The local installed skills and the project's `install-client` templates must
both describe this workflow. Anonymous MCP clients never promote drafts.

If migration fails, the legacy skill remains disabled. The legacy repository is
retained, stale GBrain pages are not deleted, and the migration can resume
idempotently.

## Execution and Verification

Run an automated representative batch before the full migration. Human review
of redacted samples is not required, but every sample must pass server
validation and round-trip verification.

Completion requires:

- the final GitHub archival commit is pushed;
- every in-scope source record has exactly one active GBrain page;
- pending candidates exist as drafts;
- every written page reads back with the expected slug, type, status, source
  hash, and sanitized provenance;
- stale pre-snapshot pages are soft-deleted only after all new pages verify;
- converted references resolve or are reported as sanitized archive pointers;
- retrieval probes return representative project, incident, knowledge, and
  runbook records;
- a new MCP-native inbox capture writes and reads back successfully;
- the legacy skill and rules no longer trigger local vault access.

The permanent report contains counts, the final archival commit, redaction
category totals, reference-resolution totals, and verification results. The
temporary manifest containing original local paths is deleted after successful
verification.

## Observation and Deletion

Successful cutover starts a seven-day observation period. No unattended
deletion job is installed.

After seven days, a human rechecks retrieval and migration completeness, then
decides whether to delete the exact local legacy repository and disabled skill
paths. The GitHub archive is retained.
