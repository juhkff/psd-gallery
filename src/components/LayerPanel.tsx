/**
 * Layer panel: nested rows, one eye toggle per layer.
 *
 * Visibility has two layers of truth:
 *  - `visibility[id]` / the PSD `hidden` flag -> the layer's **own** state, which
 *    is what `aria-pressed` reports (clicking must always flip it),
 *  - `effective` (after group propagation) -> whether the layer actually ends up
 *    on the canvas.
 * A row that is switched on but buried inside a hidden group is called out, so
 * the panel never lies about what is visible.
 *
 * Layout contract: the panel is a fixed-height instrument on desktop and the
 * row list scrolls *inside* it, so a 60-layer document never grows the page.
 * Row selection is local UI state only - it never touches visibility or the
 * worker, so toggling/selecting can never trigger a re-decode.
 */

import { useMemo, useState, type ReactNode } from 'react';
import type { LayerNode } from '../../shared/manifest';
import { blendLabel, isApproximate } from '../../shared/blend';
import { formatOpacity, formatSize } from '../lib/format';
import { KIND_LABELS } from '../psd/layer-info';
import type { VisibilityMap } from '../psd/protocol';
import { layerId } from '../psd/composite';

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M1.8 10S4.9 4.8 10 4.8 18.2 10 18.2 10 15.1 15.2 10 15.2 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M1.8 10S4.9 4.8 10 4.8c1.5 0 2.8.5 3.9 1.2M18.2 10s-3.1 5.2-8.2 5.2c-1.5 0-2.8-.5-3.9-1.2" />
      <path d="M3.2 3.2 16.8 16.8" />
    </svg>
  );
}

function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn';
  title?: string;
}) {
  const tones = {
    neutral: 'border-studio-600/70 bg-studio-800/70 text-studio-300',
    accent: 'border-accent/40 bg-accent/10 text-accent-soft',
    warn: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  } as const;
  return (
    <span title={title} className={`rounded border px-1 py-px text-[10px] leading-4 ${tones[tone]}`}>
      {children}
    </span>
  );
}

export interface LayerPanelProps {
  layers: LayerNode[];
  /** Own-state overrides (missing id = PSD default). */
  visibility: VisibilityMap;
  /** Effective visibility after group propagation. */
  effective: Map<string, boolean>;
  /** Disabled until the worker reported the authoritative tree. */
  disabled: boolean;
  /**
   * Render the rows. Kept false until the first full composite exists: a layer
   * list you cannot yet act on would be a lie, and the composite must be the
   * settled one by the time the rows show up.
   */
  showRows: boolean;
  layerCount: number;
  onToggle: (id: string, next?: boolean) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onReset: () => void;
}

interface RowProps {
  node: LayerNode;
  id: string;
  depth: number;
  visibility: VisibilityMap;
  effective: Map<string, boolean>;
  disabled: boolean;
  selectedId: string | null;
  onToggle: (id: string, next?: boolean) => void;
  onSelect: (id: string) => void;
}

function LayerRow({ node, id, depth, visibility, effective, disabled, selectedId, onToggle, onSelect }: RowProps) {
  const own = visibility[id] ?? !node.hidden;
  const selected = selectedId === id;
  const shown = effective.get(id) ?? own;
  const width = Math.round(node.rect.right - node.rect.left);
  const height = Math.round(node.rect.bottom - node.rect.top);
  const kindLabel = node.kind ? KIND_LABELS[node.kind] ?? node.kind : null;
  const approximate = isApproximate(node.blendMode);
  const buried = own && !shown;

  return (
    <li>
      <div
        data-testid="layer-row"
        data-layer-id={id}
        data-visible={shown ? 'true' : 'false'}
        data-selected={selected ? 'true' : undefined}
        onClick={() => onSelect(id)}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        className={`group relative flex items-stretch gap-2 rounded-lg py-1.5 pr-2 transition-colors ${
          selected ? 'bg-accent/[0.09] ring-1 ring-inset ring-accent/25' : 'hover:bg-studio-800/60'
        }`}
      >
        {/* Indentation guides: one hairline per ancestor group level. */}
        {depth > 0 && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-2 flex">
            {Array.from({ length: depth }, (_, index) => (
              <span
                key={index}
                className={`w-4 self-stretch border-l ${index === depth - 1 ? 'border-accent/25' : 'border-studio-600/40'}`}
              />
            ))}
          </span>
        )}

        <button
          type="button"
          data-testid="layer-toggle"
          aria-pressed={own}
          aria-label={`${own ? '隐藏' : '显示'}图层 ${node.name}`}
          title={own ? '隐藏此图层' : '显示此图层'}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(id, !own);
          }}
          className={`mt-0.5 shrink-0 self-start rounded-md p-1.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${
            own ? 'text-accent hover:bg-accent/15' : 'text-studio-400 hover:bg-studio-700 hover:text-studio-100'
          }`}
        >
          <EyeIcon open={own} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`truncate text-[13px] leading-5 ${node.isGroup ? 'font-semibold' : ''} ${
                shown ? 'text-studio-100' : 'text-studio-400'
              }`}
            >
              {node.name}
            </span>
            {kindLabel && <Chip>{kindLabel}</Chip>}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {node.blendMode !== 'normal' && (
              <Chip tone="accent" title={approximate ? '浏览器只能近似还原' : undefined}>
                混合：{blendLabel(node.blendMode)}
                {approximate ? ' ≈' : ''}
              </Chip>
            )}
            {node.opacity < 1 && <Chip title="图层不透明度">{formatOpacity(node.opacity)}</Chip>}
            {!node.isGroup && <span className="text-[10px] tabular-nums text-studio-400">{formatSize(width, height)} px</span>}
            {!node.hasImage && !node.isGroup && <span className="text-[10px] text-studio-400">无像素数据</span>}
            {node.note && <span className="text-[10px] text-amber-300/90">{node.note}</span>}
            {buried && <span className="text-[10px] text-amber-300/90">所在组已隐藏</span>}
          </div>
        </div>
      </div>

      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((child, index) => (
            <LayerRow
              key={`${id}.${index}`}
              node={child}
              id={`${id}.${index}`}
              depth={depth + 1}
              visibility={visibility}
              effective={effective}
              disabled={disabled}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

interface LayerStats {
  total: number;
  seen: number;
}

/** Visible/total over the whole tree, using the same effective map as the eyes. */
function collectStats(
  layers: readonly LayerNode[],
  effective: Map<string, boolean>,
  visibility: VisibilityMap,
): LayerStats {
  const stats: LayerStats = { total: 0, seen: 0 };
  const walk = (nodes: readonly LayerNode[], parentId: string | null): void => {
    nodes.forEach((node, index) => {
      const id = layerId(parentId, index);
      const own = visibility[id] ?? !node.hidden;
      const shown = effective.get(id) ?? own;
      stats.total += 1;
      if (shown) stats.seen += 1;
      if (node.children && node.children.length > 0) walk(node.children, id);
    });
  };
  walk(layers, null);
  return stats;
}

function LayerSkeleton() {
  const widths = ['72%', '54%', '64%', '46%', '58%', '40%'];
  return (
    <div className="flex flex-col gap-2 py-1">
      <p className="text-xs leading-relaxed text-studio-300">正在解码图层…图层列表会在画面合成完成后出现。</p>
      <div aria-hidden="true" className="flex flex-col gap-2">
        {widths.map((width, index) => (
          <div key={index} className="flex items-center gap-2" style={{ paddingLeft: `${index % 3}px` }}>
            <span className="h-4 w-4 shrink-0 rounded bg-studio-800" />
            <span className="shimmer-line h-3 rounded bg-studio-800/80" style={{ width }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function LayerPanel({
  layers,
  visibility,
  effective,
  disabled,
  showRows,
  layerCount,
  onToggle,
  onShowAll,
  onHideAll,
  onReset,
}: LayerPanelProps) {
  // Collapsible on small screens. Defaults to open so the rows are always
  // present on first render (a collapsed-by-default panel would hide the layer
  // list on phones and in a narrow browser window).
  const [open, setOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rowsVisible = showRows && layers.length > 0;
  const stats = useMemo(() => collectStats(layers, effective, visibility), [layers, effective, visibility]);
  const total = stats.total > 0 ? stats.total : layerCount;
  const select = (id: string) => setSelectedId((current) => (current === id ? null : id));

  const controlClass =
    'flex-1 px-2 py-1 text-[11px] transition hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <section className="glass flex min-h-0 flex-col gap-3 rounded-2xl p-3 lg:h-[calc(100vh-11rem)] lg:w-80 lg:shrink-0">
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex items-baseline gap-2 font-display text-sm font-semibold tracking-wide text-studio-100">
              图层
              <span className="text-[11px] font-normal tabular-nums text-studio-300">
                {rowsVisible ? `${stats.seen} / ${total} 显示` : `${layerCount} 个`}
              </span>
            </h2>
            <p className="mt-0.5 text-[10px] leading-relaxed text-studio-400">
              点击行选中 · 眼睛按钮切换显示（本地重绘，不重新解码）
            </p>
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="layer-panel-body"
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 rounded-full border border-studio-600 px-2 py-0.5 text-[11px] font-normal text-studio-300 transition hover:border-accent hover:text-accent lg:hidden"
          >
            {open ? '收起' : '展开'}
          </button>
        </div>

        <div className="flex overflow-hidden rounded-lg border border-studio-700/80 bg-studio-900/50">
          <button type="button" onClick={onShowAll} disabled={disabled} className={controlClass}>
            全部显示
          </button>
          <span aria-hidden="true" className="w-px bg-studio-700/80" />
          <button type="button" onClick={onHideAll} disabled={disabled} className={controlClass}>
            全部隐藏
          </button>
          <span aria-hidden="true" className="w-px bg-studio-700/80" />
          <button type="button" onClick={onReset} disabled={disabled} className={controlClass}>
            恢复默认
          </button>
        </div>
      </div>

      <div
        id="layer-panel-body"
        className={`min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain pr-1 lg:max-h-none lg:flex-1 ${
          open ? 'block' : 'hidden lg:block'
        }`}
      >
        {rowsVisible ? (
          <ul className="flex flex-col gap-px">
            {layers.map((node, index) => {
              const id = layerId(null, index);
              return (
                <LayerRow
                  key={id}
                  node={node}
                  id={id}
                  depth={0}
                  visibility={visibility}
                  effective={effective}
                  disabled={disabled}
                  selectedId={selectedId}
                  onToggle={onToggle}
                  onSelect={select}
                />
              );
            })}
          </ul>
        ) : (
          <LayerSkeleton />
        )}
      </div>
    </section>
  );
}

export default LayerPanel;
