/**
 * Scrolling helpers.
 *
 * WHY NOT `element.scrollIntoView()`: the gallery wraps each date section in a
 * `.reveal` element, which starts at `transform: translateY(18px)` until the
 * scroll observer reveals it. A transformed ancestor becomes its own containing
 * block, and `scrollIntoView()` on a descendant of one silently fails: measured
 * on this site, calling it on a section inside an unrevealed `.reveal` left
 * `scrollY` at 0 with the target still 948px down the page. That is exactly why
 * clicking a timeline node sometimes did nothing.
 *
 * Scrolling the window to an absolute offset avoids the whole class of problem.
 */

/** Current document scroll offset, tolerating the old Safari body-scroll model. */
export function currentScrollY(): number {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

/** Absolute Y of an element in the document, ignoring any ancestor transform. */
export function documentTopOf(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  return rect.top + currentScrollY();
}

export interface ScrollToOptions {
  /** Space to leave above the target, e.g. for a sticky header. */
  offset?: number;
  /** Honour `prefers-reduced-motion`. */
  smooth?: boolean;
}

/** Scroll the window so `element` sits `offset` px below the viewport top. */
export function scrollToElement(element: HTMLElement, options: ScrollToOptions = {}): void {
  const { offset = 0, smooth = true } = options;
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = Math.max(0, documentTopOf(element) - offset);
  window.scrollTo({ top, behavior: smooth && !reduce ? 'smooth' : 'auto' });
}

/** Scroll to a date section (`#date-YYYY-MM-DD`); returns false when absent. */
export function scrollToDateSection(date: string, options: ScrollToOptions = {}): boolean {
  const element =
    document.getElementById(`date-${date}`) ??
    document.querySelector<HTMLElement>(`[data-timeline-date="${date}"]`);
  if (!element) return false;
  scrollToElement(element, options);
  return true;
}
