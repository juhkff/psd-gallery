/**
 * DecodeProgress: the wait, made legible.
 *
 * The worker already reports a real 0..1 `progress` plus a Chinese
 * `progressLabel` (`psd/protocol.ts#ProgressResponse`) while it fetches, reads
 * the layer tree, decodes layer pixels and composites. This component renders
 * *only* those numbers - never a timed fake bar, never an invented percentage:
 *
 *  - `progress > 0` -> a determinate bar whose fill is the worker's fraction,
 *    over a ruler of tick marks sized by the document's real layer count.
 *  - `progress === 0` -> an honestly indeterminate shimmer (`shimmer-line`),
 *    with no `aria-valuenow` claimed.
 *  - the only other number on screen is elapsed wall time and the real
 *    document/layer counts from the manifest.
 *
 * It is an overlay: pointer-transparent, no decode work, no canvas.
 */

import { useEffect, useMemo, useState } from 'react';
import { formatElapsed, formatProgress, formatSize, stripTrailingPercent } from '../lib/format';
import type { PsdStatus } from '../psd/usePsdWork';

/** The two real phases the hook can be in: the worker sets `status` per phase. */
const PHASES = ['下载', '解码'] as const;

export interface DecodeProgressProps {
  status: PsdStatus;
  /** Worker-reported overall progress, 0..1. */
  progress: number;
  /** Worker-reported Chinese status line. */
  progressLabel: string;
  layerCount: number;
  documentWidth: number;
  documentHeight: number;
}

function MetaDot() {
  return <span aria-hidden="true" className="h-0.5 w-0.5 rounded-full bg-studio-600" />;
}

function LocalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M4.5 7V5.4a3.5 3.5 0 0 1 7 0V7" />
      <rect x="3" y="7" width="10" height="6.2" rx="1.4" />
    </svg>
  );
}

export function DecodeProgress({
  status,
  progress,
  progressLabel,
  layerCount,
  documentWidth,
  documentHeight,
}: DecodeProgressProps) {
  const busy = status === 'loading' || status === 'decoding';
  const [elapsedMs, setElapsedMs] = useState(0);

  // Elapsed wall time of the current wait. Reset whenever a new wait starts
  // (load, route change, retry); the 100 ms cadence only updates a label.
  useEffect(() => {
    if (!busy) {
      setElapsedMs(0);
      return;
    }
    const startedAt = performance.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 100);
    return () => window.clearInterval(timer);
  }, [busy]);

  // Ruler marks: an honest density cue derived from the real layer count, not
  // a claim about how many layers are done.
  const tickCount = useMemo(() => {
    const rough = Math.round(layerCount / 2);
    return Math.min(44, Math.max(14, rough || 18));
  }, [layerCount]);

  if (!busy) return null;

  const hasFraction = Number.isFinite(progress) && progress > 0;
  const phaseIndex = status === 'loading' ? 0 : 1;
  // The worker's fetch label embeds its own *phase-local* percentage
  // ("正在下载 PSD… 34%") while the bar below is the worker's *overall*
  // progress; `stripTrailingPercent` drops the duplicate so exactly one
  // percentage is ever on screen - the one the bar and aria-valuenow report.
  const labelText = stripTrailingPercent(progressLabel) || '正在解码 PSD…';

  return (
    // Raised above the floating zoom control on phones, level with it from `sm`.
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center p-3 sm:bottom-3 sm:p-4">
      <div className="glass w-full max-w-sm animate-fade-up rounded-2xl px-4 py-3 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.95)]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-accent" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            <span className="truncate text-xs text-studio-100">{labelText || '正在解码 PSD…'}</span>
          </div>
          {hasFraction && (
            <span className="font-display text-xl leading-none tabular-nums text-gradient-gold">
              {formatProgress(progress)}
            </span>
          )}
        </div>

        <div
          role="progressbar"
          aria-label="PSD 解码进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={hasFraction ? Math.round(progress * 100) : undefined}
          aria-valuetext={hasFraction ? undefined : '正在解码，进度未知'}
          className="relative mt-2.5 h-1.5 overflow-hidden rounded-full bg-studio-800/90 ring-1 ring-inset ring-studio-100/5"
        >
          <span aria-hidden="true" className="absolute inset-0 flex items-stretch justify-between px-px opacity-70">
            {Array.from({ length: tickCount }, (_, index) => (
              <span key={index} className="w-px bg-studio-600/80" />
            ))}
          </span>
          {hasFraction ? (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-ember via-accent to-accent-soft transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(1.5, progress * 100)}%` }}
            />
          ) : (
            <span aria-hidden="true" className="shimmer-line absolute inset-0" />
          )}
        </div>

        <ol className="mt-2 flex items-center gap-2 text-[10px] text-studio-400">
          {PHASES.map((label, index) => (
            <li key={label} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`h-1 w-1 rounded-full ${
                  index < phaseIndex ? 'bg-accent' : index === phaseIndex ? 'animate-pulse bg-accent' : 'bg-studio-600'
                }`}
              />
              <span className={index <= phaseIndex ? 'text-studio-300' : undefined}>{label}</span>
              {index < PHASES.length - 1 && <span aria-hidden="true" className="h-px w-4 bg-studio-700" />}
            </li>
          ))}
        </ol>

        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-studio-400">
          <span className="inline-flex items-center gap-1 text-studio-300">
            <LocalIcon />
            本地浏览器解码
          </span>
          <MetaDot />
          <span className="tabular-nums text-studio-300">{formatElapsed(elapsedMs)}</span>
          {layerCount > 0 && (
            <>
              <MetaDot />
              <span className="tabular-nums">{layerCount} 个图层</span>
            </>
          )}
          {documentWidth > 0 && documentHeight > 0 && (
            <>
              <MetaDot />
              <span className="tabular-nums">{formatSize(documentWidth, documentHeight)} px</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export default DecodeProgress;
