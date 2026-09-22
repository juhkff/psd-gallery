/**
 * DecodeProgress: the wait, made legible.
 *
 * The worker already reports a real 0..1 `progress` plus a Chinese
 * `progressLabel` (`psd/protocol.ts#ProgressResponse`) while it fetches, reads
 * the layer tree, decodes layer pixels and composites. This component renders
 * *only* those numbers - never a timed fake bar, never an invented percentage:
 *
 *  - `progress > 0` -> a determinate bar whose fill is the worker's fraction,
 *    over a ruler of tick marks sized by the document's real layer count, with a
 *    light head (halo + core + trail) marking the leading edge.
 *  - `progress === 0` -> an honestly indeterminate shimmer (`shimmer-line`),
 *    with no `aria-valuenow` claimed.
 *  - the phase rail shows only the two phases the worker actually sets
 *    (`status`: loading -> decoding). Exactly one is marked current, with shape
 *    as well as colour: done = check in a filled node, current = pulsing core
 *    behind a lit ring, upcoming = hollow node.
 *  - the only other number on screen is elapsed wall time and the real
 *    document/layer counts from the manifest.
 *
 * It is an overlay: pointer-transparent, no decode work, no canvas. Because the
 * whole card is pointer-transparent it deliberately does NOT enable the
 * pointer-tracked specular - a hover highlight would require stealing pointer
 * events from the canvas underneath.
 */

import { useEffect, useMemo, useState } from 'react';
import { formatElapsed, formatProgress, formatSize, stripTrailingPercent } from '../lib/format';
import type { PsdStatus } from '../psd/usePsdWork';

/** The two real phases the hook can be in: the worker sets `status` per phase. */
const PHASES = ['下载', '读取图层'] as const;

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
  return <span aria-hidden="true" className="h-0.5 w-0.5 rounded-full bg-ink-600" />;
}


type PhaseState = 'done' | 'current' | 'todo';

/** Shape carries the state: check / pulsing core / hollow dot. */
function PhaseMark({ state }: { state: PhaseState }) {
  if (state === 'done') {
    return (
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M2.4 6.3 4.7 8.6 9.6 3.5" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`rounded-full ${state === 'current' ? 'h-1.5 w-1.5 animate-pulse bg-accent-soft' : 'h-1 w-1 bg-ink-600'}`}
    />
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
  const labelText = stripTrailingPercent(progressLabel) || '正在读取图层…';

  return (
    // Raised above the floating zoom control on phones, level with it from `sm`.
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center p-3 sm:bottom-3 sm:p-4">
      <div className="panel w-full max-w-sm animate-fade-in px-4 py-3">
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <span className="truncate text-xs text-ink-100">{labelText}</span>
            </div>
            {hasFraction && (
              <span className="font-display text-xl leading-none tabular-nums">
                {formatProgress(progress)}
              </span>
            )}
          </div>

          {/* Light travelling along a fibre: a recessed track carrying the tick
              ruler, then the worker's real fraction on top with a travelling
              head - a soft halo, a hard core, and a short trail behind it. */}
          <div
            role="progressbar"
            aria-label="读取进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={hasFraction ? Math.round(progress * 100) : undefined}
            aria-valuetext={hasFraction ? undefined : '进度未知'}
            className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-ink-950/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-ink-100/10"
          >
            {/* Tick ruler: an honest density cue from the real layer count, kept
                at low contrast so it never competes with the travelling light -
                at higher opacity it reads as a barcode instead of a fibre. */}
            <span aria-hidden="true" className="absolute inset-0 flex items-stretch justify-between px-px opacity-45">
              {Array.from({ length: tickCount }, (_, index) => (
                <span key={index} className="w-px bg-ink-100/[0.16]" />
              ))}
            </span>
            {hasFraction ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-ember via-accent to-accent-soft shadow-[0_0_16px_-2px_rgba(201,162,39,0.9)] transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(1.5, progress * 100)}%` }}
              >
                <span className="absolute inset-0 overflow-hidden rounded-full">
                  <span className="shimmer-line absolute inset-0 opacity-70" />
                </span>
                <span className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2">
                  <span className="absolute right-0 top-1/2 h-1 w-10 -translate-y-1/2 bg-gradient-to-l from-ink-100/70 to-transparent blur-[1px]" />
                  <span className="absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-ink-100/60 blur-[3px]" />
                  <span className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-ink-100 shadow-[0_0_10px_3px_rgba(236,236,242,0.6)]" />
                </span>
              </span>
            ) : (
              <span aria-hidden="true" className="shimmer-line absolute inset-0" />
            )}
          </div>

          {/* The phase rail: exactly one node is current, and the connector
              behind it is lit - so "where am I" is readable without reading. */}
          <ol className="mt-2.5 flex items-center text-[10px]">
            {PHASES.map((label, index) => {
              const state: PhaseState = index < phaseIndex ? 'done' : index === phaseIndex ? 'current' : 'todo';
              return (
                <li
                  key={label}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className="flex items-center"
                >
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 ${
                      state === 'current' ? 'bg-accent/[0.12] ring-1 ring-inset ring-accent/30' : ''
                    }`}
                  >
                    <span
                      className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                        state === 'done'
                          ? 'border-accent/45 bg-accent/20 text-accent-soft'
                          : state === 'current'
                            ? 'border-accent/60 bg-accent/15 text-accent-soft shadow-[0_0_10px_-1px_rgba(201,162,39,0.85)]'
                            : 'border-ink-100/[0.14] bg-ink-950/40 text-ink-600'
                      }`}
                    >
                      <PhaseMark state={state} />
                    </span>
                    <span
                      className={
                        state === 'current'
                          ? 'font-medium text-ink-100'
                          : state === 'done'
                            ? 'text-ink-300'
                            : 'text-ink-400'
                      }
                    >
                      {label}
                    </span>
                  </span>
                  {index < PHASES.length - 1 && (
                    <span
                      aria-hidden="true"
                      className={`mx-1.5 h-px w-6 ${state === 'done' ? 'bg-accent/45' : 'bg-ink-100/[0.14]'}`}
                    />
                  )}
                </li>
              );
            })}
          </ol>

          <div aria-hidden="true" className="rule mt-2.5" />

          {/* The card can sit over a bright print, and the artwork shows through
              the glass tint: the meta line is one step brighter than the usual
              micro-label so it stays readable on the lightest backdrop. */}
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-ink-300">
            <span className="tabular-nums">{formatElapsed(elapsedMs)}</span>
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
    </div>
  );
}

export default DecodeProgress;
