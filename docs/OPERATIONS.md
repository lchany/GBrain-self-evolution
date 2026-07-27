# GBrain Operations Runbook

## Scope and source of record

The canonical content record is the Git working tree at
`/opt/gbrain-knowledge/source` on the server. Markdown written successfully by
the GBrain write-through path is the recoverable content plane; reviewed pages
are additionally protected by the repository's reviewed Git history. Do not
use a deprecated archival workflow as a restore source.

Task-12 inventory found the repository to be a Git worktree. It had 10 tracked
Markdown files and additional working-tree Markdown at the time of the check,
so an isolated recovery validation must use `sync --full` rather than depend on
an incremental Git checkpoint.

## Configuration and service inventory

| Area | Location or unit | Operational note |
| --- | --- | --- |
| GBrain home | `/root/.gbrain/` | `config.json` contains `engine`, `database_url`, and `schema_pack`. Database URL values are never copied into evidence or backups. |
| HTTP service config | `/etc/gbrain/gbrain-serve.env` | Root-readable only. Inventory only key names. |
| Scheduled-job config | `/etc/gbrain/gbrain-maintenance.env` | Root-readable only. |
| Web UI config | `/etc/gbrain/webui.env` | Root-readable only. |
| OAuth client configs | `/etc/gbrain/clients/*.env` | Root-readable only. Inventory only client file names and scopes. |
| HTTP MCP | `gbrain-serve-http.service` | Enabled and active; serves the protected MCP endpoint. |
| Read-only Web UI | `gbrain-webui.service` | Enabled and active. |
| Network allowlist | Cloud-provider firewall/security group | Sole source-IP access boundary for ports 3131/3132; not configured or restored on the host. |
| Incremental sync | `gbrain-sync.service` and `gbrain-sync.timer` | Timer enabled and active; service is oneshot. |
| Doctor capture | `gbrain-doctor.service` and `gbrain-doctor.timer` | Timer enabled and active; service is oneshot. |

The production Postgres database name and role are obtained only from the
`database_url` configuration key and are intentionally not reproduced here.
The current server uses PostgreSQL 15 with pgvector. The bootstrap role must
have `SUPERUSER` and `BYPASSRLS` while GBrain initializes its schema; the
task-12 staging initialization applied schema version 1 through 124.

## Network access boundary

Source-IP filtering for GBrain is managed exclusively by the cloud-provider
firewall/security group. Do not create GBrain-specific host `iptables`,
`nftables`, or `firewalld` rules, scripts, or systemd units. The host services
bind ports 3131/3132 as configured; the cloud firewall decides which source IPs
can reach them, while OAuth/bearer credentials and Web UI authentication remain
the application-level authorization boundary.

During deployment or recovery, verify the cloud firewall separately from the
server. Cloud firewall configuration is intentionally absent from host backups
and must not be reconstructed from historical host-firewall evidence.

## Root-only operational backup

The task-12 backup bundle is at:

```text
/opt/gbrain-backup/20260723/
```

The directory is mode `0700`; every bundle file is mode `0600`. It contains:

- copies of all installed `gbrain-*` unit files;
- a source-repository reference and Git state metadata;
- GBrain config file paths and key names only;
- environment key-name inventories, including Web UI configuration keys;
- client names, scopes, and rotation procedure only;
- Postgres/pgvector and migration-ledger metadata without database URL values;
- a secret-assignment scan result.

It deliberately excludes canonical Markdown, database URL values, passwords,
client IDs, client secrets, bearer tokens, and token plaintext. Recover
Markdown from the canonical source, not from this operations bundle.

## Credential rotation

1. Register a replacement OAuth client with the minimum required scope.
2. Store the new credentials only in a new mode-`0600` root-owned file under
   `/etc/gbrain/clients/`; never copy their values into a runbook, backup, or
   evidence file.
3. Mint a short-lived token via `client_credentials` and run the appropriate
   read-only or write-capable smoke test.
4. Switch the consuming service or local client configuration, then repeat the
   smoke test with the replacement client.
5. Revoke the superseded client/token through GBrain administration and remove
   the old root-readable credential file after the replacement is verified.
6. Record only the client name, scope, rotation date, and revocation result.

Token plaintext is never backed up.

## Backup and recovery objectives

- **Content RPO:** the latest Markdown that completed write-through to
  `/opt/gbrain-knowledge/source`. For reviewed content, the stronger recovery
  point is the latest reviewed Git commit.
- **DB-only RPO:** none. A page that exists only in Postgres is lost during a
  database rebuild unless it is exported/reconciled into the canonical source
  before the rebuild.
- **RTO (operational estimate):** after the OS, PostgreSQL/pgvector, GBrain,
  repo, and root-only configuration are present, task 12 observed a 91-file
  full import in about five seconds. Package installation, host hardening, and
  credential rotation dominate a from-scratch recovery and must be planned as
  minutes, not seconds.

Optional database dumps preserve non-source operational history, but are not a
substitute for the source rebuild path. Create and protect any dump outside
the source repository, for example with the configured database administrator:

```bash
sudo -u postgres pg_dump --format=custom --file /secure/backup/gbrain.dump <configured-db>
```

The dump path and retention policy are deployment decisions; never place a
database URL or password in the command history or this runbook.

## Restore from scratch

1. Prepare the supported OS, install PostgreSQL 15, initialize and start it,
   then install the pgvector extension compatible with that PostgreSQL build.
2. Create the dedicated database role and database. Before the first GBrain
   bootstrap, grant the role `SUPERUSER` and `BYPASSRLS`; retain only the least
   privilege that the installed GBrain schema requires afterward.
3. Restore the GBrain source and executable (`/opt/gbrain` and
   `/usr/local/bin/gbrain`) at the reviewed deployment revision.
4. Restore the canonical repository to `/opt/gbrain-knowledge/source` from its
   reviewed Git history. Do not alter taxonomy content during recovery.
5. Restore root-owned config files from secure secret storage, not from this
   backup bundle. Recreate `/root/.gbrain/config.json` with the configured
   engine, database URL, and schema pack.
6. Initialize and migrate GBrain against the intended Postgres database, then
   run a full no-embed import:

   ```bash
   gbrain sync --repo /opt/gbrain-knowledge/source --full --no-pull --no-embed --yes
   gbrain stats
   ```

7. Restore unit files from `/opt/gbrain-backup/20260723/units/`, restore the
   root-only environment files from secure secret storage, run
   `systemctl daemon-reload`, and enable the required HTTP, Web UI, and timer
   units according to the inventory above. Do not restore any historical
   `gbrain-firewall` unit or host rules. Validate on loopback, then verify that
   the cloud firewall permits only the intended source IPs.
8. Rotate OAuth clients rather than restoring their previous plaintext. Follow
   the credential-rotation procedure above and validate each scope.
9. Run the three source-rebuild search checks below and retain redacted
   evidence before declaring recovery complete.

## Isolated rebuild procedure

Use this procedure for a recovery rehearsal. It never targets the production
database, production `GBRAIN_HOME`, or production services.

1. Choose a previously unused temporary database and home, such as
   `gbrain_staging_task12` and `/root/gbrain-task12-stage`.
2. Derive a staging-only database URL by replacing only the database component
   of the configured URL. Keep that URL in process memory; do not print or
   persist it.
3. Create the temporary database with the already-authorized bootstrap role.
4. Initialize with the production schema-pack value and deferred embeddings:

   ```bash
   GBRAIN_HOME=/root/gbrain-task12-stage \
   GBRAIN_DATABASE_URL=<staging-url-not-printed> \
     gbrain init --non-interactive --no-embedding --schema-pack <configured-pack> --json
   ```

5. Rebuild from canonical Markdown, not from a database export:

   ```bash
   GBRAIN_HOME=/root/gbrain-task12-stage \
   GBRAIN_DATABASE_URL=<staging-url-not-printed> \
     gbrain sync --repo /opt/gbrain-knowledge/source --full --no-pull --no-embed --yes
   ```

6. Confirm `gbrain stats` and search at least these source pages in the
   staging environment:

   ```text
   legacy-migration/examples/example-migrated-legacy
   legacy-migration/incidents-2026-06-16-verl-jpeg-q90-reward-drift-root-cause-c3f3f3d3ca
   legacy-migration/knowledge-2026-06-16-use-dedicated-workspace-for-verl-lazy-transport-changes-4aaba5d06b
   ```

7. Compare staging and production `gbrain stats`. Counts need not be equal:
   task 12's full source scan imported 91 Markdown pages while production had
   76 visible pages. The acceptance criterion is that known reviewed pages are
   recovered and searchable; investigate any unexpected count change before a
   production restore.
8. Before teardown, confirm production stats, source-worktree state, and the
   four protected runtime states (HTTP service, Web UI service, sync timer,
   doctor timer) are unchanged. Drop the temporary database and remove the
   temporary home, then verify both are absent.

## Failure boundaries and operating rules

- `put_page` write-through writes Markdown but does **not** make a Git commit.
  Commit only reviewed pages according to the review policy.
- The scheduled incremental sync uses the Git checkpoint and can miss
  non-Git-visible filesystem changes. Use a controlled `--full` sync for a
  deliberate source reconciliation; do not add `--full` to the periodic timer
  without reviewing the ingestion consequence.
- If write-through fails, DB-only drafts are the exact data at risk during a
  database rebuild. Export or reconcile them into the canonical source before
  destructive database work.
- A full import may include Markdown that is present in the source but not
  currently visible in production. Treat source hygiene and page-count
  differences as an operational review item, not as permission to overwrite
  production.
- Do not stop, restart, reconfigure, or point staging commands at
  `gbrain-serve-http`, `gbrain-webui`, `gbrain-sync.timer`,
  `gbrain-doctor.timer`, or the production database during a rehearsal.
- Agent-instruction activation and rollback are separate from service restore.
  For that controlled cutover, use
  `/mnt/disk2t/l30002999/gbrain-knowledge/cutover/ACTIVATE.md`.
