/**
 * Pure compositing decisions - no DOM, no workers, no ag-psd runtime.
 *
 * Everything here is deterministic given (layer tree, visibility overrides), so
 * the worker and the React layer panel share exactly one source of truth and
 * the whole module is unit-testable under Node.
 *
 * The manifest lists layers **top-most first** (Photoshop panel order), so the
 * draw order used by the compositor is the reverse of a pre-order flatten.
 */

import { blendInfo, isApproximate, toCompositeOperation } from '../../shared/blend';
import type { LayerNode, LayerRect } from '../../shared/manifest';

/** Documents above this many pixels are decoded/rendered through a proxy. */
export const PROXY_PIXEL_THRESHOLD = 6_000_000;

/** Longest edge of the proxy composite, in pixels (measured sweet spot ~1500px). */
export const PROXY_MAX_EDGE = 1500;

/** Never shrink a document below this factor (guards absurdly large PSDs). */
export const PROXY_MIN_SCALE = 0.02;

export type VisibilityOverrides = Readonly<Record<string, boolean>>;

export interface FlatLayer {
  /** Dotted index path, stable for a given tree: "0", "0.2". */
  id: string;
  name: string;
  /** 0 for top-level layers, +1 per group nesting level. */
  depth: number;
  /** `null` for top-level layers. */
  parentId: string | null;
  isGroup: boolean;
  hasImage: boolean;
  /** PSD `hidden` flag (declared default). */
  hidden: boolean;
  opacity: number;
  blendMode: string;
  rect: LayerRect;
  kind?: string;
  note?: string;
  node: LayerNode;
}

export interface PlannedLayer {
  id: string;
  name: string;
  depth: number;
  /** Position/size in proxy pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Effective alpha (own opacity × ancestor group opacity), 0..1. */
  opacity: number;
  blendMode: string;
  /** `globalCompositeOperation` value. */
  composite: string;
  /** True when a fallback animation cannot reproduce the PSD mode exactly. */
  approximate: boolean;
  /** Blend mode label for tooltips. */
  label: string;
}

export interface ProxyPlan {
  useProxy: boolean;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  pixels: number;
  documentPixels: number;
}

export function layerId(parentId: string | null, index: number): string {
  return parentId === null ? String(index) : `${parentId}.${index}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Depth-first, pre-order flatten (parents before children, top-most first). */
export function flattenLayers(layers: readonly LayerNode[]): FlatLayer[] {
  const out: FlatLayer[] = [];
  const walk = (nodes: readonly LayerNode[], parentId: string | null, depth: number): void => {
    nodes.forEach((node, index) => {
      const id = layerId(parentId, index);
      out.push({
        id,
        name: node.name,
        depth,
        parentId,
        isGroup: node.isGroup,
        hasImage: node.hasImage && !node.isGroup,
        hidden: node.hidden,
        opacity: clamp01(node.opacity),
        blendMode: node.blendMode,
        rect: node.rect,
        ...(node.kind ? { kind: node.kind } : {}),
        ...(node.note ? { note: node.note } : {}),
        node,
      });
      if (node.children && node.children.length > 0) walk(node.children, id, depth + 1);
    });
  };
  walk(layers, null, 0);
  return out;
}

/** Look up one flattened layer by id (null when the tree changed underneath). */
export function findFlatLayer(layers: readonly LayerNode[], id: string): FlatLayer | null {
  if (!/^\d+(\.\d+)*$/.test(id)) return null;
  let nodes: readonly LayerNode[] | undefined = layers;
  let node: LayerNode | undefined;
  for (const part of id.split('.')) {
    if (!nodes) return null;
    node = nodes[Number(part)];
    if (!node) return null;
    nodes = node.children;
  }
  if (!node) return null;
  // Re-derive depth by counting segments.
  const depth = id.split('.').length - 1;
  const parentId = depth === 0 ? null : id.slice(0, id.lastIndexOf('.'));
  return {
    id,
    name: node.name,
    depth,
    parentId,
    isGroup: node.isGroup,
    hasImage: node.hasImage && !node.isGroup,
    hidden: node.hidden,
    opacity: clamp01(node.opacity),
    blendMode: node.blendMode,
    rect: node.rect,
    ...(node.kind ? { kind: node.kind } : {}),
    ...(node.note ? { note: node.note } : {}),
    node,
  };
}

/**
 * Effective visibility: a layer is visible only when neither it nor any
 * ancestor group is hidden/toggled off. Overrides win over the PSD default.
 */
export function resolveVisibility(
  layers: readonly LayerNode[],
  overrides: VisibilityOverrides = {},
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const flat of flattenLayers(layers)) {
    const own = overrides[flat.id] ?? !flat.hidden;
    const parentVisible = flat.parentId === null ? true : result.get(flat.parentId) ?? true;
    result.set(flat.id, own && parentVisible);
  }
  return result;
}

/** A folder node: `isGroup`, or (defensively) any node carrying children. */
function isFolder(layer: FlatLayer): boolean {
  return layer.isGroup || (layer.node.children?.length ?? 0) > 0;
}

/** Effective alpha contributed by a group to its children (product of ancestors). */
function groupAlphaByLayer(flat: readonly FlatLayer[]): Map<string, number> {
  const alpha = new Map<string, number>();
  for (const layer of flat) {
    const parentAlpha = layer.parentId === null ? 1 : alpha.get(layer.parentId) ?? 1;
    alpha.set(layer.id, isFolder(layer) ? parentAlpha * layer.opacity : parentAlpha);
  }
  return alpha;
}

/**
 * Draw list: the layers that must actually be painted, in **bottom-most first**
 * order, already mapped to proxy pixels and `globalCompositeOperation` values.
 *
 * `flattenLayers` is pre-order over ag-psd's `children`, which Photoshop lists
 * TOP-MOST FIRST, so the last flatten entry is the bottom-most layer and painting
 * must walk the flatten BACKWARDS.
 *
 * This was investigated after a report that the live canvas showed a flat fill.
 * Pixel-diffing against ag-psd's own `getCompositeCanvas()` for the same document
 * proved the order is correct (mean |diff| per channel 0.0 for a PSD whose layer
 * records are ordered properly). The real defect was in the sample PSDs, whose
 * layer records were written inverted - see scripts/samples/generate_samples.py.
 * Do NOT "fix" a flat composite by flipping this loop.
 *
 * `plan` is only needed for proxy rendering; without it document pixels are used.
 */
export function planComposite(
  layers: readonly LayerNode[],
  overrides: VisibilityOverrides = {},
  plan?: ProxyPlan,
): PlannedLayer[] {
  const flat = flattenLayers(layers);
  const visibility = resolveVisibility(layers, overrides);
  const groupAlpha = groupAlphaByLayer(flat);
  const scaleX = plan && plan.scaleX > 0 ? plan.scaleX : 1;
  const scaleY = plan && plan.scaleY > 0 ? plan.scaleY : 1;

  const out: PlannedLayer[] = [];
  // Backwards over a top-first flatten == bottom-most layer painted first.
  for (let index = flat.length - 1; index >= 0; index -= 1) {
    const layer = flat[index];
    if (isFolder(layer) || !layer.hasImage) continue;
    if (!visibility.get(layer.id)) continue;

    const rect = layer.rect;
    const documentWidth = rect.right - rect.left;
    const documentHeight = rect.bottom - rect.top;
    if (!(documentWidth > 0) || !(documentHeight > 0)) continue;

    const ancestorAlpha = layer.parentId === null ? 1 : groupAlpha.get(layer.parentId) ?? 1;
    const opacity = clamp01(layer.opacity) * ancestorAlpha;
    if (opacity <= 0) continue;

    const x = Math.round(rect.left * scaleX);
    const y = Math.round(rect.top * scaleY);
    const width = Math.max(1, Math.round(documentWidth * scaleX));
    const height = Math.max(1, Math.round(documentHeight * scaleY));
    const info = blendInfo(layer.blendMode);

    out.push({
      id: layer.id,
      name: layer.name,
      depth: layer.depth,
      x,
      y,
      width,
      height,
      opacity,
      blendMode: layer.blendMode,
      composite: toCompositeOperation(layer.blendMode),
      approximate: isApproximate(layer.blendMode) || ancestorAlpha < 1,
      label: info.label,
    });
  }
  return out;
}

export interface ProxyPlanOptions {
  /** Pixel count above which the proxy path kicks in. */
  thresholdPx?: number;
  /** Longest edge of the proxy composite. */
  maxEdge?: number;
  /** Force the proxy path regardless of size (dev / e2e). */
  force?: boolean;
}

/** Choose the decode/render resolution for a document. Never upscales. */
export function computeProxyPlan(
  documentWidth: number,
  documentHeight: number,
  options: ProxyPlanOptions = {},
): ProxyPlan {
  const width = Number.isFinite(documentWidth) ? Math.max(0, Math.round(documentWidth)) : 0;
  const height = Number.isFinite(documentHeight) ? Math.max(0, Math.round(documentHeight)) : 0;
  const pixels = width * height;
  const threshold = options.thresholdPx ?? PROXY_PIXEL_THRESHOLD;
  const maxEdge = options.maxEdge ?? PROXY_MAX_EDGE;
  const full: ProxyPlan = {
    useProxy: false,
    scaleX: 1,
    scaleY: 1,
    width: Math.max(1, width),
    height: Math.max(1, height),
    pixels: Math.max(1, pixels),
    documentPixels: pixels,
  };
  if (pixels <= 0) return full;
  if (!options.force && pixels <= threshold) return full;

  const longest = Math.max(width, height);
  const rawScale = longest > 0 ? maxEdge / longest : 1;
  const scale = Math.max(PROXY_MIN_SCALE, Math.min(1, rawScale));
  if (scale >= 1 && !options.force) return full;
  const proxyWidth = Math.max(1, Math.round(width * scale));
  const proxyHeight = Math.max(1, Math.round(height * scale));
  return {
    useProxy: true,
    scaleX: proxyWidth / width,
    scaleY: proxyHeight / height,
    width: proxyWidth,
    height: proxyHeight,
    pixels: proxyWidth * proxyHeight,
    documentPixels: pixels,
  };
}

/** Scale a document-space rect into proxy pixels (used for canvas layout). */
export function scaleRect(
  rect: LayerRect,
  plan: ProxyPlan,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(rect.left * plan.scaleX),
    y: Math.round(rect.top * plan.scaleY),
    width: Math.max(1, Math.round((rect.right - rect.left) * plan.scaleX)),
    height: Math.max(1, Math.round((rect.bottom - rect.top) * plan.scaleY)),
  };
}

/** True when the tree contains at least one layer that can be drawn. */
export function hasDrawableLayers(layers: readonly LayerNode[]): boolean {
  return flattenLayers(layers).some((layer) => layer.hasImage);
}

/** All drawable layer ids, bottom-first (the order the worker decodes them in). */
export function drawableLayerIds(layers: readonly LayerNode[]): string[] {
  return flattenLayers(layers)
    .filter((layer) => layer.hasImage)
    .map((layer) => layer.id)
    .reverse();
}
