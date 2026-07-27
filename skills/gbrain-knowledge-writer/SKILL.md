---
name: gbrain-knowledge-writer
description: Write normalized knowledge pages into GBrain via MCP put_page. Use when an agent with a trusted writer client needs to create or update a knowledge, incident, runbook, decision, environment, project, agent-skill, or legacy page in the GBrain knowledge base. Enforces search-before-create, the SCHEMA.md frontmatter contract, status/verification lifecycle, forbidden-content self-check, and merge policy. Not for read-only clients.
triggers:
  - gbrain put_page
  - write knowledge page
  - gbrain knowledge writer
  - update gbrain page
  - 写入知识库
  - gbrain 知识写入
  - mcp put_page
  - knowledge ingestion
---

# GBrain Knowledge Writer

You write pages into the team GBrain knowledge base through MCP
`put_page`. Default clients are READ-ONLY; only run this workflow from a
trusted writer client with write scope.

The canonical contract lives in the knowledge source repo:

- Taxonomy and topic paths: `source/README.md`
- Frontmatter contract: `source/SCHEMA.md`
- Writer rules: `source/AGENTS.md`

Follow this workflow exactly. Do not invent fields, paths, or statuses
beyond the contract.

## 1. SEARCH FIRST

Before creating any page, query GBrain (search/query tools) by likely
slug and by keywords from the intended title.

- A matching page exists: UPDATE that page via `put_page` with the same
  slug. Bump `date`, append new `source_refs`, and only raise
  `status`/`verification` when you have fresh evidence.
- No match: create a new page (see status rules below).

Never fork a duplicate of an existing topic.

## 2. CLASSIFY

Pick exactly one page `type` and its matching path prefix:

| Path | `type` | Contents |
| --- | --- | --- |
| `knowledge/` | `knowledge` | Reusable, verified cross-project lessons. |
| `projects/` | `project` | Project-specific facts: paths, containers, dataset roots. |
| `incidents/` | `incident` | Root-caused failures: symptom, root cause, verified fix. |
| `runbooks/` | `runbook` | Step-by-step procedures actually executed. |
| `decisions/` | `decision` | Architecture/process decisions with rationale. |
| `environments/` | `environment` | Machine, network, platform facts (anonymized). |
| `agent-skills/` | `agent-skill` | Candidate or adopted agent skill notes. |
| `inbox/` | target type | Unreviewed drafts. Nothing here is verified. |
| `legacy-migration/` | `legacy` | One-time migrated content, `status: migrated-legacy`. |

Note: `type` is singular, paths are plural (`type: incident` lives under
`incidents/`).

Capture templates:

- `templates/success-case.md` for success cases.
- `templates/wrong-answer.md` for wrong-answer / 错题集 entries.

Both templates use the same structure: scenario, action, result,
conclusion, next-time-rule.

## 3. WRITE via put_page

Call MCP `put_page` with a normalized Markdown body.

Frontmatter, exactly these 9 fields (no speculative extras):

```yaml
---
type: knowledge            # one of the types above
date: YYYY-MM-DD           # written or last materially updated
status: draft              # draft | reviewed | verified | migrated-legacy
sensitivity: internal      # public | internal | private
verification: unverified   # unverified | verified
applicability:
  - <CONTEXT>
non_applicable: []
source_refs:
  - <EVIDENCE_POINTER>     # log path, doc URL, commit, session id; >= 1 entry
migrated_from: null        # non-null only for migrated-legacy pages
---
```

Slug discipline:

- Slug = path relative to source root, no `.md` extension, e.g.
  `incidents/examples/example-incident`.
- Lowercase alphanumeric plus hyphens only. No underscores, no
  uppercase, no spaces.
- Unique within the source.

Citations: every factual claim in the body must be traceable to a
`source_refs` entry. A page without evidence is a draft at best.

## 4. STATUS RULES

- New or unverified content goes to `inbox/` with `status: draft` and
  `verification: unverified`. `inbox/` drafts are not confirmed
  knowledge.
- The `type` you set on an `inbox/` draft is only a suggestion. Human
  review decides the final target path.
- `status: reviewed` means classified and normalized; verification may
  still be `unverified`.
- `status: verified` requires `verification: verified`: the claim was
  tested against its real surface. Root-cause hypotheses stay
  `unverified`.
- Legacy content stays under `legacy-migration/` with
  `status: migrated-legacy` and non-null `migrated_from`; never promote
  it without fresh tested evidence.
- Never promote a draft from `inbox/` automatically. Promotion to
  `knowledge/` or general `runbooks/` requires explicit human review
  and the confirmation phrase `PROMOTE <target-slug>`.

## 5. FORBIDDEN CONTENT (hard gate)

Never write any of:

- Passwords, API keys, tokens, private keys, raw auth files.
- Dense command logs or raw session output. Distill the conclusion;
  cite the log path in `source_refs`.
- Raw transcripts. Never store full chat logs, full tool output, raw
  JSON, or authentication responses.
- Real personal names, employee IDs, personal account names.
- Non-anonymized internal IPs or hostnames. Use `<SERVER_IP>`,
  `<EXAMPLE_HOST>` style placeholders.

Never move a draft out of `inbox/` without explicit human review.

Self-check before every `put_page`:

1. [ ] No string resembling a key or token (`sk-...`, `AKIA...`,
       `github_pat_...`, `xox...`, `gbrain_...`, long random tokens).
2. [ ] No `password`/`passwd`/`secret`/`token` assignments with real
       values; placeholders only.
3. [ ] No `-----BEGIN ... PRIVATE KEY-----` blocks.
4. [ ] No non-loopback IPv4 addresses except explicitly allowlisted
       infrastructure examples.
5. [ ] No real personal names, IDs, or account names.
6. [ ] Body is distilled prose, not pasted logs (dense `$`/`>`/
       timestamp lines are a red flag).

The server-side secret gate (`gate/scan_secrets.py`) scans every page
body before indexing and rejects violations. Do not try to route around
it; fix the content instead.

## 6. MERGE POLICY

- Near-duplicate exists: update the existing page, and note the merge in
  the page body (one line: what was merged in, from where, and when).
- Slug collision with a different topic: pick a more specific slug
  (append a qualifier, e.g. `-docker`, `-2026q3`) instead of
  overwriting.
- Superseded content: update in place; do not leave parallel `old`,
  `v2`, or `backup` pages.

## 7. AFTER WRITE

- Inspect the `put_page` result and any `auto_links` it returns; fix
  unexpected link targets if they reveal a wrong slug or duplicate.
- Record the source and slug in your session reply so the caller can
  find the page later.
