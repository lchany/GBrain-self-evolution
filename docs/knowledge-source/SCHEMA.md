# SCHEMA.md: Page Frontmatter Contract

Every page in this repo is a Markdown file with a YAML frontmatter block
delimited by `---` lines. This file defines the required fields. Do not
add speculative fields; this list is the contract.

## Required fields (all page types)

| Field | Values | Meaning |
| --- | --- | --- |
| `type` | `knowledge` \| `project` \| `incident` \| `runbook` \| `decision` \| `environment` \| `agent-skill` \| `legacy` | Page type. Must match the topic path it lives under (see README). Pages in `inbox/` declare their target type, but this is only an agent suggestion until human review. |
| `date` | `YYYY-MM-DD` | Date the page was written or last materially updated. |
| `status` | `draft` \| `reviewed` \| `verified` \| `migrated-legacy` | Lifecycle state. `draft` only in `inbox/`. `migrated-legacy` only under `legacy-migration/`. |
| `sensitivity` | `public` \| `internal` \| `private` | Sharing scope. Default is `internal`. `private` pages must contain no secrets regardless; sensitivity is about audience, not a license to store credentials. |
| `verification` | `unverified` \| `verified` | Whether the claim was tested against its real surface. `verified` status requires `verification: verified`. |
| `applicability` | list of strings | Contexts where this page applies (project ids, platforms, components). Use `all` only when genuinely universal. |
| `non_applicable` | list of strings | Contexts where this page does not apply. Empty list `[]` is allowed. Record known boundaries so future agents do not misapply the lesson. |
| `source_refs` | list of strings | Citations: log paths, doc URLs, commit hashes, session ids, or legacy source paths. At least one entry required. |
| `migrated_from` | string or `null` | Original location for migrated content. `null` for all new pages. Required (non-null) when `status: migrated-legacy`. |

## Field rules per status

- `status: draft` implies `verification: unverified` and path under `inbox/`.
- The `type` value on an `inbox/` draft is only an agent suggestion. It
  is not a confirmed classification until a reviewer approves it.
- `status: reviewed` means classified and normalized; verification may
  still be `unverified`.
- `status: verified` requires `verification: verified`.
- `status: migrated-legacy` requires a non-null `migrated_from` and
  implies `verification: unverified` until the content is re-tested.
- Agents cannot move a draft out of `inbox/` automatically. Promotion to
  `knowledge/` or general `runbooks/` requires explicit human review and
  the confirmation phrase `PROMOTE <target-slug>`.

## Slug rules

- The slug is the page path relative to the repo root, without the `.md`
  extension. Example: `incidents/examples/example-incident`.
- Slugs are lowercase alphanumeric plus hyphens only.
- No underscores, no uppercase, no spaces, no file extension in the slug.
- Directory names and file names both follow the same rule.
- The full slug must be unique within the source.

## Search-before-create rule

Before creating any page, the writer must search GBrain for the topic:

1. Search by likely slug and by keywords from the intended title.
2. If a matching page exists, update that page instead of creating a
   new one. Bump `date`, adjust `status`/`verification` only with
   evidence, and append new `source_refs`.
3. Only create a new page when no existing page covers the topic.
4. New unreviewed pages go to `inbox/` with `status: draft`.

## Query policy

- Default lookup excludes `inbox/`. Searches and retrievals only target
  `knowledge/`, `runbooks/`, `incidents/`, `decisions/`, `projects/`,
  `environments/`, and `agent-skills/`.
- Explicit review or draft mode may include `inbox/`.
- This prevents unverified drafts from being treated as confirmed
  knowledge.

## Templates

Capture templates live in `templates/`:

- `templates/success-case.md`: success case capture.
- `templates/wrong-answer.md`: wrong-answer / 错题集 capture.

Both use the five-section structure: scenario, action, result,
conclusion, next-time-rule.

## Forbidden content (all pages)

- Passwords, tokens, API keys, private keys, raw auth files.
- Real personal names, employee IDs, personal account names.
- Non-loopback IP addresses; use `<SERVER_IP>` style placeholders.
- Raw session logs or dense command output; cite the log path in
  `source_refs` and distill the conclusion into the body.
- No raw transcript storage. Full chat transcripts, full tool output,
  raw JSON, and dense command logs are not allowed anywhere in the
  source.

## Minimal valid page skeleton

```markdown
---
type: knowledge
date: 2026-07-23
status: draft
sensitivity: internal
verification: unverified
applicability:
  - <CONTEXT>
non_applicable: []
source_refs:
  - <EVIDENCE_POINTER>
migrated_from: null
---

# <Title>

Body text.
```
