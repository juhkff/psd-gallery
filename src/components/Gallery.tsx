/**
 * Gallery: works grouped by date, one lazy thumbnail tile per work.
 *
 * Tiles are plain `<a href="#/date/name">` links, so opening a work is a normal
 * navigation and the browser back button just works.
 *
 * SCALING: every tile is a DOM node and a daily-practice library grows without
 * bound. Measured on this machine (scripts/bench-scale.ts): ~10.6 DOM nodes per
 * work, and at 500 works the page would be ~320,000 px tall - a scrollbar that
 * long stops being navigable well before the browser struggles. So the list is
 * paginated by date group: the first page paints immediately and older dates are
 * revealed on demand. Thumbnails stay `loading="lazy"`, which is why a gallery of
 * hundreds of works still issues only a handful of image requests.
 */

import { useMemo, useState } from 'react';
import type { DateGroup, WorkEntry } from '../../shared/manifest';
import { formatDateLabel } from '../../shared/paths';
import { formatBytes, formatSize } from '../lib/format';
import { GROUPS_PER_PAGE, planGalleryPage } from '../lib/gallery-page';
import { workHash } from '../lib/route';

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
      <div className="checkerboard flex h-full w-full items-center justify-center text-xs text-studio-300">
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
      className="h-full w-full object-contain"
    />
  );
}

function WorkTile({ date, work, selected }: WorkTileProps) {
  const { thumbWidth, thumbHeight } = work.preview;
  return (
    <a
      data-testid="work-tile"
      href={workHash(date, work.name)}
      aria-current={selected ? 'true' : undefined}
      className={`group flex h-full flex-col overflow-hidden rounded-xl border bg-studio-900/70 transition hover:border-accent/70 hover:bg-studio-800 focus-visible:border-accent ${
        selected ? 'border-accent/70' : 'border-studio-700'
      }`}
    >
      <div
        className="checkerboard w-full overflow-hidden"
        style={{ aspectRatio: `${thumbWidth} / ${thumbHeight}` }}
      >
        <Thumbnail work={work} />
      </div>
      <div className="flex flex-col gap-1 p-3 text-left">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-studio-100">
            {work.name}.psd
          </span>
          <span className="shrink-0 text-xs text-studio-300">{formatBytes(work.bytes)}</span>
        </span>
        <span className="text-xs text-studio-300">
          {formatSize(work.width, work.height)} · {work.layerCount} 个图层
        </span>
      </div>
    </a>
  );
}

export interface GalleryProps {
  groups: DateGroup[];
  /** `date/name` of the currently open work, if any. */
  selected?: string | null;
}

export function Gallery({ groups, selected = null }: GalleryProps) {
  const [visibleGroups, setVisibleGroups] = useState(GROUPS_PER_PAGE);

  // Newest first; a deep link into an older date widens the page so the
  // selected tile is never paginated away. See lib/gallery-page.ts.
  const page = useMemo(
    () => planGalleryPage(groups, visibleGroups, selected),
    [groups, visibleGroups, selected],
  );

  if (groups.length === 0) {
    return <p className="text-sm text-studio-300">暂时没有可展示的作品。</p>;
  }

  const { shown, hiddenCount, hiddenWorks, totalGroups, totalWorks, hasMore } = page;

  return (
    <div className="flex flex-col gap-10">
      {shown.map((group) => (
        <section key={group.date} className="flex flex-col gap-4">
          <div className="flex items-baseline gap-3 border-b border-studio-700 pb-2">
            <h2 data-date={group.date} className="text-lg font-semibold tracking-wide">
              {formatDateLabel(group.date)}
            </h2>
            <span className="text-xs text-studio-300">{group.works.length} 件作品</span>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {group.works.map((work) => (
              <li key={work.name}>
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
        <div className="flex flex-col items-center gap-2 border-t border-studio-700 pt-6">
          <button
            type="button"
            data-testid="load-more"
            onClick={() => setVisibleGroups((current) => current + GROUPS_PER_PAGE)}
            className="rounded-lg border border-studio-600 px-5 py-2 text-sm text-studio-100 transition hover:border-accent/70 hover:bg-studio-800"
          >
            显示更早的日期（还有 {hiddenCount} 天 · {hiddenWorks} 件）
          </button>
          <p className="text-xs text-studio-300">
            已显示 {shown.length} / {totalGroups} 天，共 {totalWorks} 件作品
          </p>
        </div>
      )}
    </div>
  );
}

export default Gallery;
