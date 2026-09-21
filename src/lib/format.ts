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
