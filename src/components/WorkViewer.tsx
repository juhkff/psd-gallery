/**
 * WorkViewer: the PSD viewer for one work.
 *
 * First paint is the build-time `display.webp` preview (already in the HTTP
 * cache from the gallery); the live `<canvas>` fades in over it as soon as the
 * worker hands over a composited ImageBitmap. The preview stays mounted
 * underneath, so there is never a blank frame - but it is always a separate
 * `<img>`, so the live canvas is unambiguously identifiable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkEntry } from '../../shared/manifest';
import { formatDateLabel } from '../../shared/paths';
import { formatBytes, formatSize } from '../lib/format';
import { forceProxyFromHash } from '../lib/route';
import { collectCaveats } from '../psd/layer-info';
import { usePsdWork } from '../psd/usePsdWork';
import { LayerPanel } from './LayerPanel';
import { Toolbar } from './Toolbar';

export interface WorkViewerProps {
  date: string;
  work: WorkEntry;
  /** Called by the "返回图库" control (the App decides how to navigate). */
  onClose: () => void;
}

export function WorkViewer({ date, work, onClose }: WorkViewerProps) {
  // `#/date/name?proxy=1` forces the proxy path (debug/e2e affordance for
  // machines whose sample PSDs are all below the proxy threshold).
  const [forceProxy] = useState(() => forceProxyFromHash(window.location.hash));
  const psd = usePsdWork(work, forceProxy);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = psd.frame;

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

  const documentWidth = psd.documentWidth || work.width;
  const documentHeight = psd.documentHeight || work.height;
  const preview = work.preview;
  const busy = psd.status === 'loading' || psd.status === 'decoding';

  // Caveats from the worker once it has read the PSD; before that, derived from
  // the manifest tree so the warning is visible during the decode.
  const manifestCaveats = useMemo(
    () => collectCaveats(work.layers, { useProxy: false }),
    [work.layers],
  );
  const caveats = psd.caveats.length > 0 ? psd.caveats : manifestCaveats;

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="mb-1 text-xs text-studio-300 underline-offset-2 hover:text-accent hover:underline"
          >
            ← 返回图库
          </button>
          <h1 className="truncate text-xl font-semibold">
            <span className="text-studio-300">{formatDateLabel(date)}</span>
            <span className="mx-2 text-studio-600">/</span>
            {work.name}.psd
          </h1>
          <p className="mt-1 text-xs text-studio-300">
            {formatSize(documentWidth, documentHeight)} px · {work.layerCount} 个图层 ·{' '}
            {formatBytes(work.bytes)}
          </p>
        </div>

        <a
          data-testid="download-psd"
          href={work.psd}
          download={`${date}-${work.name}.psd`}
          className="shrink-0 rounded-lg border border-accent/70 bg-accent/10 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/20"
        >
          下载 PSD（{formatBytes(work.bytes)}）
        </a>
      </header>

      <div className="flex min-h-0 flex-col gap-4 lg:flex-row">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <div
            className="checkerboard relative flex w-full items-center justify-center overflow-hidden rounded-xl border border-studio-700"
            style={{ aspectRatio: `${documentWidth} / ${documentHeight}` }}
          >
            {preview.display && (
              <img
                src={preview.display}
                width={preview.displayWidth}
                height={preview.displayHeight}
                alt=""
                aria-hidden="true"
                decoding="async"
                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
                  frame ? 'opacity-0' : 'opacity-100'
                }`}
              />
            )}
            <canvas
              data-testid="work-canvas"
              ref={canvasRef}
              className={`relative h-full w-full object-contain transition-opacity duration-200 ${
                frame ? 'opacity-100' : 'opacity-0'
              }`}
            />
            {!frame && busy && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="rounded-full bg-studio-950/80 px-3 py-1 text-xs text-studio-100">
                  {psd.progressLabel || '正在解码 PSD…'}
                </span>
              </div>
            )}
            {!frame && !busy && psd.status === 'error' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="rounded-full bg-studio-950/80 px-3 py-1 text-xs text-amber-300">
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
            <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-200">
              {psd.error}
            </p>
          )}

          {caveats.length > 0 && (
            <div className="rounded-lg border border-studio-700 bg-studio-900/60 p-3">
              <h2 className="mb-1 text-xs font-semibold text-studio-100">关于在线合成</h2>
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
