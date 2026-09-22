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
 * LIQUID GLASS: one `liquid-glass-thin` panel with a slow sheen, and one thin
 * glass row per file. Nothing here is allowed to draw attention away from the
 * gallery above it.
 */

import { formatDateLabel } from '../../shared/paths';
import { formatBytes } from '../lib/format';
import { CATEGORY_LABELS, type UnbuiltFile, type UnbuiltGroup } from '../lib/index-loader';

function FileRow({ file }: { file: UnbuiltFile }) {
  return (
    <li className="liquid-glass-thin flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2 transition hover:brightness-[1.06]">
      <div className="relative z-[1] flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-studio-100/10 bg-studio-950/40 text-studio-300"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M4 1.8h4.6L12 5.2v9H4z" />
            <path d="M8.4 1.8v3.6H12" />
            <path d="M5.8 8.6h4.4M5.8 11h4.4" />
          </svg>
        </span>
        <span className="truncate text-sm text-studio-100">{file.name}</span>
        <span className="shrink-0 rounded-full border border-studio-100/10 bg-studio-100/[0.06] px-1.5 py-px text-[10px] text-studio-300">
          {CATEGORY_LABELS[file.category]}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-studio-300">{formatBytes(file.bytes)}</span>
      </div>
      <a
        href={file.url}
        download={file.name}
        className="relative z-[1] shrink-0 rounded-full border border-studio-100/15 bg-studio-100/[0.04] px-2.5 py-1 text-xs text-studio-300 transition hover:border-accent hover:text-accent"
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
    <section data-unbuilt-section="true" className="flex flex-col gap-5 border-t border-studio-700 pt-7">
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
              ，只能下载。重新运行构建（npm run manifest）后，它们会出现在上方的图库中。
            </p>
          </div>

          {groups.map((group) => (
            <div key={group.date} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-3">
                <h3 data-date={group.date} data-unbuilt-date={group.date} className="font-display text-sm font-medium text-studio-100">
                  {formatDateLabel(group.date)}
                </h3>
                <span className="text-[11px] tabular-nums text-studio-300">{group.files.length} 个待构建文件</span>
                <span aria-hidden="true" className="h-px flex-1 bg-studio-100/10" />
              </div>
              <ul className="flex flex-col gap-2">
                {group.files.map((file) => (
                  <FileRow key={`${group.date}/${file.name}`} file={file} />
                ))}
              </ul>
            </div>
          ))}

          <p className="text-[11px] text-studio-300">共 {total} 个待构建文件。</p>
        </div>

        <i aria-hidden="true" className="liquid-sheen" />
      </div>
    </section>
  );
}

export default UnbuiltList;
