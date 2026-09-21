import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimelineRail } from '../components/TimelineRail';
import { useTimelineSpy } from './useTimelineSpy';
import {
  buildTimelineEntries,
  computeStreakStats,
  groupEntriesByMonth,
  monthLabel,
  parseIsoDate,
  relativeDayLabel,
  todayIso,
  type TimelineEntry,
  type TimelineSourceGroup,
} from './timeline';

interface TestWork {
  name: string;
  bytes?: number;
}

const group = (date: string, works: TestWork[]): TimelineSourceGroup<TestWork> => ({ date, works });

/** One date folder with `count` works of `bytes` each. */
const day = (date: string, count = 1, bytes = 1000): TimelineSourceGroup<TestWork> =>
  group(
    date,
    Array.from({ length: count }, (_, i) => ({ name: String(i + 1), bytes })),
  );

const entriesFrom = (days: string[]): TimelineEntry<TestWork>[] =>
  buildTimelineEntries(days.map((date) => day(date)));

describe('buildTimelineEntries', () => {
  it('orders newest first and derives year/month/label/count/bytes', () => {
    const entries = buildTimelineEntries([
      day('2025-12-31', 2, 500),
      day('2026-09-21', 3, 1024),
      day('2026-09-20', 1, 256),
    ]);

    expect(entries.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-20', '2025-12-31']);

    const [newest] = entries;
    expect(newest.year).toBe('2026');
    expect(newest.yearNumber).toBe(2026);
    expect(newest.month).toBe(9);
    expect(newest.monthKey).toBe('2026-09');
    expect(newest.monthLabel).toBe('2026年9月');
    expect(newest.workCount).toBe(3);
    expect(newest.bytes).toBe(3072);
    expect(newest.works.map((w) => w.name)).toEqual(['1', '2', '3']);

    expect(entries[2].monthKey).toBe('2025-12');
    expect(entries[2].monthLabel).toBe('2025年12月');
  });

  it('drops invalid dates and merges duplicate folders without mutating the input', () => {
    const input: TimelineSourceGroup<TestWork>[] = [
      day('2026-02-30', 5), // not a real date
      day('2026-09-21', 1),
      day('not-a-date', 1),
      day('2026-09-21', 2),
    ];
    const before = input.map((g) => g.date);

    const entries = buildTimelineEntries(input);

    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2026-09-21');
    expect(entries[0].workCount).toBe(3);
    expect(input.map((g) => g.date)).toEqual(before);
  });

  it('reports 0 bytes when the caller does not provide sizes', () => {
    const entries = buildTimelineEntries([group('2026-09-21', [{ name: '1' }])]);
    expect(entries[0].bytes).toBe(0);
    expect(entries[0].workCount).toBe(1);
  });

  it('handles empty, null and undefined input', () => {
    expect(buildTimelineEntries([])).toEqual([]);
    expect(buildTimelineEntries(null)).toEqual([]);
    expect(buildTimelineEntries(undefined)).toEqual([]);
  });
});

describe('groupEntriesByMonth', () => {
  it('buckets chronologically (oldest month first) with the right labels and totals', () => {
    const months = groupEntriesByMonth(
      entriesFrom(['2026-09-21', '2026-09-20', '2026-10-02', '2025-12-31', '2026-10-01']),
    );

    expect(months.map((m) => m.key)).toEqual(['2025-12', '2026-09', '2026-10']);
    expect(months.map((m) => m.shortLabel)).toEqual(['12月', '9月', '10月']);
    expect(months.map((m) => m.year)).toEqual(['2025', '2026', '2026']);

    const september = months[1];
    expect(september.label).toBe('2026年9月');
    expect(september.workCount).toBe(2);
    expect(september.entries.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-20']);
    expect(september.firstDate).toBe('2026-09-20');
    expect(september.lastDate).toBe('2026-09-21');
  });

  it('leaves months with no practice absent instead of fabricating them', () => {
    const months = groupEntriesByMonth(entriesFrom(['2026-09-01', '2026-11-30']));
    expect(months.map((m) => m.key)).toEqual(['2026-09', '2026-11']);
  });

  it('exposes coverage vs span so a sparse month reads honestly', () => {
    // Two practice days stretched across a 14-day span: 2 covered, 14 spanned.
    const months = groupEntriesByMonth(entriesFrom(['2026-09-01', '2026-09-14']));
    expect(months[0].coverageDays).toBe(2);
    expect(months[0].spanDays).toBe(14);
  });

  it('does not double count a duplicated date', () => {
    const entries = entriesFrom(['2026-09-21', '2026-09-21']);
    const months = groupEntriesByMonth(entries);
    expect(months[0].coverageDays).toBe(1);
    expect(months[0].entries).toHaveLength(1);
  });

  it('ignores invalid dates and empty input', () => {
    const entries = buildTimelineEntries<TestWork>([day('2026-02-30', 1)]);
    expect(entries).toEqual([]);
    expect(groupEntriesByMonth(entries)).toEqual([]);
    expect(groupEntriesByMonth([])).toEqual([]);
  });
});

describe('computeStreakStats', () => {
  it('matches the crafted history: gap, run of 3, coverage 5', () => {
    const entries = entriesFrom(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05']);
    const stats = computeStreakStats(entries, '2026-09-05');

    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(3);
    expect(stats.activeDays).toBe(4);
    expect(stats.coverageDays).toBe(5);
    expect(stats.firstDate).toBe('2026-09-01');
    expect(stats.lastDate).toBe('2026-09-05');
  });

  it('keeps the streak alive across a month boundary', () => {
    const entries = entriesFrom(['2026-08-30', '2026-08-31', '2026-09-01']);
    const stats = computeStreakStats(entries, '2026-09-01');
    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
  });

  it('counts a single day', () => {
    const stats = computeStreakStats(entriesFrom(['2026-09-21']), '2026-09-21');
    expect(stats).toMatchObject({
      currentStreak: 1,
      longestStreak: 1,
      activeDays: 1,
      coverageDays: 1,
      firstDate: '2026-09-21',
      lastDate: '2026-09-21',
    });
  });

  it('finds the longest run anywhere, not just the newest', () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08'];
    const stats = computeStreakStats(entriesFrom(days), '2026-09-08');
    expect(stats.longestStreak).toBe(4);
    expect(stats.currentStreak).toBe(1);
  });

  it('treats several works on one day as one active day', () => {
    const entries = buildTimelineEntries([day('2026-09-21', 3), day('2026-09-22', 2)]);
    const stats = computeStreakStats(entries, '2026-09-22');
    expect(stats.activeDays).toBe(2);
    expect(stats.currentStreak).toBe(2);
  });

  it('reports no current streak when today has no work (no implicit grace day)', () => {
    const stats = computeStreakStats(entriesFrom(['2026-09-01', '2026-09-02']), '2026-09-03');
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(2);
  });

  it('is deterministic for an invalid "today" and for unsorted input', () => {
    const entries = entriesFrom(['2026-09-03', '2026-09-01', '2026-09-02']);
    expect(computeStreakStats(entries, 'today').currentStreak).toBe(0);
    expect(computeStreakStats(entries, '2026-09-03').currentStreak).toBe(3);
  });

  it('returns zeroed stats for empty input', () => {
    expect(computeStreakStats([], '2026-09-21')).toEqual({
      currentStreak: 0,
      longestStreak: 0,
      activeDays: 0,
      coverageDays: 0,
      firstDate: null,
      lastDate: null,
    });
    expect(computeStreakStats(null, '2026-09-21').activeDays).toBe(0);
  });
});

describe('monthLabel', () => {
  it('formats month keys and full dates', () => {
    expect(monthLabel('2026-09')).toBe('2026年9月');
    expect(monthLabel('2026-09-21')).toBe('2026年9月');
    expect(monthLabel('2025-12')).toBe('2025年12月');
  });

  it('returns invalid input unchanged', () => {
    expect(monthLabel('2026-13')).toBe('2026-13');
    expect(monthLabel('2026-2')).toBe('2026-2');
    expect(monthLabel('nope')).toBe('nope');
  });
});

describe('relativeDayLabel', () => {
  it('labels today, yesterday and recent days', () => {
    expect(relativeDayLabel('2026-09-21', '2026-09-21')).toBe('今天');
    expect(relativeDayLabel('2026-09-20', '2026-09-21')).toBe('昨天');
    expect(relativeDayLabel('2026-09-18', '2026-09-21')).toBe('3 天前');
    expect(relativeDayLabel('2026-09-30', '2026-10-02')).toBe('2 天前');
  });

  it('falls back to the absolute label for old or future days', () => {
    expect(relativeDayLabel('2026-08-22', '2026-09-21')).toBe('2026年8月22日');
    expect(relativeDayLabel('2026-09-22', '2026-09-21')).toBe('2026年9月22日');
  });

  it('returns invalid input unchanged', () => {
    expect(relativeDayLabel('nope', '2026-09-21')).toBe('nope');
    expect(relativeDayLabel('2026-09-21', 'nope')).toBe('2026-09-21');
  });
});

describe('parseIsoDate', () => {
  it('accepts real dates including a leap day', () => {
    expect(parseIsoDate('2028-02-29')?.day).toBe(29);
    expect(parseIsoDate('2026-09-21')?.ordinal).toBe(Math.round(Date.UTC(2026, 8, 21) / 86_400_000));
  });

  it('rejects malformed and rolled-over dates', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-00-10')).toBeNull();
    expect(parseIsoDate('2026-9-21')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });
});

describe('todayIso', () => {
  it('formats an injected local date as YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 8, 21))).toBe('2026-09-21');
    expect(todayIso(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});

describe('TimelineRail', () => {
  it('renders the nav, the anchors, the active node and the month chips from props', () => {
    const entries = entriesFrom(['2026-09-20', '2026-09-05', '2026-08-30']);
    const months = groupEntriesByMonth(entries);
    const stats = computeStreakStats(entries, '2026-09-20');

    const html = renderToStaticMarkup(
      createElement(TimelineRail, {
        entries,
        months,
        activeDate: '2026-09-05',
        activeMonth: '2026-09',
        stats,
      }),
    );

    // The wiring contract the Lead must satisfy.
    expect(html).toContain('aria-label="练习时间线"');
    expect(html).toContain('data-testid="timeline-rail"');

    // Real anchor links / a real current node.
    expect(html).toContain('href="#date-2026-09-20"');
    expect(html).toContain('href="#date-2026-09-05"');
    expect(html).toContain('href="#date-2026-08-30"');
    expect(html).toContain('aria-current="true"');

    // Month chips, one per existing month, active month pressed.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('8月');
    expect(html).toContain('9月');

    // Density ("3 件" at a glance) and the stats footer.
    expect(html).toContain('件');
    expect(html).toContain(`${stats.currentStreak} 天`);
    expect(html).toContain(`${stats.coverageDays} 天`);
  });

  it('renders an empty state without entries', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineRail, {
        entries: [],
        months: [],
        activeDate: null,
        activeMonth: null,
        stats: computeStreakStats([], '2026-09-21'),
      }),
    );
    expect(html).toContain('还没有可导航的日期');
  });
});

/**
 * There is no DOM test environment in this repo (no jsdom/happy-dom), so the
 * IntersectionObserver branch of useTimelineSpy cannot be executed here. This
 * SSR render at least proves the hook is import-safe and returns its documented
 * `null` initial state with no `window`/`document`/IntersectionObserver present.
 */
function SpyProbe({ dates }: { dates: string[] }) {
  const active = useTimelineSpy(dates);
  return createElement('span', { 'data-active': active ?? 'none' });
}

describe('useTimelineSpy', () => {
  it('renders safely outside a browser and starts with no active date', () => {
    const html = renderToStaticMarkup(createElement(SpyProbe, { dates: ['2026-09-21'] }));
    expect(html).toContain('data-active="none"');
  });
});
