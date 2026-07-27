# GBrain 客户端规则安装片段

将下方片段追加到对应 AGENTS.md；这是归档副本，已将非 loopback 真实 IP 脱敏为 `<MACHINE_N_IP>`。不要反向还原占位符。

## GBrain Knowledge Rules

GBrain is the default project knowledge and experience system. Use the configured client/MCP server `<server>`; never write real GBrain URLs, IPs, tokens, or secrets into AGENTS files, skills, notes, or drafts.

Experience Vault is retired/legacy for daily agent work. Do not use the old `experience_vault.py event` / `distill` / `archive` lifecycle as the default flow. Only use legacy vault material when the user explicitly asks for it or a project-specific legacy migration requires it.

### Default lookup

For non-trivial work, before planning or executing, query GBrain and classify retrieved records as directly applicable, partially applicable, or not applicable before reusing them. Default lookup excludes `inbox/` so unreviewed drafts do not pollute decisions.

GBrain lookup must use two lanes:

1. Reusable success knowledge: `knowledge/`, `runbooks/`, related `decisions/`, and `projects/`.
2. Failed-attempt / wrong-answer incidents: related `incidents/`, 错题集, and verified-invalid approaches.

Report a short 3-5 line recall summary when it affects the task:

```text
本次 GBrain 召回：
- 可复用：...
- 禁止重犯：...
```

### Error-after lookup

After any command failure, verification failure, repeated failed attempt, invalid solution, SSH/Docker/NPU/CANN/MindSpeed/VERL/profiling/training error, or strategy change, query related GBrain `incidents/` / 错题集 before retrying. Do not keep retrying from the same assumption until the failed-attempt lane has been checked.

### Capture triggers

Use the `gbrain-capture` skill and/or structured CLI when durable knowledge should be recorded:

```bash
gbrain capture --title "<title>" --summary "<scenario-action-result-conclusion-next-rule>" --evidence "<evidence pointer>" --type <knowledge|runbook|decision|project|incident|environment>
gbrain capture retry
```

MUST consider capture when:

- The user gives a durable rule or preference using phrases such as "以后/后续/永远/必须/不要/默认/所有", "remember this", "from now on", "always", "must", or "never".
- A clear architecture, process, configuration, deployment, or tool-choice decision is made.
- A root cause is confirmed and the fix is verified through the real surface.
- A solution or assumption is proven wrong by hard evidence and should become a wrong-answer incident.
- A project milestone or project close is completed.
- The user explicitly says the finding is valuable and should be recorded.

SHOULD consider capture when a reusable workflow is first proven, a runbook emerges, an environment/machine/network/deployment/dataset fact is discovered, a new correct path replaces an old one, or a decision avoids major risk.

NEVER capture idle chat, unsupported guesses, one-off noise, raw transcripts, raw tool output, dense logs, raw JSON, authentication responses, passwords, API keys, tokens, private keys, raw auth files, real personal names, employee IDs, personal account names, or non-anonymized non-loopback IPs/hostnames/machine aliases.

### Inbox-first and writer rules

All new capture goes to `inbox/<slug>` with `status: draft` and `verification: unverified`. The suggested `type` on an inbox draft is only a suggestion; human review decides the final target.

When writing pages directly through MCP, load `gbrain-knowledge-writer`, follow search-before-create, update an existing same-topic page instead of duplicating it, use MCP `put_page`, keep the nine-field frontmatter contract, and put only evidence pointers in `source_refs`.

Do not store raw transcripts or dense command output in GBrain. Store distilled conclusions plus evidence pointers.

### Human review gates

Use `gbrain-review` for inbox review:

```bash
gbrain review list
gbrain review show inbox/<slug>
gbrain review plan inbox/<slug> --action <keep|promote|merge|reject|needs-evidence|repair|cleanup> --target <target-slug> --type <target-type>
gbrain review keep inbox/<slug> --target <target-slug> --type <target-type>
gbrain review promote inbox/<slug> --target <knowledge|runbooks>/<slug> --type <knowledge|runbook> --confirm "PROMOTE <target-slug>"
gbrain review merge inbox/<slug> --target <existing-slug> --type <target-type> --confirm "MERGE <existing-slug>"
gbrain review reject inbox/<slug> --reason "<reason>"
gbrain review needs-evidence inbox/<slug> --reason "<missing evidence>"
gbrain review verify <target-slug>
gbrain review repair inbox/<slug>
gbrain review cleanup inbox/<slug>
```

Promotion to `knowledge/` or general `runbooks/` must be reviewed by a human one item at a time and requires the exact confirmation phrase `PROMOTE <target-slug>`. Agents must not auto-promote or invent the confirmation phrase. If target retrieval verification or review-record writing fails, do not delete the original `inbox/` draft.
