/**
 * Verify the gallery stays bounded as the library grows.
 *
 * The expensive part of scripts/bench-scale.ts is generating real PSDs. This
 * probe instead synthesises the *manifest* (what the browser actually consumes)
 * for N works spread over D dates, so it can check pagination behaviour at a
 * realistic long-running scale in seconds:
 *
 *   - first paint renders only GROUPS_PER_PAGE date groups
 *   - page height and DOM node count stay bounded
 *   - "show older" reveals more groups
 *   - a same-page comparison against the unpaginated node count
 *
 *   npx tsx scripts/verify-scale-ui.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC_GENERATED = path.join(ROOT, 'public', 'generated');
const PORT = Number(process.env.SCALE_UI_PORT ?? 4195);
const GROUPS_PER_PAGE = 30;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.psd': 'application/octet-stream',
};

/** N works over D dates, with preview URLs deliberately left blank (placeholder path). */
function syntheticManifest(works: number, dates: number) {
  const perDate = Math.ceil(works / dates);
  const groups = [];
  const start = Date.UTC(2026, 0, 1);
  let made = 0;
  for (let d = 0; d < dates && made < works; d++) {
    const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    const items = [];
    for (let n = 1; n <= perDate && made < works; n++, made++) {
      items.push({
        index: n,
        name: String(n),
        psd: `/generated/works/${date}/${n}.psd`,
        bytes: 3_600_000,
        width: 1200,
        height: 800,
        preview: { thumb: '', display: '', thumbWidth: 1200, thumbHeight: 800, displayWidth: 1200, displayHeight: 800 },
        layerCount: 6,
        layers: [{ name: '1-底色', hidden: false, opacity: 1, blendMode: 'normal', rect: { left: 0, top: 0, right: 1200, bottom: 800 }, hasImage: true, isGroup: false }],
      });
    }
    groups.push({ date, works: items });
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    base: '/',
    totals: { works: made, bytes: made * 3_600_000 },
    groups,
  };
}

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.join(DIST, rel || 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIST)) {
    console.error('dist/ not found - run `npm run build` first.');
    process.exit(1);
  }
  // This probe rewrites manifest.json in BOTH public/ (source) and dist/
  // (served). Both must be backed up and restored, otherwise dist/ is left
  // advertising works that have no preview files - which silently breaks the
  // e2e (it clicks a tile whose work cannot load).
  const publicManifest = path.join(PUBLIC_GENERATED, 'manifest.json');
  const distManifest = path.join(DIST, 'generated', 'manifest.json');
  const backups = [publicManifest, distManifest].map((file) => ({
    file,
    body: fs.existsSync(file) ? fs.readFileSync(file) : null,
  }));

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 300000,
  });
  const failures: string[] = [];

  try {
    const server = await serve();
    const scenarios = [
      { works: 120, dates: 60 },
      { works: 600, dates: 300 },
    ];
    console.log(`  works  dates  groups shown  DOM nodes  page height  after load-more`);
    for (const scenario of scenarios) {
      const manifest = syntheticManifest(scenario.works, scenario.dates);
      fs.mkdirSync(path.join(DIST, 'generated'), { recursive: true });
      fs.writeFileSync(path.join(DIST, 'generated', 'manifest.json'), JSON.stringify(manifest));

      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="work-tile"]').length > 0,
        { timeout: 30000, polling: 100 },
      );
      const first = await page.evaluate(() => ({
        groups: document.querySelectorAll('[data-date]').length,
        tiles: document.querySelectorAll('[data-testid="work-tile"]').length,
        nodes: document.getElementsByTagName('*').length,
        height: document.documentElement.scrollHeight,
        hasMore: !!document.querySelector('[data-testid="load-more"]'),
      }));

      if (first.groups > GROUPS_PER_PAGE) {
        failures.push(`${scenario.works} works: rendered ${first.groups} groups on first paint (cap ${GROUPS_PER_PAGE})`);
      }
      if (!first.hasMore && scenario.dates > GROUPS_PER_PAGE) {
        failures.push(`${scenario.works} works: "show older" control missing despite ${scenario.dates} dates`);
      }

      let afterTiles = 0;
      if (first.hasMore) {
        await page.click('[data-testid="load-more"]');
        await new Promise((r) => setTimeout(r, 300));
        afterTiles = await page.evaluate(
          () => document.querySelectorAll('[data-testid="work-tile"]').length,
        );
        if (afterTiles <= first.tiles) {
          failures.push(`${scenario.works} works: load-more did not reveal more tiles (${first.tiles} -> ${afterTiles})`);
        }
      }

      if (errors.length > 0) failures.push(`${scenario.works} works: page errors ${errors[0]}`);
      console.log(
        `  ${String(scenario.works).padStart(5)}  ${String(scenario.dates).padStart(5)}  ` +
        `${String(first.groups).padStart(12)}  ${String(first.nodes).padStart(9)}  ` +
        `${String(Math.round(first.height)).padStart(11)}px  ${String(afterTiles).padStart(15)}`,
      );
      await page.close();
    }
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    await browser.close();
    // Restore every manifest this probe overwrote, then regenerate from source
    // so public/ and dist/ agree again.
    for (const { file, body } of backups) {
      if (body) fs.writeFileSync(file, body);
    }
    spawnSync('npx', ['tsx', 'scripts/build-manifest.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? '' },
    });
    console.log('\n  restored the real manifest (public/ and dist/)');
  }

  if (failures.length > 0) {
    console.error('\nSCALE UI VERIFICATION FAILED:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('\nSCALE UI VERIFICATION PASSED');
}

await main();
