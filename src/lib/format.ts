/**
 * Small display helpers shared by the gallery and the viewer.
 * Pure string/number formatting only - safe on the main thread.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** "3.5 MB" - always at most `digits` decimals, unit-scaled. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Number(value.toFixed(digits));
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** "1200 × 800" */
export function formatSize(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** "8.7 MP" / "0.96 MP" */
export function formatMegapixels(width: number, height: number): string {
  const mp = (width * height) / 1_000_000;
  if (!Number.isFinite(mp) || mp <= 0) return '—';
  return `${mp >= 10 ? mp.toFixed(0) : mp.toFixed(2)} MP`;
}

/** 0..1 -> "80%" */
export function formatOpacity(opacity: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  return `${Math.round(clamped * 100)}%`;
}

/** 0..1 -> "42%" (progress, never rounds a partial step down to 0%). */
export function formatProgress(progress: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * A CSS-pixels-per-document-pixel zoom factor -> "18%".
 *
 * Used by the viewer's zoom control; `1` means one document pixel per CSS
 * pixel ("100%"), which is the only number the label ever claims.
 */
export function formatScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '—';
  return `${Math.round(scale * 100)}%`;
}

/**
 * Elapsed wall time of a short wait -> "0.8s" / "1.4s" / "12s".
 *
 * One decimal below ten seconds (the decode window we actually observe),
 * whole seconds above it so the label never jitters in width.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** Long-form duration for tooltips/readouts -> "820 ms" / "1.4 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * Drop a trailing *phase-local* percentage from a worker status label.
 *
 * The worker's fetch phase reports its own fraction inside the label
 * ("正在下载 PSD… 34%", `psd.worker.ts`), while the UI bars show the worker's
 * *overall* progress (fetch is only the first 12% of the wait). Printing both
 * next to each other reads as a contradiction, so callers strip the duplicate
 * number and show the worker's overall progress exactly once.
 */
export function stripTrailingPercent(label: string): string {
  return label.replace(/\s*\d{1,3}%\s*$/, '').trim();
}
