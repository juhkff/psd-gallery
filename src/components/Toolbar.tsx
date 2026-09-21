/**
 * Toolbar: status, progress, resolution/proxy badges and the decode counter.
 *
 * `data-decode-count` is the in-browser proof that toggling layers never
 * re-decodes the PSD: it is the number of `getLayerCanvas()` calls the worker
 * performed for this work (0 on a cache hit) and it must not move on a toggle.
 * It stays on the root element, which is also where `data-compose-count` lives.
 *
 * Visually this is a compact glass instrument panel: labelled micro-readouts in
 * tabular figures, so decode/compose/redraw numbers can be compared at a glance.
 */

import type { ReactNode } from 'react';
import { formatMegapixels, formatProgress, formatSize, stripTrailingPercent } from '../lib/format';
import type { PsdStatus } from '../psd/usePsdWork';

export interface ToolbarProps {
  status: PsdStatus;
  progress: number;
  progressLabel: string;
  documentWidth: number;
  documentHeight: number;
  frameWidth: number;
  frameHeight: number;
  useProxy: boolean;
  scaleX: number;
  scaleY: number;
  decodeCount: number;
  composeCount: number;
  composeMs: number;
  source: 'network' | 'cache' | 'memory' | null;
  failedLayers: string[];
  onRetry: () => void;
}

const STATUS_TEXT: Record<PsdStatus, string> = {
  idle: '等待中',
  loading: '下载中',
  decoding: '解码中',
  ready: '就绪',
  error: '出错',
};

const STATUS_DOT: Record<PsdStatus, string> = {
  idle: 'bg-studio-400',
  loading: 'animate-pulse bg-accent',
  decoding: 'animate-pulse bg-accent',
  ready: 'bg-accent shadow-[0_0_10px_rgba(201,162,39,0.75)]',
  error: 'bg-amber-400',
};

const SOURCE_TEXT: Record<'network' | 'cache' | 'memory', string> = {
  network: '网络',
  cache: '本地缓存秒开',
  memory: '内存缓存',
};

function Sep() {
  return <span aria-hidden="true" className="hidden h-3 w-px bg-studio-700 sm:block" />;
}

/** A labelled readout, the instrument-panel unit: dim label, tabular value. */
function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-studio-400">{label}</span>
      <span className="tabular-nums text-studio-100">{children}</span>
    </span>
  );
}

export function Toolbar(props: ToolbarProps) {
  const {
    status,
    progress,
    progressLabel,
    documentWidth,
    documentHeight,
    frameWidth,
    frameHeight,
    useProxy,
    scaleX,
    scaleY,
    decodeCount,
    composeCount,
    composeMs,
    source,
    failedLayers,
    onRetry,
  } = props;

  const busy = status === 'loading' || status === 'decoding';
  const proxyPercent = Math.round(Math.min(scaleX, scaleY) * 100);
  // Same rule as the decode card: one percentage on screen, and it is the
  // worker's overall progress - the label's phase-local "34%" is dropped.
  const progressText = stripTrailingPercent(progressLabel);

  return (
    <div
      data-decode-count={decodeCount}
      data-compose-count={composeCount}
      className="glass flex flex-col gap-2 rounded-2xl px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
          <span className="font-medium text-studio-100">{STATUS_TEXT[status]}</span>
        </span>

        {documentWidth > 0 && (
          <>
            <Sep />
            <Readout label="文档">
              {formatSize(documentWidth, documentHeight)} px · {formatMegapixels(documentWidth, documentHeight)}
            </Readout>
          </>
        )}

        {useProxy && (
          <>
            <Sep />
            <span className="inline-flex items-baseline gap-1 whitespace-nowrap rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent-soft">
              代理 {formatSize(frameWidth, frameHeight)}
              <span className="tabular-nums">· {proxyPercent}%</span>
            </span>
          </>
        )}

        {source && (
          <>
            <Sep />
            <Readout label="来源">{SOURCE_TEXT[source]}</Readout>
          </>
        )}

        {composeMs > 0 && (
          <>
            <Sep />
            <Readout label="重绘">{composeMs.toFixed(0)} ms</Readout>
          </>
        )}

        <Sep />
        <Readout label="解码">{decodeCount} 次</Readout>
        <Sep />
        <Readout label="合成">{composeCount} 次</Readout>

        {failedLayers.length > 0 && (
          <>
            <Sep />
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-amber-300">
              {failedLayers.length} 个图层无法解码
            </span>
          </>
        )}

        {status === 'error' && (
          <button
            type="button"
            onClick={onRetry}
            className="ml-auto rounded-full border border-studio-600 px-2.5 py-1 text-[11px] text-studio-100 transition hover:border-accent hover:text-accent"
          >
            重试
          </button>
        )}
      </div>

      {busy && (
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="PSD 解码进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-1 flex-1 overflow-hidden rounded-full bg-studio-700"
          >
            <div
              className={`h-full rounded-full bg-gradient-to-r from-ember via-accent to-accent-soft ${
                progress > 0 ? 'transition-[width] duration-200' : 'shimmer-line'
              }`}
              style={progress > 0 ? { width: `${Math.max(2, progress * 100)}%` } : { width: '100%' }}
            />
          </div>
          <span className="min-w-0 max-w-[16rem] truncate text-right text-[11px] text-studio-300">
            {progressText || '解码中'}
          </span>
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-studio-100">
            {formatProgress(progress)}
          </span>
        </div>
      )}

      {failedLayers.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-300/90">
          无法解码的图层：{failedLayers.join('、')}（这些图层在页面上不会显示，请下载 PSD 查看）
        </p>
      )}
    </div>
  );
}

export default Toolbar;
