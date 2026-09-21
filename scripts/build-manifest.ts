/**
 * Build-time manifest generator for the PSD gallery.
 *
 * Scans `works/YYYY-MM-DD/*.psd`, extracts the Photoshop layer panel order and
 * document metadata, renders web-sized previews from the PSD composite, copies
 * each source PSD next to its previews so the deployed site can serve the
 * download, and writes `public/generated/manifest.json` (see shared/manifest.ts).
 *
 *   npx tsx scripts/build-manifest.ts [--base /repo/] [--works dir] [--out-dir dir] [--check]
 *
 * Why two reads per file (see DECISIONS.md):
 *   a) `skipLayerImageData` is nearly free (0.1-2.8 ms) and gives dimensions plus
 *      the whole layer tree, so the size guard runs before anything expensive.
 *   b) `useRawData` keeps the compressed channels instead of decoded canvases,
 *      which is what makes `getCompositeCanvas()` safe to call selectively.
 * A document above MAX_DECODE_PIXELS is never decoded: its structure still lands
 * in the manifest and a deterministic placeholder preview is emitted instead.
 *
 * `--check` regenerates in memory (no writes at all), ignores `generatedAt` and
 * exits non-zero with a diff summary when the committed manifest is stale.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { getCompositeCanvas, initializeCanvas, readPsd, type Layer, type Psd } from 'ag-psd';
import {
  MANIFEST_VERSION,
  type DateGroup,
  type LayerNode,
  type LayerRect,
  type Manifest,
  type PreviewAssets,
  type WorkEntry,
} from '../shared/manifest';
import { ISO_DATE, joinUrl, normalizeBase, numericNameKey, stripUrlBase } from '../shared/paths';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_WORKS_DIR = path.join(ROOT, 'works');
const DEFAULT_OUT_DIR = path.join(ROOT, 'public', 'generated');

/** Documents larger than this are never decoded into canvases (DECISIONS.md #3). */
const MAX_DECODE_PIXELS = 40_000_000;
const THUMB_EDGE = 480;
const DISPLAY_EDGE = 1600;
const WEBP_QUALITY = 82;
/** How many diff lines `--check` prints before it summarises the rest. */
const DIFF_LIMIT = 25;

// Node has no DOM canvas: ag-psd needs a factory, installed before any decode.
// The cast is confined here because ag-psd types the factory as the DOM
// HTMLCanvasElement while @napi-rs/canvas returns its own Canvas class.
type CanvasFactory = Parameters<typeof initializeCanvas>[0];
const canvasFactory = ((width: number, height: number) =>
  createCanvas(width, height)) as unknown as CanvasFactory;
initializeCanvas(canvasFactory);

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/**
 * Where generated output lives.
 *
 * `siteRoot` is the directory whose *contents* become the site root (`public/`
 * by default). Vite copies the contents of `public/` to the dist root and
 * serves them at "/", so `public/generated/x` is served as `/generated/x` - the
 * `public/` segment must never appear in a manifest URL.
 */
interface Layout {
  outDir: string;
  siteRoot: string;
  manifestFile: string;
}

function createLayout(outDir: string): Layout {
  const resolved = path.resolve(outDir);
  return {
    outDir: resolved,
    siteRoot: path.dirname(resolved),
    manifestFile: path.join(resolved, 'manifest.json'),
  };
}

function publicPath(layout: Layout, file: string): string {
  return path.relative(layout.siteRoot, file).split(path.sep).join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  console.log(`[manifest] ${message}`);
}

function warn(message: string): void {
  console.warn(`[manifest] ! ${message}`);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

// --- CLI --------------------------------------------------------------------

interface CliArgs {
  /** Directory scanned for `YYYY-MM-DD/*.psd`. */
  worksDir: string;
  /** Directory the generated site files are written to. */
  outDir: string;
  /** Normalized site prefix every manifest URL is written against. */
  base: string;
  check: boolean;
}

function printUsage(): void {
  console.log(
    [
      'Usage: npx tsx scripts/build-manifest.ts [options]',
      '',
      '  --base <path>    Site prefix for manifest URLs (also env BASE_PATH, default "/")',
      '  --works <dir>    Directory holding YYYY-MM-DD folders (default works/)',
      '  --out-dir <dir>  Generated output directory (default public/generated)',
      '  --check          Regenerate in memory and exit 1 if manifest.json is stale',
      '  -h, --help       Show this help',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): CliArgs {
  let base = process.env.BASE_PATH ?? '/';
  let worksDir = DEFAULT_WORKS_DIR;
  let outDir = DEFAULT_OUT_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--base') {
      const value = argv[++i];
      if (!value) throw new Error('--base requires a value');
      base = value;
    } else if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
    } else if (arg === '--works') {
      const value = argv[++i];
      if (!value) throw new Error('--works requires a value');
      worksDir = path.resolve(value);
    } else if (arg.startsWith('--works=')) {
      worksDir = path.resolve(arg.slice('--works='.length));
    } else if (arg === '--out-dir') {
      const value = argv[++i];
      if (!value) throw new Error('--out-dir requires a value');
      outDir = path.resolve(value);
    } else if (arg.startsWith('--out-dir=')) {
      outDir = path.resolve(arg.slice('--out-dir='.length));
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { worksDir, outDir, base: normalizeBase(base), check };
}

// --- discovery --------------------------------------------------------------

interface WorkFile {
  /** File stem, e.g. "1" for "1.psd". */
  name: string;
  file: string;
}

interface DateFolder {
  date: string;
  files: WorkFile[];
}

/** `<worksDir>/YYYY-MM-DD/*.psd`, dates ascending, works numerically by stem. */
function listWorks(worksDir: string): DateFolder[] {
  if (!fs.existsSync(worksDir)) {
    warn(`no works directory at ${rel(worksDir)}`);
    return [];
  }
  const entries = fs.readdirSync(worksDir, { withFileTypes: true });
  const ignored = entries
    .filter((entry) => entry.isDirectory() && !ISO_DATE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (ignored.length > 0) {
    warn(`ignoring non-ISO-date folder(s): ${ignored.join(', ')}`);
  }
  const dates = entries
    .filter((entry) => entry.isDirectory() && ISO_DATE.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const folders: DateFolder[] = [];
  for (const date of dates) {
    const dir = path.join(worksDir, date);
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.psd$/i.test(entry.name))
      .map((entry) => ({
        name: path.basename(entry.name, path.extname(entry.name)),
        file: path.join(dir, entry.name),
      }))
      .sort((a, b) => {
        const byNumber = numericNameKey(a.name) - numericNameKey(b.name);
        if (byNumber !== 0) return byNumber;
        // Stable tie-breaker for stems that map to the same number ("1" vs "01").
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    if (files.length > 0) folders.push({ date, files });
  }
  return folders;
}

// --- layer tree -------------------------------------------------------------

/** Decoded-pixel availability, mirrored 1:1 onto the structure-only tree. */
interface ImageFlags {
  hasImage: boolean;
  children: ImageFlags[];
}

function imageFlags(layer: Layer): ImageFlags {
  return {
    hasImage: Boolean(layer.rawData ?? layer.imageData),
    children: (layer.children ?? []).map(imageFlags),
  };
}

/** Photoshop layer kinds ag-psd can tell apart without rasterizing. */
type LayerKind = 'pixel' | 'group' | 'text' | 'shape' | 'adjustment' | 'smartObject';

function layerKind(layer: Layer): LayerKind {
  if (layer.sectionDivider || layer.children) return 'group';
  if (layer.text) return 'text';
  if (layer.adjustment) return 'adjustment';
  if (layer.placedLayer) return 'smartObject';
  if (layer.vectorFill) return 'shape';
  return 'pixel';
}

function layerNote(layer: Layer, kind: LayerKind): string | undefined {
  switch (kind) {
    case 'group':
      return 'Group';
    case 'text': {
      const firstLine = (layer.text?.text ?? '').split('\n')[0].trim();
      const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
      return preview ? `Text: ${preview}` : 'Text layer';
    }
    case 'adjustment':
      return `Adjustment: ${layer.adjustment?.type ?? 'unknown'}`;
    case 'smartObject':
      return `Smart object: ${layer.placedLayer?.type ?? 'unknown'}`;
    case 'shape':
      return 'Vector shape';
    default:
      return undefined;
  }
}

function round(value: number): number {
  return Math.round(value);
}

function roundOpacity(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 10_000) / 10_000;
}

/**
 * Depth-first tree in Photoshop panel order. ag-psd's `children` is already
 * TOP-first, so the array order is preserved (never reversed).
 */
function buildNodes(layers: readonly Layer[] | undefined, flags: readonly ImageFlags[] | undefined): LayerNode[] {
  if (!layers) return [];
  return layers.map((layer, index) => {
    const kind = layerKind(layer);
    const isGroup = kind === 'group';
    const own = flags?.[index];
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const rect: LayerRect = {
      left: round(left),
      top: round(top),
      right: round(layer.right ?? left),
      bottom: round(layer.bottom ?? top),
    };
    const node: LayerNode = {
      name: layer.name?.trim() ? layer.name : `Layer ${index + 1}`,
      kind,
      hidden: layer.hidden === true,
      opacity: roundOpacity(layer.opacity ?? 1),
      blendMode: layer.blendMode ?? 'normal',
      rect,
      // Groups never carry their own pixels.
      hasImage: isGroup ? false : Boolean(own?.hasImage),
      isGroup,
    };
    const note = layerNote(layer, kind);
    if (note) node.note = note;
    if (isGroup) node.children = buildNodes(layer.children, own?.children);
    return node;
  });
}

function countLayers(nodes: readonly LayerNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countLayers(node.children ?? []), 0);
}

// --- images -----------------------------------------------------------------

type ImageFormat = { mime: 'image/webp' | 'image/png'; ext: '.webp' | '.png' };

/** Probe the encoder once so `--check` predicts the same URLs as a real build. */
function detectImageFormat(): ImageFormat {
  try {
    createCanvas(1, 1).toBuffer('image/webp', WEBP_QUALITY);
    return { mime: 'image/webp', ext: '.webp' };
  } catch (error) {
    warn(`webp encoder unavailable (${errorMessage(error)}) - falling back to png previews`);
    return { mime: 'image/png', ext: '.png' };
  }
}

function encode(canvas: Canvas, format: ImageFormat): Buffer {
  return format.mime === 'image/webp'
    ? canvas.toBuffer('image/webp', WEBP_QUALITY)
    : canvas.toBuffer('image/png');
}

interface Size {
  width: number;
  height: number;
}

/** Longest edge capped at `edge`; small documents are never upscaled. */
function fitWithin(width: number, height: number, edge: number): Size {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, edge / longest) : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

interface EncodedImage extends Size {
  file: string;
}

function writePreview(source: Canvas, dir: string, stem: string, edge: number, format: ImageFormat): EncodedImage {
  const target = fitWithin(source.width, source.height, edge);
  const out = createCanvas(target.width, target.height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const file = path.join(dir, `${stem}${format.ext}`);
  fs.writeFileSync(file, encode(out, format));
  return { file, width: target.width, height: target.height };
}

/**
 * Deterministic stand-in for documents we refuse to decode. Geometry only (no
 * text) so the bytes do not depend on which fonts the build machine has.
 */
function placeholderCanvas(width: number, height: number, edge: number): Canvas {
  const target = fitWithin(width, height, edge);
  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d');
  const stroke = Math.max(1, Math.round(Math.min(target.width, target.height) / 120));
  ctx.fillStyle = '#14161b';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.strokeStyle = '#3a3f4b';
  ctx.lineWidth = stroke;
  ctx.strokeRect(stroke / 2, stroke / 2, target.width - stroke, target.height - stroke);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(target.width, target.height);
  ctx.moveTo(target.width, 0);
  ctx.lineTo(0, target.height);
  ctx.stroke();
  return canvas;
}

// --- one work ---------------------------------------------------------------

interface WorkBuild {
  entry: WorkEntry;
  warnings: string[];
}

interface BuildOptions {
  /** false for `--check`: nothing is created, copied or encoded. */
  write: boolean;
  layout: Layout;
}

function buildWork(
  date: string,
  name: string,
  source: string,
  base: string,
  format: ImageFormat,
  options: BuildOptions,
): WorkBuild {
  const warnings: string[] = [];
  const bytes = fs.statSync(source).size;
  const buffer = fs.readFileSync(source);

  // (a) cheap structure pass: dimensions + the whole layer tree for the guard.
  const struct = readPsd(buffer, {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const width = struct.width;
  const height = struct.height;
  const pixels = width * height;
  const overBudget = pixels > MAX_DECODE_PIXELS;

  // (b) raw pass: keeps compressed channels, decodes nothing yet.
  let raw: Psd | undefined;
  if (overBudget) {
    warnings.push(
      `document is ${(pixels / 1_000_000).toFixed(1)} MP > ${(MAX_DECODE_PIXELS / 1_000_000).toFixed(0)} MP` +
        ` decode budget - bitmaps skipped, placeholder preview emitted`,
    );
  } else {
    try {
      raw = readPsd(buffer, { useRawData: true, useRawThumbnail: true });
    } catch (error) {
      warnings.push(`raw read failed (${errorMessage(error)}) - structure only`);
    }
  }

  const layers = buildNodes(struct.children, raw?.children?.map(imageFlags));

  const outDateDir = path.join(options.layout.outDir, 'works', date);
  const psdFile = path.join(outDateDir, `${name}.psd`);
  let thumbFile = path.join(outDateDir, `${name}.thumb${format.ext}`);
  let displayFile = path.join(outDateDir, `${name}.display${format.ext}`);
  let thumbSize = fitWithin(width, height, THUMB_EDGE);
  let displaySize = fitWithin(width, height, DISPLAY_EDGE);

  if (options.write) {
    fs.mkdirSync(outDateDir, { recursive: true });
    // Byte-for-byte copy so the deployed site can serve the original download.
    fs.copyFileSync(source, psdFile);
    const copied = fs.statSync(psdFile).size;
    if (copied !== bytes) {
      warnings.push(`copied PSD size ${copied} != source ${bytes}`);
    }

    let composite: Canvas | undefined;
    if (raw) {
      try {
        // getCompositeCanvas is typed as the DOM HTMLCanvasElement but returns
        // the @napi-rs/canvas Canvas registered above. Cast confined here.
        composite = getCompositeCanvas(raw) as unknown as Canvas | undefined;
      } catch (error) {
        warnings.push(`composite decode failed (${errorMessage(error)}) - placeholder preview`);
      }
    }
    if (!composite) {
      if (!overBudget) warnings.push('no composite in PSD - placeholder preview');
    }

    try {
      const thumb = writePreview(
        composite ?? placeholderCanvas(width, height, THUMB_EDGE),
        outDateDir,
        `${name}.thumb`,
        THUMB_EDGE,
        format,
      );
      const display = writePreview(
        composite ?? placeholderCanvas(width, height, DISPLAY_EDGE),
        outDateDir,
        `${name}.display`,
        DISPLAY_EDGE,
        format,
      );
      thumbFile = thumb.file;
      displayFile = display.file;
      // Record what was actually encoded, not what we hoped for.
      thumbSize = { width: thumb.width, height: thumb.height };
      displaySize = { width: display.width, height: display.height };
    } catch (error) {
      // A failed preview must never abort the build; drop a placeholder instead.
      warnings.push(`preview encode failed (${errorMessage(error)}) - placeholder preview`);
      const thumb = writePreview(
        placeholderCanvas(width, height, THUMB_EDGE),
        outDateDir,
        `${name}.thumb`,
        THUMB_EDGE,
        format,
      );
      const display = writePreview(
        placeholderCanvas(width, height, DISPLAY_EDGE),
        outDateDir,
        `${name}.display`,
        DISPLAY_EDGE,
        format,
      );
      thumbFile = thumb.file;
      displayFile = display.file;
      thumbSize = { width: thumb.width, height: thumb.height };
      displaySize = { width: display.width, height: display.height };
    }
  }

  const preview: PreviewAssets = {
    thumb: joinUrl(base, publicPath(options.layout, thumbFile)),
    display: joinUrl(base, publicPath(options.layout, displayFile)),
    thumbWidth: thumbSize.width,
    thumbHeight: thumbSize.height,
    displayWidth: displaySize.width,
    displayHeight: displaySize.height,
  };

  const entry: WorkEntry = {
    index: numericNameKey(name),
    name,
    psd: joinUrl(base, publicPath(options.layout, psdFile)),
    bytes,
    width,
    height,
    preview,
    layerCount: countLayers(layers),
    layers,
  };

  return { entry, warnings };
}

// --- deterministic serialization -------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function sortKeysDeep(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, Json> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeysDeep(source[key]);
    }
    return out;
  }
  if (value === undefined) return null;
  return value as Json;
}

/** Pretty-printed with sorted keys so git diffs stay readable and stable. */
function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`;
}

// --- --check ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function diffValues(expected: unknown, actual: unknown, at: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push(`${at}: expected ${short(expected)}, got ${short(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      out.push(`${at}.length: expected ${expected.length}, got ${actual.length}`);
    }
    const count = Math.max(expected.length, actual.length);
    for (let i = 0; i < count && out.length < limit; i++) {
      diffValues(expected[i], actual[i], `${at}[${i}]`, out, limit);
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (out.length >= limit) return;
      diffValues(expected[key], actual[key], `${at}.${key}`, out, limit);
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    out.push(`${at}: expected ${short(expected)}, got ${short(actual)}`);
  }
}

/** Manifest URLs that point at files which are missing on disk. */
function missingAssets(manifest: Manifest, layout: Layout): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const group of manifest.groups) {
    for (const work of group.works) {
      for (const url of [work.psd, work.preview.thumb, work.preview.display]) {
        if (seen.has(url)) continue;
        seen.add(url);
        const onDisk = path.join(layout.siteRoot, stripUrlBase(manifest.base, url));
        if (!fs.existsSync(onDisk)) missing.push(rel(onDisk));
      }
    }
  }
  return missing;
}

/** Returns true when the committed manifest matches the freshly generated one. */
function runCheck(next: Manifest, nextText: string, layout: Layout): boolean {
  if (!fs.existsSync(layout.manifestFile)) {
    console.error(`[manifest] stale: ${rel(layout.manifestFile)} does not exist - run \`npm run manifest\``);
    return false;
  }
  const currentText = fs.readFileSync(layout.manifestFile, 'utf8');
  let current: Manifest;
  try {
    current = JSON.parse(currentText) as Manifest;
  } catch (error) {
    console.error(`[manifest] stale: ${rel(layout.manifestFile)} is not valid JSON (${errorMessage(error)})`);
    return false;
  }

  // generatedAt changes on every run, so it can never be part of the comparison.
  const IGNORED = '<generatedAt ignored by --check>';
  const diffs: string[] = [];
  diffValues(
    sortKeysDeep({ ...current, generatedAt: IGNORED }),
    sortKeysDeep({ ...next, generatedAt: IGNORED }),
    'manifest',
    diffs,
    DIFF_LIMIT,
  );

  const missing = missingAssets(next, layout);
  const stale = diffs.length > 0 || missing.length > 0;
  if (!stale) {
    console.log(`[manifest] up to date: ${rel(layout.manifestFile)} matches generated output`);
    return true;
  }

  console.error(`[manifest] stale: ${rel(layout.manifestFile)} differs from generated output`);
  if (diffs.length > 0) {
    console.error(`  ${diffs.length}${diffs.length >= DIFF_LIMIT ? '+' : ''} difference(s):`);
    for (const line of diffs) console.error(`    ${line}`);
  } else if (currentText === nextText) {
    console.error('  (content identical)');
  }
  if (missing.length > 0) {
    console.error(`  ${missing.length} referenced asset(s) missing, e.g. ${missing.slice(0, 5).join(', ')}`);
  }
  return false;
}

// --- reporting --------------------------------------------------------------

interface SummaryRow {
  date: string;
  file: string;
  bytes: number;
  layers: number;
  thumb: string;
  display: string;
  warnings: number;
}

function printTable(rows: readonly SummaryRow[], failures: readonly { file: string; error: string }[]): void {
  const header = ['date', 'file', 'bytes', 'layers', 'thumb', 'display', 'status'];
  const cells = rows.map((row) => [
    row.date,
    row.file,
    humanBytes(row.bytes),
    String(row.layers),
    row.thumb,
    row.display,
    row.warnings > 0 ? `${row.warnings} warning(s)` : 'ok',
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => row[column].length)),
  );
  const line = (row: readonly string[]) => `  ${row.map((cell, i) => cell.padEnd(widths[i])).join('  ')}`;
  console.log(line(header));
  console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  for (const row of cells) console.log(line(row));
  for (const failure of failures) {
    console.log(`  ${'FAILED'.padEnd(widths[0])}  ${rel(failure.file)}: ${failure.error}`);
  }
}

// --- main -------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const layout = createLayout(args.outDir);
  const format = detectImageFormat();
  const folders = listWorks(args.worksDir);

  log(
    `${rel(args.worksDir)} -> ${rel(layout.outDir)}  base ${args.base}  previews ${format.ext}` +
      `${args.check ? '  (check mode: nothing written)' : ''}`,
  );

  if (!args.check) {
    // Drop previews of works that no longer exist so a removed PSD cannot
    // linger in the deployed site. index-dates.json (deploy server) is kept.
    fs.rmSync(path.join(layout.outDir, 'works'), { recursive: true, force: true });
    fs.mkdirSync(layout.outDir, { recursive: true });
  }

  const groups: DateGroup[] = [];
  const rows: SummaryRow[] = [];
  const failures: { file: string; error: string }[] = [];
  let workCount = 0;
  let totalBytes = 0;

  for (const folder of folders) {
    const works: WorkEntry[] = [];
    for (const item of folder.files) {
      try {
        const built = buildWork(folder.date, item.name, item.file, args.base, format, {
          write: !args.check,
          layout,
        });
        works.push(built.entry);
        workCount += 1;
        totalBytes += built.entry.bytes;
        for (const message of built.warnings) warn(`${rel(item.file)}: ${message}`);
        rows.push({
          date: folder.date,
          file: item.name,
          bytes: built.entry.bytes,
          layers: built.entry.layerCount,
          thumb: `${built.entry.preview.thumbWidth}x${built.entry.preview.thumbHeight}`,
          display: `${built.entry.preview.displayWidth}x${built.entry.preview.displayHeight}`,
          warnings: built.warnings.length,
        });
      } catch (error) {
        // One unreadable PSD must never abort the whole build.
        failures.push({ file: item.file, error: errorMessage(error) });
        warn(`skipping ${rel(item.file)}: ${errorMessage(error)}`);
      }
    }
    if (works.length > 0) groups.push({ date: folder.date, works });
  }

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    base: args.base,
    totals: { works: workCount, bytes: totalBytes },
    groups,
  };
  const text = serializeManifest(manifest);

  console.log('');
  if (rows.length === 0) {
    warn(`no PSD found under ${rel(args.worksDir)} - writing an empty manifest`);
  }
  printTable(rows, failures);

  if (args.check) {
    console.log('');
    if (!runCheck(manifest, text, layout)) process.exitCode = 1;
    return;
  }

  fs.writeFileSync(layout.manifestFile, text);
  console.log('');
  log(
    `wrote ${rel(layout.manifestFile)} - ${workCount} work(s) in ${groups.length} date group(s), ` +
      `${humanBytes(totalBytes)}, ${format.ext} previews`,
  );
  if (failures.length > 0) {
    // Deliberately still exit 0: one unreadable PSD must not abort the deploy
    // of everything else. The FAILED rows above and these warnings are the
    // signal, and the file is simply absent from the manifest.
    warn(`${failures.length} file(s) failed and were omitted from the manifest (build continued)`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[manifest] fatal: ${errorMessage(error)}`);
  process.exitCode = 1;
}
