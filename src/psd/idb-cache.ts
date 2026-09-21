/**
 * IndexedDB cache for decoded PSD work.
 *
 * Identity: `url | bytes | cheap hash of the file bytes`. A second visit to the
 * same work restores the per-layer proxy bitmaps from here, so it never parses
 * or decodes the PSD again - `decodeCount` stays 0 for a cache hit.
 *
 * Layer bitmaps are stored as **lossless PNG**, so a cache-restored composite is
 * pixel-identical to the freshly decoded one (a lossy preview would break the
 * "toggle back restores the original exactly" guarantee).
 *
 * Layout (two stores so LRU eviction scans metadata without pulling blobs):
 *   - `works`     : one small metadata record per work (layers tree, plan, sizes)
 *   - `workBlobs` : `{ key, id, blob }`, one row per layer bitmap
 *
 * Everything degrades gracefully: no IndexedDB, private mode, or a tiny quota
 * simply means "cache unavailable", never a broken viewer.
 */

import type { LayerNode } from '../../shared/manifest';
import type { ProxyPlan } from './composite';

export const CACHE_DB_NAME = 'psd-gallery-cache';
export const CACHE_DB_VERSION = 1;
export const CACHE_STORE_META = 'works';
export const CACHE_STORE_BLOBS = 'workBlobs';

/** Hard ceiling for the whole cache. */
export const CACHE_BUDGET_BYTES = 400 * 1024 * 1024;
/** Never store a single layer bitmap bigger than this. */
export const CACHE_MAX_BLOB_BYTES = 12 * 1024 * 1024;

export interface CachedWorkMeta {
  /** Stable identity used as the store key (`url|bytes|hash`). */
  key: string;
  url: string;
  bytes: number;
  documentWidth: number;
  documentHeight: number;
  plan: ProxyPlan;
  layers: LayerNode[];
  layerCount: number;
  /** Number of layer bitmaps stored for this work. */
  bitmapCount: number;
  /** Sum of all stored blob bytes for this work. */
  sizeBytes: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface CachedBlob {
  key: string;
  id: string;
  sizeBytes: number;
  blob: Blob;
}

export interface CachedWork {
  meta: CachedWorkMeta;
  bitmaps: CachedBlob[];
}

export interface CacheWriteInput {
  meta: Omit<CachedWorkMeta, 'sizeBytes' | 'bitmapCount' | 'createdAt' | 'lastUsedAt'>;
  bitmaps: CachedBlob[];
}

export type CacheWriteResult = 'stored' | 'quota' | 'unavailable';

/* ------------------------------------------------------------------ *
 * identity
 * ------------------------------------------------------------------ */

export function fileIdentity(url: string, bytes: number, hash: number): string {
  return `${url}|${bytes}|${hash.toString(16)}`;
}

/**
 * Cheap 32-bit FNV-1a over at most ~256 KB sampled from the buffer.
 * Fast enough to run in the worker even on a 100 MB PSB.
 */
export function hashBytes(buffer: ArrayBufferLike): number {
  const bytes = new Uint8Array(buffer);
  const length = bytes.length;
  const PRIME = 0x01000193;
  const SAMPLE_BUDGET = 256 * 1024;
  const CHUNK = 4096;
  let hash = 0x811c9dc5 ^ (length >>> 0);
  const step = length <= SAMPLE_BUDGET ? 1 : Math.max(1, Math.floor(length / (SAMPLE_BUDGET / CHUNK)));
  for (let start = 0; start < length; start += step * CHUNK) {
    const end = Math.min(length, start + CHUNK * step);
    for (let index = start; index < end; index += step) {
      hash ^= bytes[index];
      hash = Math.imul(hash, PRIME);
    }
  }
  return hash >>> 0;
}

/* ------------------------------------------------------------------ *
 * low level IDB helpers
 * ------------------------------------------------------------------ */

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
  });
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Open (once) the cache database; resolves `null` when unavailable. */
export function openCache(): Promise<IDBDatabase | null> {
  if (!isIndexedDbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_META)) {
        db.createObjectStore(CACHE_STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE_BLOBS)) {
        db.createObjectStore(CACHE_STORE_BLOBS, { keyPath: ['key', 'id'] });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
    open.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Effective byte budget: never more than 400 MB and never more than ~40% of quota. */
export function cacheBudgetBytes(estimate?: { quota?: number } | null): number {
  const quota = estimate?.quota;
  if (typeof quota === 'number' && Number.isFinite(quota) && quota > 0) {
    return Math.max(32 * 1024 * 1024, Math.min(CACHE_BUDGET_BYTES, Math.floor(quota * 0.4)));
  }
  return CACHE_BUDGET_BYTES;
}

/* ------------------------------------------------------------------ *
 * read / write
 * ------------------------------------------------------------------ */

export async function readCachedWork(
  db: IDBDatabase,
  key: string,
  touch = true,
): Promise<CachedWork | null> {
  try {
    const metaTx = db.transaction(CACHE_STORE_META, touch ? 'readwrite' : 'readonly');
    const metaStore = metaTx.objectStore(CACHE_STORE_META);
    const meta = await request<CachedWorkMeta | undefined>(metaStore.get(key));
    if (!meta) return null;
    if (touch) metaStore.put({ ...meta, lastUsedAt: Date.now() });
    await transactionDone(metaTx);

    const blobTx = db.transaction(CACHE_STORE_BLOBS, 'readonly');
    const rows = await request<CachedBlob[]>(
      blobTx.objectStore(CACHE_STORE_BLOBS).getAll(IDBKeyRange.bound([key, ''], [key, '\uffff'])),
    );
    await transactionDone(blobTx);
    return { meta, bitmaps: rows };
  } catch {
    return null;
  }
}

async function sumUsage(db: IDBDatabase): Promise<CachedWorkMeta[]> {
  const tx = db.transaction(CACHE_STORE_META, 'readonly');
  const rows = await request<CachedWorkMeta[]>(tx.objectStore(CACHE_STORE_META).getAll());
  await transactionDone(tx);
  return rows;
}

export async function deleteCachedWork(db: IDBDatabase, key: string): Promise<void> {
  try {
    const tx = db.transaction([CACHE_STORE_META, CACHE_STORE_BLOBS], 'readwrite');
    tx.objectStore(CACHE_STORE_META).delete(key);
    tx.objectStore(CACHE_STORE_BLOBS).delete(IDBKeyRange.bound([key, ''], [key, '\uffff']));
    await transactionDone(tx);
  } catch {
    /* best effort */
  }
}

/** Evict least-recently-used works until `neededBytes` fits in `budget`. */
export async function evictLru(
  db: IDBDatabase,
  neededBytes: number,
  budget: number,
  keepKey?: string,
): Promise<number> {
  try {
    const metas = await sumUsage(db);
    const bytes = metas.reduce((sum, meta) => sum + (meta.sizeBytes || 0), 0);
    if (bytes + neededBytes <= budget) return 0;
    const candidates = metas
      .filter((meta) => meta.key !== keepKey)
      .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    let freed = 0;
    for (const meta of candidates) {
      if (bytes - freed + neededBytes <= budget) break;
      await deleteCachedWork(db, meta.key);
      freed += meta.sizeBytes || 0;
    }
    return freed;
  } catch {
    return 0;
  }
}

export async function cacheUsage(db: IDBDatabase): Promise<{ entries: number; bytes: number }> {
  try {
    const metas = await sumUsage(db);
    return { entries: metas.length, bytes: metas.reduce((sum, meta) => sum + (meta.sizeBytes || 0), 0) };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

export async function clearCache(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction([CACHE_STORE_META, CACHE_STORE_BLOBS], 'readwrite');
    tx.objectStore(CACHE_STORE_META).clear();
    tx.objectStore(CACHE_STORE_BLOBS).clear();
    await transactionDone(tx);
  } catch {
    /* best effort */
  }
}

/**
 * Store one work. Replaces an existing entry for the same key and evicts LRU
 * neighbours first so the byte budget is respected. Never throws.
 */
export async function writeCachedWork(
  db: IDBDatabase,
  input: CacheWriteInput,
  budget = CACHE_BUDGET_BYTES,
): Promise<CacheWriteResult> {
  const blobs = input.bitmaps.filter((row) => row.sizeBytes > 0 && row.sizeBytes <= CACHE_MAX_BLOB_BYTES);
  if (blobs.length === 0) return 'unavailable';

  const total = blobs.reduce((sum, row) => sum + row.sizeBytes, 0);
  const meta: CachedWorkMeta = {
    ...input.meta,
    bitmapCount: blobs.length,
    sizeBytes: total,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };

  await evictLru(db, total, budget, meta.key);

  const attempt = async (rows: CachedBlob[]): Promise<void> => {
    const tx = db.transaction([CACHE_STORE_META, CACHE_STORE_BLOBS], 'readwrite');
    const metaStore = tx.objectStore(CACHE_STORE_META);
    const blobStore = tx.objectStore(CACHE_STORE_BLOBS);
    metaStore.put({
      ...meta,
      bitmapCount: rows.length,
      sizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
    });
    blobStore.delete(IDBKeyRange.bound([meta.key, ''], [meta.key, '\uffff']));
    for (const row of rows) blobStore.put(row);
    await transactionDone(tx);
  };

  try {
    await attempt(blobs);
    return 'stored';
  } catch {
    // Quota exceeded (or a transient failure): clear every other work and retry.
    try {
      await evictLru(db, total, 0, meta.key);
      await attempt(blobs);
      return 'stored';
    } catch {
      await deleteCachedWork(db, meta.key);
      return 'quota';
    }
  }
}
