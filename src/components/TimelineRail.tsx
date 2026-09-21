/**
 * TimelineRail: the left-hand practice timeline for the gallery.
 *
 * Three stacked surfaces:
 *  1. a sticky glass month scrubber - one chip per month that actually exists,
 *     oldest -> newest, newest year first, active month highlighted;
 *  2. a vertical gradient rail with one node per rendered date, a month
 *     separator, the day label, the work count and a density bar;
 *  3. a compact streak/coverage footer fed by `computeStreakStats`.
 *
 * SCALING: the rail renders exactly the `entries` it is handed. Gallery
 * paginates at GROUPS_PER_PAGE (see lib/gallery-page.ts) and passes only the
 * date groups currently in the DOM, so the node count is bounded by the page
 * size rather than by the size of the library - dates that are paginated away
 * are not clickable because they are not on the page to anchor to. If a caller
 * ever passes the whole history, the rail grows linearly with it; that is the
 * signal to keep feeding it the rendered page.
 *
 * ACCESSIBILITY: a real `<nav aria-label="练习时间线">` of `<a href="#date-...">`
 * anchors, so navigation works without JS; the node in view carries
 * aria-current="true"; month chips are buttons with aria-pressed.
 *
 * RESPONSIVE: below `lg` the node list collapses and only the sticky month
 * chips + footer remain. Every scroll animation respects prefers-reduced-motion.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { MonthBucket, StreakStats, TimelineEntry } from '../lib/timeline';
import { relativeDayLabel, todayIso } from '../lib/timeline';

export interface TimelineRailProps {
  /** Date groups currently rendered by the gallery, newest first. */
  entries: TimelineEntry[];
  /** Month buckets from groupEntriesByMonth(entries), oldest first. */
  months: MonthBucket[];
  /** Date section currently in view (from useTimelineSpy). */
  activeDate: string | null;
  /** Month key ("YYYY-MM") currently in view; derived from activeDate if null. */
  activeMonth: string | null;
  stats: StreakStats;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Smooth-scroll to a rendered date section. No-op when it is not on the page. */
function scrollToTimelineDate(date: string): void {
  if (typeof document === 'undefined') return;
  const element =
    document.getElementById(`date-${date}`) ??
    document.querySelector<HTMLElement>(`[data-timeline-date="${date}"]`);
  if (!element) return;
  element.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start',
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-studio-700/80 bg-studio-900/50 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-studio-400">{label}</dt>
      <dd className="text-sm font-medium text-studio-100">{value}</dd>
    </div>
  );
}

export function TimelineRail({
  entries,
  months,
  activeDate,
  activeMonth,
  stats,
}: TimelineRailProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const today = useMemo(() => todayIso(), []);

  // The Lead may hand us only activeDate; deriving the month keeps the scrubber
  // honest even then.
  const resolvedMonth = activeMonth ?? (activeDate ? activeDate.slice(0, 7) : null);

  // Newest year first, months oldest -> newest inside a year (calendar reading).
  const yearGroups = useMemo(() => {
    const groups: { year: string; buckets: MonthBucket[] }[] = [];
    for (const bucket of months) {
      const last = groups[groups.length - 1];
      if (last && last.year === bucket.year) last.buckets.push(bucket);
      else groups.push({ year: bucket.year, buckets: [bucket] });
    }
    return groups.reverse();
  }, [months]);

  const maxWorkCount = useMemo(
    () => entries.reduce((max, entry) => Math.max(max, entry.workCount), 1),
    [entries],
  );

  // Keep the highlighted chip inside the horizontally scrollable scrubber.
  useEffect(() => {
    if (!resolvedMonth) return;
    const chip = navRef.current?.querySelector<HTMLElement>('[data-active-month="true"]');
    chip?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
  }, [resolvedMonth]);

  return (
    <nav
      ref={navRef}
      aria-label="练习时间线"
      data-testid="timeline-rail"
      className="flex w-full flex-col gap-4 lg:w-60 lg:shrink-0"
    >
      {/* Sticky month scrubber: the "where am I in the calendar" control. */}
      <div className="glass sticky top-0 z-30 flex flex-col gap-1.5 rounded-xl px-2 py-2 shadow-lg shadow-studio-950/40">
        {yearGroups.length === 0 && (
          <p className="px-1 text-xs text-studio-400">还没有可导航的日期</p>
        )}
        {yearGroups.map((group) => (
          <div key={group.year} className="flex items-center gap-2">
            <span className="font-display shrink-0 text-xs text-accent-soft">{group.year}年</span>
            <div className="flex min-w-0 gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {group.buckets.map((bucket) => {
                const isActive = bucket.key === resolvedMonth;
                return (
                  <button
                    key={bucket.key}
                    type="button"
                    aria-pressed={isActive}
                    aria-label={`跳转到 ${bucket.label}，共 ${bucket.coverageDays} 天练习`}
                    data-active-month={isActive ? 'true' : undefined}
                    onClick={() => scrollToTimelineDate(bucket.firstDate)}
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition focus-visible:outline-none ${
                      isActive
                        ? 'border-accent/70 bg-accent/15 text-accent-soft'
                        : 'border-studio-700 text-studio-300 hover:border-accent/50 hover:text-studio-100'
                    }`}
                  >
                    {bucket.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* The rail itself. Hidden on small screens; the chips stay. */}
      <div className="reveal relative hidden lg:block">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3 left-[4px] top-3 w-px bg-gradient-to-b from-accent-soft/70 via-ember/50 to-transparent"
        />
        <ol className="flex flex-col gap-1.5">
          {entries.map((entry, index) => {
            const isActive = entry.date === activeDate;
            const previous = entries[index - 1];
            const newMonth = !previous || previous.monthKey !== entry.monthKey;
            const density = Math.max(8, Math.round((entry.workCount / maxWorkCount) * 100));
            return (
              <li key={entry.date} className="contents">
                {newMonth && (
                  <span
                    className={`flex items-center gap-2 pl-[18px] text-[10px] uppercase tracking-wider text-studio-400 ${
                      index === 0 ? '' : 'mt-3'
                    }`}
                  >
                    {entry.monthLabel}
                  </span>
                )}
                <a
                  href={`#date-${entry.date}`}
                  data-timeline-node={entry.date}
                  aria-current={isActive ? 'true' : undefined}
                  className={`group relative flex items-start gap-3 rounded-lg py-1.5 pl-[18px] pr-2 transition focus-visible:outline-none ${
                    isActive ? 'bg-accent/10' : 'hover:bg-studio-800/60'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute left-[1px] top-[9px] h-[7px] w-[7px] rounded-full border transition ${
                      isActive
                        ? 'animate-pulse-ring border-accent bg-accent-soft'
                        : 'border-studio-600 bg-studio-900 group-hover:border-accent/70'
                    }`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-xs font-medium ${
                          isActive ? 'text-accent-soft' : 'text-studio-100'
                        }`}
                      >
                        {relativeDayLabel(entry.date, today)}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-studio-400">
                        {entry.date.slice(5)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="shrink-0 text-[11px] text-studio-300">
                        {entry.workCount} 件
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-1 w-12 overflow-hidden rounded-full bg-studio-700"
                      >
                        <span
                          className="block h-full rounded-full bg-gradient-to-r from-accent-soft to-ember"
                          style={{ width: `${density}%` }}
                        />
                      </span>
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </div>

      <dl className="hidden grid-cols-2 gap-2 lg:grid">
        <Stat label="当前连续" value={`${stats.currentStreak} 天`} />
        <Stat label="最长连续" value={`${stats.longestStreak} 天`} />
        <Stat label="练习天数" value={`${stats.activeDays} 天`} />
        <Stat label="时间跨度" value={`${stats.coverageDays} 天`} />
      </dl>
    </nav>
  );
}

export default TimelineRail;
