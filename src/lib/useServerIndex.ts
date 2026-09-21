/**
 * `useServerIndex` - best-effort fetch of the deploy-time file index.
 *
 * There is deliberately no error state: when the file is missing the viewer
 * simply behaves exactly as before (gallery only).
 */

import { useEffect, useState } from 'react';
import type { IndexResponse } from '../../shared/manifest';
import { loadServerIndex } from './index-loader';

export interface UseServerIndexResult {
  status: 'loading' | 'ready' | 'unavailable';
  index: IndexResponse | null;
}

export function useServerIndex(): UseServerIndexResult {
  const [status, setStatus] = useState<UseServerIndexResult['status']>('loading');
  const [index, setIndex] = useState<IndexResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void loadServerIndex({ signal: controller.signal }).then((result) => {
      if (cancelled) return;
      setIndex(result);
      setStatus(result ? 'ready' : 'unavailable');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return { status, index };
}
