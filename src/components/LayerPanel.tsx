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
 */

import { useState } from 'react';
import type { LayerNode } from '../../shared/manifest';
import { blendLabel, isApproximate } from '../../shared/blend';
import { formatOpacity, formatSize } from '../lib/format';
import { KIND_LABELS } from '../psd/layer-info';
import type { VisibilityMap } from '../psd/protocol';
import { layerId } from '../psd/composite';

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M1.8 10S4.9 4.8 10 4.8 18.2 10 18.2 10 15.1 15.2 10 15.2 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M1.8 10S4.9 4.8 10 4.8c1.5 0 2.8.5 3.9 1.2M18.2 10s-3.1 5.2-8.2 5.2c-1.5 0-2.8-.5-3.9-1.2" />
      <path d="M3.2 3.2 16.8 16.8" />
    </svg>
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
  onToggle: (id: string, next?: boolean) => void;
}

function LayerRow({ node, id, depth, visibility, effective, disabled, onToggle }: RowProps) {
  const own = visibility[id] ?? !node.hidden;
  const shown = effective.get(id) ?? own;
  const width = Math.round(node.rect.right - node.rect.left);
  const height = Math.round(node.rect.bottom - node.rect.top);
  const kindLabel = node.kind ? KIND_LABELS[node.kind] ?? node.kind : null;
  const approximate = isApproximate(node.blendMode);

  return (
    <li>
      <div
        data-testid="layer-row"
        data-layer-id={id}
        data-visible={shown ? 'true' : 'false'}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
          shown ? 'text-studio-100' : 'text-studio-300'
        } hover:bg-studio-800/60`}
      >
        <button
          type="button"
          data-testid="layer-toggle"
          aria-pressed={own}
          aria-label={`${own ? '隐藏' : '显示'}图层 ${node.name}`}
          title={own ? '隐藏此图层' : '显示此图层'}
          disabled={disabled}
          onClick={() => onToggle(id, !own)}
          className={`mt-0.5 shrink-0 rounded p-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${
            own ? 'text-accent hover:bg-studio-700' : 'text-studio-600 hover:bg-studio-700'
          }`}
        >
          <EyeIcon open={own} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`truncate text-sm ${node.isGroup ? 'font-semibold' : ''}`}>{node.name}</span>
            {kindLabel && (
              <span className="rounded bg-studio-700 px-1 py-px text-[10px] text-studio-300">{kindLabel}</span>
            )}
            {node.blendMode !== 'normal' && (
              <span className="text-[11px] text-accent" title={approximate ? '浏览器只能近似还原' : undefined}>
                混合：{blendLabel(node.blendMode)}
                {approximate ? ' ≈' : ''}
              </span>
            )}
            {node.opacity < 1 && <span className="text-[11px] text-studio-300">{formatOpacity(node.opacity)}</span>}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-studio-300">
            {!node.isGroup && <span>{formatSize(width, height)} px</span>}
            {!node.hasImage && !node.isGroup && <span>无像素数据</span>}
            {node.note && <span className="text-amber-300/90">{node.note}</span>}
            {own && !shown && <span className="text-amber-300/90">所在组已隐藏</span>}
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
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
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

  return (
    <section className="flex min-h-0 flex-col gap-3 rounded-xl border border-studio-700 bg-studio-900/70 p-3 lg:h-[calc(100vh-11rem)] lg:w-80 lg:shrink-0 lg:overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          图层
          <span className="text-xs font-normal text-studio-300">{layerCount} 个</span>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="layer-panel-body"
            onClick={() => setOpen((value) => !value)}
            className="rounded border border-studio-600 px-2 py-0.5 text-[11px] font-normal hover:border-accent hover:text-accent lg:hidden"
          >
            {open ? '收起' : '展开'}
          </button>
        </h2>
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={onShowAll}
            disabled={disabled}
            className="rounded border border-studio-600 px-2 py-1 hover:border-accent hover:text-accent disabled:opacity-40"
          >
            全部显示
          </button>
          <button
            type="button"
            onClick={onHideAll}
            disabled={disabled}
            className="rounded border border-studio-600 px-2 py-1 hover:border-accent hover:text-accent disabled:opacity-40"
          >
            全部隐藏
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            className="rounded border border-studio-600 px-2 py-1 hover:border-accent hover:text-accent disabled:opacity-40"
          >
            恢复默认
          </button>
        </div>
      </div>

      <div id="layer-panel-body" className={open ? 'flex min-h-0 flex-col' : 'hidden min-h-0 flex-col lg:flex'}>
        {!showRows || layers.length === 0 ? (
          <p className="text-xs text-studio-300">正在解码图层…图层列表会在画面合成完成后出现。</p>
        ) : (
          <ul className="flex flex-col">
            {layers.map((node, index) => (
              <LayerRow
                key={layerId(null, index)}
                node={node}
                id={layerId(null, index)}
                depth={0}
                visibility={visibility}
                effective={effective}
                disabled={disabled}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default LayerPanel;
