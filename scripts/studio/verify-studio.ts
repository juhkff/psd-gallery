/**
 * Browser-level verification of the local studio.
 *
 *   npx tsx scripts/studio/verify-studio.ts
 *
 * Drives the real page in headless Chrome: drop a PSD -> it appears as a draft
 * with a preview -> press 发布 -> the file lands in works/<date>/<n>.psd and is
 * committed. It also asserts the guards the API alone cannot prove are wired
 * into the UI (a fake .psd is rejected and surfaced).
 *
 * SAFETY: the publish step runs against a throwaway bare repository, so this
 * test can never push to GitHub. It restores your `origin` afterwards and prints
 * the exact command to undo its local commit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.STUDIO_VERIFY_PORT ?? 4181);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DATE = process.env.STUDIO_VERIFY_DATE ?? '2098-12-31';
const SAMPLE_PSD = path.join(ROOT, 'works', '2026-09-24', '1.psd');

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`);
}

const git = (args: string[], cwd = ROOT) =>
  spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.env.LFS_BIN_DIR ?? '/home/ubuntu/projects/.gocache/bin'}:${process.env.PATH ?? ''}`,
      GIT_ASKPASS: process.env.GIT_ASKPASS ?? '/home/ubuntu/projects/.gocache/askpass.sh',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

/** Set a file on the page's <input type=file> (typed helper). */
async function uploadViaUi(page: import('puppeteer-core').Page, file: string): Promise<void> {
  const input = await page.$('#file');
  if (!input) throw new Error('#file input missing');
  await (input as unknown as { uploadFile: (target: string) => Promise<void> }).uploadFile(file);
}

function startStudio(): { child: ReturnType<typeof spawn>; token: Promise<string> } {
  const child = spawn('npx', ['tsx', 'scripts/studio/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, STUDIO_PORT: String(PORT) },
  });
  const token = new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('studio did not print a token in 30s')), 30_000);
    const onData = (chunk: Buffer) => {
      buffer += String(chunk);
      const match = /token=([0-9a-f]{16,})/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
  return { child, token };
}

const WATCHDOG_MS = Number(process.env.STUDIO_VERIFY_TIMEOUT_MS ?? 300_000);

/** Hard stop: a hung verification must not sit there forever. */
function armWatchdog(): NodeJS.Timeout {
  return setTimeout(() => {
    console.error(`\n  watchdog: verification exceeded ${WATCHDOG_MS} ms - aborting`);
    process.exit(2);
  }, WATCHDOG_MS);
}

async function main(): Promise<void> {
  if (!fs.existsSync(SAMPLE_PSD)) {
    console.error(`sample PSD missing: ${SAMPLE_PSD} (run \`npm run samples\`)`);
    process.exit(1);
  }

  // SAFETY PREFLIGHT. This test publishes into the real repository, so cleanup
  // removes its own commit with a hard reset. That can only ever be safe on a
  // clean tree, and it must reset to the pre-test HEAD (not origin/main) or it
  // would also discard local commits ahead of origin - which is exactly how a
  // full unreleased redesign was destroyed once. Refuse anything but clean.
  const dirty = git(['status', '--porcelain']).stdout.trim();
  if (dirty !== '') {
    console.error(
      [
        '',
        '  REFUSING TO RUN: the working tree has uncommitted changes and cleanup',
        '  ends with `git reset --hard origin/main`, which would delete them.',
        '',
        ...dirty.split('\n').slice(0, 20).map((line) => `    ${line}`),
        dirty.split('\n').length > 20 ? `    … and ${dirty.split('\n').length - 20} more` : '',
        '',
        '  Commit or stash first, then re-run.',
        '',
      ].filter((line) => line !== undefined).join('\n'),
    );
    process.exit(3);
  }

  // 1. throwaway remote so 发布 cannot touch GitHub
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bare-'));
  git(['init', '--bare', '--quiet', bare]);
  const originalRemote = git(['remote', 'get-url', 'origin']).stdout.trim();
  const headBefore = git(['rev-parse', 'HEAD']).stdout.trim();
  git(['remote', 'set-url', 'origin', bare]);
  // Belt-and-braces: the watchdog and any hard exit skip the `finally` block,
  // and a verifier killed that way once left the real repo pointing at a
  // now-deleted /tmp bare repo. This handler runs even for process.exit().
  const restoreOrigin = () => { try { git(['remote', 'set-url', 'origin', originalRemote]); } catch { /* best effort */ } };
  process.on('exit', restoreOrigin);
  process.on('SIGINT', () => { restoreOrigin(); process.exit(130); });
  process.on('SIGTERM', () => { restoreOrigin(); process.exit(143); });
  console.log(`  (publish target: temp bare repo ${bare}, origin restored afterwards)\n`);

  const watchdog = armWatchdog();
  const { child, token } = startStudio();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let page: import('puppeteer-core').Page | undefined;

  try {
    const studioToken = await token;
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      protocolTimeout: 300_000,
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${BASE}/?token=${studioToken}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(
      () => document.getElementById('work-count') !== null && document.getElementById('date') !== null,
      { timeout: 20_000, polling: 100 },
    );

    const startWorks = Number(await page.$eval('#work-count', (el) => el.textContent));
    check('page loads and reports the archived works', startWorks >= 3, `${startWorks} archived works`);

    // 2. upload a real PSD through the actual <input type=file>
    await page.$eval('#date', (el, date) => { (el as HTMLInputElement).value = date; }, TEST_DATE);
    await uploadViaUi(page, SAMPLE_PSD);
    await page.waitForFunction(
      () => (document.getElementById('log')?.textContent ?? '').includes('.incoming'),
      { timeout: 60_000, polling: 250 },
    );
    const logAfterUpload = await page.$eval('#log', (el) => el.textContent ?? '');
    check('uploaded PSD becomes a draft (not a published work)', /\.incoming/.test(logAfterUpload), logAfterUpload.split('\n')[0]);

    // the draft list must show it, and the archived count must be unchanged
    await page.waitForFunction(
      () => Number(document.getElementById('draft-count')?.textContent ?? '0') > 0,
      { timeout: 30_000, polling: 250 },
    );
    const midWorks = Number(await page.$eval('#work-count', (el) => el.textContent));
    check('archived works unchanged while it is still a draft', midWorks === startWorks, `${midWorks} works`);
    const draftText = await page.$eval('#drafts', (el) => el.textContent ?? '');
    check('draft list shows the pending file', draftText.includes(TEST_DATE), draftText.replace(/\s+/g, ' ').slice(0, 120));

    // 3. a fake .psd must be rejected by the magic-byte guard, via the UI
    const fake = path.join(os.tmpdir(), `fake-${Date.now()}.psd`);
    fs.writeFileSync(fake, Buffer.from('this is definitely not a photoshop file'));
    await uploadViaUi(page, fake);
    await page.waitForFunction(
      () => /8BPS/.test(document.getElementById('log')?.textContent ?? ''),
      { timeout: 30_000, polling: 250 },
    );
    const logAfterFake = await page.$eval('#log', (el) => el.textContent ?? '');
    check('fake .psd rejected in the UI', /8BPS/.test(logAfterFake), 'rejection surfaced in 日志');
    fs.rmSync(fake, { force: true });

    // 4. publish. Assert on real effects (file on disk, commit, push) rather
    // than on log text - a UI string is a presentation detail, the filesystem
    // is the contract.
    page.on('dialog', (dialog) => void dialog.accept());
    // The 发布 button stays disabled while an upload/rebuild is busy - clicking a
    // disabled button silently does nothing, so wait for it to become actionable
    // instead of racing the background poll.
    try {
      await page.waitForFunction(
        () => {
          const button = document.getElementById('publish') as HTMLButtonElement | null;
          return !!button && !button.disabled;
        },
        { timeout: 120_000, polling: 300 },
      );
    } catch {
      const dump = await page.evaluate(() => ({
        disabled: (document.getElementById('publish') as HTMLButtonElement | null)?.disabled,
        drafts: document.getElementById('draft-count')?.textContent,
        works: document.getElementById('work-count')?.textContent,
        log: (document.getElementById('log')?.textContent ?? '').slice(0, 200),
      }));
      throw new Error(`发布 button never became enabled: ${JSON.stringify(dump)}`);
    }
    await page.click('#publish');
    const publishedDir = path.join(ROOT, 'works', TEST_DATE);
    // The file appears at the *move* step; commit and push happen after it, so
    // wait for the publish call to report completion before asserting.
    // publish() logs a "git push — …" step and then "✅ 已发布 …"; the upload
    // path logs "✅ 预览已就绪…". Match on plain substrings only — no regex, so
    // nothing has to survive string-escaping into the browser context.
    await page
      .waitForFunction(
        () => {
          const text = document.getElementById('log')?.textContent ?? '';
          return text.indexOf('git add') !== -1 || text.indexOf('git push') !== -1;
        },
        { timeout: 300_000, polling: 500 },
      )
      .catch(() => undefined);
    const published = fs.existsSync(publishedDir)
      ? fs.readdirSync(publishedDir).filter((name) => name.endsWith('.psd'))
      : [];

    check('published PSD landed in works/<date>/<n>.psd', published.length === 1 && /^\d+\.psd$/.test(published[0] ?? ''), published.join(', ') || '(none)');
    if (published[0]) {
      const bytes = fs.readFileSync(path.join(publishedDir, published[0]));
      check('published file is a real PSD (8BPS)', bytes.subarray(0, 4).toString('ascii') === '8BPS', `${(bytes.length / 1024 / 1024).toFixed(1)} MiB`);
    }
    check('drafts are gone after publish', !fs.existsSync(path.join(ROOT, 'works', '.incoming', TEST_DATE)), 'incoming date folder removed');

    const logAfterPublish = await page.$eval('#log', (el) => el.textContent ?? '');
    check('publish surfaced git push in the log', /git push/.test(logAfterPublish) && !/❌/.test(logAfterPublish), logAfterPublish.split('\n').slice(-1)[0] ?? '');

    const commit = git(['log', '--oneline', '-1']).stdout.trim();
    check('a release commit was created', /发布/.test(commit), commit);
    const bareHead = git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']).stdout.trim();
    const localHead = git(['rev-parse', 'HEAD']).stdout.trim();
    check('temp remote received the commit', bareHead !== '' && bareHead === localHead, bareHead.slice(0, 12));
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');
  } finally {
    clearTimeout(watchdog);
    await browser?.close();
    child.kill('SIGTERM');
    child.unref();
    git(['remote', 'set-url', 'origin', originalRemote]);
    fs.rmSync(bare, { recursive: true, force: true });

    // leave the repo exactly as we found it (unless --keep was passed)
    if (!process.argv.includes('--keep')) {
      // Restore the commit we started from - NOT origin/main. Resetting to
      // origin/main silently discards every local commit ahead of origin: this
      // test publishes into the real repo, so the earlier `reset --hard
      // origin/main` destroyed a full redesign commit that had not been pushed
      // yet. `headBefore` is the only value that means "exactly as we found it".
      const reset = git(['reset', '--hard', '--quiet', headBefore]);
      fs.rmSync(path.join(ROOT, 'works', TEST_DATE), { recursive: true, force: true });
      fs.rmSync(path.join(ROOT, 'works', '.incoming'), { recursive: true, force: true });
      if (reset.status === 0) console.log(`\n  (restored the repo to the pre-test HEAD ${headBefore.slice(0, 12)})`);
    }
  }

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length === 0) {
    console.log(`\n  The repo was restored to the pre-test HEAD ${headBefore.slice(0, 12)} (pass --keep to inspect the test commit).`);
    process.exit(0);
  } else {
    for (const item of failed) console.error(`  FAILED: ${item.name} — ${item.detail}`);
    console.error(`\n  Undo the test commit with: git reset --hard ${headBefore.slice(0, 12)}`);
    process.exit(1);
  }
}

await main();
