# GBrain Knowledge Source: Taxonomy and Canonical Layout

This repository is the canonical Markdown source for the team's GBrain
knowledge base. It is staged locally and will be deployed to the GBrain
server in a later step. Every knowledge page that enters GBrain through
MCP `put_page` must conform to the layout defined here and to the
frontmatter contract in [SCHEMA.md](SCHEMA.md).

## Mental model

- A **brain** is one GBrain database. We run exactly one brain.
- A **source** is a named content repo inside a brain. In GBrain v0.18,
  sources are repo-level objects, and slugs are unique per source.

## Design decision: one default source, path-based topic prefixes

We organize all team knowledge inside a single GBrain source named
`default`. Page types are separated by top-level directory prefixes
(topic paths) inside this repo, not by separate GBrain sources.

Rationale:

- Cross-source search is on by default for federated sources, so
  splitting into many sources buys no retrieval isolation, only extra
  routing complexity (`--source`, dotfiles, per-source credentials).
- Topic separation is needed for browsing, migration bookkeeping, and
  writer guidance. Directory prefixes deliver that at zero operational
  cost.
- Slug uniqueness is enforced per source. With one source, a slug like
  `incidents/examples/example-incident` is globally unique and stable.
- If retrieval noise ever proves that a topic pollutes search (for
  example `legacy-migration` drowning out fresh knowledge), the affected
  prefix can be promoted into a real GBrain source later. The path
  layout already matches the target source names, so the split is a
  mechanical move, not a redesign.

Do not create additional GBrain sources without a written decision page
in `decisions/` explaining the retrieval problem that forced the split.

## Topic paths

| Path | Page `type` | Contents |
| --- | --- | --- |
| `knowledge/` | `knowledge` | Reusable, verified lessons and facts that apply across projects. |
| `projects/` | `project` | Project-specific facts: paths, containers, dataset roots, current state. |
| `incidents/` | `incident` | Root-caused failures: symptom, root cause, verified fix. |
| `runbooks/` | `runbook` | Step-by-step operational procedures that were actually executed. |
| `decisions/` | `decision` | Architecture and process decisions with context and rationale. |
| `environments/` | `environment` | Machine, network, and platform facts (anonymized). |
| `agent-skills/` | `agent-skill` | Candidate or adopted agent skill definitions and notes. |
| `inbox/` | any | Drafts awaiting review. Nothing here is verified knowledge. |
| `legacy-migration/` | `legacy` | One-time migrated content from the old Experience Vault / agent-evolutionism flow. Status is always `migrated-legacy` until re-verified. |

## Inbox-first lifecycle

1. All new captures first go to `inbox/` with `status: draft` and
   `verification: unverified`. Nothing under `inbox/` is confirmed
   knowledge until it passes human review.
2. v1 has no lifecycle hooks. Capture and review are driven by explicit
   commands, skills, and AGENTS rules, not by automatic triggers.
3. An agent may pre-classify `type` (for example `type: incident`), but
   this is only a suggestion until human review. The reviewer decides
   the real target path and `type`.
4. A reviewer promotes a page to its topic path with `status: reviewed`
   once the content is classified and normalized.
5. `status: verified` requires `verification: verified`, meaning the fix
   or fact was tested against its real surface, not just hypothesized.
6. Legacy pages live under `legacy-migration/` with
   `status: migrated-legacy`. They are never promoted to verified
   knowledge without fresh evidence.

## Query policy

- Default lookup excludes `inbox/`. Agents and regular searches query
  only `knowledge/`, `runbooks/`, `incidents/`, `decisions/`,
  `projects/`, `environments/`, and `agent-skills/`.
- Explicit review or draft mode includes `inbox/`. Use that mode only
  during `gbrain-review` or when explicitly asked to list pending
  drafts.

This prevents unverified drafts from polluting retrieval results and
being mistaken for confirmed knowledge.

## Templates

Page templates live in [`templates/`](templates/):

- [`templates/success-case.md`](templates/success-case.md): success-case
  capture (场景 / 正确做法 / 结果 / 结论 / 下次规则).
- [`templates/wrong-answer.md`](templates/wrong-answer.md): wrong-answer /
  错题集 capture (场景 / 错误做法 / 失败结果 / 结论 / 下次规则).

Both templates use the same five-section structure. The `type` field on
an `inbox/` draft is only a suggestion; the reviewer picks the final
path.

## MCP Contract

GBrain exposes an MCP capability layer. MCP is **passive**:

- MCP provides `gbrain_*` tools for search, query, `put_page`,
  `get_page`, `list_pages`, and `delete_page`.
- MCP does **not** actively capture, review, promote, or decide what is
  worth knowing.
- MCP does **not** store raw transcripts or dense logs.
- MCP validates frontmatter, slugs, and forbidden content, but it does
  not perform human review.

Tool design follows the `mcp-builder` contract:

- New tools use the `gbrain_` prefix (for example `gbrain_search`,
  `gbrain_put_page`).
- Every tool has an explicit input schema.
- List and search tools support pagination with `limit`, `offset` or
  cursor, and return `has_more`, `next_offset`/`next_cursor`, and
  `total_count`.
- Tools return structured output.
- Errors are actionable and include a suggested next step.
- Tools declare MCP annotations where applicable:
  `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`.

## Hard rules

- Search before create. Always query GBrain for an existing page on the
  topic before writing a new one; update the existing page instead of
  forking duplicates.
- Inbox first. All new captures start in `inbox/` with `status: draft`
  and `verification: unverified`.
- No automatic promotion. Agents cannot promote a page from `inbox/`
  into `knowledge/` or general `runbooks/` without human review.
- Promote requires explicit human confirmation phrase:
  `PROMOTE <target-slug>`.
- No raw transcript storage. Never store full chat logs, full tool
  output, raw JSON, authentication responses, or dense logs. Distill
  the conclusion and cite the path in `source_refs`.
- No secrets. Never store passwords, tokens, API keys, private keys, raw
  auth files, or dense logs.
- Anonymize. No real personal names, employee IDs, or non-loopback IP
  addresses. Use placeholder forms such as `<SERVER_IP>` or
  `<EXAMPLE_HOST>`.
- Cite sources. Every page carries `source_refs` pointing at the
  evidence (log path, doc URL, commit, session id) it was distilled
  from.

See [AGENTS.md](AGENTS.md) for the writer-facing summary,
[SCHEMA.md](SCHEMA.md) for the full frontmatter contract, and
[`templates/`](templates/) for capture templates.
