export const GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME = 'gbrain-experience-guard.ts';

export const GBRAIN_OPENCODE_EXPERIENCE_PLUGIN = `import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
type MessagePart = { id?: string; sessionID?: string; messageID?: string; type: string; text?: string; synthetic?: boolean };
type MessageOutput = { message: { id: string; sessionID: string }; parts: MessagePart[] };
type PluginInput = { directory: string };

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

const failedToolOutput = (output: unknown): { failed: boolean; exitCode?: number } => {
  if (!isRecord(output)) return { failed: false };
  const metadata = isRecord(output.metadata) ? output.metadata : {};
  const rawExit = metadata.exit ?? metadata.exitCode ?? output.exit_code;
  const exitCode = typeof rawExit === 'number' ? rawExit : undefined;
  return {
    failed: output.isError === true || output.is_error === true || typeof output.error === 'string'
      || (exitCode !== undefined && exitCode !== 0),
    exitCode,
  };
};

export const GBrainOpenCodeGuard = async ({ directory }: PluginInput) => {
  const projectChecked = new Set<string>();
  const activeTurns = new Map<string, string>();
  const pendingContexts = new Map<string, string>();
  const pendingEvents = new Map<string, Promise<void>>();

  const observeFailure = (sessionID: string, payload: JsonRecord): Promise<void> => {
    if (!EXPERIENCE_ENABLED) return Promise.resolve();
    const turnID = activeTurns.get(sessionID);
    if (!turnID) return Promise.resolve();
    const previous = pendingEvents.get(sessionID) ?? Promise.resolve();
    const current = previous.then(async () => {
      const result = await runHook(experienceScript, {
        session_id: sessionID,
        turn_id: turnID,
        cwd: directory,
        hook_event_name: 'PostToolUse',
        ...payload,
      }, true);
      const context = contextFrom(result);
      if (context) pendingContexts.set(sessionID, context);
    }).finally(() => {
      if (pendingEvents.get(sessionID) === current) pendingEvents.delete(sessionID);
    });
    pendingEvents.set(sessionID, current);
    return current;
  };

  return {
    'chat.message': async (
      input: { sessionID: string; messageID?: string },
      output: MessageOutput,
    ): Promise<void> => {
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
      input: { tool?: string; sessionID?: string; args?: JsonRecord },
      output: unknown,
    ): Promise<void> => {
      if (!input.sessionID) return;
      const status = failedToolOutput(output);
      if (!status.failed) return;
      await observeFailure(input.sessionID, {
        tool_name: input.tool === 'bash' ? 'Bash' : (input.tool ?? 'unknown'),
        tool_input: input.args ?? {},
        tool_response: { is_error: true, ...(status.exitCode === undefined ? {} : { exit_code: status.exitCode }) },
      });
    },
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system?: string[] },
    ): Promise<void> => {
      if (!input.sessionID) return;
      await pendingEvents.get(input.sessionID);
      const context = pendingContexts.get(input.sessionID);
      if (!context) return;
      pendingContexts.delete(input.sessionID);
      if (!Array.isArray(output.system)) output.system = [];
      output.system.push(context);
    },
    event: async ({ event }: { event: { type: string; properties: JsonRecord } }): Promise<void> => {
      if (!EXPERIENCE_ENABLED || event.type !== 'message.part.updated') return;
      const part = event.properties.part;
      if (!isRecord(part) || part.type !== 'tool' || typeof part.sessionID !== 'string') return;
      const state = part.state;
      if (!isRecord(state) || state.status !== 'error') return;
      await observeFailure(part.sessionID, {
        tool_name: typeof part.tool === 'string' ? part.tool : 'unknown',
        tool_input: isRecord(state.input) ? state.input : {},
        tool_response: { is_error: true },
      });
    },
    dispose: async (): Promise<void> => {
      projectChecked.clear();
      activeTurns.clear();
      pendingContexts.clear();
      pendingEvents.clear();
    },
  };
};
`;
