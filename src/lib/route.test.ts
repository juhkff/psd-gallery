/**
 * Hash routing tests: works must be linkable (`#/2026-09-21/1`) and the browser
 * back button has to keep working, so the parse/format pair is load-bearing.
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_MANIFEST } from '../__fixtures__/manifest';
import { findWork, forceProxyFromHash, isNonEmptyRoute, parseRoute, workHash } from './route';

describe('workHash / parseRoute', () => {
  it('round-trips a work link', () => {
    const hash = workHash('2026-09-21', '1');
    expect(hash).toBe('#/2026-09-21/1');
    expect(parseRoute(hash)).toEqual({ date: '2026-09-21', name: '1' });
  });

  it('treats empty, partial and malformed hashes as "gallery"', () => {
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#')).toBeNull();
    expect(parseRoute('#/')).toBeNull();
    expect(parseRoute('#/2026-09-21')).toBeNull();
    expect(parseRoute('#/2026-9-21/1')).toBeNull();
    expect(parseRoute('#/not-a-date/1')).toBeNull();
    expect(parseRoute('#/2026-09-21/')).toBeNull();
  });

  it('ignores query flags and decodes the file name', () => {
    expect(parseRoute('#/2026-09-21/1?proxy=1')).toEqual({ date: '2026-09-21', name: '1' });
    expect(parseRoute('#/2026-09-21/%E4%B8%AD%E6%96%87')).toEqual({ date: '2026-09-21', name: '中文' });
  });

  it('isNonEmptyRoute mirrors parseRoute', () => {
    expect(isNonEmptyRoute('#/2026-09-21/1')).toBe(true);
    expect(isNonEmptyRoute('')).toBe(false);
  });
});

describe('forceProxyFromHash', () => {
  it('accepts the documented spellings only', () => {
    expect(forceProxyFromHash('#/2026-09-21/1?proxy=1')).toBe(true);
    expect(forceProxyFromHash('#/x?proxy=true')).toBe(true);
    expect(forceProxyFromHash('#/x?proxy=0')).toBe(false);
    expect(forceProxyFromHash('#/x')).toBe(false);
    expect(forceProxyFromHash('')).toBe(false);
  });
});

describe('findWork', () => {
  it('resolves a selection against the manifest', () => {
    const found = findWork(FIXTURE_MANIFEST, { date: '2026-09-21', name: '2' });
    expect(found?.work.psd).toBe('/works/2026-09-21/2.psd');
    expect(found?.group.date).toBe('2026-09-21');
  });

  it('returns null for unknown dates, names or missing input', () => {
    expect(findWork(FIXTURE_MANIFEST, { date: '2020-01-01', name: '1' })).toBeNull();
    expect(findWork(FIXTURE_MANIFEST, { date: '2026-09-21', name: '99' })).toBeNull();
    expect(findWork(FIXTURE_MANIFEST, null)).toBeNull();
    expect(findWork(null, { date: '2026-09-21', name: '1' })).toBeNull();
  });
});
