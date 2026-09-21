/**
 * Unit tests for the pure compositing decisions.
 *
 * These are the invariants the whole viewer rests on:
 *  1. group visibility propagates to descendants,
 *  2. the draw order is Photoshop's (bottom-most first),
 *  3. proxy scale math is exact for known document sizes,
 *  4. blend modes map to the right `globalCompositeOperation` (with fallbacks),
 *  5. a visibility toggle never re-decodes a layer bitmap.
 *
 * Real PSD decoding is intentionally NOT unit-tested here - the Lead runs that
 * in a real browser.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Layer } from 'ag-psd';
import { blendLabel, isApproximate, toCompositeOperation } from '../../shared/blend';
import type { LayerNode } from '../../shared/manifest';
import { FIXTURE_MANIFEST } from '../__fixtures__/manifest';
import {
  PROXY_MAX_EDGE,
  PROXY_PIXEL_THRESHOLD,
  computeProxyPlan,
  drawableLayerIds,
  findFlatLayer,
  flattenLayers,
  planComposite,
  resolveVisibility,
  scaleRect,
} from './composite';
import { LayerBitmapCache } from './layer-cache';
import { buildLayerTree, collectCaveats, layerHasImage, layerKindOf } from './layer-info';

/** 2026-09-21 / 2 - nested tree: group, text layer, smart object, hidden layer. */
const NESTED: LayerNode[] = FIXTURE_MANIFEST.groups[0].works[1].layers;
/** 2026-09-21 / 1 - flat six-layer stack; index 4 uses `vividLight`. */
const FLAT: LayerNode[] = FIXTURE_MANIFEST.groups[0].works[0].layers;

const IDS = {
  text: '0',
  group: '1',
  groupTop: '1.0',
  groupBottom: '1.1',
  lineart: '2',
  hiddenHighlight: '3',
  shadow: '4',
  color: '5',
  wash: '6',
  smartObject: '7',
} as const;

/** A synthetic 4000x3000 document for the proxy maths. */
const BIG: LayerNode[] = [
  {
    name: 'background',
    hidden: false,
    opacity: 1,
    blendMode: 'normal',
    rect: { left: 0, top: 0, right: 4000, bottom: 3000 },
    hasImage: true,
    isGroup: false,
  },
  {
    name: 'inset',
    hidden: false,
    opacity: 1,
    blendMode: 'multiply',
    rect: { left: 400, top: 300, right: 800, bottom: 600 },
    hasImage: true,
    isGroup: false,
  },
];

describe('flattenLayers', () => {
  it('walks depth-first, top-most layer first, with dotted index ids', () => {
    const flat = flattenLayers(NESTED);
    expect(flat.map((layer) => layer.id)).toEqual(['0', '1', '1.0', '1.1', '2', '3', '4', '5', '6', '7']);
    expect(flat.map((layer) => layer.depth)).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(flat.find((layer) => layer.id === '1.0')?.parentId).toBe('1');
    expect(flat.find((layer) => layer.id === '0')?.parentId).toBeNull();
    expect(flat.find((layer) => layer.id === '1')?.isGroup).toBe(true);
  });

  it('findFlatLayer round-trips an id and rejects junk', () => {
    expect(findFlatLayer(NESTED, IDS.groupBottom)?.name).toBe('6a-颗粒质感');
    expect(findFlatLayer(NESTED, '9')).toBeNull();
    expect(findFlatLayer(NESTED, '1.x')).toBeNull();
    expect(findFlatLayer(NESTED, '')).toBeNull();
  });
});

describe('resolveVisibility (group propagation)', () => {
  it('falls back to the PSD hidden flag when there is no override', () => {
    const map = resolveVisibility(NESTED);
    expect(map.get(IDS.text)).toBe(true);
    expect(map.get(IDS.hiddenHighlight)).toBe(false);
    expect(map.get(IDS.groupTop)).toBe(true);
  });

  it('hides every descendant when a group is switched off', () => {
    const map = resolveVisibility(NESTED, { [IDS.group]: false });
    expect(map.get(IDS.group)).toBe(false);
    expect(map.get(IDS.groupTop)).toBe(false);
    expect(map.get(IDS.groupBottom)).toBe(false);
    // Unrelated siblings are untouched.
    expect(map.get(IDS.lineart)).toBe(true);
  });

  it('does not let a child override a hidden ancestor', () => {
    const map = resolveVisibility(NESTED, { [IDS.group]: false, [IDS.groupBottom]: true });
    expect(map.get(IDS.groupBottom)).toBe(false);
  });

  it('re-shows an explicitly hidden layer', () => {
    expect(resolveVisibility(NESTED, { [IDS.hiddenHighlight]: true }).get(IDS.hiddenHighlight)).toBe(true);
  });
});

describe('planComposite (draw order)', () => {
  it('draws bottom-most first and skips groups / hidden / non-pixel layers', () => {
    // Reverse document order: 7, 6, 5, 4, 3, 2, 1.1, 1.0, 1, 0.
    // Dropped: 7 (smart object, no pixels), 3 (hidden), 1 (group), 0 (text).
    expect(planComposite(NESTED).map((layer) => layer.id)).toEqual(['6', '5', '4', '2', '1.1', '1.0']);
  });

  it('inserts a re-shown layer at its correct stack position', () => {
    const planned = planComposite(NESTED, { [IDS.hiddenHighlight]: true });
    expect(planned.map((layer) => layer.id)).toEqual(['6', '5', '4', '3', '2', '1.1', '1.0']);
  });

  it('multiplies group opacity into child layers', () => {
    const planned = planComposite(NESTED);
    // 6-特效组 opacity = 0.8; 6b-亮片光斑 own opacity = 0.6 -> 0.48.
    expect(planned.find((layer) => layer.id === IDS.groupTop)?.opacity).toBeCloseTo(0.48, 5);
    // 6a-颗粒质感 own opacity = 1 -> just the group's 0.8.
    expect(planned.find((layer) => layer.id === IDS.groupBottom)?.opacity).toBeCloseTo(0.8, 5);
    const topLevel = planned.find((layer) => layer.id === IDS.lineart);
    expect(topLevel?.opacity).toBe(1);
  });

  it('maps blend modes and flags browser approximations', () => {
    const byId = new Map(planComposite(FLAT).map((layer) => [layer.id, layer]));
    expect(byId.get('0')?.composite).toBe('overlay'); // 6-颗粒质感
    expect(byId.get('1')?.composite).toBe('source-over'); // 5-线稿 (normal)
    expect(byId.get('3')?.composite).toBe('multiply'); // 3-暗部阴影
    expect(byId.get('2')).toBeUndefined(); // 4-高光 is hidden

    const fallback = byId.get('4');
    expect(fallback?.blendMode).toBe('vividLight');
    expect(fallback?.composite).toBe('source-over');
    expect(fallback?.approximate).toBe(true);
  });

  it('scales every rect by the proxy plan', () => {
    const plan = computeProxyPlan(4000, 3000);
    const planned = planComposite(BIG, {}, plan);
    const background = planned.find((layer) => layer.id === '0');
    expect(background).toMatchObject({ x: 0, y: 0, width: 1500, height: 1125 });
    const inset = planned.find((layer) => layer.id === '1');
    expect(inset).toMatchObject({ x: 150, y: 113, width: 150, height: 113 });
  });
});

describe('computeProxyPlan (proxy threshold math)', () => {
  it('keeps small documents at full resolution', () => {
    const plan = computeProxyPlan(1200, 800);
    expect(plan.useProxy).toBe(false);
    expect(plan.scaleX).toBe(1);
    expect(plan.width).toBe(1200);
    expect(plan.height).toBe(800);
  });

  it('renders a 12 MP document at a 1500px longest edge', () => {
    const plan = computeProxyPlan(4000, 3000);
    expect(plan.documentPixels).toBe(12_000_000);
    expect(plan.useProxy).toBe(true);
    expect(plan.width).toBe(PROXY_MAX_EDGE);
    expect(plan.height).toBe(1125);
    expect(plan.scaleX).toBeCloseTo(0.375, 6);
    expect(plan.scaleY).toBeCloseTo(0.375, 6);
    expect(plan.pixels).toBeLessThan(PROXY_PIXEL_THRESHOLD);
  });

  it('handles A4@300dpi (2480x3508, 8.7 MP)', () => {
    const plan = computeProxyPlan(2480, 3508);
    expect(plan.useProxy).toBe(true);
    expect(plan.height).toBe(1500);
    expect(plan.width).toBe(1060);
    expect(plan.pixels / 1_000_000).toBeLessThan(1.7);
  });

  it('honours a lowered threshold', () => {
    const plan = computeProxyPlan(2000, 2000, { thresholdPx: 1_000_000 });
    expect(plan.useProxy).toBe(true);
    expect(plan.width).toBe(1500);
    expect(plan.height).toBe(1500);
    expect(plan.scaleX).toBeCloseTo(0.75, 6);
  });

  it('never upscales, even when forced', () => {
    const plan = computeProxyPlan(800, 600, { force: true });
    expect(plan.width).toBe(800);
    expect(plan.height).toBe(600);
    expect(plan.scaleX).toBe(1);
  });

  it('scaleRect maps document pixels into proxy pixels', () => {
    const plan = computeProxyPlan(4000, 3000);
    expect(scaleRect({ left: 400, top: 300, right: 800, bottom: 600 }, plan)).toEqual({
      x: 150,
      y: 113,
      width: 150,
      height: 113,
    });
  });

  it('is degenerate-safe', () => {
    expect(computeProxyPlan(0, 0)).toMatchObject({ useProxy: false, width: 1, height: 1 });
    expect(computeProxyPlan(Number.NaN, Number.NaN).width).toBe(1);
  });
});

describe('blend mode mapping + fallbacks', () => {
  it('uses the CSS globalCompositeOperation spelling', () => {
    expect(toCompositeOperation('multiply')).toBe('multiply');
    expect(toCompositeOperation('colorBurn')).toBe('color-burn');
    expect(toCompositeOperation('linearDodge')).toBe('lighter');
    expect(toCompositeOperation('normal')).toBe('source-over');
  });

  it('falls back to source-over for modes the browser cannot reproduce', () => {
    for (const mode of ['vividLight', 'linearLight', 'pinLight', 'hardMix', 'subtract', 'divide', 'dissolve']) {
      expect(toCompositeOperation(mode)).toBe('source-over');
      expect(isApproximate(mode)).toBe(true);
    }
  });

  it('is exact for the modes canvas supports', () => {
    for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'softLight', 'hue', 'luminosity', 'difference']) {
      expect(isApproximate(mode)).toBe(false);
    }
  });

  it('labels in Chinese and degrades to the raw name', () => {
    expect(blendLabel('multiply')).toBe('正片叠底');
    expect(blendLabel(undefined)).toBe('正常');
    expect(blendLabel('frobnicate')).toBe('frobnicate');
  });

  it('tolerates loose spellings ("color burn", "ColorBurn")', () => {
    expect(toCompositeOperation('color burn')).toBe('color-burn');
    expect(toCompositeOperation('ColorBurn')).toBe('color-burn');
    expect(toCompositeOperation('')).toBe('source-over');
  });
});

describe('decode-once invariant (toggles never re-decode)', () => {
  interface FakeBitmap {
    id: string;
    close: () => void;
  }

  it('decodes every drawable layer exactly once', async () => {
    const decode = vi.fn(async (id: string): Promise<FakeBitmap> => ({ id, close: vi.fn() }));
    const cache = new LayerBitmapCache<FakeBitmap>(decode);
    const ids = drawableLayerIds(NESTED);

    const result = await cache.ensure(ids);
    expect(result.failed).toEqual([]);
    expect(decode).toHaveBeenCalledTimes(ids.length);
    expect(cache.decodeCount).toBe(ids.length);

    // A second pass is free.
    await cache.ensure(ids);
    expect(decode).toHaveBeenCalledTimes(ids.length);
  });

  it('redraws 30 visibility changes without a single extra decode', async () => {
    const decode = vi.fn(async (id: string): Promise<FakeBitmap> => ({ id, close: vi.fn() }));
    const cache = new LayerBitmapCache<FakeBitmap>(decode);
    const plan = computeProxyPlan(1000, 1000);
    await cache.ensure(drawableLayerIds(NESTED));
    const decodesAfterLoad = decode.mock.calls.length;

    for (let index = 0; index < 30; index += 1) {
      const overrides =
        index % 2 === 0
          ? { [IDS.hiddenHighlight]: true, [IDS.group]: false }
          : { [IDS.hiddenHighlight]: false, [IDS.group]: true };
      const planned = planComposite(NESTED, overrides, plan);
      expect(planned.length).toBeGreaterThan(0);
      // The compositor only ever reads cached bitmaps for the planned layers.
      for (const layer of planned) expect(cache.peek(layer.id)).toBeDefined();
    }

    expect(decode.mock.calls.length).toBe(decodesAfterLoad);
    expect(cache.decodeCount).toBe(decodesAfterLoad);
  });

  it('de-duplicates concurrent requests for the same layer', async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const decode = vi.fn(async (id: string): Promise<FakeBitmap> => {
      await gate;
      return { id, close: vi.fn() };
    });
    const cache = new LayerBitmapCache<FakeBitmap>(decode);
    const first = cache.get(IDS.lineart);
    const second = cache.get(IDS.lineart);
    releaseGate();
    await Promise.all([first, second]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(cache.decodeCount).toBe(1);
  });

  it('restoring from IndexedDB does not count as a decode', async () => {
    const decode = vi.fn(async (id: string): Promise<FakeBitmap> => ({ id, close: vi.fn() }));
    const cache = new LayerBitmapCache<FakeBitmap>(decode);
    cache.set('0', { id: '0', close: vi.fn() });
    cache.set('1', { id: '1', close: vi.fn() });
    expect(cache.decodeCount).toBe(0);
    expect(cache.has('0')).toBe(true);
    await cache.get('0');
    expect(decode).not.toHaveBeenCalled();
    expect(cache.decodeCount).toBe(0);
  });

  it('records failures without poisoning the cache, and can retry', async () => {
    let attempts = 0;
    const decode = vi.fn(async (id: string): Promise<FakeBitmap> => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return { id, close: vi.fn() };
    });
    const cache = new LayerBitmapCache<FakeBitmap>(decode);
    const result = await cache.ensure(['9']);
    expect(result.failed).toEqual(['9']);
    expect(cache.stats.failures).toBe(1);
    expect(cache.has('9')).toBe(false);
    await cache.get('9');
    expect(cache.has('9')).toBe(true);
    expect(cache.decodeCount).toBe(1);
  });
});

describe('layer-info (ag-psd Layer -> manifest LayerNode)', () => {
  const fakeLayer = (extra: Partial<Layer>): Layer => ({ name: 'x', ...extra }) as Layer;
  const rawData = {} as Layer['rawData'];

  it('classifies pixel / text / adjustment / smart object / vector / group layers', () => {
    expect(layerKindOf(fakeLayer({ rawData }))).toBe('pixel');
    expect(layerKindOf(fakeLayer({ text: {} as Layer['text'] }))).toBe('text');
    expect(layerKindOf(fakeLayer({ adjustment: {} as Layer['adjustment'] }))).toBe('adjustment');
    expect(layerKindOf(fakeLayer({ placedLayer: {} as Layer['placedLayer'] }))).toBe('smartObject');
    expect(layerKindOf(fakeLayer({ vectorFill: {} as Layer['vectorFill'] }))).toBe('vector');
    expect(layerKindOf(fakeLayer({ sectionDivider: { type: 1 } as Layer['sectionDivider'] }))).toBe('group');
  });

  it('groups never count as drawable pixels', () => {
    expect(layerHasImage(fakeLayer({ rawData, children: [fakeLayer({})] }))).toBe(false);
    expect(layerHasImage(fakeLayer({ rawData }))).toBe(true);
  });

  it('builds a tree that keeps Photoshop order and notes non-pixel layers', () => {
    const tree = buildLayerTree(
      [
        fakeLayer({ name: 'top', top: 0, left: 0, right: 100, bottom: 50, rawData }),
        fakeLayer({ name: '标题', text: {} as Layer['text'] }),
      ],
      100,
      50,
    );
    expect(tree.map((node) => node.name)).toEqual(['top', '标题']);
    expect(tree[0]).toMatchObject({ hasImage: true, isGroup: false, kind: 'pixel' });
    expect(tree[1]).toMatchObject({ hasImage: false, kind: 'text' });
    expect(tree[1].note).toContain('文字');
  });

  it('collects stable caveats', () => {
    const tree = buildLayerTree([fakeLayer({ name: 'a', text: {} as Layer['text'] })], 10, 10);
    const caveats = collectCaveats(tree, { useProxy: true });
    expect(caveats).toHaveLength(2);
    expect(caveats[0]).toContain('文字');
    expect(caveats[1]).toContain('代理分辨率');
  });
});
