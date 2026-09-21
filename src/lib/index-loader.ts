/**
 * Build-artifact discovery: `generated/index-dates.json`.
 *
 * The deploy server can list the files it actually has in `works/<date>/`, so a
 * PSD that was uploaded *after* the site was built can still be revealed. Those
 * files have no thumbnail, no preview and no layer data - they can only be
 * listed and downloaded, and the UI says so explicitly.
 *
 * Loading is strictly best-effort: a missing index (404), a broken JSON file or
 * a network failure is a silent no-op, never an error state.
 */

import type { IndexEntry, IndexResponse, Manifest } from '../../shared/manifest';
import { ISO_DATE, joinUrl, normalizeBase } from '../../shared/paths';

export const INDEX_PATH = 'generated/index-dates.json';

export const CATEGORY_LABELS: Record<IndexEntry['category'], string> = {
  psd: 'PSD',
  ai: 'Illustrator',
  image: '图片',
  other: '其他',
};

const CATEGORIES: readonly IndexEntry['category'][] = ['psd', 'ai', 'image', 'other'];

/** Site-absolute URL of the deploy-time file index, honoring Vite's `base`. */
export function indexUrl(base: string | undefined = import.meta.env.BASE_URL): string {
  return joinUrl(normalizeBase(base), INDEX_PATH);
}

export interface UnbuiltFile {
  date: string;
  /** File name **including** the extension, e.g. "1.psd" (unlike WorkEntry.name). */
  name: string;
  /** File name without the extension, for display. */
  stem: string;
  extension: string;
  category: IndexEntry['category'];
  bytes: number;
  /** Site-absolute download URL. */
  url: string;
}

export interface UnbuiltGroup {
  date: string;
  files: UnbuiltFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFinite(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asCategory(value: unknown): IndexEntry['category'] {
  const text = asString(value)?.toLowerCase();
  return (CATEGORIES as readonly string[]).includes(text ?? '') ? (text as IndexEntry['category']) : 'other';
}

/** Validate an unknown JSON value into an {@link IndexResponse} (null when unusable). */
export function parseIndexResponse(raw: unknown): IndexResponse | null {
  if (!isRecord(raw) || !isRecord(raw.dates)) return null;
  const dates: Record<string, IndexEntry[]> = {};
  for (const [date, entriesRaw] of Object.entries(raw.dates)) {
    if (!ISO_DATE.test(date) || !Array.isArray(entriesRaw)) continue;
    const entries: IndexEntry[] = [];
    for (const entryRaw of entriesRaw) {
      if (!isRecord(entryRaw)) continue;
      const name = asString(entryRaw.name)?.trim();
      if (!name) continue;
      entries.push({
        name,
        bytes: Math.max(0, asFinite(entryRaw.bytes) ?? 0),
        category: asCategory(entryRaw.category),
      });
    }
    if (entries.length > 0) dates[date] = entries;
  }
  return {
    dates,
    generatedAt: asString(raw.generatedAt) ?? '',
  };
}

/** File name of an URL, decoded, without query/hash. */
export function fileNameOf(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? '';
  const parts = clean.split('/');
  const last = parts[parts.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** `date/fileName` keys of everything that already has a built work. */
export function builtFileKeys(manifest: Manifest | null): Set<string> {
  const keys = new Set<string>();
  for (const group of manifest?.groups ?? []) {
    for (const work of group.works) {
      keys.add(`${group.date}/${fileNameOf(work.psd)}`);
    }
  }
  return keys;
}

function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot + 1).toLowerCase() };
}

function fileUrl(base: string, date: string, name: string): string {
  const safePath = name
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return joinUrl(normalizeBase(base), `works/${date}/${safePath}`);
}

/**
 * Index entries that the manifest does not know about, newest date first.
 * The comparison is on `date + file name (with extension)`.
 */
export function listUnbuiltFiles(
  index: IndexResponse | null,
  manifest: Manifest | null,
  base: string | undefined = import.meta.env.BASE_URL,
): UnbuiltGroup[] {
  if (!index) return [];
  const built = builtFileKeys(manifest);
  const groups: UnbuiltGroup[] = [];
  for (const [date, entries] of Object.entries(index.dates)) {
    if (!ISO_DATE.test(date)) continue;
    const files: UnbuiltFile[] = [];
    for (const entry of entries) {
      if (built.has(`${date}/${entry.name}`)) continue;
      const { stem, extension } = splitName(entry.name);
      files.push({
        date,
        name: entry.name,
        stem,
        extension,
        category: entry.category,
        bytes: entry.bytes,
        url: fileUrl(base ?? '/', date, entry.name),
      });
    }
    if (files.length > 0) {
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
      groups.push({ date, files });
    }
  }
  groups.sort((a, b) => b.date.localeCompare(a.date));
  return groups;
}

export interface LoadServerIndexOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Fetch + validate the deploy index. Returns null for *any* failure (silent). */
export async function loadServerIndex(options: LoadServerIndexOptions = {}): Promise<IndexResponse | null> {
  const doFetch: typeof fetch | undefined =
    options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  if (!doFetch) return null;
  try {
    const response = await doFetch(indexUrl(options.base), {
      signal: options.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    return parseIndexResponse(raw);
  } catch {
    return null;
  }
}
