/**
 * Generate small, realistic sample PSDs so the gallery has something to show
 * out of the box and so the build/viewer pipeline can be tested end to end.
 *
 * These are deliberately tiny (a few hundred KB each) because they are
 * committed to the repo. Drop your real files into the same folders - the
 * build script picks up any `works/YYYY-MM-DD/N.psd`.
 *
 *   npm run samples
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas, writePsdBuffer, type Layer } from 'ag-psd';

/**
 * ag-psd types its canvas factory as returning `HTMLCanvasElement`, but
 * @napi-rs/canvas returns its own Canvas class. They are structurally
 * compatible for everything ag-psd does; the cast is confined here.
 */
initializeCanvas((w, h) => newCanvas(w, h) as unknown as HTMLCanvasElement);

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKS = path.join(ROOT, 'works');

/** Deterministic RNG so regenerating samples produces identical files. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = ReturnType<Canvas['getContext']>;

function newCanvas(w: number, h: number): Canvas {
  return createCanvas(w, h);
}

function linearGradient(ctx: Ctx, w: number, h: number, stops: [number, string][], angle = 90) {
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad);
  const y = Math.sin(rad);
  const g = ctx.createLinearGradient(
    w / 2 - (x * w) / 2, h / 2 - (y * h) / 2,
    w / 2 + (x * w) / 2, h / 2 + (y * h) / 2,
  );
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

interface Layers {
  [name: string]: Canvas;
}

function renderStudy(w: number, h: number, seed: number): Layers {
  const rnd = mulberry32(seed);

  // base wash
  const base = newCanvas(w, h);
  const bctx = base.getContext('2d');
  bctx.fillStyle = linearGradient(bctx, w, h, [
    [0, '#f6efe4'], [0.55, '#efe4d4'], [1, '#e3d6c3'],
  ], 120);
  bctx.fillRect(0, 0, w, h);
  bctx.fillStyle = 'rgba(160,120,90,0.10)';
  bctx.beginPath();
  bctx.ellipse(w * 0.5, h * 0.62, w * 0.34, h * 0.3, -0.2, 0, Math.PI * 2);
  bctx.fill();

  // tinted study shapes
  const shapes = newCanvas(w, h);
  const sctx = shapes.getContext('2d');
  const palette = ['#d98a6a', '#8fb3c9', '#c9b06a', '#9c8fc9', '#7fb09a'];
  for (let i = 0; i < 7; i++) {
    const cx = w * (0.15 + rnd() * 0.7);
    const cy = h * (0.15 + rnd() * 0.7);
    const r = Math.min(w, h) * (0.06 + rnd() * 0.16);
    sctx.fillStyle = palette[i % palette.length];
    sctx.globalAlpha = 0.35 + rnd() * 0.3;
    sctx.beginPath();
    sctx.arc(cx, cy, r, 0, Math.PI * 2);
    sctx.fill();
  }
  sctx.globalAlpha = 1;

  // shadow pass
  const shadow = newCanvas(w, h);
  const shctx = shadow.getContext('2d');
  shctx.fillStyle = 'rgba(48,34,28,0.55)';
  for (let i = 0; i < 5; i++) {
    shctx.globalAlpha = 0.10 + rnd() * 0.16;
    shctx.beginPath();
    shctx.ellipse(
      w * (0.2 + rnd() * 0.6), h * (0.5 + rnd() * 0.45),
      w * (0.08 + rnd() * 0.16), h * (0.03 + rnd() * 0.08),
      rnd(), 0, Math.PI * 2,
    );
    shctx.fill();
  }
  shctx.globalAlpha = 1;

  // highlight pass
  const highlight = newCanvas(w, h);
  const hctx = highlight.getContext('2d');
  hctx.fillStyle = 'rgba(255,248,236,0.85)';
  for (let i = 0; i < 6; i++) {
    hctx.globalAlpha = 0.12 + rnd() * 0.22;
    hctx.beginPath();
    hctx.ellipse(
      w * (0.15 + rnd() * 0.7), h * (0.1 + rnd() * 0.5),
      w * (0.04 + rnd() * 0.12), h * (0.02 + rnd() * 0.07),
      -rnd(), 0, Math.PI * 2,
    );
    hctx.fill();
  }
  hctx.globalAlpha = 1;

  // line art on transparent paper
  const line = newCanvas(w, h);
  const lctx = line.getContext('2d');
  lctx.strokeStyle = '#2b2622';
  lctx.lineCap = 'round';
  lctx.lineJoin = 'round';
  for (let i = 0; i < 26; i++) {
    lctx.globalAlpha = 0.25 + rnd() * 0.55;
    lctx.lineWidth = 1 + rnd() * 3.2;
    lctx.beginPath();
    let x = w * (0.1 + rnd() * 0.8);
    let y = h * (0.1 + rnd() * 0.8);
    lctx.moveTo(x, y);
    const segs = 2 + Math.floor(rnd() * 4);
    for (let s = 0; s < segs; s++) {
      x += (rnd() - 0.5) * w * 0.28;
      y += (rnd() - 0.5) * h * 0.28;
      lctx.quadraticCurveTo(
        x + (rnd() - 0.5) * w * 0.1, y + (rnd() - 0.5) * h * 0.1, x, y,
      );
    }
    lctx.stroke();
  }
  lctx.globalAlpha = 1;

  // grain texture
  const grain = newCanvas(w, h);
  const gctx = grain.getContext('2d');
  const img = gctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rnd() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 18;
  }
  gctx.putImageData(img, 0, 0);

  return { base, shapes, shadow, highlight, line, grain };
}

function toLayer(
  name: string, canvas: Canvas, w: number, h: number,
  opts: { blendMode?: Layer['blendMode']; opacity?: number; hidden?: boolean } = {},
): Layer {
  return {
    name,
    top: 0, left: 0, bottom: h, right: w,
    canvas: canvas as unknown as HTMLCanvasElement,
    blendMode: opts.blendMode,
    opacity: opts.opacity ?? 1,
    hidden: opts.hidden ?? false,
  };
}

interface Piece {
  date: string;
  name: string;
  width: number;
  height: number;
  seed: number;
  title: string;
}

const PIECES: Piece[] = [
  { date: '2026-09-21', name: '1', width: 1200, height: 800, seed: 11, title: '色彩小稿' },
  { date: '2026-09-21', name: '2', width: 900, height: 1200, seed: 22, title: '人物速涂' },
  { date: '2026-09-24', name: '1', width: 1000, height: 1000, seed: 33, title: '方构图练习' },
];

function build(piece: Piece): { file: string; bytes: number } {
  const { width: w, height: h } = piece;
  const art = renderStudy(w, h, piece.seed);

  const psd = {
    width: w,
    height: h,
    children: [
      toLayer('6-颗粒质感', art.grain, w, h, { blendMode: 'overlay', opacity: 0.7 }),
      toLayer('5-线稿', art.line, w, h, { opacity: 0.95 }),
      toLayer('4-高光', art.highlight, w, h, { blendMode: 'screen', opacity: 0.85, hidden: true }),
      toLayer('3-暗部阴影', art.shadow, w, h, { blendMode: 'multiply', opacity: 0.9 }),
      toLayer('2-色块铺陈', art.shapes, w, h, { opacity: 1 }),
      toLayer('1-底色wash', art.base, w, h, { opacity: 1 }),
    ],
  };

  const buf = writePsdBuffer(psd);
  const dir = path.join(WORKS, piece.date);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${piece.name}.psd`);
  fs.writeFileSync(file, Buffer.from(buf));
  return { file, bytes: buf.byteLength };
}

fs.mkdirSync(WORKS, { recursive: true });
for (const piece of PIECES) {
  const { file, bytes } = build(piece);
  console.log(
    `${path.relative(ROOT, file).padEnd(30)} ${piece.width}x${piece.height}  ` +
    `${(bytes / 1024).toFixed(0)} KiB  ${piece.title}`,
  );
}
console.log('\nsamples written to', path.relative(ROOT, WORKS));
