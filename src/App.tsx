/**
 * App: gallery <-> viewer, driven by the URL hash (`#/2026-09-21/1`).
 *
 * The hash is the single source of navigation truth, so:
 *  - works are linkable/bookmarkable,
 *  - the browser back/forward buttons work without a router,
 *  - the gallery tile can stay a plain `<a href="#/...">`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Gallery } from './components/Gallery';
import { UnbuiltList } from './components/UnbuiltList';
import { WorkViewer } from './components/WorkViewer';
import { formatBytes } from './lib/format';
import { listUnbuiltFiles } from './lib/index-loader';
import { MANIFEST_EMPTY_MESSAGE } from './lib/manifest-loader';
import { findWork, parseRoute } from './lib/route';
import { useManifest } from './lib/useManifest';
import { useScrollReveal } from './lib/useScrollReveal';
import { useServerIndex } from './lib/useServerIndex';

const DAY_MS = 86_400_000;

function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

/** Headline numbers for the hero, derived from the manifest alone. */
interface HeroStats {
  works: number;
  bytes: number;
  activeDays: number;
  spanDays: number;
  latest: string | null;
}

function heroStats(groups: readonly { date: string; works: readonly { bytes: number }[] }[]): HeroStats {
  const works = groups.reduce((total, group) => total + group.works.length, 0);
  const bytes = groups.reduce(
    (total, group) => total + group.works.reduce((sum, work) => sum + work.bytes, 0),
    0,
  );
  const dates = groups.map((group) => group.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  if (dates.length === 0) {
    return { works, bytes, activeDays: 0, spanDays: 0, latest: null };
  }
  const sorted = [...dates].sort();
  const first = Date.parse(`${sorted[0]}T00:00:00Z`);
  const last = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`);
  return {
    works,
    bytes,
    activeDays: new Set(dates).size,
    spanDays: Math.max(1, Math.round((last - first) / DAY_MS) + 1),
    latest: sorted[sorted.length - 1],
  };
}

function Stat({
  value,
  label,
  hint,
}: {
  value: string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="glass flex min-w-[7.5rem] flex-col gap-0.5 rounded-2xl px-4 py-3">
      <span className="font-display text-2xl leading-none text-gradient-gold">{value}</span>
      <span className="text-[11px] tracking-wide text-studio-300">{label}</span>
      {hint && <span className="text-[10px] text-studio-400">{hint}</span>}
    </div>
  );
}

function StateCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="glass mx-auto flex max-w-xl flex-col items-start gap-3 rounded-2xl p-6">
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-studio-300">{children}</p>
      {action}
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-hidden="true">
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-4">
          <div className="flex items-end gap-3 border-b border-studio-700 pb-2">
            <div className="h-5 w-40 animate-pulse rounded bg-studio-800" />
            <div className="h-3 w-16 animate-pulse rounded bg-studio-800" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="flex flex-col gap-2 overflow-hidden rounded-2xl border border-studio-700 bg-studio-900/50 p-3"
              >
                <div className="aspect-[3/2] w-full animate-pulse rounded-xl bg-studio-800" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-studio-800" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { status, manifest, error, reload } = useManifest();
  const serverIndex = useServerIndex();
  const [hash, setHash] = useState<string>(readHash);

  // One IntersectionObserver drives every `.reveal` on the page.
  useScrollReveal();

  useEffect(() => {
    const onHashChange = () => setHash(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const route = useMemo(() => parseRoute(hash), [hash]);
  const selection = useMemo(() => findWork(manifest, route), [manifest, route]);
  const unbuilt = useMemo(
    () => listUnbuiltFiles(serverIndex.index, manifest),
    [serverIndex.index, manifest],
  );

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [hash]);

  const closeViewer = useCallback(() => {
    // Keep it a hash change so the browser history stays consistent.
    window.location.hash = '#/';
  }, []);

  const stats = useMemo(() => heroStats(manifest?.groups ?? []), [manifest]);
  const showHero = status === 'ready' && !!manifest && !selection && !route;

  return (
    <div className="relative min-h-screen w-full">
      {/* Ambient backdrop: fixed, pointer-transparent, never intercepts clicks. */}
      <div className="studio-backdrop pointer-events-none fixed inset-0 -z-10" aria-hidden="true" />
      <div
        className="grain-overlay pointer-events-none fixed inset-0 -z-10 opacity-[0.05] mix-blend-overlay"
        aria-hidden="true"
      />

      <div className="mx-auto flex min-h-screen w-full max-w-[1560px] flex-col px-4 sm:px-6">
        {/* Deliberately NOT sticky: the timeline rail is the only sticky layer
            on the page, so its month scrubber can pin to the viewport top
            without stacking underneath a second sticky element. */}
        <header className="mb-2">
          <div className="glass mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-2.5">
            <a href="#/" className="group flex items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent/60 animate-pulse-ring" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
              </span>
              <span className="font-display text-sm font-semibold tracking-wide">绘画练习图库</span>
            </a>
            <span className="hidden text-[11px] text-studio-400 md:inline">
              每日练习 · PSD 图层在线查看 · 源文件下载
            </span>
            {stats.works > 0 && (
              <span className="ml-auto flex items-center gap-3 text-[11px] text-studio-300">
                <span>{stats.works} 件作品</span>
                <span className="text-studio-600">/</span>
                <span>{stats.activeDays} 个练习日</span>
                <span className="hidden text-studio-600 sm:inline">/</span>
                <span className="hidden sm:inline">{formatBytes(stats.bytes)}</span>
              </span>
            )}
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col pb-10">
          {showHero && <Hero stats={stats} />}

          {status === 'loading' && (
            <div className="mt-6">
              <GallerySkeleton />
            </div>
          )}

          {status === 'empty' && <StateCard title="还没有作品">{MANIFEST_EMPTY_MESSAGE}</StateCard>}

          {status === 'error' && (
            <StateCard
              title="无法加载作品清单"
              action={
                <button
                  type="button"
                  onClick={reload}
                  className="rounded-full border border-studio-600 px-4 py-1.5 text-sm transition hover:border-accent hover:text-accent"
                >
                  重新加载
                </button>
              }
            >
              {error ?? '未知错误。'}
            </StateCard>
          )}

          {status === 'ready' && manifest && selection && (
            <WorkViewer key={selection.work.psd} date={selection.date} work={selection.work} onClose={closeViewer} />
          )}

          {status === 'ready' && manifest && !selection && route && (
            <StateCard title="找不到这个作品">
              链接中的作品（{route.date} / {route.name}）不在当前清单里，可能已被移除或重命名。
              <a href="#/" className="text-accent underline underline-offset-2">
                返回图库
              </a>
            </StateCard>
          )}

          {status === 'ready' && manifest && !selection && !route && (
            <div className="mt-8 flex flex-col gap-14">
              <Gallery groups={manifest.groups} selected={null} />
              <UnbuiltList groups={unbuilt} />
            </div>
          )}        </main>

        <footer className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-studio-700/70 py-4 text-[11px] text-studio-400">
          <span>PSD 解码完全在本地浏览器中进行（Web Worker + IndexedDB 缓存），不会上传任何文件。</span>
          {stats.latest && <span className="ml-auto">最近更新 {stats.latest}</span>}
        </footer>
      </div>
    </div>
  );
}

/** Big editorial opening: title, one-line intent, and the headline numbers. */
function Hero({ stats }: { stats: HeroStats }) {
  return (
    <section className="reveal relative overflow-hidden rounded-3xl border border-studio-700/80 px-5 py-9 sm:px-9 sm:py-12">
      <div className="studio-backdrop absolute inset-0 -z-10 opacity-90" aria-hidden="true" />
      <p className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-accent/90">
        <span className="inline-block h-px w-8 bg-accent/60" />
        Drawing Practice Archive
      </p>
      <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-6xl">
        每日练习<span className="text-gradient-gold">·</span>时间线
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-studio-300 sm:text-base">
        按日期归档的绘画练习与 PSD 工程文件。在浏览器里逐层查看图层、随时隐藏或显示，
        原始 PSD 一键下载 —— 解析全部在本机完成。
      </p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Stat value={String(stats.works)} label="件作品" hint="已归档" />
        <Stat value={String(stats.activeDays)} label="个练习日" hint="有产出的天数" />
        <Stat value={String(stats.spanDays)} label="天跨度" hint="首件至今" />
        <Stat
          value={stats.bytes >= 1024 ** 3 ? `${(stats.bytes / 1024 ** 3).toFixed(1)}G` : `${(stats.bytes / 1024 ** 2).toFixed(0)}M`}
          label="源文件总量"
          hint="PSD 字节数"
        />
      </div>
    </section>
  );
}

export default App;
