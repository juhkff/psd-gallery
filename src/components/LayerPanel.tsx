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
 *
 * ROW RHYTHM (deliberate, because these rows are the most-looked-at surface):
 * every row is a two-line block with a fixed metric - a 28px name line that the
 * 28px eye control shares, then a 16px chip line. Every chip and every plain
 * value on the chip line is exactly `h-4`, so the second line is one shared
 * baseline instead of a ragged mix of pills and text. Group rows get a child
 * count so they keep the same two-line height as leaves.
 *
 * NESTING: the guide is drawn per row and extends 4px past the row's top and
 * bottom, which is exactly the list gap - so consecutive rows' rails meet and
 * read as one continuous line rather than a dashed column. Each level is a rail
 * plus, at the deepest level, an elbow that turns into the row: shape, not
 * colour, is what says "this belongs to that group".
 *
 * LIQUID GLASS
 * The panel is one `liquid-glass` pane (with its moving sheen) and every layer
 * row is a `liquid-glass-thin` surface: hover/selection brighten the row's rim
 * (border color, not an opaque wash) and selection adds a gold rail plus a soft
 * glow. The eye button keeps its single-svg child contract; state is expressed
 * with the icon shape, the fill and a ring rather than a wrapper element.
 */

import { useMemo, useState, type ReactNode } from 'react';
import type { LayerNode } from '../../shared/manifest';
import { blendLabel, isApproximate } from '../../shared/blend';
import { formatOpacity, formatSize } from '../lib/format';
import { KIND_LABELS } from '../psd/layer-info';
import type { VisibilityMap } from '../psd/protocol';
import { layerId } from '../psd/composite';

/** Horizontal step per nesting level, in px. Shared by rows and guides. */
const INDENT = 16;
/** Left edge of the guide rails. */
const RAIL_LEFT = 10;
/** Row-local y of the name line's centre; the elbow lands here. */
const ELBOW_TOP = 20;

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

/** A group marker: a stacked-folders glyph, so groups are not "just bold". */
function GroupIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-studio-400" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M1.8 12.2V4.4h4l1.2 1.5h7.2v6.3z" />
      <path d="M3.4 8.1h9.2" />
    </svg>
  );
}

/**
 * A tiny glass pill. Tone is carried by the label color so the pane tint stays.
 * Fixed `h-4` is the alignment contract for the chip line.
 */
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
    neutral: 'text-studio-300',
    accent: 'text-accent-soft',
    warn: 'text-amber-300',
  } as const;
  return (
    <span
      title={title}
      className={`liquid-glass-thin inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-[10px] leading-none ${tones[tone]}`}
    >
      <span className="relative z-[1]">{children}</span>
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
  const childCount = node.children?.length ?? 0;

  return (
    <li className="min-w-0">
      <div
        data-testid="layer-row"
        data-layer-id={id}
        data-visible={shown ? 'true' : 'false'}
        data-selected={selected ? 'true' : undefined}
        onClick={() => onSelect(id)}
        style={{ paddingLeft: `${8 + depth * INDENT}px` }}
        className={`liquid-glass-thin hover-glow group relative grid min-h-[3.75rem] grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 rounded-xl py-1.5 pr-2.5 ${
          selected
            ? 'border-accent/50 shadow-[0_0_0_1px_rgba(201,162,39,0.22),0_18px_36px_-22px_rgba(201,162,39,0.85)]'
            : 'border-studio-100/10 hover:border-studio-100/25 hover:shadow-[0_14px_30px_-20px_rgba(0,0,0,0.95)]'
        }`}
      >
        {/* Selection: a warm wash, a gold rail on the leading edge and a soft
            outer glow. Enough to be unmistakable at a glance, but it stays a
            translucent tint - no opaque outline, which would fight the glass. */}
        {selected && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-xl bg-accent/[0.13]" />
        )}
        {selected && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-gradient-to-b from-accent-soft via-accent to-ember shadow-[0_0_12px_rgba(201,162,39,0.75)]"
          />
        )}

        {/* Nesting guide: one rail per ancestor level, plus an elbow at the
            deepest level. `-top-1`/`-bottom-1` bridge the list gap so the rails
            of consecutive rows join into a continuous line. */}
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-1 -top-1 z-[1] flex"
            style={{ left: RAIL_LEFT }}
          >
            {Array.from({ length: depth }, (_, index) => {
              const deepest = index === depth - 1;
              return (
                <span
                  key={index}
                  className={`relative w-4 border-l ${deepest ? 'border-studio-400/40' : 'border-studio-600/45'}`}
                >
                  {deepest && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 h-px w-2.5 bg-studio-400/45"
                      style={{ top: ELBOW_TOP + 4 }}
                    />
                  )}
                </span>
              );
            })}
          </span>
        )}

        {/* The eye. A 28px rounded square - big enough to hit, and a square (not
            a circle) so it reads as a control rather than as a status LED. */}
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
          className={`relative z-[1] grid h-7 w-7 shrink-0 place-items-center rounded-[9px] border transition duration-200 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 ${
            own
              ? 'border-accent/35 bg-gradient-to-b from-accent/25 to-accent/[0.06] text-accent-soft shadow-[inset_0_1px_0_rgba(236,236,242,0.22)] hover:border-accent/60 hover:from-accent/35'
              : 'border-studio-100/10 bg-studio-950/50 text-studio-400 hover:border-studio-100/25 hover:text-studio-200'
          }`}
        >
          <EyeIcon open={own} />
        </button>

        <div className="relative z-[1] min-w-0">
          <div className="flex min-h-7 min-w-0 items-center gap-2">
            {node.isGroup && <GroupIcon />}
            <span
              className={`truncate text-[13px] leading-5 ${node.isGroup ? 'font-semibold' : ''} ${
                shown ? 'text-studio-100' : 'text-studio-400'
              }`}
            >
              {node.name}
            </span>
            {kindLabel && <Chip>{kindLabel}</Chip>}
          </div>

          {/* The chip line. Everything here is exactly h-4 / leading-4 so the row
              keeps one shared baseline; opacity and size are plain tabular text
              (not pills) so a row does not turn into five competing lozenges. */}
          <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] leading-4">
            {node.blendMode !== 'normal' && (
              <Chip tone="accent" title={approximate ? '浏览器只能近似还原' : undefined}>
                混合：{blendLabel(node.blendMode)}
                {approximate ? ' ≈' : ''}
              </Chip>
            )}
            {node.opacity < 1 && (
              <span className="tabular-nums text-studio-300" title="图层不透明度">
                {formatOpacity(node.opacity)}
              </span>
            )}
            {!node.isGroup && <span className="tabular-nums text-studio-400">{formatSize(width, height)} px</span>}
            {!node.hasImage && !node.isGroup && <span className="text-studio-400">无像素数据</span>}
            {node.isGroup && <span className="tabular-nums text-studio-400">{childCount} 个子图层</span>}
            {node.note && <span className="text-amber-300/90">{node.note}</span>}
            {buried && <span className="text-amber-300/90">所在组已隐藏</span>}
          </div>
        </div>
      </div>

      {node.children && node.children.length > 0 && (
        <ul className="flex flex-col gap-1 pt-1">
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

/**
 * Placeholder rows, on the real row metric: a 28px eye slot on a 28px name line
 * and a 16px chip line. A skeleton that is a different height than the real rows
 * makes the whole list jump when the decode lands.
 */
function LayerSkeleton() {
  const widths = ['72%', '54%', '64%', '46%', '58%', '40%'];
  return (
    <div className="flex flex-col gap-2 py-1">
      <p className="text-xs leading-relaxed text-studio-300">正在解码图层…图层列表会在画面合成完成后出现。</p>
      <div aria-hidden="true" className="flex flex-col gap-1">
        {widths.map((width, index) => (
          <div
            key={index}
            className="liquid-glass-thin grid min-h-[3.75rem] grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 rounded-xl py-1.5 pr-2.5"
            style={{ paddingLeft: `${8 + (index % 3) * INDENT}px` }}
          >
            <span className="h-7 w-7 shrink-0 rounded-[9px] bg-studio-800/80" />
            <span className="flex min-h-7 flex-col justify-center gap-2">
              <span className="shimmer-line h-3 rounded bg-studio-800/80" style={{ width }} />
              <span className="h-2.5 w-24 rounded bg-studio-800/60" />
            </span>
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
    'rounded-full px-2 py-1 text-[11px] text-studio-300 transition hover:bg-accent/[0.12] hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-40';

  // Height comes from the row: `items-stretch` matches the panel to the viewer
  // column, and `min-h-0` keeps a 60-layer document from growing the page - the
  // row list scrolls inside instead. (A fixed `100vh-11rem` height was taller
  // than the viewer column at a 1000px viewport, so the pane hung past the fold
  // and read as an unfinished rectangle.)
  return (
    <section className="liquid-glass liquid-interactive flex min-h-0 flex-col p-3 lg:w-80 lg:shrink-0">
      <div className="relative z-[1] flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="flex items-baseline gap-2 font-display text-sm font-semibold tracking-wide text-studio-100">
                <span className="text-gradient-ice">图层</span>
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
              className="shrink-0 rounded-full border border-studio-100/15 bg-studio-100/[0.05] px-2 py-0.5 text-[11px] font-normal text-studio-300 transition hover:border-accent hover:text-accent lg:hidden"
            >
              {open ? '收起' : '展开'}
            </button>
          </div>

          <div aria-hidden="true" className="glass-divider mt-2.5" />

          {/* Segmented control: pill wrapper, pill segments, hairline dividers. */}
          <div className="mt-2.5 flex items-stretch rounded-full border border-studio-100/10 bg-studio-950/40 p-0.5">
            <button type="button" onClick={onShowAll} disabled={disabled} className={`flex-1 ${controlClass}`}>
              全部显示
            </button>
            <span
              aria-hidden="true"
              className="my-1 w-px shrink-0 bg-gradient-to-b from-transparent via-studio-100/15 to-transparent"
            />
            <button type="button" onClick={onHideAll} disabled={disabled} className={`flex-1 ${controlClass}`}>
              全部隐藏
            </button>
            <span
              aria-hidden="true"
              className="my-1 w-px shrink-0 bg-gradient-to-b from-transparent via-studio-100/15 to-transparent"
            />
            <button type="button" onClick={onReset} disabled={disabled} className={`flex-1 ${controlClass}`}>
              恢复默认
            </button>
          </div>
        </div>

        {/* The rows scroll inside the pane: 60 layers must never grow the page.
            The scroll container is a child of the glass, never an ancestor of it. */}
        <div
          id="layer-panel-body"
          className={`min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain pr-1 lg:max-h-none lg:flex-1 ${
            open ? 'block' : 'hidden lg:block'
          }`}
        >
          {rowsVisible ? (
            <ul className="flex flex-col gap-1">
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
      </div>

      <i aria-hidden="true" className="liquid-sheen" />
      <i aria-hidden="true" className="liquid-specular" />
    </section>
  );
}

export default LayerPanel;
