/**
 * Regenerate the demo PSDs in works/<date>/.
 *
 *   npx tsx scripts/samples/generate_samples.ts
 *
 * The layer data is written by ag-psd (its writer and reader agree about
 * transparency), and the flattened composite is patched in by us because
 * `writePsdBuffer()` emits a black composite section for layered documents.
 * See scripts/samples/psd-write.ts for the full reasoning and the byte layout.
 *
 * Layers are pixel layers only, on purpose: text/vector/smart-object layers are
 * exactly what ag-psd cannot re-render, so a sample full of them would advertise
 * behaviour the viewer does not have.
 *
 * Layer names are ASCII: the compatibility layer-name field is macroman, and the
 * viewer is exercised with CJK names by real Photoshop files anyway.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { writeSamplePsd, type SampleLayer } from './psd-write';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKS = path.join(ROOT, 'works');

/** Deterministic RNG so regenerating produces identical files. */
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

function make(w: number, h: number): { canvas: Canvas; ctx: Ctx } {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Warm paper wash: the opaque base of every piece. */
function baseWash(w: number, h: number, seed: number): Canvas {
  const rnd = mulberry32(seed);
  const { canvas, ctx } = make(w, h);
  const g = ctx.createLinearGradient(0, 0, w * 0.6, h);
  g.addColorStop(0, '#f6efe4');
  g.addColorStop(0.55, '#efe4d4');
  g.addColorStop(1, '#e3d6c3');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // soft vignette
  const v = ctx.createRadialGradient(w * 0.5, h * 0.55, Math.min(w, h) * 0.1, w * 0.5, h * 0.55, Math.max(w, h) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(60,40,25,0.18)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  // faint paper mottling
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(120,95,70,${0.01 + rnd() * 0.02})`;
    ctx.beginPath();
    ctx.ellipse(rnd() * w, rnd() * h, w * 0.05, h * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/** Loose colour blocking on a transparent layer. */
function colourShapes(w: number, h: number, seed: number): Canvas {
  const rnd = mulberry32(seed);
  const { canvas, ctx } = make(w, h);
  const palette = ['#d98a6a', '#8fb3c9', '#c9b06a', '#9c8fc9', '#7fb09a'];
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = palette[i % palette.length];
    ctx.globalAlpha = 0.35 + rnd() * 0.35;
    ctx.beginPath();
    ctx.ellipse(w * (0.12 + rnd() * 0.76), h * (0.12 + rnd() * 0.76),
      Math.min(w, h) * (0.07 + rnd() * 0.17), Math.min(w, h) * (0.06 + rnd() * 0.14), rnd(), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Soft shadow pass (multiply). */
function shadowPass(w: number, h: number, seed: number): Canvas {
  const rnd = mulberry32(seed);
  const { canvas, ctx } = make(w, h);
  ctx.fillStyle = '#30221c';
  for (let i = 0; i < 6; i++) {
    ctx.globalAlpha = 0.12 + rnd() * 0.2;
    ctx.beginPath();
    ctx.ellipse(w * (0.18 + rnd() * 0.64), h * (0.5 + rnd() * 0.45),
      w * (0.08 + rnd() * 0.16), h * (0.03 + rnd() * 0.08), rnd(), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Highlight pass (screen) - hidden by default in every sample. */
function highlightPass(w: number, h: number, seed: number): Canvas {
  const rnd = mulberry32(seed);
  const { canvas, ctx } = make(w, h);
  ctx.fillStyle = '#fff8ec';
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = 0.18 + rnd() * 0.3;
    ctx.beginPath();
    ctx.ellipse(w * (0.14 + rnd() * 0.72), h * (0.1 + rnd() * 0.5),
      w * (0.04 + rnd() * 0.12), h * (0.02 + rnd() * 0.07), -rnd(), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Ink strokes on a transparent layer. */
function lineArt(w: number, h: number, seed: number): Canvas {
  const rnd = mulberry32(seed);
  const { canvas, ctx } = make(w, h);
  ctx.strokeStyle = '#2b2622';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 34; i++) {
    ctx.globalAlpha = 0.25 + rnd() * 0.55;
    ctx.lineWidth = 1.2 + rnd() * 3.2;
    let x = w * (0.08 + rnd() * 0.84);
    let y = h * (0.08 + rnd() * 0.84);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 2 + Math.floor(rnd() * 4);
    for (let s = 0; s < segs; s++) {
      x += (rnd() - 0.5) * w * 0.28;
      y += (rnd() - 0.5) * h * 0.28;
      ctx.quadraticCurveTo(x + (rnd() - 0.5) * w * 0.1, y + (rnd() - 0.5) * h * 0.1, x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Sparse film grain (overlay). Kept sparse so RLE compresses well. */
function grainPass(w: number, h: number, seed: number): Canvas {
  const rnd = mulberry32(seed);
  const { canvas, ctx } = make(w, h);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rnd() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = rnd() < 0.12 ? Math.floor(14 + rnd() * 20) : 0;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
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

/** Top-most first, exactly like the Photoshop layer panel. */
function layersFor(piece: Piece): SampleLayer[] {
  const { width: w, height: h, seed } = piece;
  return [
    { name: '6-grain', canvas: grainPass(w, h, seed + 5), blendMode: 'overlay', opacity: 0.7 },
    { name: '5-lineart', canvas: lineArt(w, h, seed + 4), opacity: 0.95 },
    { name: '4-highlight', canvas: highlightPass(w, h, seed + 3), blendMode: 'screen', opacity: 0.85, hidden: true },
    { name: '3-shadow', canvas: shadowPass(w, h, seed + 2), blendMode: 'multiply', opacity: 0.9 },
    { name: '2-color-blocks', canvas: colourShapes(w, h, seed + 1) },
    { name: '1-base-wash', canvas: baseWash(w, h, seed) },
  ];
}

function main(): void {
  fs.mkdirSync(WORKS, { recursive: true });
  let failures = 0;

  for (const piece of PIECES) {
    const layers = layersFor(piece);
    try {
      const result = writeSamplePsd(piece.width, piece.height, layers);
      const dir = path.join(WORKS, piece.date);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${piece.name}.psd`);
      fs.writeFileSync(file, result.bytes);

      const alphas = result.layersRead.join(' ');
      console.log(
        `${path.relative(ROOT, file).padEnd(26)} ${piece.width}x${piece.height}  ` +
        `${layers.length} layers  ${(result.bytes.length / 1024).toFixed(0)} KiB  ` +
        `composite avg=${result.composite.avg.toFixed(0)} max=${result.composite.max.toFixed(0)}  ${piece.title}`,
      );
      console.log(`  ${alphas}`);
    } catch (error) {
      failures += 1;
      console.error(`FAILED ${piece.date}/${piece.name}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} sample(s) failed`);
    process.exit(1);
  }
  console.log(`\nsamples written to ${path.relative(ROOT, WORKS)}`);
}

main();
