/**
 * Hand-written fixture manifest.
 *
 * The real manifest is generated at build time by `scripts/build-manifest.ts`
 * into `public/generated/manifest.json`; this fixture exists so the client can
 * be developed and unit-tested before that output lands, and so tests do not
 * depend on generated binary previews.
 *
 * The first three works mirror the real sample PSDs in `works/` (same sizes and
 * layer names, verified with `node .verify-samples.mjs`). The last work is
 * synthetic and oversized (4000×3000 = 12 MP) purely to exercise the proxy
 * resolution path in unit tests; it has no real preview files.
 */

import { MANIFEST_VERSION, type LayerNode, type Manifest } from '../../shared/manifest';

/** Minimal helper so the tree below stays readable. */
function layer(
  name: string,
  rect: [number, number, number, number],
  blendMode = 'normal',
  extra: Partial<LayerNode> = {},
): LayerNode {
  const [left, top, right, bottom] = rect;
  return {
    name,
    hidden: false,
    opacity: 1,
    blendMode,
    rect: { left, top, right, bottom },
    hasImage: true,
    isGroup: false,
    ...extra,
  };
}

/** The six-layer stack used by every real sample PSD. */
function sampleStack(width: number, height: number, bits = 0): LayerNode[] {
  // `layers` are given top-most first (manifest order). Every sample layer
  // covers the whole document, like the real sample PSDs.
  const full: [number, number, number, number] = [0, 0, width, height];
  return [
    layer('6-颗粒质感', full, 'overlay', { opacity: 0.85 }),
    layer('5-线稿', full),
    layer('4-高光', [0, 0, Math.round(width * 0.8), Math.round(height * 0.8)], 'screen', {
      hidden: true,
      opacity: 0.7,
    }),
    layer('3-暗部阴影', full, 'multiply', { opacity: 0.9 }),
    layer('2-色块铺陈', full, bits % 2 === 0 ? 'vividLight' : 'normal'),
    layer('1-底色wash', full, 'normal', { opacity: 0.95 }),
  ];
}

const work1Layers = sampleStack(1200, 800, 0);
const work2Layers = sampleStack(900, 1200, 1);
const work3Layers = sampleStack(1000, 1000, 0);

/** A nested tree with a group, a text layer and a smart object, for UI tests. */
const nestedLayers: LayerNode[] = [
  layer('7-标题文字', [120, 80, 760, 220], 'normal', {
    hasImage: false,
    kind: 'text',
    note: '文字图层：网页端不重绘文字效果',
  }),
  {
    name: '6-特效组',
    hidden: false,
    opacity: 0.8,
    blendMode: 'passThrough',
    rect: { left: 0, top: 0, right: 1000, bottom: 1000 },
    hasImage: false,
    isGroup: true,
    children: [
      layer('6b-亮片光斑', [0, 0, 1000, 1000], 'screen', { opacity: 0.6 }),
      layer('6a-颗粒质感', [0, 0, 1000, 1000], 'overlay'),
    ],
  },
  layer('5-线稿', [0, 0, 1000, 1000]),
  layer('4-高光', [0, 0, 800, 800], 'screen', { hidden: true }),
  layer('3-暗部阴影', [0, 0, 1000, 1000], 'multiply', { opacity: 0.9 }),
  layer('2-色块铺陈', [0, 0, 1000, 1000], 'normal'),
  layer('1-底色wash', [0, 0, 1000, 1000]),
  layer('0-智能对象', [0, 0, 1000, 1000], 'normal', {
    hasImage: false,
    kind: 'smartObject',
    note: '智能对象：网页端不重绘其变换与样式',
  }),
];

export const FIXTURE_MANIFEST: Manifest = {
  version: MANIFEST_VERSION,
  generatedAt: '2026-09-24T12:00:00.000Z',
  base: '/',
  totals: {
    works: 4,
    bytes:
      3_636_070 + 4_083_806 + 3_798_010 + 12_345_678,
  },
  groups: [
    {
      date: '2026-09-21',
      works: [
        {
          index: 1,
          name: '1',
          psd: '/works/2026-09-21/1.psd',
          bytes: 3_636_070,
          width: 1200,
          height: 800,
          layerCount: work1Layers.length,
          layers: work1Layers,
          preview: {
            thumb: '/generated/2026-09-21/1-thumb.webp',
            display: '/generated/2026-09-21/1-display.webp',
            thumbWidth: 480,
            thumbHeight: 320,
            displayWidth: 1200,
            displayHeight: 800,
          },
        },
        {
          index: 2,
          name: '2',
          psd: '/works/2026-09-21/2.psd',
          bytes: 4_083_806,
          width: 900,
          height: 1200,
          layerCount: nestedLayers.length,
          layers: nestedLayers,
          preview: {
            thumb: '/generated/2026-09-21/2-thumb.webp',
            display: '/generated/2026-09-21/2-display.webp',
            thumbWidth: 360,
            thumbHeight: 480,
            displayWidth: 900,
            displayHeight: 1200,
          },
        },
      ],
    },
    {
      date: '2026-09-24',
      works: [
        {
          index: 1,
          name: '1',
          psd: '/works/2026-09-24/1.psd',
          bytes: 3_798_010,
          width: 1000,
          height: 1000,
          layerCount: work3Layers.length,
          layers: work3Layers,
          preview: {
            thumb: '/generated/2026-09-24/1-thumb.webp',
            display: '/generated/2026-09-24/1-display.webp',
            thumbWidth: 480,
            thumbHeight: 480,
            displayWidth: 1000,
            displayHeight: 1000,
          },
        },
        {
          index: 2,
          name: '2',
          psd: '/works/2026-09-24/2.psd',
          bytes: 12_345_678,
          width: 4000,
          height: 3000,
          layerCount: work2Layers.length,
          layers: work2Layers,
          preview: {
            thumb: '/generated/2026-09-24/2-thumb.webp',
            display: '/generated/2026-09-24/2-display.webp',
            thumbWidth: 480,
            thumbHeight: 360,
            displayWidth: 1600,
            displayHeight: 1200,
          },
        },
      ],
    },
  ],
};

/** JSON text of {@link FIXTURE_MANIFEST}, for fetch-stub based tests. */
export const FIXTURE_MANIFEST_JSON = JSON.stringify(FIXTURE_MANIFEST, null, 2);

/** Deep clone helper so a test can corrupt the fixture without leaking state. */
export function cloneFixture(): Manifest {
  return JSON.parse(FIXTURE_MANIFEST_JSON) as Manifest;
}
