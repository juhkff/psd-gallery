/**
 * Translate ag-psd `Layer` objects into the manifest's `LayerNode` shape and
 * collect the honest "what the browser cannot reproduce" caveats.
 *
 * `Layer` is imported **type-only** so this module can also be loaded on the
 * main thread (and in unit tests) without pulling ag-psd into a chunk.
 */

import type { Layer } from 'ag-psd';
import type { LayerNode, LayerRect } from '../../shared/manifest';
import { isApproximate } from '../../shared/blend';

export const KIND_LABELS: Record<string, string> = {
  pixel: '像素图层',
  text: '文字图层',
  adjustment: '调整图层',
  smartObject: '智能对象',
  vector: '矢量图层',
  group: '图层组',
};

export const CAVEAT_NON_PIXEL =
  '本作品含文字 / 矢量 / 智能对象 / 调整图层：网页端的图层合成只重绘像素图层，这些效果不会显示（请下载 PSD 用 Photoshop 查看完整效果）。';

export const CAVEAT_BLEND_APPROX = '部分混合模式浏览器无法精确还原，已自动使用最接近的替代模式。';

export const CAVEAT_GROUP_OPACITY = '图层组的不透明度按子图层近似处理，组级混合与蒙版不会完全一致。';

export const CAVEAT_EFFECTS = '图层样式（阴影 / 发光 / 描边等）不会在网页端重绘。';

export const CAVEAT_PROXY = '文档较大，已使用代理分辨率解码与合成，画面为缩放预览，图层切换仍然即时。';

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** PSD folder layers are marked with a `sectionDivider` record. */
export function isGroupLayer(layer: Layer): boolean {
  const divider = layer.sectionDivider;
  if (divider) {
    const type = asNumber(divider.type);
    // 1 = open folder, 2 = closed folder, 3 = bounding section divider.
    if (type === 1 || type === 2 || type === 3) return true;
  }
  return Array.isArray(layer.children) && layer.children.length > 0;
}

/** True when the layer carries pixel data that `getLayerCanvas()` can decode. */
export function layerHasImage(layer: Layer): boolean {
  if (isGroupLayer(layer)) return false;
  return Boolean(layer.rawData || layer.imageData || layer.canvas);
}

export function layerKindOf(layer: Layer): string | undefined {
  if (isGroupLayer(layer)) return 'group';
  if (layer.text) return 'text';
  if (layer.adjustment) return 'adjustment';
  if (layer.placedLayer) return 'smartObject';
  if (layer.vectorFill || layer.vectorMask || layer.vectorStroke) return 'vector';
  if (layerHasImage(layer)) return 'pixel';
  return undefined;
}

/** Chinese hint explaining what will be missing when this layer is not pixel art. */
export function layerNoteOf(layer: Layer): string | undefined {
  const kind = layerKindOf(layer);
  switch (kind) {
    case 'text':
      return '文字内容与效果不会重绘';
    case 'adjustment':
      return '调整效果不会重绘';
    case 'smartObject':
      return '智能对象变换与样式不会重绘';
    case 'vector':
      return '矢量填充 / 描边不会重绘';
    default:
      break;
  }
  if (layer.effects) return '图层样式不会重绘';
  return undefined;
}

/** Document-space rect, falling back to the whole canvas for degenerate layers. */
export function layerRectOf(layer: Layer, documentWidth: number, documentHeight: number): LayerRect {
  const left = asNumber(layer.left) ?? 0;
  const top = asNumber(layer.top) ?? 0;
  const right = asNumber(layer.right) ?? left + documentWidth;
  const bottom = asNumber(layer.bottom) ?? top + documentHeight;
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
  };
}

/** Depth-first conversion; `children` are already in Photoshop panel order. */
export function buildLayerTree(
  children: readonly Layer[] | undefined,
  documentWidth: number,
  documentHeight: number,
): LayerNode[] {
  if (!children || children.length === 0) return [];
  return children.map((layer) => {
    const group = isGroupLayer(layer);
    const kind = layerKindOf(layer);
    const note = layerNoteOf(layer);
    const nested = group ? buildLayerTree(layer.children, documentWidth, documentHeight) : [];
    const node: LayerNode = {
      name: layer.name ?? '未命名图层',
      hidden: layer.hidden === true,
      opacity: Math.min(1, Math.max(0, asNumber(layer.opacity) ?? 1)),
      blendMode: layer.blendMode ?? 'normal',
      rect: layerRectOf(layer, documentWidth, documentHeight),
      hasImage: layerHasImage(layer),
      isGroup: group,
    };
    if (kind) node.kind = kind;
    if (note) node.note = note;
    if (nested.length > 0) node.children = nested;
    return node;
  });
}

export interface CaveatOptions {
  /** True when the viewer fell back to a reduced-resolution proxy. */
  useProxy: boolean;
}

/** Stable, de-duplicated list of caveats for the given tree. */
export function collectCaveats(layers: readonly LayerNode[], options: CaveatOptions): string[] {
  const caveats: string[] = [];
  const kinds = new Set<string>();

  const walk = (nodes: readonly LayerNode[]): void => {
    for (const node of nodes) {
      if (node.kind) kinds.add(node.kind);
      if (node.isGroup && node.opacity < 1) kinds.add('groupOpacity');
      if (node.hasImage && isApproximate(node.blendMode)) kinds.add('blendApprox');
      if (node.note && node.note.includes('图层样式')) kinds.add('effects');
      if (node.children) walk(node.children);
    }
  };
  walk(layers);

  if (kinds.has('text') || kinds.has('vector') || kinds.has('smartObject') || kinds.has('adjustment')) {
    caveats.push(CAVEAT_NON_PIXEL);
  }
  if (kinds.has('effects')) caveats.push(CAVEAT_EFFECTS);
  if (kinds.has('blendApprox')) caveats.push(CAVEAT_BLEND_APPROX);
  if (kinds.has('groupOpacity')) caveats.push(CAVEAT_GROUP_OPACITY);
  if (options.useProxy) caveats.push(CAVEAT_PROXY);
  return caveats;
}
