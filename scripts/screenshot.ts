/**
 * Screenshot the built site for visual review.
 *
 *   npx tsx scripts/screenshot.ts [--route "#/2026-09-21/1"] [--out .bench-output/shot.png] [--width 1440] [--full]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.SHOT_PORT ?? 4197);

const argv = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const route = arg('--route', '');
const out = arg('--out', '.bench-output/home.png');
const width = Number(arg('--width', '1440'));
const height = Number(arg('--height', '980'));
const full = argv.includes('--full');

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
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Force every scroll-reveal to its final state; otherwise a full-page capture
  // shows off-screen sections as blank (they are legitimately still hidden).
  await page.evaluateOnNewDocument(() => {
    const style = document.createElement('style');
    style.textContent =
      '.reveal-ready .reveal{opacity:1 !important;transform:none !important;transition:none !important}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });
  await page.goto(`http://127.0.0.1:${PORT}/${route}`, { waitUntil: 'networkidle2', timeout: 60000 });
  // let reveals and the crossfade settle
  await new Promise((r) => setTimeout(r, 1200));
  const target = path.join(ROOT, out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: full });
  const info = await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas').length;
    const tiles = document.querySelectorAll('[data-testid="work-tile"]').length;
    const timeline = !!document.querySelector('nav[aria-label="练习时间线"]');
    return { tiles, canvases, timeline, height: document.documentElement.scrollHeight };
  });
  console.log(`saved ${out}  ${width}x${height}${full ? ' (full page)' : ''}`);
  console.log(`  route="${route || '/'}" tiles=${info.tiles} canvases=${info.canvases} timelineNav=${info.timeline} pageHeight=${info.height}`);
  if (errors.length) console.log('  page errors:', errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
