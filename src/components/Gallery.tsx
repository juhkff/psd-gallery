/**
 * Gallery: works grouped by date, one lazy thumbnail tile per work.
 *
 * Tiles are plain `<a href="#/date/name">` links, so opening a work is a normal
 * navigation and the browser back button just works.
 *
 * Four ideas shape this component:
 *
 * SCALING: every tile is a DOM node and a daily-practice library grows without
 * bound. Measured on this machine (scripts/bench-scale.ts): ~10.6 DOM nodes per
 * work, and at 500 works the page would be ~320,000 px tall - a scrollbar that
 * long stops being navigable well before the browser struggles. So the list is
 * paginated by date group: the first page paints immediately and older dates are
 * revealed on demand. Thumbnails stay `loading="lazy"`, which is why a gallery of
 * hundreds of works still issues only a handful of image requests.
 *
 * TIMELINE: the library is a practice history, so it is presented as one. A
 * sticky rail on the left carries a year/month scrubber, a node per practice day
 * and the streak stats. Only dates that are actually rendered can be anchored to,
 * so the rail receives the rendered page while the stats are computed from the
 * FULL history - the numbers must not shrink just because older dates are
 * paginated away.
 *
 * LIQUID GLASS: a tile is a pane of glass over its thumbnail. Each tile is
 * `.liquid-interactive` (so the shared specular layer knows where to light up),
 * but the pointer handler is attached ONCE to the grid: one listener for the
 * whole gallery instead of one per tile, and no React re-render on mousemove.
 */

import { useId, useMemo, useState } from 'react';
import type { DateGroup, WorkEntry } from '../../shared/manifest';
import { formatDateLabel } from '../../shared/paths';
import { formatBytes, formatSize } from '../lib/format';
import { GROUPS_PER_PAGE, planGalleryPage } from '../lib/gallery-page';
import { workHash } from '../lib/route';
import { buildTimelineEntries, computeStreakStats, groupEntriesByMonth, todayIso } from '../lib/timeline';
import { useLiquidPointer } from '../lib/useLiquidPointer';
import { useTimelineSpy } from '../lib/useTimelineSpy';
import { LiquidGlass } from './LiquidGlass';
import { TimelineRail } from './TimelineRail';

export { GROUPS_PER_PAGE };

interface WorkTileProps {
  date: string;
  work: WorkEntry;
  selected: boolean;
}

function Thumbnail({ work }: { work: WorkEntry }) {
  const [failed, setFailed] = useState(false);
  const { thumb, thumbWidth, thumbHeight } = work.preview;
  if (!thumb || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-studio-400">
        暂无预览
      </div>
    );
  }
  return (
    <img
      src={thumb}
      width={thumbWidth}
      height={thumbHeight}
      loading="lazy"
      decoding="async"
      alt={`${work.name} 缩略图`}
      onError={() => setFailed(true)}
      className="h-full w-full object-contain transition duration-500 group-hover:scale-[1.02]"
    />
  );
}

function WorkTile({ date, work, selected }: WorkTileProps) {
  const { thumbWidth, thumbHeight } = work.preview;
  return (
    <LiquidGlass
      as="a"
      variant="thin"
      interactive
      data-testid="work-tile"
      href={workHash(date, work.name)}
      aria-current={selected ? 'true' : undefined}
      className={`group flex flex-col transition duration-300 hover:-translate-y-1 hover:shadow-2xl hover:shadow-studio-950/70 ${
        selected ? 'ring-1 ring-accent/70' : ''
      }`}
    >
      {/* The image sits in a matte well so the glass frame reads as a frame. */}
      <div className="checkerboard m-1.5 overflow-hidden rounded-[10px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),inset_0_-8px_20px_-12px_rgba(0,0,0,0.9)]"
        style={{ aspectRatio: `${thumbWidth} / ${thumbHeight}` }}
      >
        <Thumbnail work={work} />
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-1 text-left">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-studio-100">{work.name}.psd</span>
          <span className="shrink-0 text-[11px] tabular-nums text-studio-300">{formatBytes(work.bytes)}</span>
        </span>
        <span className="text-[11px] text-studio-400">
          {formatSize(work.width, work.height)} · {work.layerCount} 个图层
        </span>
      </div>
      {selected && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-accent/50"
        />
      )}
    </LiquidGlass>
  );
}

export interface GalleryProps {
  groups: DateGroup[];
  /** `date/name` of the currently open work, if any. */
  selected?: string | null;
}

export function Gallery({ groups, selected = null }: GalleryProps) {
  const [visibleGroups, setVisibleGroups] = useState(GROUPS_PER_PAGE);
  const headingId = useId();

  // One pointer listener for the whole gallery; it targets the nearest
  // `.liquid-interactive` ancestor of whatever the pointer is over.
  const pointer = useLiquidPointer<HTMLDivElement>();

  // Newest first; a deep link into an older date widens the page so the
  // selected tile is never paginated away. See lib/gallery-page.ts.
  const page = useMemo(
    () => planGalleryPage(groups, visibleGroups, selected),
    [groups, visibleGroups, selected],
  );

  const { shown, hiddenCount, hiddenWorks, totalGroups, totalWorks, hasMore } = page;

  // History-wide stats, so pagination never understates the streak.
  const stats = useMemo(() => computeStreakStats(groups, todayIso()), [groups]);
  // Calendar chips for everything; only rendered dates are actually scrollable.
  const months = useMemo(() => groupEntriesByMonth(buildTimelineEntries(groups)), [groups]);
  // Rail nodes + anchors must match what is in the DOM right now.
  const renderedEntries = useMemo(() => buildTimelineEntries(shown), [shown]);
  const renderedDates = useMemo(() => renderedEntries.map((entry) => entry.date), [renderedEntries]);
  const activeDate = useTimelineSpy(renderedDates);

  if (groups.length === 0) {
    return <p className="text-sm text-studio-300">暂时没有可展示的作品。</p>;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      {/* Sticky on its own: the app header is deliberately NOT sticky, so the
          rail is the only sticky layer and its scrubber cannot stack under a
          second one. */}
      <div className="lg:sticky lg:top-6">
        <TimelineRail
          entries={renderedEntries}
          months={months}
          activeDate={activeDate}
          activeMonth={null}
          stats={stats}
        />
      </div>

      <div ref={pointer.ref} onPointerMove={pointer.onPointerMove} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-10">
        <h2 id={headingId} className="sr-only">
          按日期归档的作品
        </h2>

        {shown.map((group) => (
          <section
            key={group.date}
            id={`date-${group.date}`}
            data-timeline-date={group.date}
            // scroll-mt-* keeps the anchor from landing under the edge of the viewport
            className="reveal flex scroll-mt-24 flex-col gap-4"
          >
            <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
              <h3
                data-date={group.date}
                className="font-display text-lg font-semibold tracking-wide text-studio-100"
              >
                {formatDateLabel(group.date)}
              </h3>
              <span className="text-[11px] text-studio-400">{group.works.length} 件作品</span>
              <span className="ml-auto hidden text-[11px] tabular-nums text-studio-600 sm:inline">
                {group.date.split('-').join(' · ')}
              </span>
              {/* A hairline that fades out: separates dates without drawing a border. */}
              <span
                aria-hidden="true"
                className="h-px w-full bg-gradient-to-r from-studio-100/16 via-studio-100/5 to-transparent"
              />
            </div>
            <ul className="grid grid-cols-2 items-start gap-3.5 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {group.works.map((work) => (
                // self-start keeps a landscape tile from being stretched to the
                // height of a portrait neighbour in the same row.
                <li key={work.name} className="self-start">
                  <WorkTile
                    date={group.date}
                    work={work}
                    selected={selected === `${group.date}/${work.name}`}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}

        {hasMore && (
          <LiquidGlass variant="thin" className="flex flex-col items-center gap-2 px-6 py-5">
            <button
              type="button"
              data-testid="load-more"
              onClick={() => setVisibleGroups((current) => current + GROUPS_PER_PAGE)}
              className="liquid-interactive rounded-full px-6 py-2.5 text-sm text-studio-100 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14)] transition hover:text-accent-soft"
            >
              <i aria-hidden="true" className="liquid-specular" />
              显示更早的日期（还有 {hiddenCount} 天 · {hiddenWorks} 件）
            </button>
            <p className="text-[11px] text-studio-400">
              已显示 {shown.length} / {totalGroups} 天，共 {totalWorks} 件作品
            </p>
          </LiquidGlass>
        )}
      </div>
    </div>
  );
}

export default Gallery;
