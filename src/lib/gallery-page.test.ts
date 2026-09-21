import { describe, expect, it } from 'vitest';
import {
  GROUPS_PER_PAGE,
  groupsRequiredForSelection,
  orderGroupsNewestFirst,
  planGalleryPage,
  type DatedGroup,
} from './gallery-page';

const group = (date: string, works: number): DatedGroup => ({
  date,
  works: Array.from({ length: works }, (_, i) => ({ name: String(i + 1) })),
});

/** 90 dates: 2026-06-01 .. 2026-08-29, one work each. */
function longLibrary(days = 90): DatedGroup[] {
  const out: DatedGroup[] = [];
  const start = Date.UTC(2026, 5, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    out.push(group(iso, i % 3 === 0 ? 3 : 1));
  }
  return out;
}

describe('orderGroupsNewestFirst', () => {
  it('sorts descending by date without mutating the input', () => {
    const input = [group('2026-09-21', 1), group('2026-09-24', 2), group('2026-09-20', 1)];
    const before = input.map((g) => g.date);
    const ordered = orderGroupsNewestFirst(input);
    expect(ordered.map((g) => g.date)).toEqual(['2026-09-24', '2026-09-21', '2026-09-20']);
    expect(input.map((g) => g.date)).toEqual(before);
  });
});

describe('planGalleryPage', () => {
  it('returns everything when the library fits in one page', () => {
    const plan = planGalleryPage([group('2026-09-21', 2), group('2026-09-24', 1)], GROUPS_PER_PAGE);
    expect(plan.shown).toHaveLength(2);
    expect(plan.hasMore).toBe(false);
    expect(plan.hiddenCount).toBe(0);
    expect(plan.totalWorks).toBe(3);
  });

  it('paginates a long library and keeps the newest date first', () => {
    const groups = longLibrary(90);
    const plan = planGalleryPage(groups, GROUPS_PER_PAGE);
    expect(plan.shown).toHaveLength(GROUPS_PER_PAGE);
    expect(plan.totalGroups).toBe(90);
    expect(plan.hasMore).toBe(true);
    expect(plan.hiddenCount).toBe(90 - GROUPS_PER_PAGE);
    // newest first
    const dates = plan.shown.map((g) => g.date);
    expect(dates).toEqual([...dates].sort().reverse());
    // hidden work count matches what is left
    expect(plan.shown.length + plan.hiddenCount).toBe(90);
    expect(plan.hiddenWorks).toBeGreaterThan(0);
  });

  it('reveals a page at a time until nothing is hidden', () => {
    const groups = longLibrary(90);
    let visible = GROUPS_PER_PAGE;
    let guard = 0;
    let plan = planGalleryPage(groups, visible);
    while (plan.hasMore && guard++ < 50) {
      visible += GROUPS_PER_PAGE;
      plan = planGalleryPage(groups, visible);
    }
    expect(plan.hasMore).toBe(false);
    expect(plan.shown).toHaveLength(90);
    expect(plan.hiddenWorks).toBe(0);
  });

  it('widens the page so a deep-linked older work is visible', () => {
    const groups = longLibrary(90);
    // oldest date in the library
    const oldest = orderGroupsNewestFirst(groups).at(-1)!.date;
    const plan = planGalleryPage(groups, GROUPS_PER_PAGE, `${oldest}/1`);
    expect(plan.shown).toHaveLength(90);
    expect(plan.shown.some((g) => g.date === oldest)).toBe(true);
    expect(plan.hasMore).toBe(false);
  });

  it('widens only as far as needed for a mid-list selection', () => {
    const groups = longLibrary(90);
    const ordered = orderGroupsNewestFirst(groups);
    const target = ordered[44].date;
    const plan = planGalleryPage(groups, GROUPS_PER_PAGE, `${target}/1`);
    expect(plan.shown).toHaveLength(45);
    expect(plan.hasMore).toBe(true);
  });

  it('ignores a selection that is not in the library', () => {
    const groups = longLibrary(90);
    const plan = planGalleryPage(groups, GROUPS_PER_PAGE, '1999-01-01/1');
    expect(plan.shown).toHaveLength(GROUPS_PER_PAGE);
  });

  it('handles an empty library and a zero page size', () => {
    expect(planGalleryPage([], GROUPS_PER_PAGE).shown).toEqual([]);
    const plan = planGalleryPage(longLibrary(5), 0);
    expect(plan.shown).toHaveLength(0);
    expect(plan.hasMore).toBe(true);
  });
});

describe('groupsRequiredForSelection', () => {
  it('counts positions from the newest date', () => {
    const ordered = orderGroupsNewestFirst(longLibrary(10));
    expect(groupsRequiredForSelection(ordered, null)).toBe(0);
    expect(groupsRequiredForSelection(ordered, `${ordered[0].date}/1`)).toBe(1);
    expect(groupsRequiredForSelection(ordered, `${ordered[3].date}/2`)).toBe(4);
    expect(groupsRequiredForSelection(ordered, '1999-01-01/1')).toBe(0);
  });
});
