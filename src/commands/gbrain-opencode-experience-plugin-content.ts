export const GBRAIN_OPENCODE_EXPERIENCE_PLUGIN_FILENAME = 'gbrain-experience-guard.ts';

export const GBRAIN_OPENCODE_EXPERIENCE_PLUGIN = `import { tool } from '@opencode-ai/plugin';

type Review = {
  readonly sessionID: string;
  readonly slug: string;
  readonly directory: string;
  readonly deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const reviewTimeoutMs = (): number => {
  if (process.env.GBRAIN_EXPERIENCE_HOOK_TESTING !== '1') return 5 * 60 * 1000;
  const seconds = Number(process.env.GBRAIN_EXPERIENCE_HOOK_TEST_REVIEW_SECONDS);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 30 ? seconds * 1000 : 5 * 60 * 1000;
};

const resumePrompt = (slug: string): string => (
  'GBRAIN_REVIEW_RESUME: 静默审核期已结束且没有用户回复。现在将刚才锁定的完整正文写入 '
  + slug
  + '，调用 get_page 验证后记录 captured 回执。'
);

export const GBrainExperienceGuard = async ({ client }: { client: { session: { promptAsync(input: { sessionID: string; parts: Array<{ type: 'text'; text: string }> }): Promise<unknown> } } }) => {
  const reviews = new Map<string, Review>();

  const cancel = (sessionID: string): void => {
    const review = reviews.get(sessionID);
    if (!review) return;
    if (review.timer) clearTimeout(review.timer);
    reviews.delete(sessionID);
  };

  const wake = (sessionID: string): void => {
    const review = reviews.get(sessionID);
    if (!review) return;
    reviews.delete(sessionID);
    void client.session.promptAsync({
      sessionID: review.sessionID,
      parts: [{ type: 'text', text: resumePrompt(review.slug) }],
    });
  };

  return {
    tool: {
      gbrain_experience_review_start: tool({
        description: 'Start the GBrain five-minute silent review after displaying a locked inbox draft.',
        args: { slug: tool.schema.string() },
        async execute(args, context) {
          cancel(context.sessionID);
          reviews.set(context.sessionID, {
            sessionID: context.sessionID,
            slug: args.slug,
            directory: context.directory,
            deadline: Date.now() + reviewTimeoutMs(),
            timer: undefined,
          });
          return 'GBrain silent review scheduled.';
        },
      }),
    },
    event: async ({ event }: { event: { type: string; properties: Record<string, unknown> } }) => {
      if (event.type === 'message.updated') {
        const info = event.properties.info;
        if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
          const record = info as Record<string, unknown>;
          if (record.role === 'user' && typeof record.sessionID === 'string') cancel(record.sessionID);
        }
        return;
      }
      if (event.type !== 'session.idle' || typeof event.properties.sessionID !== 'string') return;
      const review = reviews.get(event.properties.sessionID);
      if (!review || review.timer) return;
      review.timer = setTimeout(() => wake(review.sessionID), Math.max(0, review.deadline - Date.now()));
    },
    dispose: async () => {
      for (const review of reviews.values()) if (review.timer) clearTimeout(review.timer);
      reviews.clear();
    },
  };
};
`;
