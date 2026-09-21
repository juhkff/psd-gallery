/**
 * Timeline maths for the gallery rail.
 *
 * Pure and DOM-free, in the same spirit as lib/gallery-page.ts: a daily-practice
 * library is a sparse, newest-first pile of date folders, and the rail's job is
 * to make an honest *calendar* out of it. The interesting bugs (streaks across a
 * gap, months that do not exist, duplicate folders, a "today" that moves) live in
 * this arithmetic, so it is unit-tested without a browser.
 *
 * `today` is always INJECTED by the caller - this module never calls `Date.now()`
 * - so streaks and labels are deterministic under test and in the hero.
 *
 * Everything is UTC-midnight arithmetic on "YYYY-MM-DD" strings: no timezone in
 * the data, no timezone in the maths.
 */

import { formatDateLabel } from '../../shared/paths';

/** The only thing the timeline needs to know about a work is how big it is. */
export interface TimelineWork {
  bytes?: number;
}

/** Minimal source shape; structurally a manifest `DateGroup`. */
export interface TimelineSourceGroup<TWork extends TimelineWork = TimelineWork> {
  date: string;
  works: readonly TWork[];
}

export interface TimelineEntry<TWork extends TimelineWork = TimelineWork> {
  /** "YYYY-MM-DD". */
  date: string;
  /** "2026". */
  year: string;
  /** 2026. */
  yearNumber: number;
  /** 1..12. */
  month: number;
  /** "2026-09" - the month bucket key. */
  monthKey: string;
  /** "2026年9月". */
  monthLabel: string;
  workCount: number;
  /** Total bytes of the day's works; 0 when the caller reports no sizes. */
  bytes: number;
  /** The caller's own work objects, in their original order. */
  works: readonly TWork[];
}

/** One month of the rail; months with no practice simply do not exist. */
export interface MonthBucket<TWork extends TimelineWork = TimelineWork> {
  /** "2026-09". */
  key: string;
  year: string;
  yearNumber: number;
  /** 1..12. */
  month: number;
  /** "2026年9月". */
  label: string;
  /** "9月" - the chip text. */
  shortLabel: string;
  /** Newest first, like buildTimelineEntries(). */
  entries: TimelineEntry<TWork>[];
  /** Oldest date in the bucket ("the month's first date" for the scrubber). */
  firstDate: string;
  /** Newest date in the bucket. */
  lastDate: string;
  workCount: number;
  /** Distinct calendar days in this month with at least one work. */
  coverageDays: number;
  /** firstDate -> lastDate inclusive: how wide the month's practice stretches. */
  spanDays: number;
}

export interface StreakStats {
  /** Consecutive active days ending exactly on `today` (0 when today is empty). */
  currentStreak: number;
  /** Longest run of consecutive active days anywhere in the history. */
  longestStreak: number;
  /** Distinct days with at least one work. */
  activeDays: number;
  /**
   * first practice day -> last practice day, inclusive (the global span).
   * NOTE: a MonthBucket names its own distinct-day count `coverageDays` and its
   * stretch `spanDays`; here the two collapse into one measure.
   */
  coverageDays: number;
  firstDate: string | null;
  lastDate: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

export interface IsoDateParts {
  yearNumber: number;
  month: number;
  /** 1..31 */
  day: number;
  /** Days since the Unix epoch (UTC), for cheap calendar maths. */
  ordinal: number;
}

/**
 * Parse "YYYY-MM-DD" into its parts and a day ordinal, or null when the string
 * is not a real calendar date (guards "2026-02-30", "2026-13-01", "26-1-1").
 */
export function parseIsoDate(date: string): IsoDateParts | null {
  if (typeof date !== 'string') return null;
  const match = ISO_DATE.exec(date);
  if (!match) return null;
  const yearNumber = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(yearNumber, month - 1, day));
  // Round-trip check: Date.UTC rolls "2026-02-30" over to March.
  if (
    utc.getUTCFullYear() !== yearNumber ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return { yearNumber, month, day, ordinal: Math.round(utc.getTime() / 86_400_000) };
}

/** "2026-09" from a year and 1-based month. */
export function monthKeyOf(yearNumber: number, month: number): string {
  return `${yearNumber}-${String(month).padStart(2, '0')}`;
}

/** "2026年9月" from a year and 1-based month. */
export function monthLabelOf(yearNumber: number, month: number): string {
  return `${yearNumber}年${month}月`;
}

/**
 * "2026年9月" for a "YYYY-MM" or "YYYY-MM-DD" string; the input is returned
 * unchanged when it is not a valid month, so callers can render it blindly.
 */
export function monthLabel(month: string): string {
  if (typeof month !== 'string') return String(month);
  const full = ISO_MONTH.exec(month);
  if (full) {
    const yearNumber = Number(full[1]);
    const monthNumber = Number(full[2]);
    if (monthNumber < 1 || monthNumber > 12) return month;
    return monthLabelOf(yearNumber, monthNumber);
  }
  const parts = parseIsoDate(month);
  return parts ? monthLabelOf(parts.yearNumber, parts.month) : month;
}

/** The local calendar day as "YYYY-MM-DD" (the caller decides when "today" is). */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * "今天" / "昨天" / "3 天前" for recent days, falling back to the full
 * "2026年9月21日" label for anything older than a month (or for invalid input).
 */
export function relativeDayLabel(date: string, today: string): string {
  const target = parseIsoDate(date);
  const reference = parseIsoDate(today);
  if (!target || !reference) return date;
  const diff = reference.ordinal - target.ordinal;
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 1 && diff < 30) return `${diff} 天前`;
  return formatDateLabel(date);
}

/** Distinct, valid dates from anything entry-shaped, ascending. */
function distinctValidDates(entries: readonly { date: string }[] | null | undefined): IsoDateParts[] {
  const seen = new Set<string>();
  const out: IsoDateParts[] = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.date !== 'string') continue;
    if (seen.has(entry.date)) continue;
    const parts = parseIsoDate(entry.date);
    if (!parts) continue;
    seen.add(entry.date);
    out.push(parts);
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Newest-first timeline entries for the date groups the caller actually renders.
 *
 * - Invalid dates are dropped; duplicate folders for one day are merged so no
 *   work is lost.
 * - `bytes` is the sum of the works' reported sizes (0 when unknown).
 * - The input array is never mutated.
 */
export function buildTimelineEntries<TWork extends TimelineWork>(
  groups: readonly TimelineSourceGroup<TWork>[] | null | undefined,
): TimelineEntry<TWork>[] {
  const byDate = new Map<string, { date: string; works: TWork[] }>();
  for (const group of groups ?? []) {
    if (!group || typeof group.date !== 'string') continue;
    if (!parseIsoDate(group.date)) continue;
    const works: readonly TWork[] = Array.isArray(group.works) ? group.works : [];
    const existing = byDate.get(group.date);
    if (existing) existing.works.push(...works);
    else byDate.set(group.date, { date: group.date, works: [...works] });
  }

  const entries: TimelineEntry<TWork>[] = [];
  for (const { date, works } of byDate.values()) {
    const parts = parseIsoDate(date);
    // Guarded above; the `continue` keeps the compiler honest without a cast.
    if (!parts) continue;
    let bytes = 0;
    for (const work of works) {
      const value = work && typeof work.bytes === 'number' ? work.bytes : 0;
      if (Number.isFinite(value) && value > 0) bytes += value;
    }
    entries.push({
      date,
      year: String(parts.yearNumber),
      yearNumber: parts.yearNumber,
      month: parts.month,
      monthKey: monthKeyOf(parts.yearNumber, parts.month),
      monthLabel: monthLabelOf(parts.yearNumber, parts.month),
      workCount: works.length,
      bytes,
      works,
    });
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Ordered month buckets for the sticky year/month scrubber, OLDEST -> NEWEST
 * (calendar reading order, so the chips run 9月 10月 11月 left to right).
 *
 * A month with no practice is absent rather than fabricated, so a sparse history
 * reads as a calendar only through `coverageDays` / `spanDays`:
 *   coverageDays = distinct days with a work in that month
 *   spanDays     = firstDate -> lastDate inclusive inside that month
 * Density (`coverageDays / spanDays`) is the honest answer to "was this month
 * busy or was it two Sundays?".
 */
export function groupEntriesByMonth<TWork extends TimelineWork>(
  entries: readonly TimelineEntry<TWork>[] | null | undefined,
): MonthBucket<TWork>[] {
  const buckets = new Map<string, MonthBucket<TWork>>();
  const seenDates = new Map<string, Set<string>>();

  for (const entry of entries ?? []) {
    if (!entry || typeof entry.date !== 'string') continue;
    const parts = parseIsoDate(entry.date);
    if (!parts) continue;
    const key = monthKeyOf(parts.yearNumber, parts.month);
    let bucket = buckets.get(key);
    let dates = seenDates.get(key);
    if (!bucket || !dates) {
      bucket = {
        key,
        year: String(parts.yearNumber),
        yearNumber: parts.yearNumber,
        month: parts.month,
        label: monthLabelOf(parts.yearNumber, parts.month),
        shortLabel: `${parts.month}月`,
        entries: [],
        firstDate: entry.date,
        lastDate: entry.date,
        workCount: 0,
        coverageDays: 0,
        spanDays: 0,
      };
      dates = new Set<string>();
      buckets.set(key, bucket);
      seenDates.set(key, dates);
    }
    if (dates.has(entry.date)) continue;
    dates.add(entry.date);
    bucket.entries.push(entry);
    bucket.workCount += entry.workCount;
    bucket.coverageDays += 1;
  }

  const out = [...buckets.values()];
  for (const bucket of out) {
    bucket.entries.sort((a, b) => b.date.localeCompare(a.date));
    const oldest = bucket.entries[bucket.entries.length - 1];
    const newest = bucket.entries[0];
    const first = parseIsoDate(oldest.date);
    const last = parseIsoDate(newest.date);
    bucket.firstDate = oldest.date;
    bucket.lastDate = newest.date;
    bucket.spanDays = first && last ? last.ordinal - first.ordinal + 1 : 0;
  }
  // Key sort == chronological sort for zero-padded "YYYY-MM".
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Streak maths over the distinct active days in `entries`.
 *
 * `currentStreak` counts consecutive active days ENDING ON `today`; an empty
 * today is 0 (pass yesterday as `today` if you want a grace period). Invalid
 * dates and duplicates are ignored, so a day with three works is one active day.
 */
export function computeStreakStats(
  entries: readonly { date: string }[] | null | undefined,
  today: string,
): StreakStats {
  const dates = distinctValidDates(entries);
  const empty: StreakStats = {
    currentStreak: 0,
    longestStreak: 0,
    activeDays: 0,
    coverageDays: 0,
    firstDate: null,
    lastDate: null,
  };
  if (dates.length === 0) return empty;

  const first = dates[0];
  const last = dates[dates.length - 1];

  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i += 1) {
    run = dates[i].ordinal === dates[i - 1].ordinal + 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
  }

  const reference = parseIsoDate(today);
  let currentStreak = 0;
  if (reference) {
    const active = new Set(dates.map((parts) => parts.ordinal));
    while (active.has(reference.ordinal - currentStreak)) currentStreak += 1;
  }

  return {
    currentStreak,
    longestStreak,
    activeDays: dates.length,
    coverageDays: last.ordinal - first.ordinal + 1,
    firstDate: isoFromOrdinal(first.ordinal),
    lastDate: isoFromOrdinal(last.ordinal),
  };
}

/** Ordinal -> "YYYY-MM-DD" (used for the stats' human-readable bounds). */
function isoFromOrdinal(ordinal: number): string {
  return new Date(ordinal * 86_400_000).toISOString().slice(0, 10);
}
