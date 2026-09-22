/**
 * Verifies the liquid-glass effects actually render, not just that the CSS was
 * written. A pane that looks flat usually means an ancestor created a containing
 * block (transform/filter/overflow) that silently kills backdrop-filter.
 *
 *   npx tsx scripts/liquid-check.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.LIQUID_PORT ?? 4210);
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

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures.push(name);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:${PORT}/?liquid=1`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));

  const probe = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    const panes = Array.from(document.querySelectorAll('.liquid-glass, .liquid-glass-thin'));
    out.paneCount = panes.length;
    const first = panes[0] as HTMLElement | undefined;
    if (first) {
      const cs = getComputedStyle(first);
      out.blur = cs.backdropFilter;
      out.background = cs.backgroundColor;
      out.rect = first.getBoundingClientRect().width;
      // Does backdrop-filter actually apply? A containing block on an ancestor
      // makes the computed value still report the filter while rendering nothing.
      out.ancestorsWithContainingBlock = (() => {
        const bad: string[] = [];
        let node: HTMLElement | null = first.parentElement;
        while (node && node !== document.documentElement) {
          const s = getComputedStyle(node);
          if (
            s.transform !== 'none' || s.filter !== 'none' ||
            (s.backdropFilter && s.backdropFilter !== 'none') ||
            s.overflow === 'hidden' || Number(s.opacity) < 1 ||
            s.willChange.includes('transform') || s.perspective !== 'none' ||
            s.contain.includes('paint')
          ) {
            bad.push(`${node.tagName}.${String(node.className).split(' ')[0]}(transform=${s.transform}, filter=${s.filter}, overflow=${s.overflow}, opacity=${s.opacity})`);
          }
          node = node.parentElement;
        }
        return bad;
      })();
    }
    const sheens = Array.from(document.querySelectorAll('.liquid-sheen'));
    out.sheenCount = sheens.length;
    if (sheens[0]) {
      const cs = getComputedStyle(sheens[0]);
      out.sheenBlend = cs.mixBlendMode;
      out.sheenOpacity = cs.opacity;
      const before = getComputedStyle(sheens[0], '::before');
      out.sheenAnim = `${before.animationName} ${before.animationDuration}`;
      out.sheenAnimating = before.animationName !== 'none';
    }
    const speculars = Array.from(document.querySelectorAll('.liquid-specular'));
    out.specularCount = speculars.length;
    out.interactiveCount = document.querySelectorAll('.liquid-interactive').length;
    out.filtersInDom = !!document.querySelector('filter#liquid-displace');
    out.hoverMedia = typeof matchMedia === 'function' ? matchMedia('(hover: hover)').matches : null;
    return out;
  });

  console.log(JSON.stringify(probe, null, 1));
  check('glass panes exist', Number(probe.paneCount) > 0, `${probe.paneCount} panes`);
  check('backdrop-filter is applied', String(probe.blur ?? '').includes('blur'), String(probe.blur));
  const bad = (probe.ancestorsWithContainingBlock as string[]) ?? [];
  check('no ancestor breaks the backdrop-filter containing block', bad.length === 0, bad.length ? bad.join(' | ') : 'clean ancestry');
  check('sheen layer is animating', probe.sheenAnimating === true, String(probe.sheenAnim));
  check('pointer specular layers exist for interactive tiles', Number(probe.specularCount) > 0 && Number(probe.interactiveCount) > 0, `${probe.interactiveCount} interactive, ${probe.specularCount} specular`);
  check('SVG refraction filter is in the document', probe.filtersInDom === true, 'filter#liquid-displace');

  // The sheen must actually move over time.
  const t1 = await page.evaluate(() => {
    const el = document.querySelector('.liquid-sheen');
    return el ? getComputedStyle(el, '::before').transform : 'none';
  });
  await new Promise((r) => setTimeout(r, 1200));
  const t2 = await page.evaluate(() => {
    const el = document.querySelector('.liquid-sheen');
    return el ? getComputedStyle(el, '::before').transform : 'none';
  });
  check('sheen transform advances over time', t1 !== t2, `${t1} -> ${t2}`);

  // The pointer specular must update --mx/--my without a React re-render.
  const tile = await page.$('[data-testid="work-tile"]');
  if (tile) {
    const box = await tile.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
      await new Promise((r) => setTimeout(r, 300));
      const mx = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="work-tile"]') as HTMLElement | null;
        const interactive = el?.classList.contains('liquid-interactive');
        const gridHasHandler = !!el?.closest('div[aria-labelledby]');
        return `inline=${el?.style.getPropertyValue('--mx') ?? '<unset>'} interactive=${interactive} gridFound=${gridHasHandler}`;
      });
      check('pointer sets --mx on the hovered tile', /inline=-?\d/.test(mx), mx);
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(failures.length === 0 ? '\nLIQUID GLASS CHECK PASSED' : `\n${failures.length} check(s) FAILED`);
if (failures.length > 0) process.exit(1);
