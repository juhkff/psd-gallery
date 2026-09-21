/**
 * Deploy-server date index generator.
 *
 * GitHub Pages cannot list directories at runtime (DECISIONS.md #1) and the
 * build-time manifest only refreshes on CI runs. This script is meant to run
 * periodically on the VPS that mirrors the site: it scans `<root>/YYYY-MM-DD/`
 * and writes a small `index-dates.json` (shared/manifest.ts -> IndexResponse)
 * so files dropped in after the last build are discoverable without a rebuild.
 *
 *   npx tsx scripts/build-index.ts --root /srv/psd-mirror/works --out public/generated/index-dates.json
 *
 * `IndexEntry.name` is the FULL file name including extension ("1.psd",
 * "ref.png"): unlike WorkEntry.name (a stem) this list mixes several extensions
 * per category, so the extension is the only unambiguous way to rebuild URLs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexEntry, IndexResponse } from '../shared/manifest';
import { ISO_DATE } from '../shared/paths';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_ROOT = process.env.INDEX_ROOT ?? path.join(ROOT, 'works');
const DEFAULT_OUT = process.env.INDEX_OUT ?? path.join(ROOT, 'public', 'generated', 'index-dates.json');

type Category = IndexEntry['category'];

/** Extension -> category, exactly as specified by the IndexEntry contract. */
const CATEGORY_BY_EXTENSION: Readonly<Record<string, Category>> = {
  '.psd': 'psd',
  '.ai': 'ai',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  console.log(`[index] ${message}`);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function categoryOf(fileName: string): Category {
  return CATEGORY_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'other';
}

// --- CLI --------------------------------------------------------------------

interface CliArgs {
  root: string;
  out: string;
}

function printUsage(): void {
  console.log(
    [
      'Usage: npx tsx scripts/build-index.ts [options]',
      '',
      '  --root <dir>   Directory containing YYYY-MM-DD folders (env INDEX_ROOT)',
      `                 default: ${path.relative(ROOT, DEFAULT_ROOT) || '.'}`,
      '  --out <file>   index-dates.json output path (env INDEX_OUT)',
      `                 default: ${path.relative(ROOT, DEFAULT_OUT)}`,
      '  -h, --help     Show this help',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): CliArgs {
  let root = DEFAULT_ROOT;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error('--root requires a value');
      root = path.resolve(value);
    } else if (arg.startsWith('--root=')) {
      root = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a value');
      out = path.resolve(value);
    } else if (arg.startsWith('--out=')) {
      out = path.resolve(arg.slice('--out='.length));
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, out };
}

// --- scan -------------------------------------------------------------------

interface DateScan {
  date: string;
  entries: IndexEntry[];
  bytes: number;
}

/** Numeric-aware stem order, then extension, so "2.psd" comes after "1.psd". */
function compareFileNames(a: string, b: string): number {
  const stemA = Number.parseInt(path.basename(a, path.extname(a)), 10);
  const stemB = Number.parseInt(path.basename(b, path.extname(b)), 10);
  const numA = Number.isFinite(stemA) ? stemA : Number.MAX_SAFE_INTEGER;
  const numB = Number.isFinite(stemB) ? stemB : Number.MAX_SAFE_INTEGER;
  if (numA !== numB) return numA - numB;
  return a < b ? -1 : a > b ? 1 : 0;
}

function scanRoot(root: string): DateScan[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`root is not a directory: ${root}`);
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const ignored = entries
    .filter((entry) => entry.isDirectory() && !ISO_DATE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (ignored.length > 0) {
    log(`ignoring non-ISO-date folder(s): ${ignored.join(', ')}`);
  }

  const scans: DateScan[] = [];
  for (const date of entries
    .filter((entry) => entry.isDirectory() && ISO_DATE.test(entry.name))
    .map((entry) => entry.name)
    .sort()) {
    const files = fs
      .readdirSync(path.join(root, date), { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareFileNames);
    if (files.length === 0) continue;

    const items: IndexEntry[] = [];
    let bytes = 0;
    for (const file of files) {
      const stat = fs.statSync(path.join(root, date, file));
      bytes += stat.size;
      items.push({ name: file, bytes: stat.size, category: categoryOf(file) });
    }
    scans.push({ date, entries: items, bytes });
  }
  return scans;
}

// --- serialization ----------------------------------------------------------

// Kept local (rather than shared with build-manifest.ts) so each script stays a
// self-contained tool for the VPS cron job.
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

// --- main -------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scans = scanRoot(args.root);

  const dates: Record<string, IndexEntry[]> = {};
  for (const scan of scans) dates[scan.date] = scan.entries;

  const response: IndexResponse = {
    dates,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(sortKeysDeep(response), null, 2)}\n`);

  log(`root ${args.root}`);
  let files = 0;
  let bytes = 0;
  for (const scan of scans) {
    const byCategory = new Map<Category, number>();
    for (const entry of scan.entries) {
      byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
    }
    const breakdown = [...byCategory.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([category, count]) => `${category}:${count}`)
      .join(' ');
    files += scan.entries.length;
    bytes += scan.bytes;
    console.log(
      `  ${scan.date}  ${String(scan.entries.length).padStart(3)} file(s)  ` +
        `${humanBytes(scan.bytes).padStart(10)}  ${breakdown}`,
    );
  }
  log(`wrote ${args.out} - ${files} file(s) in ${scans.length} date folder(s), ${humanBytes(bytes)} total`);
}

try {
  main();
} catch (error) {
  console.error(`[index] fatal: ${errorMessage(error)}`);
  process.exitCode = 1;
}
