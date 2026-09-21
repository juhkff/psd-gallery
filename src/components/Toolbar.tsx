/**
 * Toolbar: status, progress, resolution/proxy badges and the decode counter.
 *
 * `data-decode-count` is the in-browser proof that toggling layers never
 * re-decodes the PSD: it is the number of `getLayerCanvas()` calls the worker
 * performed for this work (0 on a cache hit) and it must not move on a toggle.
 */

import type { ReactNode } from 'react';
import { formatMegapixels, formatProgress, formatSize } from '../lib/format';
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

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' }) {
  const tones = {
    neutral: 'border-studio-600 text-studio-300',
    accent: 'border-accent/70 text-accent',
    warn: 'border-amber-400/60 text-amber-300',
  } as const;
  return <span className={`rounded border px-2 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
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

  return (
    <div
      data-decode-count={decodeCount}
      data-compose-count={composeCount}
      className="flex flex-col gap-2 rounded-xl border border-studio-700 bg-studio-900/70 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status === 'error' ? 'warn' : status === 'ready' ? 'accent' : 'neutral'}>
          {STATUS_TEXT[status]}
        </Badge>
        {documentWidth > 0 && (
          <Badge>
            {formatSize(documentWidth, documentHeight)} px · {formatMegapixels(documentWidth, documentHeight)}
          </Badge>
        )}
        {useProxy && (
          <Badge tone="accent">
            代理分辨率 {formatSize(frameWidth, frameHeight)}（适应窗口 · {proxyPercent}%）
          </Badge>
        )}
        {source === 'cache' && <Badge tone="accent">本地缓存秒开</Badge>}
        {source === 'memory' && <Badge tone="accent">内存缓存</Badge>}
        {composeMs > 0 && <Badge>重绘 {composeMs.toFixed(0)} ms</Badge>}
        {import.meta.env.DEV && (
          <Badge>
            解码 {decodeCount} 次 / 合成 {composeCount} 次
          </Badge>
        )}
        {failedLayers.length > 0 && <Badge tone="warn">{failedLayers.length} 个图层无法解码</Badge>}
        {status === 'error' && (
          <button
            type="button"
            onClick={onRetry}
            className="ml-auto rounded border border-studio-600 px-2 py-1 text-xs hover:border-accent hover:text-accent"
          >
            重试
          </button>
        )}
      </div>

      {busy && (
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-studio-700"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.max(2, progress * 100)}%` }}
            />
          </div>
          <span className="w-28 shrink-0 text-right text-[11px] text-studio-300">
            {progressLabel || formatProgress(progress)}
          </span>
        </div>
      )}

      {failedLayers.length > 0 && (
        <p className="text-[11px] text-amber-300/90">
          无法解码的图层：{failedLayers.join('、')}（这些图层在页面上不会显示，请下载 PSD 查看）
        </p>
      )}
    </div>
  );
}

export default Toolbar;
