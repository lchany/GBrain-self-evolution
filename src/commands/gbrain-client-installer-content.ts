export const GBRAIN_RULES_BLOCK_START = '<!-- GBRAIN_CLIENT_RULES_START -->';
export const GBRAIN_RULES_BLOCK_END = '<!-- GBRAIN_CLIENT_RULES_END -->';

export const GBRAIN_CLIENT_RULES = `${GBRAIN_RULES_BLOCK_START}
# GBrain client rules

- Before non-trivial work, query GBrain for reusable knowledge/runbooks and known incidents; classify results as directly applicable, partially applicable, or not applicable.
- Use \`gbrain capture --title ... --type ... --summary ... --evidence ...\` for durable findings. Automatic or semi-automatic capture writes only \`inbox/\` drafts.
- Never write raw transcripts, dense logs, bearer tokens, client secrets, passwords, private keys, personal identifiers, or unredacted non-loopback IPs to GBrain.
- Use \`gbrain review\` for human review. Promotion to \`knowledge/\` or general \`runbooks/\` requires the exact confirmation phrase \`PROMOTE <target-slug>\`.
- Do not add lifecycle hooks for GBrain capture or review. The workflow is explicit command/skill driven.
- Local credentials live only in \`~/.config/gbrain/local-read.env\` and \`~/.config/gbrain/local-writer.env\` with mode 600. Do not copy their values into config, prompts, logs, or evidence.

Suggested skills: \`gbrain-capture\`, \`gbrain-review\`.
${GBRAIN_RULES_BLOCK_END}
`;

export const GBRAIN_CAPTURE_SKILL = `---
name: gbrain-capture
description: Capture verified durable findings into GBrain inbox drafts. Use after durable rules, verified root causes, reusable procedures, project milestones, or explicit user requests to record knowledge.
---

# GBrain Capture

Use \`gbrain capture --title <title> --type <knowledge|runbook|incident|decision|project|environment|agent-skill> --summary <summary> --evidence <pointer>\`.

Rules:

- Search GBrain first when the current task is non-trivial or follows a failure.
- Capture only distilled conclusions plus evidence pointers.
- Capture writes \`inbox/\` drafts only; do not target final \`knowledge/\`, \`runbooks/\`, or \`incidents/\` paths.
- Do not capture raw transcripts, dense logs, secrets, private keys, credentials, personal identifiers, or unredacted non-loopback IPs.
- If writer credentials are unavailable, keep the offline queue receipt and retry with \`gbrain capture retry\` after credentials are restored.
`;

export const GBRAIN_REVIEW_SKILL = `---
name: gbrain-review
description: Review GBrain inbox drafts and promote, keep, merge, repair, or reject them with explicit human confirmation.
---

# GBrain Review

Use \`gbrain review list\`, \`gbrain review show <inbox/slug>\`, \`gbrain review plan ...\`, and \`gbrain review promote ...\`.

Rules:

- Review starts from \`inbox/\` drafts.
- Do not promote automatically.
- Promotion to \`knowledge/\` or general \`runbooks/\` requires the exact confirmation phrase \`PROMOTE <target-slug>\` from the human operator.
- Reject or mark needs-evidence with a reason.
- Keep evidence pointers, not raw logs or secrets.
`;
