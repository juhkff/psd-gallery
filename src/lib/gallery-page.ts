/**
 * Pagination maths for the gallery.
 *
 * Kept out of the component so it can be unit-tested without a DOM: the library
 * grows a date folder per practice day, and the measured DOM cost is ~10.6 nodes
 * per work, so an unbounded list turns into a 300,000 px page.
 */

/** Date groups revealed per page. */
export const GROUPS_PER_PAGE = 30;

export interface DatedGroup {
  date: string;
  works: unknown[];
}

export interface PagePlan<T extends DatedGroup> {
  /** Groups to render right now, newest first. */
  shown: T[];
  /** Groups still hidden behind "show older". */
  hiddenCount: number;
  /** Works still hidden behind "show older". */
  hiddenWorks: number;
  totalGroups: number;
  totalWorks: number;
  hasMore: boolean;
}

/** Newest date first, without mutating the caller's array. */
export function orderGroupsNewestFirst<T extends DatedGroup>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * How many groups must be visible for `selected` ("date/name") to be on screen.
 * Returns 0 when nothing is selected or the date is unknown.
 */
export function groupsRequiredForSelection<T extends DatedGroup>(
  ordered: readonly T[],
  selected: string | null | undefined,
): number {
  if (!selected) return 0;
  const date = selected.split('/')[0];
  const index = ordered.findIndex((group) => group.date === date);
  return index < 0 ? 0 : index + 1;
}

/**
 * Decide what the gallery renders. A deep link into an older date widens the
 * page so the selected tile is never paginated away.
 */
export function planGalleryPage<T extends DatedGroup>(
  groups: readonly T[],
  visibleGroups: number,
  selected?: string | null,
): PagePlan<T> {
  const ordered = orderGroupsNewestFirst(groups);
  const required = groupsRequiredForSelection(ordered, selected);
  const take = Math.max(visibleGroups, required, 0);
  const shown = ordered.slice(0, take);
  const rest = ordered.slice(shown.length);
  return {
    shown,
    hiddenCount: rest.length,
    hiddenWorks: rest.reduce((total, group) => total + group.works.length, 0),
    totalGroups: ordered.length,
    totalWorks: ordered.reduce((total, group) => total + group.works.length, 0),
    hasMore: rest.length > 0,
  };
}
