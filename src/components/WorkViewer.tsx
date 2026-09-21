/**
 * WorkViewer: the PSD viewer for one work.
 *
 * First paint is the build-time `display.webp` preview (already in the HTTP
 * cache from the gallery); the live `<canvas>` crossfades in over it with a
 * small scale settle as soon as the worker hands over a composited ImageBitmap.
 * The preview stays mounted underneath, so there is never a blank frame - but
 * it is always a separate `<img>`, so the live canvas is unambiguously
 * identifiable.
 *
 * The stage is a real viewer, not a fixed picture: the document surface is
 * sized in CSS pixels from the measured stage (fit) or from the document's own
 * pixels (100%), so a 2480x3508 A4 @300dpi scan can be inspected at 1:1 and
 * panned. Zooming only touches layout/transform; decode stays in the worker.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { WorkEntry } from '../../shared/manifest';
import { formatDateLabel } from '../../shared/paths';
import { formatBytes, formatMegapixels, formatScale, formatSize } from '../lib/format';
import { forceProxyFromHash } from '../lib/route';
import { collectCaveats } from '../psd/layer-info';
import { usePsdWork } from '../psd/usePsdWork';
import { DecodeProgress } from './DecodeProgress';
import { LayerPanel } from './LayerPanel';
import { Toolbar } from './Toolbar';

/** Absolute zoom bounds, in CSS pixels per document pixel. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
/** One press of the +/- controls. */
const ZOOM_STEP = 1.25;
/** One ctrl/⌘ + wheel notch. */
const WHEEL_STEP = 1.12;

type ZoomMode = 'fit' | 'actual' | 'custom';

export interface WorkViewerProps {
  date: string;
  work: WorkEntry;
  /** Called by the "返回图库" control (the App decides how to navigate). */
  onClose: () => void;
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-studio-700/70 bg-studio-900/60 px-2 py-0.5 text-[11px] tabular-nums text-studio-300">
      {children}
    </span>
  );
}

function ZoomButton({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={title ?? label}
      className={`rounded-full px-2 py-1 text-[11px] leading-none transition ${
        active ? 'bg-accent/20 text-accent-soft' : 'text-studio-300 hover:bg-studio-700/70 hover:text-studio-100'
      }`}
    >
      {children}
    </button>
  );
}

export function WorkViewer({ date, work, onClose }: WorkViewerProps) {
  // `#/date/name?proxy=1` forces the proxy path (debug/e2e affordance for
  // machines whose sample PSDs are all below the proxy threshold).
  const [forceProxy] = useState(() => forceProxyFromHash(window.location.hash));
  const psd = usePsdWork(work, forceProxy);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frame = psd.frame;

  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const [customScale, setCustomScale] = useState(1);

  // Drawing one bitmap is a sub-millisecond main-thread operation; decoding
  // never happens here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame.bitmap, 0, 0);
  }, [frame]);

  // Measure the stage so "fit" can mean exactly that. Measured before paint to
  // avoid a zero-sized first frame; ResizeObserver keeps it true afterwards.
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setStage((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const documentWidth = psd.documentWidth || work.width;
  const documentHeight = psd.documentHeight || work.height;
  const preview = work.preview;
  const busy = psd.status === 'loading' || psd.status === 'decoding';

  // `fitScale`: one CSS pixel per document pixel at which the whole document is
  // visible inside the stage (minus the surface padding).
  const fitScale = useMemo(() => {
    const availableWidth = stage.width - 16;
    const availableHeight = stage.height - 16;
    if (availableWidth <= 0 || availableHeight <= 0 || documentWidth <= 0 || documentHeight <= 0) return 0;
    return Math.min(availableWidth / documentWidth, availableHeight / documentHeight);
  }, [stage.width, stage.height, documentWidth, documentHeight]);

  const scale = zoomMode === 'fit' ? fitScale : zoomMode === 'actual' ? 1 : customScale;

  // Latest values for the imperative wheel listener / key handlers.
  const zoomStateRef = useRef({ fitScale, customScale, zoomMode });
  zoomStateRef.current = { fitScale, customScale, zoomMode };

  const zoomBy = useCallback((factor: number) => {
    const current = zoomStateRef.current;
    const active = current.zoomMode === 'fit' ? current.fitScale : current.zoomMode === 'actual' ? 1 : current.customScale;
    if (active <= 0) return;
    const floor = Math.max(MIN_ZOOM, current.fitScale > 0 ? current.fitScale * 0.25 : MIN_ZOOM);
    setCustomScale(Math.min(MAX_ZOOM, Math.max(floor, active * factor)));
    setZoomMode('custom');
  }, []);

  const fitToWindow = useCallback(() => setZoomMode('fit'), []);
  const actualSize = useCallback(() => setZoomMode('actual'), []);

  // Zoom is ctrl/⌘ + wheel, so a plain wheel still scrolls the document. The
  // listener is native and non-passive: React's root wheel listener is passive,
  // and this one has to be able to call preventDefault().
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomByRef.current(event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const onStageKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (event.key === '0') {
        event.preventDefault();
        fitToWindow();
      } else if (event.key === '1') {
        event.preventDefault();
        actualSize();
      }
    },
    [actualSize, fitToWindow, zoomBy],
  );

  const toggleFitAndActual = useCallback(() => {
    setZoomMode((mode) => (mode === 'fit' ? 'actual' : 'fit'));
  }, []);

  // The document surface, in CSS pixels. Until the stage has been measured the
  // surface falls back to the stage width at the document's own aspect ratio.
  const measured = documentWidth > 0 && documentHeight > 0 && scale > 0;
  const surfaceStyle = measured
    ? { width: Math.round(documentWidth * scale), height: Math.round(documentHeight * scale) }
    : { width: '100%', aspectRatio: `${documentWidth} / ${documentHeight}` };

  // Caveats from the worker once it has read the PSD; before that, derived from
  // the manifest tree so the warning is visible during the decode.
  const manifestCaveats = useMemo(
    () => collectCaveats(work.layers, { useProxy: false }),
    [work.layers],
  );
  const caveats = psd.caveats.length > 0 ? psd.caveats : manifestCaveats;

  const allCaveats = caveats.length > 0;

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="group inline-flex items-center gap-1.5 rounded-full border border-studio-700/80 bg-studio-900/50 px-2.5 py-1 text-[11px] text-studio-300 transition hover:border-accent/60 hover:text-accent"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 transition-transform duration-300 group-hover:-translate-x-0.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M9.5 3.5 5 8l4.5 4.5" />
              <path d="M5.5 8H13" />
            </svg>
            返回图库
          </button>

          <h1 className="mt-2 flex min-w-0 items-baseline gap-2 text-xl font-semibold sm:text-2xl">
            <span className="shrink-0 font-display text-base text-studio-300 sm:text-lg">{formatDateLabel(date)}</span>
            <span aria-hidden="true" className="text-studio-600">
              /
            </span>
            <span className="truncate">{work.name}.psd</span>
          </h1>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <MetaChip>{formatSize(documentWidth, documentHeight)} px</MetaChip>
            <MetaChip>{formatMegapixels(documentWidth, documentHeight)}</MetaChip>
            <MetaChip>{work.layerCount} 个图层</MetaChip>
            <MetaChip>{formatBytes(work.bytes)}</MetaChip>
          </div>
        </div>

        <a
          data-testid="download-psd"
          href={work.psd}
          download={`${date}-${work.name}.psd`}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-b from-accent-soft to-accent px-4 py-2.5 text-sm font-semibold text-studio-950 shadow-[0_14px_36px_-14px_rgba(201,162,39,0.85)] transition hover:brightness-[1.08] active:scale-[0.98]"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M8 2.5v7.2" />
            <path d="M5.2 7.2 8 10l2.8-2.8" />
            <path d="M3 12.5h10" />
          </svg>
          下载 PSD
          <span className="rounded-md bg-studio-950/15 px-1.5 py-px text-[11px] font-medium tabular-nums">
            {formatBytes(work.bytes)}
          </span>
        </a>
      </header>

      <div className="flex min-h-0 flex-col gap-4 lg:flex-row">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="relative">
            <div
              ref={stageRef}
              tabIndex={0}
              role="region"
              aria-label="作品画布：可缩放、可滚动"
              title="双击在适应窗口与 100% 之间切换 · Ctrl/⌘ + 滚轮缩放 · 焦点上用 +/-/0/1 键"
              onDoubleClick={toggleFitAndActual}
              onKeyDown={onStageKeyDown}
              className="studio-backdrop relative overflow-auto overscroll-contain rounded-2xl border border-studio-700/80 bg-studio-950/60 shadow-[0_36px_90px_-50px_rgba(0,0,0,1)]"
              style={{ height: 'clamp(20rem, 62vh, 48rem)' }}
            >
              <div className="flex min-h-full min-w-full p-2">
                <div
                  className="checkerboard relative m-auto shrink-0 overflow-hidden rounded-lg ring-1 ring-studio-100/10"
                  style={surfaceStyle}
                >
                  {preview.display && (
                    <img
                      src={preview.display}
                      width={preview.displayWidth}
                      height={preview.displayHeight}
                      alt=""
                      aria-hidden="true"
                      decoding="async"
                      className={`absolute inset-0 h-full w-full object-contain transition duration-700 ease-out ${
                        frame ? 'scale-[1.025] opacity-0' : 'scale-100 opacity-100'
                      }`}
                    />
                  )}
                  <canvas
                    data-testid="work-canvas"
                    ref={canvasRef}
                    className={`absolute inset-0 h-full w-full object-contain transition duration-700 ease-out ${
                      frame ? 'scale-100 opacity-100' : 'scale-[1.035] opacity-0'
                    }`}
                  />
                  {/* A designed edge for the transparency surface: hairline +
                      inner shade, never over the artwork's own pixels centre. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-lg shadow-[inset_0_0_0_1px_rgba(236,236,242,0.07),inset_0_0_70px_rgba(0,0,0,0.35)]"
                  />
                </div>
              </div>
            </div>

            <span className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-studio-600/70 bg-studio-950/70 px-2 py-0.5 text-[10px] text-studio-300 backdrop-blur">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${frame ? 'bg-accent' : 'bg-studio-400'}`}
              />
              {frame ? '在线合成' : '预览图'}
            </span>

            <div className="glass absolute bottom-3 right-3 z-30 flex items-center gap-1 rounded-full p-1">
              <ZoomButton active={zoomMode === 'fit'} onClick={fitToWindow} label="适应窗口" title="适应窗口（快捷键 0）">
                适应窗口
              </ZoomButton>
              <ZoomButton active={zoomMode === 'actual'} onClick={actualSize} label="实际像素 100%" title="实际像素 100%（快捷键 1）">
                100%
              </ZoomButton>
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-studio-600/70" />
              <ZoomButton onClick={() => zoomBy(1 / ZOOM_STEP)} label="缩小" title="缩小（快捷键 -）">
                −
              </ZoomButton>
              <span className="min-w-[3.2rem] text-center text-[11px] tabular-nums text-studio-300">{formatScale(scale)}</span>
              <ZoomButton onClick={() => zoomBy(ZOOM_STEP)} label="放大" title="放大（快捷键 +）">
                +
              </ZoomButton>
            </div>

            <DecodeProgress
              status={psd.status}
              progress={psd.progress}
              progressLabel={psd.progressLabel}
              layerCount={psd.layerCount || work.layerCount}
              documentWidth={documentWidth}
              documentHeight={documentHeight}
            />

            {!frame && !busy && psd.status === 'error' && (
              <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center p-4 sm:bottom-4">
                <span className="rounded-full border border-amber-400/40 bg-studio-950/85 px-3 py-1 text-xs text-amber-300 backdrop-blur">
                  预览可用，但在线解码失败
                </span>
              </div>
            )}
          </div>

          <Toolbar
            status={psd.status}
            progress={psd.progress}
            progressLabel={psd.progressLabel}
            documentWidth={documentWidth}
            documentHeight={documentHeight}
            frameWidth={psd.frameWidth}
            frameHeight={psd.frameHeight}
            useProxy={psd.useProxy}
            scaleX={psd.scaleX}
            scaleY={psd.scaleY}
            decodeCount={psd.decodeCount}
            composeCount={psd.composeCount}
            composeMs={psd.composeMs}
            source={psd.source}
            failedLayers={psd.failedLayers}
            onRetry={psd.retry}
          />

          {psd.error && (
            <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-200">
              {psd.error}
            </p>
          )}

          {allCaveats && (
            <div className="glass rounded-2xl p-3.5">
              <h2 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-studio-100">
                <span aria-hidden="true" className="h-3 w-0.5 rounded-full bg-ember" />
                关于在线合成
              </h2>
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-studio-300">
                {caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <LayerPanel
          layers={psd.layers}
          visibility={psd.visibility}
          effective={psd.effectiveVisibility}
          disabled={!psd.layersReady}
          showRows={psd.status === 'ready'}
          layerCount={psd.layerCount}
          onToggle={psd.toggleLayer}
          onShowAll={() => psd.setAllVisible(true)}
          onHideAll={() => psd.setAllVisible(false)}
          onReset={psd.reset}
        />
      </div>
    </div>
  );
}

export default WorkViewer;
