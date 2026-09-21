/**
 * Hash routing: `#/2026-09-21/1` selects one work.
 *
 * Plain `<a href="#/...">` links are used in the gallery, so the browser's own
 * history (back/forward buttons) works without a router dependency.
 */

import type { DateGroup, Manifest, WorkEntry } from '../../shared/manifest';
import { ISO_DATE } from '../../shared/paths';

export interface RouteSelection {
  date: string;
  /** Work file stem, e.g. "1". */
  name: string;
}

export interface WorkSelection {
  date: string;
  group: DateGroup;
  work: WorkEntry;
}

/** `#/2026-09-21/1` (leading "#" optional; `base` hash is ignored). */
export function workHash(date: string, name: string): string {
  return `#/${encodeURIComponent(date)}/${encodeURIComponent(name)}`;
}

/** Parse a `location.hash` (or a bare path) into a selection, or null for "gallery". */
export function parseRoute(hash: string): RouteSelection | null {
  if (!hash) return null;
  let path = hash.trim();
  const queryAt = path.indexOf('?');
  if (queryAt >= 0) path = path.slice(0, queryAt);
  path = path.replace(/^#/, '');
  path = path.replace(/^\/+/, '');
  if (!path) return null;
  const parts = path.split('/').filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  let date: string;
  let name: string;
  try {
    date = decodeURIComponent(parts[0]);
    name = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (!ISO_DATE.test(date) || !name) return null;
  return { date, name };
}

/** Resolve a parsed selection against the loaded manifest (null when unknown). */
export function findWork(manifest: Manifest | null, selection: RouteSelection | null): WorkSelection | null {
  if (!manifest || !selection) return null;
  const group = manifest.groups.find((entry) => entry.date === selection.date);
  if (!group) return null;
  const work = group.works.find((entry) => entry.name === selection.name);
  if (!work) return null;
  return { date: group.date, group, work };
}

/** `true` when `hash` addresses something other than the gallery root. */
export function isNonEmptyRoute(hash: string): boolean {
  return parseRoute(hash) !== null;
}

/**
 * Dev/e2e affordance: `#/2026-09-24/1?proxy=1` forces the reduced-resolution
 * proxy path even for a small document, so the proxy branch can be exercised on
 * machines that only have small sample PSDs.
 */
export function forceProxyFromHash(hash: string): boolean {
  return /[?&]proxy=(1|true|yes|force)(&|$)/i.test(hash);
}
