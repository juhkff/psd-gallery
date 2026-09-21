/**
 * URL helpers shared by the build script and the browser.
 *
 * Everything the manifest stores is written against the site root that Vite
 * is built with (`base`), so a GitHub Pages project site served from
 * "/psd-gallery/" resolves correctly.
 */

/** Normalize a Vite `base` value: "" or "/repo/" (always leading+trailing slash). */
export function normalizeBase(base: string | undefined): string {
  if (!base || base === '/') return '/';
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/** Join a normalized base with a site-relative path. */
export function joinUrl(base: string, relative: string): string {
  const b = normalizeBase(base);
  const r = relative.replace(/^\/+/, '');
  return b === '/' ? `/${r}` : `${b}${r}`;
}

/** Inverse of {@link joinUrl}: recover a site-relative path from a stored URL. */
export function stripUrlBase(base: string, url: string): string {
  const b = normalizeBase(base);
  if (b === '/') return url.replace(/^\/+/, '');
  return url.startsWith(b) ? url.slice(b.length) : url.replace(/^\/+/, '');
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Turn "2026-09-21" into "2026年9月21日" for display; falls back to the raw value. */
export function formatDateLabel(date: string): string {
  if (!ISO_DATE.test(date)) return date;
  const [y, m, d] = date.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** Numeric-aware sort key for file stems like "1", "2", "10". */
export function numericNameKey(name: string): number {
  const n = Number.parseInt(name, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}
