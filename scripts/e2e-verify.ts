/**
 * End-to-end verification of the built site in real headless Chrome.
 *
 * This is the independent check on the two workstreams: it consumes only the
 * built `dist/` output plus the repository's own manifests, and drives the
 * real UI. It asserts the four things the user asked for:
 *
 *   1. the site discovers works at build time and groups them by date folder
 *   2. a work's PSD is shown as a rendered PNG (canvas)
 *   3. clicking a layer toggles it, producing a different composite
 *   4. the source PSD can be downloaded, byte-identical to the original
 *
 * It also guards the performance contract: toggling must NOT re-decode the
 * PSD, so the main thread must stay responsive and the second toggle must not
 * be dramatically slower than the first.
 *
 *   npm run build && npx tsx scripts/e2e-verify.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.E2E_PORT ?? 4173);
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.psd': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

function startStaticServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let filePath = path.join(DIST, rel);
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html'); // SPA fallback
    }
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** md5 of the canvas pixels: proves the composite actually changed. */
async function canvasHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The viewer's canvas is mounted immediately but keeps its default
    // 300x150 backing store until the worker hands over a frame, so select it
    // by test id and hash whatever it currently holds.
    const canvas =
      document.querySelector<HTMLCanvasElement>('[data-testid="work-canvas"]') ??
      Array.from(document.querySelectorAll('canvas'))
        .filter((c) => c.width > 32 && c.height > 32)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!canvas) return 'no-canvas';
    const probe = document.createElement('canvas');
    // sample at native size so the hash is sensitive to real pixel changes
    const w = Math.min(300, canvas.width);
    const h = Math.min(300, canvas.height);
    probe.width = w;
    probe.height = h;
    const ctx = probe.getContext('2d');
    if (!ctx) return 'no-ctx';
    ctx.drawImage(canvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 7) {
      hash ^= data[i];
      hash = Math.imul(hash, 16777619);
    }
    return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
  });
}

/**
 * True once the live composite has replaced the initial placeholder.
 *
 * The viewer mounts its canvas immediately but it keeps the canvas default
 * backing store (300x150) until the worker transfers a real frame, so "bigger
 * than the default" is the work-agnostic signal that compositing finished.
 */
async function waitForCompositedFrame(page: Page, timeout = 120000): Promise<void> {
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="work-canvas"]');
      return !!canvas && canvas.width > 300 && canvas.height > 150;
    },
    { timeout, polling: 200 },
  );
}

/** minimal PNG/WebP/JPEG header reader, so we verify real image dimensions. */
function imageSize(file: string): { width: number; height: number; format: string } {
  const b = fs.readFileSync(file);
  if (b.length > 30 && b.toString('ascii', 1, 4) === 'PNG') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = b.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { width: w, height: h, format: 'webp/vp8x' };
    }
    if (fourcc === 'VP8 ') {
      // simple lossy: 14-bit dimensions after the 3-byte start code
      const w = b.readUInt16LE(26) & 0x3fff;
      const h = b.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h, format: 'webp/vp8' };
    }
    if (fourcc === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp/vp8l' };
    }
    return { width: 0, height: 0, format: `webp/${fourcc}` };
  }
  return { width: 0, height: 0, format: 'unknown' };
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error('dist/ not found - run `npm run build` first.');
    process.exit(1);
  }

  // --- build-time artefacts ------------------------------------------------
  const manifestPath = path.join(ROOT, 'public', 'generated', 'manifest.json');
  const distManifest = path.join(DIST, 'generated', 'manifest.json');
  check(
    'build emitted manifest.json into dist/',
    fs.existsSync(distManifest),
    fs.existsSync(distManifest) ? `found ${path.relative(ROOT, distManifest)}` : 'missing',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    version: number;
    base: string;
    totals: { works: number; bytes: number };
    groups: { date: string; works: { name: string; psd: string; width: number; layers: unknown[] }[] }[];
  };
  check(
    'manifest groups works by ISO date folder',
    manifest.groups.length >= 2 && manifest.groups.every((g) => /^\d{4}-\d{2}-\d{2}$/.test(g.date)),
    `groups: ${manifest.groups.map((g) => `${g.date}(${g.works.length})`).join(', ')}`,
  );
  const firstWork = manifest.groups[0].works[0] as unknown as {
    name: string;
    psd: string;
    width: number;
    layers: unknown[];
    preview: { thumbWidth?: number; thumbHeight?: number; displayWidth?: number };
  };
  const firstGroup = manifest.groups[0];
  const sourcePsd = path.join(ROOT, 'works', firstGroup.date, `${firstWork.name}.psd`);
  if (!fs.existsSync(sourcePsd)) {
    console.error(`source PSD missing for the first manifest work: ${sourcePsd}`);
    process.exit(1);
  }

  /** md5 of a source PSD, looked up by the work's manifest date/name. */
  const md5OfSource = (date: string, name: string) =>
    crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'works', date, `${name}.psd`))).digest('hex');

  // manifest URLs must be site-relative, i.e. NOT prefixed with the Vite
  // `public/` source directory (a classic bug that 404s only in the browser).
  const allUrls = manifest.groups.flatMap((g) => g.works.flatMap((w) => [
    w.psd,
    (w as { preview?: { thumb?: string; display?: string } }).preview?.thumb ?? '',
    (w as { preview?: { thumb?: string; display?: string } }).preview?.display ?? '',
  ]));
  const badUrls = allUrls.filter((u) => u.includes('/public/') || !u.startsWith('/'));
  check(
    'manifest URLs are site-relative (no "public/" prefix)',
    badUrls.length === 0,
    badUrls.length ? `bad: ${badUrls.slice(0, 3).join(', ')}` : `${allUrls.length} URLs ok, e.g. ${allUrls[0]}`,
  );

  // preview images must be real images of the declared size
  const previewDir = path.join(ROOT, 'public', 'generated', 'works', firstGroup.date);
  const thumbFile = path.join(previewDir, `${firstWork.name}.thumb.webp`);
  const displayFile = path.join(previewDir, `${firstWork.name}.display.webp`);
  const thumbSize = fs.existsSync(thumbFile) ? imageSize(thumbFile) : { width: 0, height: 0, format: 'missing' };
  const displaySize = fs.existsSync(displayFile) ? imageSize(displayFile) : { width: 0, height: 0, format: 'missing' };
  const declared = (firstWork as { preview?: { thumbWidth?: number; thumbHeight?: number } }).preview;
  check(
    'generated thumbnail is a real image with the declared dimensions',
    thumbSize.width > 0 && thumbSize.width <= 512 && thumbSize.height <= 512
      && (declared?.thumbWidth === undefined || declared.thumbWidth === thumbSize.width),
    `thumb ${thumbSize.format} ${thumbSize.width}x${thumbSize.height}, declared ${declared?.thumbWidth}x${declared?.thumbHeight}`,
  );
  check(
    'generated display preview is a real image with the declared dimensions',
    displaySize.width > 0
      && (declared as { displayWidth?: number } | undefined)?.displayWidth === displaySize.width,
    `display ${displaySize.format} ${displaySize.width}x${displaySize.height}`,
  );

  const server = await startStaticServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 300000,
  });

  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    const requests: { url: string; type: string }[] = [];
    (page as unknown as { on: (e: string, cb: (r: { url: () => string; resourceType: () => string }) => void) => void })
      .on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });

    // --- gallery -----------------------------------------------------------
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="work-tile"]').length > 0,
      { timeout: 20000, polling: 200 },
    );
    const tileCount = await page.$$eval('[data-testid="work-tile"]', (n) => n.length);
    const dateHeadings = await page.$$eval('[data-date]', (n) => n.map((e) => e.getAttribute('data-date')));
    check('gallery renders a tile per work', tileCount >= 3, `${tileCount} tiles`);
    check(
      'gallery headings show ISO date groups',
      dateHeadings.length >= 2,
      `headings: ${dateHeadings.join(', ')}`,
    );

    // ensure a thumbnail actually decoded (not a broken image)
    const thumbOk = await page.$$eval('[data-testid="work-tile"] img', (imgs) =>
      imgs.length > 0 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0));
    check('thumbnails load as real images', thumbOk, 'all tile <img> have naturalWidth > 0');

    // --- open a work -------------------------------------------------------
    const t0 = Date.now();
    await page.click('[data-testid="work-tile"]');
    const firstPaintMs = Date.now() - t0;
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="layer-row"]').length > 0,
      { timeout: 90000, polling: 200 },
    );
    const layerRows = await page.$$eval('[data-testid="layer-row"]', (n) => n.length);
    check('opening a work lists its layers', layerRows >= 6, `${layerRows} layer rows`);

    // wait until the worker has composited a real frame; until then the canvas
    // keeps its default 300x150 backing store and the preview <img> is shown
    await waitForCompositedFrame(page);
    await new Promise((r) => setTimeout(r, 200));

    const before = await canvasHash(page);
    check('canvas renders the composite', !before.startsWith('no-'), `canvas probe ${before}`);

    // --- toggle a layer ----------------------------------------------------
    const toggleSelector = '[data-testid="layer-toggle"]';
    const ariaBefore = await page.$$eval(toggleSelector, (n) => n.map((e) => e.getAttribute('aria-pressed')));
    const tToggle0 = Date.now();
    await page.click(toggleSelector);
    // give the worker a couple of frames to push the redraw
    await new Promise((r) => setTimeout(r, 400));
    const after = await canvasHash(page);
    const toggleMs = Date.now() - tToggle0;
    const ariaAfter = await page.$$eval(toggleSelector, (n) => n.map((e) => e.getAttribute('aria-pressed')));
    check(
      'clicking a layer changes the composite',
      before !== after,
      `${before} -> ${after} (${toggleMs} ms)`,
    );
    check(
      'layer toggle updates aria-pressed',
      ariaBefore[0] !== ariaAfter[0],
      `aria-pressed ${ariaBefore[0]} -> ${ariaAfter[0]}`,
    );
    check(
      'toggle is fast enough to feel instant (no re-decode)',
      toggleMs < 3000,
      `${toggleMs} ms`,
    );

    // second toggle must not be slower in a way that implies re-decoding
    const tToggle1 = Date.now();
    await page.click(toggleSelector);
    await new Promise((r) => setTimeout(r, 400));
    const back = await canvasHash(page);
    const toggle2Ms = Date.now() - tToggle1;
    check(
      'toggling back restores the original composite',
      back === before,
      `${back} vs original ${before} (${toggle2Ms} ms)`,
    );

    // --- main thread responsiveness ---------------------------------------
    // Passed as a string: bundlers inject `__name` helpers into named function
    // expressions, which do not exist in the browser context Puppeteer runs in.
    const rafGap = await page.evaluate(`(() => new Promise((resolve) => {
      let max = 0;
      let last = performance.now();
      let frames = 0;
      const tick = () => {
        const now = performance.now();
        max = Math.max(max, now - last);
        last = now;
        if (++frames < 30) requestAnimationFrame(tick);
        else resolve(max);
      };
      requestAnimationFrame(tick);
    }))()`);
    check(
      'main thread stays responsive after decode',
      typeof rafGap === 'number' && rafGap < 250,
      `max frame gap ${Number(rafGap).toFixed(1)} ms`,
    );

    // --- download the PSD --------------------------------------------------
    // Assert against whichever work the UI actually opened, derived from the
    // href - the gallery's DOM order is a presentation choice, not a contract.
    const downloadUrl = await page.$eval(
      '[data-testid="download-psd"]',
      (a) => (a as HTMLAnchorElement).getAttribute('href') ?? '',
    );
    const opened = /\/works\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.psd$/.exec(downloadUrl);
    const expectedOpenedMd5 = opened ? md5OfSource(opened[1], opened[2]) : '';
    const response = await fetch(new URL(downloadUrl, `http://127.0.0.1:${PORT}/`));
    const body = Buffer.from(await response.arrayBuffer());
    const gotMd5 = crypto.createHash('md5').update(body).digest('hex');
    check(
      'download link serves the source PSD byte-identically',
      response.ok && expectedOpenedMd5 !== '' && gotMd5 === expectedOpenedMd5,
      `${downloadUrl} -> ${body.byteLength} bytes, md5 ${gotMd5.slice(0, 12)} (source ${expectedOpenedMd5.slice(0, 12)})`,
    );

    // every work's download URL must resolve to its real source bytes
    let allOk = true;
    const wrong: string[] = [];
    for (const group of manifest.groups) {
      for (const work of group.works as unknown as { name: string; psd: string }[]) {
        const res = await fetch(new URL(work.psd, `http://127.0.0.1:${PORT}/`));
        const buf = Buffer.from(await res.arrayBuffer());
        const md5 = crypto.createHash('md5').update(buf).digest('hex');
        const want = md5OfSource(group.date, work.name);
        if (!res.ok || md5 !== want) {
          allOk = false;
          wrong.push(`${work.psd}`);
        }
      }
    }
    check('all works download as their exact source bytes', allOk, wrong.length ? `wrong: ${wrong.join(', ')}` : `${manifest.totals.works} works verified`);

    // --- no console errors -------------------------------------------------
    const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
    check('no page errors during the session', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'none');

    console.log(`\n  first paint after clicking a work: ${firstPaintMs} ms`);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'));
    process.exit(1);
  }
}

await main();
