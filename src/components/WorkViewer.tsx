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
 *
 * LIQUID GLASS
 * The whole stage is one `panel` sheet (LiquidGlass renders the moving
 * sheen layer over it). Inside it the document sits on a recessed `well`
 * with a mounted-print edge (hairline ring + contact shadow), so the picture
 * reads as a print lying *behind* the glass rather than a texture painted on a
 * dark rectangle. The reflection is ONE narrow diagonal band painted across the
 * whole sheet - mat included - because a real reflection is continuous across
 * whatever is behind it; a full-area wash would only dull the print and make 1:1
 * inspection worse. Everything that floats *over* the artwork (the live/preview
 * badge, the zoom cluster, the decode card) is real glass, so its backdrop is
 * the artwork itself - which is where the blur is actually provable in a
 * screenshot.
 *
 * BACKDROP-FILTER CONTRACT (verified in this Chrome with .bench-output/bf-probe):
 * `filter`, `opacity < 1` on an ancestor kill the backdrop sampling; `overflow`
 * and `transform` ancestors do not. Nothing here puts either of the two fatal
 * properties on an ancestor of a glass surface, and the stage clips with
 * `border-radius`, never `overflow: hidden`.
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
/**
 * The scroll stage's inner padding, in px. `fitScale` subtracts it on both
 * sides, so this constant and the stage's `p-4` class must stay in sync.
 */
const STAGE_PADDING = 16;

type ZoomMode = 'fit' | 'actual' | 'custom';

export interface WorkViewerProps {
  date: string;
  work: WorkEntry;
  /** Called by the "返回图库" control (the App decides how to navigate). */
  onClose: () => void;
}

/**
 * The header readouts as ONE aligned instrument strip: a single glass lozenge
 * with hairline-separated segments. Four separate pills of slightly different
 * widths read as four unrelated chips; one strip reads as a spec line, and the
 * tabular figures line up on a shared baseline.
 */
function MetaStrip({ items }: { items: ReactNode[] }) {
  return (
    <div className="panel-quiet inline-flex h-7 items-stretch rounded-full ring-1 ring-inset ring-ink-100/[0.05]">
      {items.map((item, index) => (
        <span
          key={index}
          className="relative inline-flex items-center px-3 text-[11px] leading-none tabular-nums text-ink-200"
        >
          {index > 0 && (
            <span aria-hidden="true" className="absolute inset-y-[7px] left-0 w-px bg-ink-100/[0.14]" />
          )}
          {item}
        </span>
      ))}
    </div>
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
      className={`hover-glow grid h-7 min-w-7 place-items-center rounded-full px-2 text-[11px] leading-none ${
        active
          ? 'bg-gradient-to-b from-accent/30 to-accent/[0.08] text-accent-soft ring-1 ring-inset ring-accent/45 shadow-[inset_0_1px_0_rgba(236,236,242,0.28),0_6px_16px_-8px_rgba(201,162,39,0.85)]'
          : 'text-ink-300 hover:bg-ink-100/[0.09] hover:text-ink-100 hover:shadow-[0_6px_16px_-10px_rgba(0,0,0,0.9)]'
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

  // One pointer tracker for the whole viewer: it resolves the nearest
  // `.liquid-interactive` ancestor of the hovered node, so a single listener
  // drives every specular highlight on this surface (badge, zoom cluster, ...)
  // without a React re-render per pointer move.

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
  // visible inside the stage *including the mat margin around the print*.
  //
  // The subtraction must cover BOTH sides of the scroll container's padding
  // (`STAGE_PADDING` below), plus a couple of pixels of slack: fit is computed
  // from fractional sizes and the surface is rounded, so an exact fit can still
  // produce a 1px overflow - and a scrollbar on a "fit" view both crops the print
  // and covers the mat margin that sells the print-behind-glass reading.
  const fitScale = useMemo(() => {
    const availableWidth = stage.width - STAGE_PADDING * 2 - 4;
    const availableHeight = stage.height - STAGE_PADDING * 2 - 4;
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
    <div className="flex min-h-0 flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="panel-quiet group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-ink-300 transition hover:text-accent"
          >
            <svg
              viewBox="0 0 16 16"
              className="relative z-[1] h-3 w-3 transition-transform duration-300 group-hover:-translate-x-0.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M9.5 3.5 5 8l4.5 4.5" />
              <path d="M5.5 8H13" />
            </svg>
            <span className="relative z-[1]">返回图库</span>
            
          </button>

          {/* Three ranks, not two: the date is a quiet caption in the display
              face, the filename is the page's headline, and the extension is
              demoted so the *name* is what the eye lands on. */}
          <h1 className="mt-2.5 flex min-w-0 items-center gap-3">
            <span className="shrink-0 font-display text-[13px] tracking-[0.01em] text-ink-400">
              {formatDateLabel(date)}
            </span>
            <span
              aria-hidden="true"
              className="h-4 w-px shrink-0 bg-gradient-to-b from-transparent via-ink-600 to-transparent"
            />
            <span className="truncate text-[1.6rem] font-semibold leading-tight tracking-[-0.01em] text-ink-100">
              {work.name}
              <span className="font-normal text-ink-400">.psd</span>
            </span>
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <MetaStrip
              items={[
                `${formatSize(documentWidth, documentHeight)} px`,
                formatMegapixels(documentWidth, documentHeight),
                `${work.layerCount} 个图层`,
                formatBytes(work.bytes),
              ]}
            />
          </div>
        </div>

        {/* The ONE primary CTA on this page: gold fill + the rotating rim
            highlight. Nothing else on the page may use `liquid-rim`.
            No `overflow-hidden` here any more: `liquid-rim` now interpolates the
            conic gradient's start angle via a registered `@property` instead of
            rotating its ::before box, so nothing swings outside the button and
            clipping would only shave the 1px ring that hugs the edge. It stays
            safe either way - no glass surface is a descendant of the CTA. */}
        <a
          data-testid="download-psd"
          href={work.psd}
          download={`${date}-${work.name}.psd`}
          className="inline-flex shrink-0 items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold transition hover:brightness-[1.08] active:scale-[0.98]"
        >
          <span className="relative z-[1] inline-flex items-center gap-2">
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M8 2.5v7.2" />
              <path d="M5.2 7.2 8 10l2.8-2.8" />
              <path d="M3 12.5h10" />
            </svg>
            下载 PSD
            <span className="rounded-md bg-ink-950/15 px-1.5 py-px text-[11px] font-medium tabular-nums">
              {formatBytes(work.bytes)}
            </span>
          </span>
          
        </a>
      </header>

      <div className="flex min-h-0 flex-col gap-4 lg:flex-row">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="relative">
            {/* The sheet of glass the artwork sits behind. Everything that must
                be sharp lives inside the scroll container; the pane, the sheen
                and the floating chrome are outside it. `refract` is the thick
                glass variant and is only allowed on a large, mostly static
                surface - this frame is exactly that (the scroller is a child). */}
            <div className="panel p-2">
              <div
                ref={stageRef}
                tabIndex={0}
                role="region"
                aria-label="作品画面"
                title="双击切换适应窗口 / 100%；Ctrl 或 ⌘ + 滚轮缩放"
                onDoubleClick={toggleFitAndActual}
                onKeyDown={onStageKeyDown}
                style={{ height: 'clamp(20rem, 62vh, 48rem)' }}
                className="well relative overflow-auto overscroll-contain rounded-[14px]"
              >
                <div className="flex min-h-full min-w-full p-4">
                  {/* The print: a crisp mounted sheet on the mat. The 1px ring
                      is the paper edge catching the pane's light; the contact
                      shadow only appears *outside* the print, so 1:1 inspection
                      stays untouched. */}
                  <div
                    className="checkerboard relative m-auto shrink-0 rounded-[3px] ring-1 ring-ink-100/[0.18] shadow-[0_26px_50px_-26px_rgba(0,0,0,0.95),0_5px_14px_-8px_rgba(0,0,0,0.8)]"
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
                  </div>
                </div>
              </div>

              {/* Mat light. `well` is deliberately near-black so the print
                  has maximum contrast, but an evenly black field reads as a hole
                  rather than as a surface. One pool of light in the lit corner -
                  screen-blended, so it lifts the mat and leaves the print
                  untouched - gives the surface a direction. Kept low: the
                  reflection band is the feature, this is only its ambient. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[14px] mix-blend-screen bg-[radial-gradient(125%_100%_at_4%_-16%,rgba(143,208,232,0.075),rgba(236,236,242,0.02)_40%,transparent_62%)]"
              />

              {/* The reflection. ONE band, at ~45° so it reads as a sheet of glass
                  rather than as a vertical smear, positioned over the lit
                  corner of the sheet - the only place a reflection can actually
                  be seen, because `screen` blending adds light on the dark mat
                  and is a near no-op on the bright print. So it costs the 1:1
                  view nothing, and the print stays the brightest thing here. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[14px] mix-blend-screen bg-[linear-gradient(134deg,transparent_0%,rgba(236,236,242,0.04)_5%,rgba(143,208,232,0.17)_10%,rgba(236,236,242,0.045)_15%,transparent_21%)]"
              />
            </div>

            {/* Live/preview state, floating over the artwork: real glass, so its
                backdrop is the canvas itself. `panel-quiet` alone (no
                `elevate`) is deliberate - both utilities set `box-shadow`, so
                elevate's generic shadow would overwrite the pane's own bevel,
                which is exactly the rim light that makes a small lozenge read as
                frosted rather than as a flat chip. */}
            <div className="pointer-events-none absolute left-3 top-3 z-10">
              <div className="panel-quiet pointer-events-auto inline-flex h-7 items-center gap-2 overflow-hidden rounded-full pl-2.5 pr-3 text-[10px] leading-none tracking-wide text-ink-200 ring-1 ring-inset ring-ink-100/[0.10]">
                {/* Front-face light: over the mat there is nothing to blur, so the
                    lozenge has to carry its own light or it reads as a flat chip.
                    `overflow-hidden` clips it to the pill; no glass inside. */}
                <i
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(236,236,242,0.12),rgba(236,236,242,0.02)_58%,transparent)]"
                />
                <span
                  aria-hidden="true"
                  className={`relative z-[1] h-1.5 w-1.5 rounded-full ${
                    frame
                      ? 'bg-accent shadow-[0_0_8px_rgba(201,162,39,0.9)]'
                      : 'bg-ink-400 shadow-[0_0_6px_rgba(0,0,0,0.8)]'
                  }`}
                />
                <span className="relative z-[1]">{frame ? '图层合成' : '预览图'}</span>
                
              </div>
            </div>

            <div className="pointer-events-none absolute bottom-3 right-3 z-30">
              <div className="panel-quiet pointer-events-auto flex items-center gap-0.5 rounded-full p-1 ring-1 ring-inset ring-ink-100/[0.07]">
                <ZoomButton active={zoomMode === 'fit'} onClick={fitToWindow} label="适应窗口" title="适应窗口（0）">
                  适应窗口
                </ZoomButton>
                <ZoomButton active={zoomMode === 'actual'} onClick={actualSize} label="实际大小" title="实际大小（1）">
                  100%
                </ZoomButton>
                <span
                  aria-hidden="true"
                  className="mx-1 h-5 w-px shrink-0 bg-gradient-to-b from-transparent via-ink-100/25 to-transparent"
                />
                <ZoomButton onClick={() => zoomBy(1 / ZOOM_STEP)} label="缩小" title="缩小（-）">
                  −
                </ZoomButton>
                <span className="min-w-[3.4rem] px-0.5 text-center text-[12.5px] font-medium leading-none tabular-nums text-ink-100">
                  {formatScale(scale)}
                </span>
                <ZoomButton onClick={() => zoomBy(ZOOM_STEP)} label="放大" title="放大（+）">
                  +
                </ZoomButton>
                
              </div>
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
                <span className="panel-quiet inline-flex items-center rounded-full px-3 py-1 text-xs text-amber-300">
                  <span className="relative z-[1]">图层暂时无法读取</span>
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
            <div className="panel p-4">
              <div>
                <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-100">
                  <span
                    aria-hidden="true"
                    className="h-3 w-0.5 rounded-full bg-gradient-to-b from-ember to-accent/30"
                  />
                  关于图层显示
                  <span className="rounded-full border border-ink-100/10 px-1.5 py-px text-[9px] font-normal tabular-nums text-ink-400">
                    {caveats.length} 条
                  </span>
                </h2>
                {/* Engraved-into-glass hairline rather than a border: a hard 1px
                    rule under a label on a translucent pane looks like a table
                    cell edge. */}
                <div aria-hidden="true" className="rule mt-2.5" />
                <ul className="mt-2.5 space-y-1.5 text-[11px] leading-relaxed text-ink-300">
                  {caveats.map((caveat) => (
                    <li key={caveat} className="flex gap-2">
                      <span aria-hidden="true" className="mt-[7px] h-px w-2.5 shrink-0 bg-ice/45" />
                      <span className="min-w-0">{caveat}</span>
                    </li>
                  ))}
                </ul>
              </div>
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
