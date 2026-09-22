/**
 * App: gallery <-> viewer, driven by the URL hash (`#/2026-09-21/1`).
 *
 * The hash is the single source of navigation truth, so works are linkable and
 * the browser back/forward buttons work without a router.
 *
 * COPY RULE for this file: a visitor should only read what helps them use the
 * page. How it is built (workers, caches, decoding) is not their business, so
 * that lives in comments like this one rather than on screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Gallery } from './components/Gallery';
import { UnbuiltList } from './components/UnbuiltList';
import { WorkViewer } from './components/WorkViewer';
import { listUnbuiltFiles } from './lib/index-loader';
import { MANIFEST_EMPTY_MESSAGE } from './lib/manifest-loader';
import { findWork, parseRoute } from './lib/route';
import { useManifest } from './lib/useManifest';
import { useScrollReveal } from './lib/useScrollReveal';
import { useServerIndex } from './lib/useServerIndex';

function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

interface IntroStats {
  works: number;
  activeDays: number;
  latest: string | null;
}

/** Totals for the intro. Derived from the manifest alone. */
function introStats(groups: readonly { date: string; works: readonly unknown[] }[]): IntroStats {
  const works = groups.reduce((total, group) => total + group.works.length, 0);
  const dates = groups.map((group) => group.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  const sorted = [...dates].sort();
  return {
    works,
    activeDays: new Set(dates).size,
    latest: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
}

/**
 * Reading progress: a hairline along the top edge.
 *
 * Writes a transform through a ref rather than state, so scrolling never
 * re-renders the tree.
 */
function ScrollProgress() {
  const bar = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const update = () => {
      const node = bar.current;
      if (!node) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      node.style.transform = `scaleX(${ratio})`;
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return (
    <span aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-px origin-left">
      <span
        ref={bar}
        className="block h-full w-full origin-left scale-x-0 bg-ink-500/50 transition-transform duration-150 ease-out"
      />
    </span>
  );
}

function StateCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel mx-auto flex max-w-lg flex-col items-start gap-3 p-6">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="text-sm leading-relaxed text-ink-300">{children}</p>
      {action}
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="flex flex-col gap-12" aria-hidden="true">
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-4">
          <div className="h-5 w-36 animate-pulse rounded bg-ink-800" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="panel-quiet p-2">
                <div className="aspect-[3/2] w-full animate-pulse rounded bg-ink-800" />
                <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-ink-800" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Two lines, then the numbers. No tagline: the work is the introduction. */
function Intro({ stats }: { stats: IntroStats }) {
  return (
    <section className="flex flex-col gap-6 pt-2">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-3xl leading-tight tracking-tight sm:text-4xl">
          每日绘画练习
        </h1>
        <p className="max-w-prose text-sm leading-relaxed text-ink-300">
          按日期归档的练习作品与 PSD 源文件。点开作品可以逐层查看图层。
        </p>
      </div>
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <div className="flex items-baseline gap-2">
          <dd className="readout font-display text-2xl leading-none">{stats.works}</dd>
          <dt className="label">件作品</dt>
        </div>
        <div className="flex items-baseline gap-2">
          <dd className="readout font-display text-2xl leading-none">{stats.activeDays}</dd>
          <dt className="label">天有练习</dt>
        </div>
        {stats.latest && (
          <div className="flex items-baseline gap-2">
            <dd className="readout font-display text-2xl leading-none">{stats.latest}</dd>
            <dt className="label">最近一次</dt>
          </div>
        )}
      </dl>
    </section>
  );
}

export function App() {
  const { status, manifest, error, reload } = useManifest();
  const serverIndex = useServerIndex();
  const [hash, setHash] = useState<string>(readHash);

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
    window.location.hash = '#/';
  }, []);

  const stats = useMemo(() => introStats(manifest?.groups ?? []), [manifest]);
  const showIntro = status === 'ready' && !!manifest && !selection && !route;

  return (
    <div className="relative min-h-screen w-full">
      <ScrollProgress />

      <div className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col px-5 sm:px-8">
        <header className="pt-7 pb-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <a href="#/" className="text-[15px] font-medium tracking-wide text-ink-100">
              绘画练习
            </a>
            {stats.works > 0 && (
              <span className="label">
                {stats.works} 件 · {stats.activeDays} 天
                {stats.latest ? ` · 最近 ${stats.latest}` : ''}
              </span>
            )}
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col pb-16">
          {status === 'loading' && (
            <div className="mt-4">
              <GallerySkeleton />
            </div>
          )}

          {status === 'empty' && <StateCard title="还没有作品">{MANIFEST_EMPTY_MESSAGE}</StateCard>}

          {status === 'error' && (
            <StateCard
              title="作品清单加载失败"
              action={
                <button type="button" onClick={reload} className="btn-quiet px-4 py-1.5 text-sm">
                  重试
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
            <StateCard title="没有这个作品">
              链接里的作品（{route.date} / {route.name}）不在清单中，可能已被移除或改名。
              <a href="#/" className="text-accent-soft underline underline-offset-2">
                返回图库
              </a>
            </StateCard>
          )}

          {status === 'ready' && manifest && !selection && !route && (
            <div className="flex flex-col gap-16">
              {showIntro && <Intro stats={stats} />}
              <Gallery groups={manifest.groups} selected={null} />
              <UnbuiltList groups={unbuilt} />
            </div>
          )}
        </main>

        <footer className="mt-auto border-t border-ink-800 py-5">
          <p className="label">本地练习归档</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
