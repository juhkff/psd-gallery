/**
 * Status line under the viewer.
 *
 * WHAT IT SHOWS: only what a viewer needs - whether the work is still loading,
 * its pixel size, a note when it is displayed at reduced resolution, and a
 * retry affordance when something failed.
 *
 * WHAT IT HIDES: instrumentation (decode count, compose count, compose
 * milliseconds, transport and cache kind). Those numbers mean nothing to a
 * visitor, and they were the main reason the page read like a debug console.
 * They stay in the DOM behind `?debug=1`, because the automated checks assert
 * on `data-decode-count`: hidden from people, still visible to the test suite.
 */

export type PsdStatus = 'idle' | 'loading' | 'decoding' | 'ready' | 'error';

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
  idle: '等待',
  loading: '读取中',
  decoding: '读取图层',
  ready: '就绪',
  error: '读取失败',
};

const STATUS_DOT: Record<PsdStatus, string> = {
  idle: 'bg-ink-500',
  loading: 'bg-accent-soft',
  decoding: 'bg-accent-soft',
  ready: 'bg-emerald-400/80',
  error: 'bg-amber-400',
};

function formatSize(width: number, height: number): string {
  return `${width} × ${height}`;
}

function formatMegapixels(width: number, height: number): string {
  const mp = (width * height) / 1e6;
  return mp >= 10 ? `${mp.toFixed(0)} MP` : `${mp.toFixed(1)} MP`;
}

/** Opt-in diagnostics: `?debug=1` in the search string or the hash. */
function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return /[?&]debug=1\b/.test(window.location.search) || /[?&]debug=1\b/.test(window.location.hash);
}

export function Toolbar(props: ToolbarProps) {
  const {
    status,
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
    failedLayers,
    onRetry,
  } = props;

  const showDebug = debugEnabled();
  const proxyPercent = Math.round(Math.min(scaleX, scaleY) * 100);

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]"
      data-decode-count={decodeCount}
      data-compose-count={composeCount}
    >
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
        <span className="text-ink-200">{STATUS_TEXT[status]}</span>
      </span>

      {documentWidth > 0 && (
        <span className="readout text-ink-400">
          {formatSize(documentWidth, documentHeight)} px · {formatMegapixels(documentWidth, documentHeight)}
        </span>
      )}

      {useProxy && (
        <span className="text-ink-400">
          预览分辨率 {formatSize(frameWidth, frameHeight)}（{proxyPercent}%）
        </span>
      )}

      {failedLayers.length > 0 && (
        <span className="text-amber-300/90">
          {failedLayers.length} 个图层读不出来（可下载源文件查看）
        </span>
      )}

      {status === 'error' && (
        <button type="button" onClick={onRetry} className="btn-quiet px-3 py-1 text-[12px]">
          重试
        </button>
      )}

      {showDebug && (
        <span className="readout text-ink-500">
          调试：解码 {decodeCount} 次 · 合成 {composeCount} 次
          {composeMs > 0 ? ` · ${composeMs.toFixed(0)}ms` : ''}
        </span>
      )}
    </div>
  );
}

export default Toolbar;
