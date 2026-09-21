/**
 * 「尚未构建的文件」: files that exist on the deploy server but were uploaded
 * after the last build, so the manifest has no thumbnail / preview / layer data
 * for them.
 *
 * They are listed with exactly what is known (name, category, size) and a
 * download link. The UI states the limitation instead of pretending they can be
 * previewed.
 */

import { formatDateLabel } from '../../shared/paths';
import { formatBytes } from '../lib/format';
import { CATEGORY_LABELS, type UnbuiltFile, type UnbuiltGroup } from '../lib/index-loader';

function FileRow({ file }: { file: UnbuiltFile }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-studio-700/70 bg-studio-900/50 px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm text-studio-100">{file.name}</span>
        <span className="rounded bg-studio-700 px-1.5 py-px text-[10px] text-studio-300">
          {CATEGORY_LABELS[file.category]}
        </span>
        <span className="text-[11px] text-studio-300">{formatBytes(file.bytes)}</span>
      </div>
      <a
        href={file.url}
        download={file.name}
        className="shrink-0 rounded border border-studio-600 px-2 py-1 text-xs transition hover:border-accent hover:text-accent"
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
    <section data-unbuilt-section="true" className="flex flex-col gap-4 border-t border-studio-700 pt-6">
      <div>
        <h2 className="text-lg font-semibold tracking-wide">尚未构建的文件</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-studio-300">
          这一组文件已经存在于服务器上，但还没有生成本站的缩略图与图层数据，因此
          <strong className="font-semibold text-studio-100">无法在线预览或查看图层</strong>
          ，只能下载。重新运行构建（npm run manifest）后，它们会出现在上方的图库中。
        </p>
      </div>

      {groups.map((group) => (
        <div key={group.date} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-3">
            <h3 data-date={group.date} data-unbuilt-date={group.date} className="text-sm font-medium text-studio-100">
              {formatDateLabel(group.date)}
            </h3>
            <span className="text-[11px] text-studio-300">{group.files.length} 个待构建文件</span>
          </div>
          <ul className="flex flex-col gap-2">
            {group.files.map((file) => (
              <FileRow key={`${group.date}/${file.name}`} file={file} />
            ))}
          </ul>
        </div>
      ))}

      <p className="text-[11px] text-studio-300">共 {total} 个待构建文件。</p>
    </section>
  );
}

export default UnbuiltList;
