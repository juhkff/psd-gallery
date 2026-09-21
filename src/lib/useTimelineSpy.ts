/**
 * Scroll-spy for the timeline rail.
 *
 * The gallery renders each date group as `<section id="date-YYYY-MM-DD"
 * data-timeline-date="YYYY-MM-DD">`; this hook watches exactly the dates the
 * caller passes in (i.e. the ones currently rendered - Gallery paginates, so an
 * older date is simply not observed until it is on the page).
 *
 * Implementation notes:
 *  - IntersectionObserver with a zero-height root band at ACTIVATION_RATIO of the
 *    viewport, so every section reports exactly when it crosses the "current"
 *    line. On each crossing we re-pick the topmost section that starts at or
 *    above that line.
 *  - If IntersectionObserver (or the DOM) is unavailable the hook returns null
 *    and never throws - a missing highlight is a cosmetic loss, not a crash.
 *  - The observer is disconnected on unmount and whenever the date list changes.
 */

import { useEffect, useRef, useState } from 'react';

export interface TimelineSpyOptions {
  /** Any valid IntersectionObserver rootMargin; default band matches ACTIVATION_RATIO. */
  rootMargin?: string;
}

/** Where the "you are here" line sits, as a fraction of the viewport height. */
export const ACTIVATION_RATIO = 0.35;

const DEFAULT_ROOT_MARGIN = `-${Math.round(ACTIVATION_RATIO * 100)}% 0px -${
  100 - Math.round(ACTIVATION_RATIO * 100)
}% 0px`;

interface Target {
  date: string;
  element: Element;
}

/** Best-effort lookup of the section for one date: id first, then data attribute. */
function findTarget(date: string): Element | null {
  const byId = document.getElementById(`date-${date}`);
  if (byId) return byId;
  return document.querySelector(`[data-timeline-date="${date}"]`);
}

export function useTimelineSpy(
  dates: readonly string[],
  options: TimelineSpyOptions = {},
): string | null {
  const { rootMargin = DEFAULT_ROOT_MARGIN } = options;
  const [activeDate, setActiveDate] = useState<string | null>(null);

  // Re-subscribe on content change, not on array identity: callers usually build
  // `dates` inline from rendered groups, which is a fresh array every render.
  const datesRef = useRef<readonly string[]>(dates);
  datesRef.current = dates;
  const datesKey = dates.join('\u0000');

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof IntersectionObserver === 'undefined'
    ) {
      setActiveDate(null);
      return;
    }

    const targets: Target[] = [];
    const seen = new Set<string>();
    for (const date of datesRef.current) {
      if (typeof date !== 'string' || seen.has(date)) continue;
      seen.add(date);
      const element = findTarget(date);
      if (element) targets.push({ date, element });
    }
    if (targets.length === 0) {
      setActiveDate(null);
      return;
    }

    const pick = (): void => {
      const line = window.innerHeight * ACTIVATION_RATIO;
      let best: string | null = null;
      let bestTop = Number.NEGATIVE_INFINITY;
      for (const target of targets) {
        const top = target.element.getBoundingClientRect().top;
        // Below the line, or scrolled out of the top of the page: not current.
        if (top > line || top < -target.element.clientHeight) continue;
        if (top > bestTop) {
          bestTop = top;
          best = target.date;
        }
      }
      // Everything is still below the line (top of page): the newest section wins.
      setActiveDate(best ?? targets[0].date);
    };

    const observer = new IntersectionObserver(
      () => {
        pick();
      },
      { rootMargin, threshold: 0 },
    );
    for (const target of targets) observer.observe(target.element);
    pick();

    return () => {
      observer.disconnect();
    };
  }, [datesKey, rootMargin]);

  return activeDate;
}
