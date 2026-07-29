import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chromium, type Page } from 'playwright';

const BASE_URL = 'http://127.0.0.1:4173';
const EVIDENCE_DIR = '/home/l30002999/source_code/gbrain/.omo/evidence/gbrain-review-ui-chinese-redesign/task-9-visual-qa';

const VIEWPORTS = [
  { width: 375, height: 667, name: 'mobile' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 1280, height: 800, name: 'desktop' },
] as const;

const ROUTES = [
  { path: '/admin/review', name: 'list' },
  { path: '/admin/review/detail/inbox%2Flist-item-1', name: 'detail' },
  { path: '/admin/review/plan/inbox%2Flist-item-1?action=keep&target_type=incident&target=incidents%2Flist-item-1-very-long-slug-to-test-wrapping-behavior-on-mobile-and-tablet-viewports', name: 'preflight' },
  { path: '/admin/review/history', name: 'history' },
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function waitForExit(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return once(process, 'exit').then(() => undefined);
}

async function stopFixtureServer(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = waitForExit(process);
  process.kill('SIGTERM');
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Fixture server did not stop after SIGTERM.')), 5000);
  });
  try {
    await Promise.race([exited, timeout]);
  } catch (error) {
    process.kill('SIGKILL');
    await exited;
    throw error;
  }
}

async function startFixtureServer(): Promise<ChildProcessWithoutNullStreams> {
  const fixtureProcess = spawn('bun', ['run', 'test/support/review-fixture-server.ts'], {
    env: { ...process.env, PORT: '4173' },
    stdio: 'pipe',
  });
  fixtureProcess.stdout.on('data', (chunk) => process.stdout.write(chunk));
  fixtureProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        reject(new Error(`Fixture server did not report readiness: ${output}`));
      }, 5000);
      const finish = (callback: () => void) => {
        clearTimeout(timeout);
        fixtureProcess.stdout.off('data', onData);
        fixtureProcess.off('error', onError);
        fixtureProcess.off('exit', onExit);
        callback();
      };
      const onData = (chunk: Uint8Array) => {
        output += new TextDecoder().decode(chunk);
        if (output.includes('Fixture server listening')) finish(resolve);
      };
      const onError = (error: Error) => finish(() => reject(error));
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(() => reject(new Error(`Fixture server exited before readiness: code=${code} signal=${signal}`)));
      };
      fixtureProcess.stdout.on('data', onData);
      fixtureProcess.once('error', onError);
      fixtureProcess.once('exit', onExit);
    });
    return fixtureProcess;
  } catch (error) {
    await stopFixtureServer(fixtureProcess);
    throw error;
  }
}

async function waitForVisibleHeading(page: Page): Promise<void> {
  await page.locator('h1').waitFor({ state: 'visible', timeout: 5000 });
}

async function navigate(page: Page, path: string): Promise<void> {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await waitForVisibleHeading(page);
}

async function assertReadableMobileTable(page: Page, routeName: string): Promise<void> {
  const metrics = await page.locator('table.review-table').evaluateAll((tables) => tables.map((table) => ({
    scrollWidth: table.scrollWidth,
    clientWidth: table.clientWidth,
    rows: [...table.querySelectorAll('tbody tr')].map((row) => ({
      display: getComputedStyle(row).display,
      labels: [...row.querySelectorAll('td[data-label]')].length,
    })),
  })));
  if (metrics.length === 0) fail(`${routeName} has no review table at 375px.`);
  for (const table of metrics) {
    if (table.scrollWidth > table.clientWidth + 1) fail(`${routeName} table overflows horizontally at 375px.`);
    for (const row of table.rows) {
      if (row.labels > 0 && row.display !== 'block') fail(`${routeName} data row is not stacked at 375px.`);
    }
  }
}

async function focusByTab(page: Page, selector: string, label: string): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab');
    const focusState = await page.locator(selector).evaluateAll((elements) => elements.map((element) => ({
      focused: document.activeElement === element,
      outlineStyle: getComputedStyle(element).outlineStyle,
      outlineWidth: Number.parseFloat(getComputedStyle(element).outlineWidth),
    })).find((state) => state.focused));
    if (focusState !== undefined) {
      if (focusState.outlineStyle === 'none' || focusState.outlineWidth === 0) {
        fail(`Keyboard focus on ${label} has no visible focus indicator.`);
      }
      return;
    }
  }
  fail(`Keyboard focus did not reach ${label}.`);
}

async function verifyKeyboardFlows(page: Page): Promise<void> {
  await navigate(page, '/admin/review/detail/inbox%2Flist-item-1');
  await focusByTab(page, '[data-action="needs_evidence"]', 'the needs-evidence decision card');
  await page.screenshot({ path: join(EVIDENCE_DIR, 'keyboard-focus.png'), fullPage: true });
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);
  await focusByTab(page, 'textarea[name="reviewNotes"]', 'the review-notes field');
  await page.keyboard.type('需要补充可复核证据。');
  await focusByTab(page, 'button[type="submit"]', 'the notes preflight submit control');
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);
  await focusByTab(page, 'textarea[name="reviewNotes"]', 'the confirmation review-notes field');
  await page.keyboard.type('需要补充可复核证据。');
  await focusByTab(page, 'button[type="submit"]', 'the notes confirmation submit control');
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);

  await navigate(page, '/admin/review/detail/inbox%2Flist-item-1');
  await focusByTab(page, '[data-action="promote"]', 'the promote decision card');
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);
  await focusByTab(page, 'select[name="target_type"]', 'the target selector');
  await page.keyboard.press('i');
  await focusByTab(page, 'button[type="submit"]', 'the target selector submit control');
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);
  await focusByTab(page, 'button[type="submit"]', 'the suggested target submit control');
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);
  await focusByTab(page, 'input[name="confirmation"]', 'the confirmation input');
  await page.keyboard.type('PROMOTE incidents/list-item-1');
  await focusByTab(page, 'button[type="submit"]', 'the confirmation submit control');
  await page.keyboard.press('Enter');
  await waitForVisibleHeading(page);
}

async function run(): Promise<void> {
  if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });

  let fixture: ChildProcessWithoutNullStreams | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    console.log('Starting fixture server...');
    fixture = await startFixtureServer();
    console.log('Fixture server is ready.');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-test-session': 'test-session' } });
    const page = await context.newPage();

    for (const route of ROUTES) {
      for (const viewport of VIEWPORTS) {
        console.log(`Capturing ${route.name} at ${viewport.name} (${viewport.width}px)...`);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await navigate(page, route.path);
        if (viewport.name === 'mobile' && (route.name === 'list' || route.name === 'history')) {
          await assertReadableMobileTable(page, route.name);
        }
        const screenshotPath = join(EVIDENCE_DIR, `${route.name}-${viewport.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Saved screenshot to ${screenshotPath}`);
      }
    }

    console.log('Checking keyboard action, target, notes, confirmation, and submit paths...');
    await page.setViewportSize({ width: 1280, height: 800 });
    await verifyKeyboardFlows(page);
    await context.close();
  } finally {
    if (browser !== undefined) await browser.close();
    if (fixture !== undefined) {
      console.log('Stopping fixture server...');
      await stopFixtureServer(fixture);
      console.log('Fixture server stopped.');
    }
  }
}

void run().catch((error: unknown) => {
  console.error('Visual QA failed:', error);
  process.exitCode = 1;
});
