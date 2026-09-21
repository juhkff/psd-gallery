/**
 * Closes the one gap the client flagged as unverified: the proxy path.
 *
 * All committed samples are <= 1.08 MP, so PROXY_PIXEL_THRESHOLD (6 MP) was
 * never reached end-to-end. This generates an 8.3 MP PSD into a temporary date
 * folder, runs the real build, verifies the manifest, drives the real UI in
 * headless Chrome, and then removes the temporary fixture again.
 *
 *   npx tsx scripts/verify-proxy.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsdBuffer, type Layer } from 'ag-psd';
import puppeteer from 'puppeteer-core';

initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DATE = '2099-01-01';
const STEM = '1';
const WIDTH = 3520;
const HEIGHT = 2360;
const PORT = Number(process.env.PROXY_PORT ?? 4180);

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

function log(step: string, detail = ''): void {
  console.log(`  ${step}${detail ? `  ${detail}` : ''}`);
}

/** A large but cheaply-compressible layer: flat fills plus a few shapes. */
function makeLayer(w: number, h: number, colour: string, blobs: number, seed: number) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < blobs; i++) {
    ctx.globalAlpha = 0.25 + rnd() * 0.4;
    ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)} 60% ${30 + Math.floor(rnd() * 40)}%)`;
    ctx.beginPath();
    ctx.ellipse(rnd() * w, rnd() * h, w * (0.05 + rnd() * 0.2), h * (0.05 + rnd() * 0.2), rnd(), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

function generatePsd(): { file: string; dir: string; bytes: number } {
  const dir = path.join(ROOT, 'works', DATE);
  fs.mkdirSync(dir, { recursive: true });
  const specs: { name: string; colour: string; blend?: Layer['blendMode']; opacity?: number; hidden?: boolean }[] = [
    { name: '5-高光', colour: 'rgba(255,250,240,0.7)', blend: 'screen', opacity: 0.8, hidden: true },
    { name: '4-暗部', colour: 'rgba(40,35,50,0.7)', blend: 'multiply', opacity: 0.9 },
    { name: '3-线稿', colour: 'rgba(25,22,20,0.6)', opacity: 0.95 },
    { name: '2-色块', colour: 'rgba(150,110,90,0.8)' },
    { name: '1-底色', colour: 'rgba(236,228,214,1)' },
  ];
  const children: Layer[] = specs.map((spec, index) => ({
    name: spec.name,
    top: 0,
    left: 0,
    bottom: HEIGHT,
    right: WIDTH,
    canvas: makeLayer(WIDTH, HEIGHT, spec.colour, 12, 7 + index) as unknown as HTMLCanvasElement,
    ...(spec.blend ? { blendMode: spec.blend } : {}),
    opacity: spec.opacity ?? 1,
    hidden: spec.hidden ?? false,
  }));

  const buf = writePsdBuffer({ width: WIDTH, height: HEIGHT, children });
  const file = path.join(dir, `${STEM}.psd`);
  fs.writeFileSync(file, Buffer.from(buf));
  return { file, dir, bytes: buf.byteLength };
}

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
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
  const failures: string[] = [];
  const generated = generatePsd();
  log('generated fixture', `${WIDTH}x${HEIGHT} = ${((WIDTH * HEIGHT) / 1e6).toFixed(2)} MP, ${(generated.bytes / 1024).toFixed(0)} KiB`);

  try {
    // real build so the manifest picks the fixture up
    const manifestRun = spawnSync('npx', ['tsx', 'scripts/build-manifest.ts'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: '/home/ubuntu/projects/.npm-cache-bench' },
    });
    if (manifestRun.status !== 0) {
      failures.push(`build-manifest exited ${manifestRun.status}: ${manifestRun.stderr.slice(-400)}`);
    }
    const buildRun = spawnSync('npx', ['vite', 'build'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: '/home/ubuntu/projects/.npm-cache-bench' },
    });
    if (buildRun.status !== 0) {
      failures.push(`vite build exited ${buildRun.status}: ${buildRun.stderr.slice(-400)}`);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'generated', 'manifest.json'), 'utf8')) as {
      groups: { date: string; works: { name: string; width: number; height: number; layerCount: number }[] }[];
    };
    const group = manifest.groups.find((g) => g.date === DATE);
    const work = group?.works[0];
    if (!work) {
      failures.push('large fixture is missing from the manifest');
    } else {
      log('manifest', `${DATE}/${work.name}.psd ${work.width}x${work.height} ${work.layerCount} layers`);
      if (work.layerCount !== 5) failures.push(`expected 5 layers, got ${work.layerCount}`);
    }

    // drive the real UI
    const server = await serve();
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      protocolTimeout: 300000,
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${PORT}/#/${DATE}/${STEM}`, { waitUntil: 'networkidle2', timeout: 60000 });

      await page.waitForFunction(
        () => document.querySelector('[data-testid="work-canvas"]') !== null,
        { timeout: 60000, polling: 200 },
      );
      const started = Date.now();
      await page.waitForFunction(
        () => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid="work-canvas"]');
          return !!c && c.width > 300 && c.height > 150;
        },
        { timeout: 180000, polling: 250 },
      );
      const readyMs = Date.now() - started;

      const info = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid="work-canvas"]')!;
        const text = document.body.innerText;
        // Prove real pixels were composited rather than an empty/placeholder
        // frame of the right size: sample the canvas and count distinct colours.
        const probe = document.createElement('canvas');
        probe.width = Math.min(160, c.width);
        probe.height = Math.min(160, c.height);
        const pctx = probe.getContext('2d')!;
        pctx.drawImage(c, 0, 0, probe.width, probe.height);
        const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
        const colours = new Set<number>();
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
          if (data[i + 3] > 0) opaque++;
        }
        return {
          canvas: { width: c.width, height: c.height },
          distinctColours: colours.size,
          opaqueRatio: opaque / (probe.width * probe.height),
          decodeCount: Number(document.querySelector('[data-decode-count]')?.getAttribute('data-decode-count') ?? -1),
          proxyMentioned: /代理|prox/i.test(text),
        };
      });
      log('canvas', `${info.canvas.width}x${info.canvas.height} after ${readyMs} ms`);
      log('proxy indicator present', String(info.proxyMentioned));
      log('decoded layers', String(info.decodeCount));
      log('canvas content', `${info.distinctColours} distinct colours, ${(info.opaqueRatio * 100).toFixed(1)}% opaque`);

      // 3520x2360 = 8.3 MP > 6 MP, longest edge 3520 > 1500 => scale 1500/3520
      const expectedW = Math.round(WIDTH * (1500 / WIDTH));
      const expectedH = Math.round(HEIGHT * (1500 / WIDTH));
      if (info.canvas.width !== expectedW || info.canvas.height !== expectedH) {
        failures.push(`proxy size mismatch: expected ${expectedW}x${expectedH}, canvas is ${info.canvas.width}x${info.canvas.height}`);
      } else {
        log('proxy scaling correct', `${WIDTH}x${HEIGHT} -> ${info.canvas.width}x${info.canvas.height}`);
      }
      // A placeholder/empty frame would be a single flat colour.
      if (info.distinctColours < 4) {
        failures.push(`canvas looks empty/placeholder: only ${info.distinctColours} distinct colours`);
      }
      // All 5 drawable layers (including the hidden one) are decoded once.
      if (info.decodeCount !== 5) {
        failures.push(`expected 5 decoded layers for this fixture, toolbar reports ${info.decodeCount}`);
      }
      if (!info.proxyMentioned) failures.push('UI never indicates the proxy resolution');
      if (errors.length > 0) failures.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

      // toggling on a proxied document must still work and stay cheap
      const toggle = await page.evaluate(`(async () => {
        const before = document.querySelector('[data-testid="work-canvas"]');
        const hash = () => {
          const c = before;
          const p = document.createElement('canvas');
          p.width = Math.min(200, c.width); p.height = Math.min(200, c.height);
          const x = p.getContext('2d'); x.drawImage(c, 0, 0, p.width, p.height);
          const d = x.getImageData(0, 0, p.width, p.height).data;
          let h = 2166136261; for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619); }
          return (h >>> 0).toString(16);
        };
        const a = hash();
        const btn = document.querySelector('[data-testid="layer-toggle"]');
        btn.click();
        await new Promise((r) => setTimeout(r, 600));
        return { a, b: hash(), pressed: btn.getAttribute('aria-pressed') };
      })()`) as { a: string; b: string; pressed: string };
      if (toggle.a === toggle.b) failures.push('toggling a layer on a proxied document did not change the composite');
      else log('toggle on proxied doc changed composite', `${toggle.a} -> ${toggle.b} (aria-pressed=${toggle.pressed})`);

      // The toggle must not have triggered any further decode.
      const decodeAfterToggle = Number(
        await page.$eval('[data-decode-count]', (el) => el.getAttribute('data-decode-count') ?? '-1'),
      );
      if (decodeAfterToggle !== info.decodeCount) {
        failures.push(`toggle re-decoded: ${info.decodeCount} -> ${decodeAfterToggle}`);
      } else {
        log('no re-decode on toggle', `decode count stayed at ${decodeAfterToggle}`);
      }
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    // always clean up the temporary fixture
    fs.rmSync(generated.dir, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'public', 'generated', 'works', DATE), { recursive: true, force: true });
    spawnSync('npx', ['tsx', 'scripts/build-manifest.ts'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: '/home/ubuntu/projects/.npm-cache-bench' },
    });
    log('cleaned up fixture and regenerated manifest');
  }

  if (failures.length > 0) {
    console.error('\nPROXY VERIFICATION FAILED:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('\nPROXY VERIFICATION PASSED');
}

await main();
