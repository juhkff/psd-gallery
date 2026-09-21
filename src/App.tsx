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
import { useServerIndex } from './lib/useServerIndex';

function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

function StateCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-3 rounded-xl border border-studio-700 bg-studio-900/70 p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-studio-300">{children}</p>
      {action}
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-xl border border-studio-700 bg-studio-900/50 p-3">
          <div className="aspect-[3/2] w-full animate-pulse rounded-lg bg-studio-800" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-studio-800" />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { status, manifest, error, reload } = useManifest();
  const serverIndex = useServerIndex();
  const [hash, setHash] = useState<string>(readHash);

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

  const totals = manifest?.totals;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-studio-700 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-wide">绘画练习图库</h1>
          <p className="mt-1 text-xs text-studio-300">
            每日练习作品归档 · 浏览器内查看 PSD 图层 · 支持下载源文件
          </p>
        </div>
        {totals && totals.works > 0 && (
          <p className="text-xs text-studio-300">
            共 {totals.works} 件作品 · {formatBytes(totals.bytes)}
          </p>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {status === 'loading' && <GallerySkeleton />}

        {status === 'empty' && <StateCard title="还没有作品">{MANIFEST_EMPTY_MESSAGE}</StateCard>}

        {status === 'error' && (
          <StateCard
            title="无法加载作品清单"
            action={
              <button
                type="button"
                onClick={reload}
                className="rounded border border-studio-600 px-3 py-1.5 text-sm hover:border-accent hover:text-accent"
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
          <div className="flex flex-col gap-12">
            <Gallery groups={manifest.groups} selected={null} />
            <UnbuiltList groups={unbuilt} />
          </div>
        )}
      </main>

      <footer className="border-t border-studio-700 pt-3 text-[11px] text-studio-300">
        PSD 解码完全在本地浏览器中进行（Web Worker + IndexedDB 缓存），不会上传任何文件。
      </footer>
    </div>
  );
}

export default App;
