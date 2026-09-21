/**
 * Pure planning logic for the local upload studio.
 *
 * Uploads land in `works/.incoming/<date>/` first and only move into
 * `works/<date>/<n>.psd` when you press 发布. That two-phase design matters:
 *
 *  - a half-finished batch never pollutes the real gallery or a commit;
 *  - the final number is decided at publish time, so several uploads in one
 *    session cannot collide with each other;
 *  - `.incoming` is git-ignored, so an abandoned draft stays local.
 *
 * Everything here is filesystem-agnostic (`DirReader`) so the numbering,
 * validation and traversal rules are unit-testable without touching disk.
 */
import { ISO_DATE, numericNameKey } from '../../shared/paths';

/** Size guard: GitHub rejects any single file above 100 MiB. */
export const MAX_PSD_BYTES = 100 * 1024 * 1024;

/** Only these extensions are accepted as uploads. */
export const ACCEPTED_EXTENSIONS = ['.psd'] as const;

/** Where drafts live, relative to the repo root. */
export const INCOMING_DIR = 'works/.incoming';

export interface DirReader {
  /** List entry names (files and directories) of `dir`; [] when missing. */
  list(dir: string): string[];
  /** True when `path` exists and is a file. */
  isFile(path: string): boolean;
  /** Size in bytes, or 0 when unknown. */
  size(path: string): number;
}

export interface PlanInput {
  /** Target date folder, `YYYY-MM-DD`. Defaults to today by the caller. */
  date: string;
  /** Uploaded file names, in the order they were dropped. */
  fileNames: string[];
  /** Size of each uploaded file, same order. */
  sizes: number[];
}

export interface PlannedUpload {
  /** Original name as uploaded (may contain path separators - sanitised below). */
  original: string;
  /** Safe base name without extension, used inside the repo. */
  stem: string;
  /** Extension, lower-cased, including the dot. */
  extension: string;
  bytes: number;
  /** Where the draft is written now. */
  incomingPath: string;
  /** Where it moves on publish. */
  publishPath: string;
  /** Sequence number inside the date folder. 0 when the upload is rejected. */
  index: number;
  /** Set when the file cannot be accepted; the rest still gets planned. */
  rejection?: string;
}

export interface PlanResult {
  date: string;
  accepted: PlannedUpload[];
  rejected: PlannedUpload[];
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Reduce an uploaded name to a safe stem.
 *
 * Uploaded names are attacker-controlled in the general case (and can be plain
 * broken in practice). Path separators, traversal, control characters, leading
 * dots and Windows-reserved names are all neutralised, then the result is
 * truncated. The final name in the repo is a number anyway - this stem is only
 * used to label the draft and show provenance in the UI.
 */
export function sanitizeStem(rawName: string): string {
  const withoutDirs = rawName.split(/[/\\]/).pop() ?? '';
  const withoutExtension = withoutDirs.replace(/\.[^.]*$/, '');
  const cleaned = withoutExtension
    // strip control chars, path-hostile chars and anything exotic
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned);
  const safe = cleaned === '' || reserved ? 'upload' : cleaned;
  return safe.slice(0, 60);
}

/** Lower-cased extension including the dot; '' when there is none. */
export function extensionOf(rawName: string): string {
  const base = rawName.split(/[/\\]/).pop() ?? '';
  const match = /\.[^.]*$/.exec(base);
  return match ? match[0].toLowerCase() : '';
}

/** Numbers already taken in a date folder, from `works/<date>` and the draft area. */
export function usedIndexes(reader: DirReader, date: string): Set<number> {
  const used = new Set<number>();
  for (const dir of [`works/${date}`, `${INCOMING_DIR}/${date}`]) {
    for (const entry of reader.list(dir)) {
      if (!/\.psd$/i.test(entry)) continue;
      const stem = entry.replace(/\.[^.]*$/, '');
      const key = numericNameKey(stem);
      if (Number.isFinite(key) && key !== Number.MAX_SAFE_INTEGER) used.add(key);
    }
  }
  return used;
}

/** Smallest positive free number for `date`. */
export function nextIndex(used: ReadonlySet<number>): number {
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Plan a batch of uploads: validate each file, assign it a sequence number in
 * the target date folder, and report exactly where it will live.
 *
 * Invalid files are reported per-file rather than failing the batch, so one bad
 * drop never discards the good ones.
 */
export function planUploads(reader: DirReader, input: PlanInput): PlanResult {
  const date = input.date;
  const used = usedIndexes(reader, date);
  const accepted: PlannedUpload[] = [];
  const rejected: PlannedUpload[] = [];

  input.fileNames.forEach((fileName, position) => {
    const bytes = input.sizes[position] ?? 0;
    const extension = extensionOf(fileName);
    const stem = sanitizeStem(fileName);
    const base: PlannedUpload = {
      original: basename(fileName),
      stem,
      extension,
      bytes,
      incomingPath: '',
      publishPath: '',
      index: 0,
    };

    const reject = (reason: string) => {
      rejected.push({ ...base, rejection: reason });
    };

    if (!isValidDate(date)) {
      reject(`日期格式必须是 YYYY-MM-DD（收到 ${JSON.stringify(date)}）`);
      return;
    }
    if (extension === '') {
      reject('没有扩展名，无法确认是 PSD');
      return;
    }
    if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
      reject(`只接受 ${ACCEPTED_EXTENSIONS.join('/')}，收到 ${extension}`);
      return;
    }
    if (bytes <= 0) {
      reject('文件为空');
      return;
    }
    if (bytes > MAX_PSD_BYTES) {
      reject(
        `${(bytes / 1024 / 1024).toFixed(1)} MiB 超过 GitHub 单文件上限 ` +
        `${MAX_PSD_BYTES / 1024 / 1024} MiB（即使走 LFS 也会被拒绝）`,
      );
      return;
    }

    const index = nextIndex(used);
    used.add(index);
    accepted.push({
      ...base,
      index,
      incomingPath: `${INCOMING_DIR}/${date}/${stem}.psd`,
      publishPath: `works/${date}/${index}.psd`,
    });
  });

  return { date, accepted, rejected };
}

/** Rows shown in the studio UI for drafts already sitting in `.incoming`. */
export interface DraftEntry {
  path: string;
  stem: string;
  bytes: number;
}

export function listDrafts(reader: DirReader, dir: string, date: string): DraftEntry[] {
  const target = `${dir}/${date}`;
  return reader
    .list(target)
    .filter((name) => /\.psd$/i.test(name))
    .map((name) => ({
      path: `${target}/${name}`,
      stem: name.replace(/\.[^.]*$/, ''),
      bytes: reader.size(`${target}/${name}`),
    }))
    .sort((a, b) => a.stem.localeCompare(b.stem));
}

/** A commit message that says what shipped, e.g. `发布 2 件作品（2026-09-24）`. */
export function publishMessage(dates: readonly string[], count: number): string {
  const unique = [...new Set(dates)].sort();
  const where = unique.length === 1 ? `（${unique[0]}）` : `（${unique.join(', ')}）`;
  return `发布 ${count} 件作品${where}`;
}
