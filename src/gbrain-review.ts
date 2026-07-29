#!/usr/bin/env bun

import { runGbrainReview } from './commands/gbrain-review.ts';

const exitCode = await runGbrainReview(process.argv.slice(2));
process.exit(exitCode);
