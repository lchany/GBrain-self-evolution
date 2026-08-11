export const GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME = 'gbrain-experience-guard.ts';

export const GBRAIN_OPENCODE_EXPERIENCE_PLUGIN = `import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
type MessagePart = { id?: string; sessionID?: string; messageID?: string; type: string; text?: string; synthetic?: boolean };
type MessageOutput = { message: { id: string; sessionID: string }; parts: MessagePart[] };
type SystemOutput = { system: string[] };
type PromptInput = { path: { id: string }; body: { parts: Array<{ type: 'text'; text: string }> }; query: { directory: string } };
type PluginInput = { directory: string; client: { session: { promptAsync(input: PromptInput): Promise<unknown> } } };

const EXPERIENCE_ENABLED = __EXPERIENCE_ENABLED__;
const pluginDir = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(pluginDir, '..');
const projectScript = join(clientRoot, 'hooks', 'gbrain-project-check.py');
const experienceScript = join(clientRoot, 'hooks', 'gbrain-experience-guard.py');
const experienceStateDir = join(clientRoot, 'gbrain-experience-guard');
const subprocessWarning = 'GBrain OpenCode 守卫执行异常，已 fail-open。';

const isRecord = (value: unknown): value is JsonRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parseResult = (value: string): JsonRecord => {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { systemMessage: subprocessWarning };
  } catch (error) {
    if (error instanceof SyntaxError) return { systemMessage: subprocessWarning };
    throw error;
  }
};

const runHook = async (script: string, payload: JsonRecord, experience: boolean): Promise<JsonRecord> => (
  new Promise((complete) => {
    const child = spawn('python3', [script], {
      env: experience ? {
        ...process.env,
        GBRAIN_EXPERIENCE_HOOK_STATE_DIR: experienceStateDir,
        GBRAIN_EXPERIENCE_HOOK_RECEIPT_ENV: '1',
      } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (result: JsonRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ systemMessage: subprocessWarning });
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length <= 65_536) stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => finish({ systemMessage: subprocessWarning }));
    child.on('close', (code) => {
      if (code !== 0 || stdout.length > 65_536) {
        finish({ systemMessage: subprocessWarning });
        return;
      }
      finish(parseResult(stdout));
    });
    child.stdin.end(JSON.stringify(payload));
  })
);

const contextFrom = (result: JsonRecord): string | undefined => {
  const specific = result.hookSpecificOutput;
  if (isRecord(specific) && typeof specific.additionalContext === 'string') return specific.additionalContext;
  return typeof result.systemMessage === 'string' ? result.systemMessage : undefined;
};

const appendContext = (output: MessageOutput, context: string | undefined): void => {
  if (!context) return;
  const textPart = output.parts.findLast((part) => part.type === 'text' && typeof part.text === 'string');
  if (textPart) {
    textPart.text = (textPart.text ?? '') + String.fromCharCode(10, 10) + context;
    return;
  }
  output.parts.push({ id: 'prt_' + crypto.randomUUID(), sessionID: output.message.sessionID,
    messageID: output.message.id, type: 'text', text: context, synthetic: true });
};

const promptText = (output: MessageOutput): string => output.parts
  .filter((part) => part.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text ?? '')
  .join(String.fromCharCode(10));

const normalizedTool = (tool: string): string => {
  if (tool === 'bash') return 'Bash';
  if (tool === 'edit') return 'Edit';
  if (tool === 'write') return 'Write';
  if (tool === 'task') return 'Agent';
  if (tool === 'gbrain_put_page') return 'mcp__gbrain__put_page';
  if (tool === 'gbrain_get_page') return 'mcp__gbrain__get_page';
  return tool;
};

const normalizedResponse = (output: unknown): JsonRecord => {
  if (!isRecord(output)) return { error: true };
  const metadata = isRecord(output.metadata) ? output.metadata : {};
  const exitCode = typeof metadata.exit === 'number' ? metadata.exit : metadata.exit_code;
  return {
    ...metadata,
    ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
    ...(output.isError === true ? { isError: true } : {}),
    ...(output.error ? { error: true } : {}),
    ...(typeof output.output === 'string' ? { output: output.output } : {}),
  };
};

export const GBrainOpenCodeGuard = async ({ client, directory }: PluginInput) => {
  const projectChecked = new Set<string>();
  const activeTurns = new Map<string, string>();
  const blockedTurns = new Set<string>();
  const pendingContexts = new Map<string, string>();
  const pendingEvents = new Map<string, Promise<void>>();
  const idleChecks = new Map<string, Promise<void>>();

  const recordTool = async (sessionID: string, callID: string, tool: string,
    args: JsonRecord, response: JsonRecord, turnID = activeTurns.get(sessionID) ?? callID): Promise<void> => {
    activeTurns.set(sessionID, turnID);
    const result = await runHook(experienceScript, {
      session_id: sessionID, turn_id: turnID, cwd: directory, hook_event_name: 'PostToolUse',
      tool_name: normalizedTool(tool), tool_use_id: callID, tool_input: args, tool_response: response,
    }, true);
    const context = contextFrom(result);
    if (context) pendingContexts.set(sessionID, context);
  };
  const queueEvent = (sessionID: string, work: () => Promise<void>): Promise<void> => {
    const previous = pendingEvents.get(sessionID) ?? Promise.resolve();
    const pending = previous.then(work, work).catch(() => undefined);
    pendingEvents.set(sessionID, pending);
    void pending.then(() => { if (pendingEvents.get(sessionID) === pending) pendingEvents.delete(sessionID); });
    return pending;
  };

  return {
    'chat.message': async (
      input: { sessionID: string; messageID?: string },
      output: MessageOutput,
    ): Promise<void> => {
      if (EXPERIENCE_ENABLED && blockedTurns.has(input.sessionID)) return;
      const idleCheck = idleChecks.get(input.sessionID);
      if (idleCheck) await idleCheck;
      const originalPrompt = promptText(output);
      if (!projectChecked.has(input.sessionID)) {
        projectChecked.add(input.sessionID);
        const project = await runHook(projectScript, {
          session_id: input.sessionID,
          cwd: directory,
          hook_event_name: 'SessionStart',
          source: 'startup',
        }, false);
        appendContext(output, contextFrom(project));
      }
      if (!EXPERIENCE_ENABLED) return;
      const turnID = input.messageID ?? crypto.randomUUID();
      activeTurns.set(input.sessionID, turnID);
      const experience = await runHook(experienceScript, {
        session_id: input.sessionID,
        turn_id: turnID,
        cwd: directory,
        hook_event_name: 'UserPromptSubmit',
        prompt: originalPrompt,
      }, true);
      appendContext(output, contextFrom(experience));
    },
    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string; args: JsonRecord },
      output: unknown,
    ): Promise<void> => {
      if (!EXPERIENCE_ENABLED) return;
      await recordTool(input.sessionID, input.callID, input.tool, input.args, normalizedResponse(output));
    },
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: SystemOutput,
    ): Promise<void> => {
      if (!input.sessionID) return;
      const pending = pendingEvents.get(input.sessionID);
      if (pending) await pending;
      const context = pendingContexts.get(input.sessionID);
      if (!context) return;
      pendingContexts.delete(input.sessionID);
      output.system.push(context);
    },
    event: async ({ event }: { event: { type: string; properties: JsonRecord } }): Promise<void> => {
      if (!EXPERIENCE_ENABLED) return;
      if (event.type === 'message.part.updated') {
        const part = event.properties.part;
        if (!isRecord(part) || part.type !== 'tool' || typeof part.sessionID !== 'string') return;
        const state = part.state;
        if (!isRecord(state) || state.status !== 'error') return;
        const callID = typeof part.callID === 'string' ? part.callID : crypto.randomUUID();
        const turnID = activeTurns.get(part.sessionID) ?? callID;
        await queueEvent(part.sessionID, () => recordTool(part.sessionID, callID,
          typeof part.tool === 'string' ? part.tool : 'unknown', isRecord(state.input) ? state.input : {},
          { error: true }, turnID));
        return;
      }
      if (event.type !== 'session.idle') return;
      const sessionID = event.properties.sessionID;
      if (typeof sessionID !== 'string') return;
      const pending = pendingEvents.get(sessionID);
      if (pending) await pending;
      if (idleChecks.has(sessionID)) return;
      const turnID = activeTurns.get(sessionID);
      if (!turnID) return;
      const check = (async (): Promise<void> => {
        try {
          const result = await runHook(experienceScript, {
            session_id: sessionID,
            turn_id: turnID,
            cwd: directory,
            hook_event_name: 'Stop',
            stop_hook_active: blockedTurns.has(sessionID),
          }, true);
          if (result.decision === 'block' && typeof result.reason === 'string') {
            blockedTurns.add(sessionID);
            const resumed = await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts: [{ type: 'text', text: result.reason }] },
              query: { directory },
            }).catch(() => ({ error: true }));
            if (!isRecord(resumed) || resumed.error) {
              blockedTurns.delete(sessionID);
              activeTurns.delete(sessionID);
            }
            return;
          }
          blockedTurns.delete(sessionID);
          activeTurns.delete(sessionID);
          pendingContexts.delete(sessionID);
        } finally {
          idleChecks.delete(sessionID);
        }
      })();
      idleChecks.set(sessionID, check);
      await check;
    },
    dispose: async (): Promise<void> => {
      projectChecked.clear();
      activeTurns.clear();
      blockedTurns.clear();
      pendingContexts.clear();
      pendingEvents.clear();
      idleChecks.clear();
    },
  };
};
`;
