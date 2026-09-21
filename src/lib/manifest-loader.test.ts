/**
 * Tests for manifest loading + defensive validation.
 *
 * The manifest is build output: the client must survive a stale, partial or
 * hand-edited file, and must show a friendly Chinese empty state instead of an
 * error when there are simply no works yet.
 */

import { describe, expect, it } from 'vitest';
import { MANIFEST_VERSION } from '../../shared/manifest';
import { FIXTURE_MANIFEST, FIXTURE_MANIFEST_JSON } from '../__fixtures__/manifest';
import {
  MANIFEST_EMPTY_MESSAGE,
  MANIFEST_MISSING_MESSAGE,
  loadManifest,
  manifestUrl,
  parseManifest,
} from './manifest-loader';

/** Loose view of the fixture so a test can corrupt one field at a time. */
function rawFixture(): Record<string, unknown> {
  return JSON.parse(FIXTURE_MANIFEST_JSON) as Record<string, unknown>;
}

function firstWork(raw: Record<string, unknown>, groupIndex = 0): Record<string, unknown> {
  const groups = raw.groups as Record<string, unknown>[];
  const works = groups[groupIndex].works as Record<string, unknown>[];
  return works[0];
}

describe('parseManifest', () => {
  it('accepts the hand-written fixture and its JSON round-trip', () => {
    const direct = parseManifest(FIXTURE_MANIFEST);
    const viaJson = parseManifest(rawFixture());
    expect(direct.error).toBeNull();
    expect(direct.warnings).toEqual([]);
    expect(viaJson.error).toBeNull();
    expect(viaJson.manifest?.totals).toEqual(direct.manifest?.totals);
    expect(direct.manifest?.version).toBe(MANIFEST_VERSION);
  });

  it('sorts dates newest first and works by numeric index', () => {
    const result = parseManifest(FIXTURE_MANIFEST);
    expect(result.manifest?.groups.map((group) => group.date)).toEqual(['2026-09-24', '2026-09-21']);
    expect(result.manifest?.groups[1].works.map((work) => work.index)).toEqual([1, 2]);
  });

  it('recomputes totals from the validated entries', () => {
    const result = parseManifest(FIXTURE_MANIFEST);
    expect(result.manifest?.totals.works).toBe(4);
    expect(result.manifest?.totals.bytes).toBe(
      3_636_070 + 4_083_806 + 3_798_010 + 12_345_678,
    );
  });

  it('rejects a version mismatch with an actionable message', () => {
    const raw = rawFixture();
    raw.version = MANIFEST_VERSION + 1;
    const result = parseManifest(raw);
    expect(result.manifest).toBeNull();
    expect(result.error).toContain('版本不匹配');
  });

  it('rejects non-objects and a missing groups array', () => {
    expect(parseManifest(null).error).toContain('顶层');
    expect(parseManifest([]).error).toContain('顶层');
    expect(parseManifest({ version: MANIFEST_VERSION }).error).toContain('groups');
  });

  it('drops invalid works/layers and keeps the rest usable', () => {
    const raw = rawFixture();
    const groups = raw.groups as Record<string, unknown>[];
    const works = groups[0].works as unknown[];
    works.push({ name: 'broken', bytes: 1 }); // no psd / width / height
    const validWork = groups[0].works as Record<string, unknown>[];
    const layers = validWork[0].layers as unknown[];
    layers.push({ name: 'no-rect' }); // dropped layer
    layers.push({ rect: { left: 0, top: 0, right: 1, bottom: 1 } }); // dropped: no name

    const result = parseManifest(raw);
    expect(result.error).toBeNull();
    expect(result.manifest?.totals.works).toBe(4); // the broken work is gone
    // The 6 valid layers survive; the two malformed ones are dropped.
    expect(result.manifest?.groups[1].works[0].layers).toHaveLength(6);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('clamps values and fills in missing optional fields', () => {
    const raw = rawFixture();
    const work = firstWork(raw);
    work.opacity = undefined;
    const layers = work.layers as Record<string, unknown>[];
    layers[0].opacity = 3; // clamped to 1
    layers[1].blendMode = 42; // falls back to normal
    layers[2].hidden = 'yes'; // falls back to the PSD default
    delete work.layerCount;

    const parsed = parseManifest(raw);
    const first = parsed.manifest?.groups[1].works[0];
    expect(first?.layers[0].opacity).toBe(1);
    expect(first?.layers[1].blendMode).toBe('normal');
    expect(first?.layers[2].hidden).toBe(false);
    // layerCount is recomputed from the tree (top level + nested children).
    expect(first?.layerCount).toBeGreaterThan(0);
    expect(first?.layerCount).toBe(parsed.manifest?.groups[1].works[0].layers.length);
  });

  it('falls back to a usable preview when the manifest has none', () => {
    const raw = rawFixture();
    const work = firstWork(raw);
    delete work.preview;
    const parsed = parseManifest(raw);
    const preview = parsed.manifest?.groups[1].works[0].preview;
    expect(preview?.thumb).toBe('');
    expect(preview?.thumbWidth).toBe(1200);
    expect(preview?.displayWidth).toBe(1200);
  });

  it('keeps an empty manifest parseable (no works, no error)', () => {
    const result = parseManifest({ version: MANIFEST_VERSION, groups: [] });
    expect(result.error).toBeNull();
    expect(result.manifest?.totals.works).toBe(0);
  });
});

describe('manifestUrl', () => {
  it('honors the Vite base', () => {
    expect(manifestUrl('/')).toBe('/generated/manifest.json');
    expect(manifestUrl('/psd-gallery/')).toBe('/psd-gallery/generated/manifest.json');
    expect(manifestUrl('psd-gallery')).toBe('/psd-gallery/generated/manifest.json');
  });
});

describe('loadManifest', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('loads the fixture over a fetch stub', async () => {
    const result = await loadManifest({ fetchImpl: async () => jsonResponse(FIXTURE_MANIFEST_JSON) });
    expect(result.status).toBe('ready');
    expect(result.aborted).toBe(false);
    expect(result.manifest?.totals.works).toBe(4);
  });

  it('reports the friendly empty state when there are no works', async () => {
    const result = await loadManifest({
      fetchImpl: async () => jsonResponse({ version: MANIFEST_VERSION, groups: [] }),
    });
    expect(result.status).toBe('empty');
    expect(result.error).toBeNull();
    expect(MANIFEST_EMPTY_MESSAGE).toContain('还没有作品');
  });

  it('maps a 404 to the "not generated yet" message', async () => {
    const result = await loadManifest({ fetchImpl: async () => jsonResponse('nope', 404) });
    expect(result.status).toBe('error');
    expect(result.error).toBe(MANIFEST_MISSING_MESSAGE);
  });

  it('reports broken JSON without throwing', async () => {
    const result = await loadManifest({ fetchImpl: async () => jsonResponse('{oops') });
    expect(result.status).toBe('error');
    expect(result.error).toContain('JSON');
  });

  it('reports network failures without throwing', async () => {
    const result = await loadManifest({
      fetchImpl: async () => {
        throw new TypeError('network down');
      },
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('network down');
  });

  it('flags an aborted request', async () => {
    const controller = new AbortController();
    const result = await loadManifest({
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });
    expect(result.status).toBe('error');
    expect(result.aborted).toBe(true);
  });
});
