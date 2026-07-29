export const GBRAIN_RULES_BLOCK_START = '<!-- GBRAIN_CLIENT_RULES_START -->';
export const GBRAIN_RULES_BLOCK_END = '<!-- GBRAIN_CLIENT_RULES_END -->';

export const GBRAIN_CLIENT_RULES = `${GBRAIN_RULES_BLOCK_START}
# GBrain client rules

- Before non-trivial work, query GBrain for reusable knowledge/runbooks and known incidents; classify results as directly applicable, partially applicable, or not applicable.
- For durable findings, search first and use the connected GBrain MCP \`put_page\` operation to create an \`inbox/\` draft.
- Never write raw transcripts, dense logs, bearer tokens, client secrets, passwords, private keys, personal identifiers, or unredacted non-loopback IPs to GBrain.
- Inspect drafts with the connected GBrain MCP \`list_pages\` and \`get_page\` operations. Promotion is performed only through the authenticated admin review interface.
- Do not add lifecycle hooks for GBrain capture or review. The workflow is explicit command/skill driven.
- Client network access is controlled by the cloud firewall allowlist; this installer does not create or distribute credentials.

Suggested skills: \`gbrain-capture\`, \`gbrain-review\`.
${GBRAIN_RULES_BLOCK_END}
`;

export const GBRAIN_CAPTURE_SKILL = `---
name: gbrain-capture
description: Capture verified durable findings into GBrain inbox drafts. Use after durable rules, verified root causes, reusable procedures, project milestones, or explicit user requests to record knowledge.
---

# GBrain Capture

Use the connected GBrain MCP operations. Search before creating a draft, then call
\`put_page\` with an \`inbox/<slug>\` slug and complete draft frontmatter.

Rules:

- Search GBrain first when the current task is non-trivial or follows a failure.
- Capture only distilled conclusions plus evidence pointers.
- Capture writes \`inbox/\` drafts only; do not target final \`knowledge/\`, \`runbooks/\`, or \`incidents/\` paths.
- Do not capture raw transcripts, dense logs, secrets, private keys, credentials, personal identifiers, or unredacted non-loopback IPs.
- Do not install a local GBrain CLI, create a local queue, or request client credentials as a fallback.
`;

export const GBRAIN_REVIEW_SKILL = `---
name: gbrain-review
description: Review GBrain inbox drafts and promote, keep, merge, repair, or reject them with explicit human confirmation.
---

# GBrain Review

Use the connected GBrain MCP \`list_pages\` and \`get_page\` operations to inspect
\`inbox/\` drafts. Promotion happens only in the authenticated admin review interface.

Rules:

- Review starts from \`inbox/\` drafts.
- Do not promote automatically.
- Anonymous MCP clients do not promote drafts.
- Reject or mark needs-evidence with a reason.
- Keep evidence pointers, not raw logs or secrets.
`;
