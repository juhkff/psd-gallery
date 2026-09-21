/**
 * `useManifest` - fetch the generated manifest once and expose it to the app.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Manifest } from '../../shared/manifest';
import { loadManifest, type ManifestStatus } from './manifest-loader';

export interface UseManifestResult {
  status: ManifestStatus;
  manifest: Manifest | null;
  error: string | null;
  reload: () => void;
}

export function useManifest(): UseManifestResult {
  const [status, setStatus] = useState<ManifestStatus>('loading');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setStatus('loading');
    setError(null);

    void loadManifest({ signal: controller.signal }).then((result) => {
      if (cancelled) return;
      if (result.status === 'error' && result.aborted) return;
      if (result.warnings.length > 0) {
        console.warn('[psd-gallery] manifest 中有被跳过的条目：', result.warnings);
      }
      setManifest(result.manifest);
      setStatus(result.status);
      setError(result.error);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { status, manifest, error, reload };
}
