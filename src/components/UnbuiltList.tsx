/**
 * 「尚未构建的文件」: files that exist on the deploy server but were uploaded
 * after the last build, so the manifest has no thumbnail / preview / layer data
 * for them.
 *
 * They are listed with exactly what is known (name, category, size) and a
 * download link. The UI states the limitation instead of pretending they can be
 * previewed - deliberately a quiet, secondary list: no thumbnails, no canvas,
 * no preview affordance of any kind.
 *
 * CRAFT: quiet must not mean unfinished. The rows are real glass, the metadata
 * is pushed to the right edge and tied to the filename by a dotted leader (the
 * table-of-contents device), and the download control is a small rimmed button
 * rather than bare text. Section and group headings are separated by
 * `glass-divider` hairlines, which read as engraved into the pane instead of as
 * table borders. Nothing here raises its voice above the gallery above it.
 */

import { formatDateLabel } from '../../shared/paths';
import { formatBytes } from '../lib/format';
import { CATEGORY_LABELS, type UnbuiltFile, type UnbuiltGroup } from '../lib/index-loader';

function FileRow({ file }: { file: UnbuiltFile }) {
  return (
    <li className="liquid-glass-thin hover-glow flex items-center gap-3 rounded-xl px-3 py-2 hover:border-studio-100/25 hover:shadow-[0_14px_30px_-20px_rgba(0,0,0,0.95)]">
      <span
        aria-hidden="true"
        className="relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-studio-950/45 text-studio-300 ring-1 ring-inset ring-studio-100/[0.08]"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M4 1.8h4.6L12 5.2v9H4z" />
          <path d="M8.4 1.8v3.6H12" />
          <path d="M5.8 8.6h4.4M5.8 11h4.4" />
        </svg>
      </span>

      <span className="relative z-[1] min-w-0 max-w-[45%] shrink-0 truncate text-[13px] text-studio-100">
        {file.name}
      </span>

      {/* Dotted leader: the eye can travel from the name to its metadata
          without reading across a void. */}
      <span
        aria-hidden="true"
        className="relative z-[1] mx-0.5 h-0 min-w-4 flex-1 self-center border-t border-dotted border-studio-100/[0.16]"
      />

      <span className="relative z-[1] flex shrink-0 items-center gap-2.5">
        <span className="rounded-full border border-studio-100/10 bg-studio-100/[0.05] px-1.5 py-px text-[10px] leading-4 text-studio-300">
          {CATEGORY_LABELS[file.category]}
        </span>
        <span className="text-[11px] leading-4 tabular-nums text-studio-300">{formatBytes(file.bytes)}</span>
      </span>

      <a
        href={file.url}
        download={file.name}
        className="hover-glow relative z-[1] shrink-0 rounded-full border border-studio-100/15 bg-studio-100/[0.05] px-2.5 py-1 text-[11px] text-studio-300 hover:border-accent/60 hover:bg-accent/[0.12] hover:text-accent-soft hover:shadow-[0_8px_18px_-10px_rgba(201,162,39,0.7)]"
      >
        下载
      </a>
    </li>
  );
}

export interface UnbuiltListProps {
  groups: UnbuiltGroup[];
}

export function UnbuiltList({ groups }: UnbuiltListProps) {
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.files.length, 0);

  return (
    <section data-unbuilt-section="true" className="flex flex-col gap-6">
      <div aria-hidden="true" className="glass-divider" />

      <div className="liquid-glass-thin flex flex-col gap-5 p-4 sm:p-5">
        <div className="relative z-[1] flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="font-display text-lg font-semibold tracking-wide text-studio-100">尚未构建的文件</h2>
              <span className="rounded-full border border-studio-100/10 bg-studio-100/[0.06] px-2 py-0.5 text-[11px] tabular-nums text-studio-300">
                {total} 个待构建
              </span>
            </div>
            <p className="max-w-3xl text-xs leading-relaxed text-studio-300">
              这一组文件已经存在于服务器上，但还没有生成本站的缩略图与图层数据，因此
              <strong className="font-semibold text-studio-100">无法在线预览或查看图层</strong>
              ，只能下载。重新运行构建（<code className="rounded bg-studio-950/60 px-1 py-px text-[11px] text-studio-200">npm run manifest</code>）后，它们会出现在上方的图库中。
            </p>
          </div>

          {groups.map((group) => (
            <div key={group.date} className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <h3 data-date={group.date} data-unbuilt-date={group.date} className="font-display text-sm font-medium text-studio-100">
                  {formatDateLabel(group.date)}
                </h3>
                <span className="shrink-0 text-[11px] tabular-nums text-studio-300">{group.files.length} 个待构建文件</span>
                <span aria-hidden="true" className="glass-divider flex-1" />
              </div>
              <ul className="flex flex-col gap-2">
                {group.files.map((file) => (
                  <FileRow key={`${group.date}/${file.name}`} file={file} />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <i aria-hidden="true" className="liquid-sheen" />
      </div>
    </section>
  );
}

export default UnbuiltList;
