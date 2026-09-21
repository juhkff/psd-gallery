/**
 * Scaling probe: what actually happens when the gallery accumulates many dates?
 *
 * Generates N disposable PSDs in a temp directory (never touching works/), then
 * measures at 25 / 50 / 100:
 *   - build time for scripts/build-manifest.ts (single-threaded, offline)
 *   - manifest.json size and total preview asset bytes
 *   - browser: time to render the gallery, DOM node count, JS heap
 *
 *   npx tsx scripts/bench-scale.ts [--counts 25,50,100] [--keep]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsdBuffer, type Layer } from 'ag-psd';
import puppeteer from 'puppeteer-core';

initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WIDTH = 1200;
const HEIGHT = 800;

const args = process.argv.slice(2);
const countsArg = args[args.indexOf('--counts') + 1];
const COUNTS = countsArg && !countsArg.startsWith('--')
  ? countsArg.split(',').map((n) => Number.parseInt(n, 10))
  : [25, 50, 100];
const KEEP = args.includes('--keep');
const PORT = Number(process.env.SCALE_PORT ?? 4190);

const cache = process.env.npm_config_cache ?? path.join(ROOT, '..', '.npm-cache-bench');

function makeLayer(w: number, h: number, colour: string, blobs: number, seed: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < blobs; i++) {
    ctx.globalAlpha = 0.3 + rnd() * 0.4;
    ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)} 55% ${28 + Math.floor(rnd() * 40)}%)`;
    ctx.beginPath();
    ctx.ellipse(rnd() * w, rnd() * h, w * 0.08, h * 0.08, rnd(), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** One realistic 6-layer practice piece, written to `<dir>/<date>/<n>.psd`. */
function writePiece(dir: string, date: string, name: string): number {
  const specs: { name: string; colour: string; blend?: Layer['blendMode']; opacity?: number; hidden?: boolean }[] = [
    { name: '6-质感', colour: 'rgba(230,230,230,0.6)', blend: 'overlay', opacity: 0.7 },
    { name: '5-线稿', colour: 'rgba(25,22,20,0.6)', opacity: 0.95 },
    { name: '4-高光', colour: 'rgba(255,250,240,0.7)', blend: 'screen', opacity: 0.8, hidden: true },
    { name: '3-暗部', colour: 'rgba(40,35,50,0.7)', blend: 'multiply', opacity: 0.9 },
    { name: '2-色块', colour: 'rgba(150,110,90,0.8)' },
    { name: '1-底色', colour: 'rgba(236,228,214,1)' },
  ];
  const children: Layer[] = specs.map((spec, index) => ({
    name: spec.name,
    top: 0, left: 0, bottom: HEIGHT, right: WIDTH,
    canvas: makeLayer(WIDTH, HEIGHT, spec.colour, 9, 31 + index + name.length) as unknown as HTMLCanvasElement,
    ...(spec.blend ? { blendMode: spec.blend } : {}),
    opacity: spec.opacity ?? 1,
    hidden: spec.hidden ?? false,
  }));
  const buf = writePsdBuffer({ width: WIDTH, height: HEIGHT, children });
  const dateDir = path.join(dir, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const file = path.join(dateDir, `${name}.psd`);
  fs.writeFileSync(file, Buffer.from(buf));
  return buf.byteLength;
}

/** Build the synthetic library: `count` works spread over dates of 2-3 works. */
function generateLibrary(dir: string, count: number): { works: number; bytes: number } {
  let bytes = 0;
  let made = 0;
  let day = 0;
  while (made < count) {
    const date = `2026-${String(1 + Math.floor(day / 28)).padStart(2, '0')}-${String((day % 28) + 1).padStart(2, '0')}`;
    const perDay = 2 + (day % 2); // 2-3 works per date
    for (let n = 1; n <= perDay && made < count; n++) {
      bytes += writePiece(dir, date, String(n));
      made++;
    }
    day++;
  }
  return { works: made, bytes };
}

function bytesOfTree(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        bytes += fs.statSync(full).size;
        files++;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes, files };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Serve dist/ statically; the scaled manifest lives in public/generated-scale/. */
function serveStatic(port: number): Promise<http.Server> {
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.psd': 'application/octet-stream',
  };
  // public/ is copied into dist/ by `vite build`, so the temp output must be
  // exposed from both roots; check public/generated-scale first.
  const extra = path.join(ROOT, 'public', 'generated-scale');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = rel.startsWith('generated-scale/')
      ? path.join(extra, rel.slice('generated-scale/'.length))
      : path.join(DIST, rel || 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

interface Row {
  count: number;
  buildMs: number;
  manifestKiB: number;
  previewMiB: number;
  domNodes: number;
  renderMs: number;
  heapMiB: number;
  requests: number;
}

/** Build the current library into `public/<name>` so manifest URLs resolve. */
function buildManifest(worksDir: string, outDir: string): { ms: number; ok: boolean; detail: string } {
  const t0 = Date.now();
  const run = spawnSync('npx', [
    'tsx', 'scripts/build-manifest.ts', '--works', worksDir, '--out-dir', outDir,
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache } });
  return {
    ms: Date.now() - t0,
    ok: run.status === 0,
    detail: `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-600),
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIST)) {
    console.error('dist/ not found - run `npm run build` first.');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-scale-'));
  // Must live under public/ so the generated URLs (/generated-scale/...) resolve
  // against the built app; cleaned up at the end.
  const outDir = path.join(ROOT, 'public', 'generated-scale');
  console.log(`temp library: ${tmp}`);
  console.log(`temp output:  ${path.relative(ROOT, outDir)}\n`);
  const rows: Row[] = [];
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
  });

  try {
    console.log('generating synthetic PSD libraries...');
    // One clean library per measurement: trimming a shared tree cannot grow it
    // back, so each count gets its own directory.
    const libs = new Map<number, { dir: string; bytes: number }>();
    for (const count of COUNTS) {
      const dir = path.join(tmp, `lib-${count}`);
      fs.mkdirSync(dir, { recursive: true });
      const gen = generateLibrary(dir, count);
      libs.set(count, { dir, bytes: gen.bytes });
      console.log(`  ${gen.works} works, ${mib(gen.bytes)} of PSD source -> ${path.basename(dir)}`);
    }
    console.log('');
    console.log(
      '  works  build(s)  manifest  previews  DOM nodes  render(ms)  heap(MiB)  img req',
    );

    for (const count of COUNTS) {
      const lib = libs.get(count);
      if (!lib) continue;
      const worksDir = lib.dir;

      fs.rmSync(outDir, { recursive: true, force: true });
      const built = buildManifest(worksDir, outDir);
      if (!built.ok) {
        console.error(`build failed at ${count}:\n${built.detail}`);
        process.exit(1);
      }
      const buildMs = built.ms;

      const manifestPath = path.join(outDir, 'manifest.json');
      // The app always fetches `<base>generated/manifest.json`, so publish the
      // scaled manifest where it will actually be read. Preview URLs stay
      // pointed at /generated-scale/works/... and are served from public/.
      fs.mkdirSync(path.join(DIST, 'generated'), { recursive: true });
      fs.copyFileSync(manifestPath, path.join(DIST, 'generated', 'manifest.json'));
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        totals: { works: number };
        groups: unknown[];
      };
      const manifestKiB = fs.statSync(manifestPath).size / 1024;
      const previews = bytesOfTree(path.join(outDir, 'works'));

      // browser measurement against the real built app + real previews
      const server = await serveStatic(PORT);
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      let imgRequests = 0;
      page.on('request', (r) => {
        if (r.resourceType() === 'image') imgRequests++;
      });
      const navStart = Date.now();
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 180000 });
      await page.waitForFunction(
        (n: number) => document.querySelectorAll('[data-testid="work-tile"]').length >= n,
        { timeout: 180000, polling: 100 },
        manifest.totals.works,
      );      const renderMs = Date.now() - navStart;
      const domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);
      const heapMiB = await page.evaluate(() => {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return m ? m.usedJSHeapSize / 1024 / 1024 : -1;
      });
      const tiles = await page.$$eval('[data-testid="work-tile"]', (n) => n.length);
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (count === COUNTS[COUNTS.length - 1]) {
        fs.mkdirSync(path.join(ROOT, '.bench-output'), { recursive: true });
        await page.screenshot({
          path: path.join(ROOT, '.bench-output', `gallery-${count}.png`),
          fullPage: false,
        });
      }
      await page.close();
      await new Promise<void>((r) => server.close(() => r()));

      rows.push({ count, buildMs, manifestKiB, previewMiB: previews.bytes / 1024 / 1024, domNodes, renderMs, heapMiB, requests: imgRequests });
      console.log(
        `  ${String(count).padStart(5)}  ${(buildMs / 1000).toFixed(1).padStart(8)}  ` +
        `${manifestKiB.toFixed(0).padStart(7)}K  ${mib(previews.bytes).padStart(8)}  ` +
        `${String(domNodes).padStart(9)}  ${String(renderMs).padStart(10)}  ` +
        `${heapMiB.toFixed(1).padStart(8)}  ${String(imgRequests).padStart(7)}  ` +
        `scroll=${Math.round(pageHeight)}px` +
        (tiles !== count ? `  !! tiles=${tiles}` : ''),
      );
    }
  } finally {
    await browser.close();
    fs.rmSync(outDir, { recursive: true, force: true });
    if (KEEP) console.log(`\nkept library: ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n--- linear fit (build time per work) ---');
  const last = rows[rows.length - 1];
  const first = rows[0];
  const perWork = (last.buildMs - first.buildMs) / (last.count - first.count);
  console.log(`  ~${perWork.toFixed(0)} ms per work on this machine (single-threaded, offline)`);
  console.log(`  => 500 works ≈ ${((perWork * 500) / 1000 / 60).toFixed(1)} min of build time`);
  console.log(`  => 1000 works ≈ ${((perWork * 1000) / 1000 / 60).toFixed(1)} min of build time`);
  console.log('\n--- asset growth ---');
  if (last.count > first.count) {
    console.log(`  previews grow ~${((last.previewMiB - first.previewMiB) / (last.count - first.count) * 1000).toFixed(2)} MiB per work`);
    console.log(`  => 500 works ≈ ${(((last.previewMiB - first.previewMiB) / (last.count - first.count)) * 500).toFixed(0)} MiB of previews alone`);
  }
}

await main();
