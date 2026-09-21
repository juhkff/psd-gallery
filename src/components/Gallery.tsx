/**
 * Gallery: works grouped by date, one lazy thumbnail tile per work.
 *
 * Tiles are plain `<a href="#/date/name">` links, so opening a work is a normal
 * navigation and the browser back button just works.
 */

import { useState } from 'react';
import type { DateGroup, WorkEntry } from '../../shared/manifest';
import { formatDateLabel } from '../../shared/paths';
import { formatBytes, formatSize } from '../lib/format';
import { workHash } from '../lib/route';

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
  if (groups.length === 0) {
    return <p className="text-sm text-studio-300">暂时没有可展示的作品。</p>;
  }
  return (
    <div className="flex flex-col gap-10">
      {groups.map((group) => (
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
    </div>
  );
}

export default Gallery;
