/**
 * UI checks for the plain design direction.
 *
 *   npx tsx scripts/ui-check.ts
 *
 * Replaces the old `liquid-check.ts`, which asserted the liquid-glass effects
 * (animated sheen, pointer-tracked specular, chromatic panes). Those effects
 * were removed on request, so their assertions became obsolete rather than
 * failing: this file checks what the plain direction actually promises.
 *
 * Still in the spirit of the old check: assert on measured browser state, not
 * on the CSS we believe we wrote.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.UI_CHECK_PORT ?? 4230);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.psd': 'application/octet-stream', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let file = path.join(DIST, rel || 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': body.byteLength });
  res.end(body);
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 800));

  // 1. decorations are really gone, not merely unused
  const decoration = await page.evaluate(() => ({
    sheen: document.querySelectorAll('.liquid-sheen, .liquid-specular, .liquid-rim').length,
    gradientText: Array.from(document.querySelectorAll('*')).filter((el) => {
      const cs = getComputedStyle(el);
      return cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
    }).length,
    glows: Array.from(document.querySelectorAll('.panel, .panel-quiet')).filter((el) => {
      const shadow = getComputedStyle(el).boxShadow;
      return shadow !== 'none' && !shadow.includes('inset');
    }).length,
  }));
  check('decorative glass layers are gone', decoration.sheen === 0, `${decoration.sheen} sheen/specular/rim nodes`);
  check('no gradient text remains', decoration.gradientText === 0, `${decoration.gradientText} nodes clip text to a gradient`);
  check('panels carry no outer glow', decoration.glows === 0, `${decoration.glows} panels with an outer shadow`);

  // 2. surfaces are still real surfaces (a light blur, not opaque blocks)
  const surface = await page.evaluate(() => {
    // Either class is a valid surface; the gallery mostly renders panel-quiet.
    const el = (document.querySelector('.panel') ?? document.querySelector('.panel-quiet')) as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { blur: cs.backdropFilter, bg: cs.backgroundColor, border: cs.borderTopWidth };
  });
  check('panels keep a light backdrop blur', !!surface && surface.blur.includes('blur('), String(surface?.blur));
  check('panels keep a hairline border', !!surface && surface.border !== '0px', String(surface?.border));

  // 3. the timeline must actually navigate (this shipped broken once)
  const before = await page.evaluate(() => scrollY);
  const nodes = await page.$$('[data-timeline-node]');
  let scrolled = false;
  if (nodes.length > 0) {
    await nodes[nodes.length - 1].click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await page.evaluate(() => scrollY);
    scrolled = after !== before;
    check('clicking a timeline node scrolls the page', scrolled, `scrollY ${before} -> ${after}`);
  } else {
    check('clicking a timeline node scrolls the page', false, 'no timeline nodes found');
  }

  // 4. no sideways scroll from any decorative overflow
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal overflow', overflow <= 0, `${overflow}px of sideways scroll`);

  // 5. no developer telemetry in the default view
  const telemetry = await page.evaluate(() => {
    const text = document.body.innerText;
    return ['Web Worker', 'IndexedDB', '解码', '缓存', '像素图层', '重绘'].filter((word) => text.includes(word));
  });
  check('no implementation jargon on the page', telemetry.length === 0, telemetry.length ? `found: ${telemetry.join(', ')}` : 'none of Web Worker / IndexedDB / 解码 / 缓存 / 重绘');

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(failures.length === 0 ? '\nUI CHECK PASSED' : `\n${failures.length} check(s) FAILED`);
if (failures.length > 0) process.exit(1);
