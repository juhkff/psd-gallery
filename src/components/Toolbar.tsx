/**
 * Toolbar: status, progress, resolution/proxy badges and the decode counter.
 *
 * `data-decode-count` is the in-browser proof that toggling layers never
 * re-decodes the PSD: it is the number of `getLayerCanvas()` calls the worker
 * performed for this work (0 on a cache hit) and it must not move on a toggle.
 * It stays on the root element, which is also where `data-compose-count` lives.
 *
 * LAYOUT: this used to be one flat strip of equally-weighted micro labels, which
 * read as a sentence of tiny text. It is now a three-cluster instrument panel -
 * 来源 / 性能 / 缓存 - separated by light-gap hairlines, preceded by the status
 * LED as its own unlabelled element. Inside a cluster the NUMBERS carry the
 * weight (15px semibold tabular) and the labels stay quiet (9px, wide tracking),
 * so the eye can compare 重绘 / 解码 / 合成 without reading anything.
 */

import type { ReactNode } from 'react';
import { formatMegapixels, formatProgress, formatSize, stripTrailingPercent } from '../lib/format';
import type { PsdStatus } from '../psd/usePsdWork';
import { LiquidGlass } from './LiquidGlass';

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
  loading: 'animate-pulse bg-accent shadow-[0_0_8px_rgba(201,162,39,0.7)]',
  decoding: 'animate-pulse bg-accent shadow-[0_0_8px_rgba(201,162,39,0.7)]',
  ready: 'bg-accent shadow-[0_0_10px_rgba(201,162,39,0.75)]',
  error: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]',
};

const SOURCE_TEXT: Record<'network' | 'cache' | 'memory', string> = {
  network: '网络',
  cache: '本地缓存',
  memory: '内存缓存',
};

/** Cluster separator: a hairline that fades at both ends, never a hard rule. */
function Divider() {
  return (
    <span
      aria-hidden="true"
      className="mx-2 hidden h-7 w-px shrink-0 bg-gradient-to-b from-transparent via-studio-100/[0.16] to-transparent sm:block"
    />
  );
}

/**
 * A named group of readouts. Three ranks, so the eye can skip: the cluster label
 * is the brightest small text (it names the group), the per-value label is the
 * dimmest (it is only there until the numbers are learned), and the value is the
 * anchor. The tick in front of the label is a shape cue - at 9px, three labels
 * of the same size are not enough to mark where a group starts.
 */
function Cluster({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <span aria-hidden="true" className="h-3 w-px shrink-0 rounded-full bg-gradient-to-b from-ice/70 to-ion/40" />
      <span className="text-[9px] font-semibold uppercase tracking-[0.24em] text-studio-300/80">{label}</span>
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">{children}</span>
    </span>
  );
}

/** The instrument unit. The value is the anchor; label and unit stay quiet. */
function Readout({
  label,
  children,
  unit,
}: {
  label: string;
  children: ReactNode;
  unit?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-studio-400/70">{label}</span>
      <span className="text-[15px] font-semibold leading-none tabular-nums text-studio-100">{children}</span>
      {unit && <span className="text-[10px] text-studio-400">{unit}</span>}
    </span>
  );
}

/** Same grid, for a text value: only NUMBERS get the anchor weight. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-studio-400/70">{label}</span>
      <span className="text-[12px] leading-none text-studio-200">{children}</span>
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
    <LiquidGlass
      variant="thin"
      elevate
      data-decode-count={decodeCount}
      data-compose-count={composeCount}
      className="px-3 py-2.5"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          {/* The power light: status is not a cluster, it is the panel's state. */}
          <span className="inline-flex items-center gap-2 pl-0.5">
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
            <span className="text-[12px] font-medium tracking-wide text-studio-100">{STATUS_TEXT[status]}</span>
          </span>

          <Divider />

          <Cluster label="来源">
            {source && <Field label="通道">{SOURCE_TEXT[source]}</Field>}
            {documentWidth > 0 && (
              <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-studio-400/70">文档</span>
                <span className="text-[15px] font-semibold leading-none tabular-nums text-studio-100">
                  {formatSize(documentWidth, documentHeight)}
                </span>
                <span className="text-[10px] text-studio-400">px · {formatMegapixels(documentWidth, documentHeight)}</span>
              </span>
            )}
            {useProxy && (
              <span className="liquid-glass-thin inline-flex items-baseline gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] text-accent-soft">
                <span className="relative z-[1]">代理 {formatSize(frameWidth, frameHeight)}</span>
                <span className="relative z-[1] tabular-nums">· {proxyPercent}%</span>
              </span>
            )}
          </Cluster>

          <Divider />

          <Cluster label="性能">
            {composeMs > 0 && (
              <Readout label="重绘" unit="ms">
                {composeMs.toFixed(0)}
              </Readout>
            )}
            <Readout label="合成" unit="次">
              {composeCount}
            </Readout>
          </Cluster>

          <Divider />

          {/* Cache is its own cluster because this counter is the proof: on a
              cache hit it stays at 0 and never moves when a layer is toggled. */}
          <Cluster label="缓存">
            <Readout label="解码" unit="次">
              {decodeCount}
            </Readout>
          </Cluster>

          {failedLayers.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300">
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-amber-300" />
              {failedLayers.length} 个图层无法解码
            </span>
          )}

          {status === 'error' && (
            <button
              type="button"
              onClick={onRetry}
              className="hover-glow ml-auto rounded-full border border-studio-100/15 bg-studio-100/[0.04] px-2.5 py-1 text-[11px] text-studio-100 hover:border-accent/60 hover:bg-accent/10 hover:text-accent-soft"
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
              // Same honesty rule as the decode card: with no fraction there is
              // no number to claim, so the bar is indeterminate and voiceless.
              aria-valuenow={progress > 0 ? Math.round(progress * 100) : undefined}
              aria-valuetext={progress > 0 ? undefined : '正在解码，进度未知'}
              className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-studio-950/70 shadow-[inset_0_1px_2px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-studio-100/10"
            >
              {progress > 0 ? (
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-ember via-accent to-accent-soft transition-[width] duration-200"
                  style={{ width: `${Math.max(2, progress * 100)}%` }}
                >
                  {/* Light travelling along the fibre: a soft halo, a hard core,
                      and a short trail behind it. */}
                  <span
                    aria-hidden="true"
                    className="absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 translate-x-1/2 rounded-full bg-studio-100/70 blur-[2px]"
                  />
                  <span
                    aria-hidden="true"
                    className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-studio-100 shadow-[0_0_8px_2px_rgba(236,236,242,0.6)]"
                  />
                </div>
              ) : (
                <div className="shimmer-line absolute inset-0" />
              )}
            </div>
            <span className="min-w-0 max-w-[16rem] truncate text-right text-[11px] text-studio-300">
              {progressText || '解码中'}
            </span>
            {progress > 0 && (
              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-studio-100">
                {formatProgress(progress)}
              </span>
            )}
          </div>
        )}

        {failedLayers.length > 0 && (
          <p className="text-[11px] leading-relaxed text-amber-300/90">
            无法解码的图层：{failedLayers.join('、')}（这些图层在页面上不会显示，请下载 PSD 查看）
          </p>
        )}
      </div>
    </LiquidGlass>
  );
}

export default Toolbar;
