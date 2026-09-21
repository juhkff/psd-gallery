/**
 * Tests for the deploy-time index (`generated/index-dates.json`).
 *
 * The important behaviours:
 *  - a missing / broken index is a silent no-op (never an error state),
 *  - files the manifest already knows about are NOT listed twice,
 *  - `IndexEntry.name` keeps its extension (unlike `WorkEntry.name`),
 *  - download URLs are built against Vite's `base`.
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_MANIFEST } from '../__fixtures__/manifest';
import {
  builtFileKeys,
  fileNameOf,
  indexUrl,
  listUnbuiltFiles,
  loadServerIndex,
  parseIndexResponse,
} from './index-loader';

const INDEX = {
  dates: {
    '2026-09-21': [
      { name: '1.psd', bytes: 3_636_070, category: 'psd' }, // built
      { name: '3.psd', bytes: 2_000_000, category: 'psd' }, // not built
      { name: 'sketch.ai', bytes: 1_500_000, category: 'ai' }, // not built
    ],
    '2026-09-24': [
      { name: '2.psd', bytes: 12_345_678, category: 'psd' }, // built (fixture work)
      { name: 'photo.jpg', bytes: 400_000, category: 'image' }, // not built
    ],
    '2026-09-25': [{ name: '1.psd', bytes: 900_000, category: 'psd' }], // brand new date
    'not-a-date': [{ name: 'x.psd', bytes: 1, category: 'psd' }],
  },
  generatedAt: '2026-09-25T00:00:00.000Z',
};

describe('parseIndexResponse', () => {
  it('accepts the documented shape and drops junk', () => {
    const parsed = parseIndexResponse({
      dates: {
        '2026-09-21': [
          { name: '1.psd', bytes: 10, category: 'psd' },
          { name: '', bytes: 10, category: 'psd' }, // no name -> dropped
          'nonsense',
          { name: 'a.b', bytes: '20', category: 'weird' }, // bytes coerced, category -> other
        ],
        'oops': [{ name: 'x.psd', bytes: 1, category: 'psd' }], // bad date -> dropped
      },
      generatedAt: 42,
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed?.dates ?? {})).toEqual(['2026-09-21']);
    expect(parsed?.dates['2026-09-21']).toEqual([
      { name: '1.psd', bytes: 10, category: 'psd' },
      { name: 'a.b', bytes: 20, category: 'other' },
    ]);
    expect(parsed?.generatedAt).toBe('');
  });

  it('returns null for unusable input', () => {
    expect(parseIndexResponse(null)).toBeNull();
    expect(parseIndexResponse('nope')).toBeNull();
    expect(parseIndexResponse({})).toBeNull();
    expect(parseIndexResponse({ dates: [] })).toBeNull();
  });
});

describe('listUnbuiltFiles', () => {
  it('lists only files the manifest does not already have', () => {
    const parsed = parseIndexResponse(INDEX);
    const groups = listUnbuiltFiles(parsed, FIXTURE_MANIFEST, '/');
    expect(groups.map((group) => group.date)).toEqual(['2026-09-25', '2026-09-24', '2026-09-21']);
    expect(groups.find((group) => group.date === '2026-09-21')?.files.map((file) => file.name)).toEqual([
      '3.psd',
      'sketch.ai',
    ]);
    expect(groups.find((group) => group.date === '2026-09-24')?.files.map((file) => file.name)).toEqual([
      'photo.jpg',
    ]);
  });

  it('keeps extensions, derives stems and builds base-aware download URLs', () => {
    const parsed = parseIndexResponse(INDEX);
    const groups = listUnbuiltFiles(parsed, FIXTURE_MANIFEST, '/psd-gallery/');
    const file = groups.find((group) => group.date === '2026-09-21')?.files.find((entry) => entry.name === 'sketch.ai');
    expect(file).toMatchObject({
      stem: 'sketch',
      extension: 'ai',
      category: 'ai',
      bytes: 1_500_000,
      url: '/psd-gallery/works/2026-09-21/sketch.ai',
    });
  });

  it('is a no-op without an index or without a manifest', () => {
    expect(listUnbuiltFiles(null, FIXTURE_MANIFEST)).toEqual([]);
    expect(listUnbuiltFiles(parseIndexResponse(INDEX), null).map((group) => group.date)).toEqual([
      '2026-09-25',
      '2026-09-24',
      '2026-09-21',
    ]);
  });

  it('keys built works by the psd URL file name, not the stem', () => {
    const keys = builtFileKeys(FIXTURE_MANIFEST);
    expect(keys.has('2026-09-21/1.psd')).toBe(true);
    expect(keys.has('2026-09-24/2.psd')).toBe(true);
    expect(keys.has('2026-09-21/1')).toBe(false);
  });
});

describe('loadServerIndex (best effort)', () => {
  it('targets <base>generated/index-dates.json', () => {
    expect(indexUrl('/')).toBe('/generated/index-dates.json');
    expect(indexUrl('/psd-gallery/')).toBe('/psd-gallery/generated/index-dates.json');
  });

  it('parses a 200 response', async () => {
    const result = await loadServerIndex({
      fetchImpl: async () => new Response(JSON.stringify(INDEX), { status: 200 }),
    });
    expect(result?.dates['2026-09-25']).toHaveLength(1);
  });

  it('is silent on 404', async () => {
    const result = await loadServerIndex({
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(result).toBeNull();
  });

  it('is silent on network errors and broken JSON', async () => {
    expect(
      await loadServerIndex({
        fetchImpl: async () => {
          throw new TypeError('network down');
        },
      }),
    ).toBeNull();
    expect(
      await loadServerIndex({ fetchImpl: async () => new Response('{oops', { status: 200 }) }),
    ).toBeNull();
  });
});

describe('fileNameOf', () => {
  it('handles absolute, relative, encoded and query URLs', () => {
    expect(fileNameOf('/works/2026-09-21/1.psd')).toBe('1.psd');
    expect(fileNameOf('works/2026-09-21/1.psd?v=2')).toBe('1.psd');
    expect(fileNameOf('/works/2026-09-21/%E4%B8%AD%E6%96%87.psd')).toBe('中文.psd');
  });
});
