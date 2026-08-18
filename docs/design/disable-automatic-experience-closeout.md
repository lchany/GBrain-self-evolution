# Disable automatic experience closeout

## Decision

GBrain clients will automate read-only experience recall but will no longer automate end-of-turn experience summarization or persistence. Users retain explicit control through the `gbrain-capture` skill.

## Problem

The current client guard can arm a Closeout Worker after nontrivial prompts, writes, external changes, failures, or session idle. This produces low-value summaries, adds latency before the final response, and can recursively create more worker activity than the underlying task warrants.

Removing only the Codex `Stop` handler would not solve the problem. Closeout context can also enter through `UserPromptSubmit`, `PostToolUse`, OpenCode tool events, OpenCode `session.idle`, and the managed client rules.

## Runtime behavior

### Codex

- Keep the `SessionStart` project guard.
- Keep the experience guard on `UserPromptSubmit` for Recall only.
- Remove GBrain-managed experience handlers from `PostToolUse` and `Stop` during every install or upgrade.
- Never arm or require a Closeout receipt.

### OpenCode

- Keep the first-message project check.
- Keep the message-time experience guard for Recall only.
- Stop forwarding tool completion and tool failure events to the experience guard.
- Stop resuming idle sessions to demand Recall or Closeout receipts.

### Manual capture

The installed `gbrain-capture` skill remains available. A user or agent may invoke it explicitly when information is worth retaining. Manual capture does not depend on an automatic Closeout token.

## Managed client rules

The generated AGENTS rules will:

- retain the independent read-only Recall Worker requirement for nontrivial tasks;
- state that automatic Closeout is disabled;
- direct explicit persistence requests to `gbrain-capture`;
- remove requirements that block final responses on Closeout Worker completion.

## Upgrade behavior

Running `gbrain install-client` or the supported client-repair path rewrites managed rules and removes GBrain-managed `PostToolUse` and `Stop` handlers. Non-GBrain handlers remain untouched. Dormant experience state may expire normally; it must not trigger future Closeout work.

## Verification

Tests must prove that:

1. nontrivial prompts inject Recall but never Closeout;
2. Codex installs only the managed `UserPromptSubmit` experience handler;
3. existing non-GBrain `PostToolUse` and `Stop` handlers survive repair;
4. OpenCode writes, failures, and idle events do not inject or resume Closeout work;
5. managed rules contain no automatic Closeout requirement and retain manual capture guidance;
6. reinstalling upgrades an older client layout to the Recall-only layout.

## Non-goals

- Removing project bootstrap.
- Removing read-only Recall.
- Deleting GBrain pages or inbox drafts.
- Changing GBrain MCP write permissions.
- Automatically deciding that any completed task deserves persistence.
