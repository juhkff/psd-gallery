/**
 * PSD decode worker - the performance core of the viewer.
 *
 * Why this is a worker: ag-psd's decoding is **synchronous** and runs at only
 * ~4-7 megapixels/s, so A4@300dpi (8.7 MP) blocks for 1.3-2.0 s. Nothing here
 * may ever touch the main thread.
 *
 * Shape of a load:
 *   1. fetch the PSD bytes here (the main thread never holds or parses them)
 *   2. identity = url + byte length + cheap FNV hash -> IndexedDB cache lookup
 *   3. cache hit  -> restore per-layer PNG blobs (no PSD parse, 0 decodes)
 *      cache miss -> `readPsd({ useRawData: true })` structure read (0.1-0.3 ms),
 *                    then decode each drawable layer with `getLayerCanvas()`
 *   4. every layer is decoded exactly once and cached as an ImageBitmap at the
 *      render resolution, so a later visibility toggle only re-draws the stack
 *   5. frames travel to the main thread as transferred ImageBitmaps
 *
 * Large documents (> PROXY_PIXEL_THRESHOLD) are rendered at proxy resolution
 * (longest edge PROXY_MAX_EDGE); the full-resolution layer canvas is downscaled
 * with `createImageBitmap(canvas, { resizeWidth, resizeHeight })` immediately
 * after decoding and then dropped, which keeps redraws in the tens of ms range.
 */

import { getLayerCanvas, initializeCanvas, readPsd } from 'ag-psd';
import type { Layer, Psd } from 'ag-psd';
import type { LayerNode } from '../../shared/manifest';
import { formatBytes } from '../lib/format';
import {
  computeProxyPlan,
  drawableLayerIds,
  flattenLayers,
  layerId,
  planComposite,
  resolveVisibility,
  PROXY_MAX_EDGE,
  type FlatLayer,
  type ProxyPlan,
} from './composite';
import * as idb from './idb-cache';
import { LayerBitmapCache } from './layer-cache';
import { buildLayerTree, collectCaveats } from './layer-info';
import {
  PSD_PROTOCOL_VERSION,
  type DecodedFrame,
  type DoneResponse,
  type FrameReason,
  type FrameResponse,
  type InitRequest,
  type LoadRequest,
  type MainToWorkerRequest,
  type ProgressResponse,
  type SetVisibilityRequest,
  type StructureResponse,
  type VisibilityMap,
  type WorkerCapabilities,
  type WorkerErrorCode,
  type WorkerPhase,
  type WorkerResponse,
} from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const DEBUG = import.meta.env.DEV;

/** A compose is attempted at most this often for progressive frames (ms). */
const PROGRESSIVE_FRAME_MS = 140;
/** Fetch progress occupies 0 .. FETCH_WEIGHT of the overall bar. */
const FETCH_WEIGHT = 0.12;
/** Decode/restore occupies DECODE_START .. DECODE_END (compose is the tail). */
const DECODE_START = 0.15;
const DECODE_END = 0.92;
/** Progress post while streaming the response body. */
const FETCH_REPORT_BYTES = 512 * 1024;

function now(): number {
  return performance.now();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------------ *
 * ag-psd canvas factory (OffscreenCanvas in a worker)
 * ------------------------------------------------------------------ */

if (typeof OffscreenCanvas !== 'undefined') {
  initializeCanvas((width, height) => {
    // ag-psd only touches width/height/getContext('2d')/putImageData, all of
    // which OffscreenCanvas implements; the cast bridges the HTMLCanvasElement
    // signature in ag-psd's public typings.
    return new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height))) as unknown as HTMLCanvasElement;
  });
}

/* ------------------------------------------------------------------ *
 * session state
 * ------------------------------------------------------------------ */

interface Session {
  requestId: number;
  url: string;
  identity: string;
  documentWidth: number;
  documentHeight: number;
  plan: ProxyPlan;
  tree: LayerNode[];
  /** id -> raw ag-psd layer, used exactly once per layer to call getLayerCanvas. */
  layerById: Map<string, Layer>;
  flatById: Map<string, FlatLayer>;
  bitmaps: LayerBitmapCache<ImageBitmap>;
  canvas: OffscreenCanvas | null;
  ctx: OffscreenCanvasRenderingContext2D | null;
  visibility: VisibilityMap;
  composeCount: number;
  decodeMs: number;
  failed: string[];
  released: boolean;
}

interface SessionInit {
  requestId: number;
  url: string;
  identity: string;
  documentWidth: number;
  documentHeight: number;
  plan: ProxyPlan;
  tree: LayerNode[];
  layerById: Map<string, Layer>;
}

/** Newest load request; anything older is stale and must be ignored. */
let generation = 0;
let sessionRef: Session | null = null;
/** Serializes message handling so two loads cannot interleave. */
let queue: Promise<void> = Promise.resolve();

function createSession(init: SessionInit): Session {
  const session: Session = {
    requestId: init.requestId,
    url: init.url,
    identity: init.identity,
    documentWidth: init.documentWidth,
    documentHeight: init.documentHeight,
    plan: init.plan,
    tree: init.tree,
    layerById: init.layerById,
    flatById: new Map(flattenLayers(init.tree).map((flat) => [flat.id, flat])),
    bitmaps: new LayerBitmapCache<ImageBitmap>((id) => decodeLayerBitmap(session, id)),
    canvas: null,
    ctx: null,
    visibility: {},
    composeCount: 0,
    decodeMs: 0,
    failed: [],
    released: false,
  };
  return session;
}

function releaseSession(): void {
  const session = sessionRef;
  if (!session) return;
  session.released = true;
  session.bitmaps.clear();
  session.canvas = null;
  session.ctx = null;
  sessionRef = null;
}

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) scope.postMessage(message, transfer);
  else scope.postMessage(message);
}

function postError(requestId: number, code: WorkerErrorCode, message: string): void {
  post({ type: 'error', requestId, code, message });
}

function postProgress(
  requestId: number,
  phase: WorkerPhase,
  progress: number,
  label: string,
  extra: Partial<Omit<ProgressResponse, 'type' | 'requestId' | 'phase' | 'progress' | 'label'>> = {},
): void {
  post({ type: 'progress', requestId, phase, progress: clamp01(progress), label, ...extra });
}

function postStructure(session: Session, requestId: number): void {
  const structure: StructureResponse = {
    type: 'structure',
    requestId,
    documentWidth: session.documentWidth,
    documentHeight: session.documentHeight,
    layers: session.tree,
    layerCount: flattenLayers(session.tree).length,
    drawableCount: drawableLayerIds(session.tree).length,
    plan: session.plan,
    caveats: collectCaveats(session.tree, { useProxy: session.plan.useProxy }),
  };
  post(structure);
}

function postFrame(requestId: number, reason: FrameReason, frame: DecodedFrame): void {
  const message: FrameResponse = { type: 'frame', requestId, reason, ...frame };
  post(message, [frame.bitmap]);
}

function postDone(
  session: Session,
  requestId: number,
  source: DoneResponse['source'],
  frame: DecodedFrame,
  decodeMs: number,
): void {
  const message: DoneResponse = {
    type: 'done',
    requestId,
    source,
    decodeMs,
    failedLayers: session.failed.slice(),
    documentWidth: session.documentWidth,
    documentHeight: session.documentHeight,
    layers: session.tree,
    layerCount: flattenLayers(session.tree).length,
    drawableCount: drawableLayerIds(session.tree).length,
    plan: session.plan,
    caveats: collectCaveats(session.tree, { useProxy: session.plan.useProxy }),
    ...frame,
  };
  post(message, [frame.bitmap]);
}

/* ------------------------------------------------------------------ *
 * decoding + compositing
 * ------------------------------------------------------------------ */

/** Decode exactly one layer (called once per layer id by the bitmap cache). */
async function decodeLayerBitmap(session: Session, id: string): Promise<ImageBitmap> {
  const flat = session.flatById.get(id);
  const layer = session.layerById.get(id);
  if (!flat) throw new Error(`未知图层：${id}`);
  if (!layer) throw new Error(`图层「${flat.name}」没有可解码的像素数据`);

  // Synchronous decode at 4-7 MP/s, on the worker thread only. ag-psd does not
  // cache the result on the layer, which is exactly why LayerBitmapCache exists.
  const canvas = getLayerCanvas(layer);
  if (!canvas) throw new Error(`图层「${flat.name}」没有像素数据`);

  const targetWidth = Math.max(1, Math.round((flat.rect.right - flat.rect.left) * session.plan.scaleX));
  const targetHeight = Math.max(1, Math.round((flat.rect.bottom - flat.rect.top) * session.plan.scaleY));
  const source = canvas as unknown as CanvasImageSource;
  if (session.plan.useProxy) {
    return await createImageBitmap(source, {
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: 'medium',
    });
  }
  return await createImageBitmap(source);
}

function ensureCanvas(session: Session): OffscreenCanvasRenderingContext2D {
  if (!session.canvas || !session.ctx) {
    session.canvas = new OffscreenCanvas(Math.max(1, session.plan.width), Math.max(1, session.plan.height));
    const ctx = session.canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
    session.ctx = ctx;
  }
  return session.ctx;
}

/**
 * Draw the visible stack bottom-to-top using the cached per-layer bitmaps.
 * This is the *only* thing a visibility toggle does - no decoding involved.
 */
async function composeFrame(session: Session): Promise<DecodedFrame> {
  const ctx = ensureCanvas(session);
  const plan = session.plan;
  const started = now();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, plan.width, plan.height);

  for (const layer of planComposite(session.tree, session.visibility, plan)) {
    const bitmap = session.bitmaps.peek(layer.id);
    if (!bitmap) continue;
    ctx.globalAlpha = layer.opacity;
    // Values come from shared/blend.ts, which maps PSD modes to the CSS
    // globalCompositeOperation vocabulary.
    ctx.globalCompositeOperation = layer.composite as GlobalCompositeOperation;
    ctx.drawImage(bitmap, layer.x, layer.y, layer.width, layer.height);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // Snapshot the canvas (0.0-0.4 ms measured) and hand the *bitmap* to the main
  // thread; the canvas stays here for the next compose.
  const bitmap = await createImageBitmap(session.canvas as OffscreenCanvas);
  const composeMs = now() - started;
  session.composeCount += 1;
  return {
    bitmap,
    width: plan.width,
    height: plan.height,
    composeMs,
    decodeCount: session.bitmaps.decodeCount,
    composeCount: session.composeCount,
    visibility: { ...session.visibility },
  };
}

/** Visible layers first (so the first complete frame arrives early), each group bottom-first. */
function orderedDrawableIds(session: Session): { ordered: string[]; visibleCount: number } {
  const all = drawableLayerIds(session.tree);
  const visibility = resolveVisibility(session.tree, session.visibility);
  const visible = all.filter((id) => visibility.get(id) === true);
  const hidden = all.filter((id) => visibility.get(id) !== true);
  return { ordered: [...visible, ...hidden], visibleCount: visible.length };
}

async function decodeAll(session: Session, requestId: number): Promise<void> {
  const { ordered, visibleCount } = orderedDrawableIds(session);
  const total = ordered.length;
  if (total === 0) return;

  let done = 0;
  let lastFrameAt = now();
  for (const id of ordered) {
    if (requestId !== generation) return;
    const flat = session.flatById.get(id);
    if (!session.bitmaps.has(id)) {
      const decodeStarted = now();
      try {
        await session.bitmaps.get(id);
      } catch (error) {
        session.failed.push(flat?.name ?? id);
        if (DEBUG) console.warn('[psd.worker] 图层解码失败', id, describe(error));
      }
      session.decodeMs += now() - decodeStarted;
    }
    done += 1;
    postProgress(
      requestId,
      'decode',
      DECODE_START + (DECODE_END - DECODE_START) * (done / total),
      `正在解码图层 ${done} / ${total}（${flat?.name ?? id}）`,
      { decodedLayers: done, totalLayers: total, ...(flat ? { layerName: flat.name } : {}) },
    );

    const at = now();
    const reachedVisibleBoundary = done === visibleCount;
    if (done < total && (at - lastFrameAt > PROGRESSIVE_FRAME_MS || reachedVisibleBoundary)) {
      lastFrameAt = at;
      const frame = await composeFrame(session);
      if (requestId !== generation) {
        frame.bitmap.close();
        return;
      }
      postFrame(requestId, 'progressive', frame);
    }
  }
  postProgress(requestId, 'compose', DECODE_END, '正在合成画面…');
}

/* ------------------------------------------------------------------ *
 * fetch
 * ------------------------------------------------------------------ */

async function fetchPsd(url: string, requestId: number): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 PSD 失败：HTTP ${response.status} ${response.statusText}`.trim());
  }
  const total = Number(response.headers.get('content-length') ?? '0') || 0;
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    postProgress(requestId, 'fetch', FETCH_WEIGHT, `PSD 下载完成（${formatBytes(buffer.byteLength)}）`, {
      bytesReceived: buffer.byteLength,
      bytesTotal: total || buffer.byteLength,
    });
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    if (requestId !== generation) {
      await reader.cancel().catch(() => undefined);
      throw new Error('加载已取消');
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
    }
    if (received - lastReport >= FETCH_REPORT_BYTES) {
      lastReport = received;
      const fraction = total > 0 ? Math.min(1, received / total) : 0;
      postProgress(
        requestId,
        'fetch',
        FETCH_WEIGHT * fraction,
        total > 0 ? `正在下载 PSD… ${Math.round(fraction * 100)}%` : `正在下载 PSD… ${formatBytes(received)}`,
        { bytesReceived: received, bytesTotal: total },
      );
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  postProgress(requestId, 'fetch', FETCH_WEIGHT, `PSD 下载完成（${formatBytes(received)}）`, {
    bytesReceived: received,
    bytesTotal: total || received,
  });
  return merged.buffer;
}

/* ------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------ */

function indexLayers(
  children: readonly Layer[] | undefined,
  parentId: string | null,
  out: Map<string, Layer>,
): void {
  if (!children) return;
  children.forEach((layer, index) => {
    const id = layerId(parentId, index);
    out.set(id, layer);
    if (layer.children && layer.children.length > 0) indexLayers(layer.children, id, out);
  });
}

/** A cache hit: rebuild the exact same session from stored PNG layer blobs. */
async function loadFromCache(
  entry: idb.CachedWork,
  message: LoadRequest,
  requestId: number,
  db: IDBDatabase,
): Promise<boolean> {
  const { meta, bitmaps } = entry;
  const drawable = drawableLayerIds(meta.layers);
  const byId = new Map(bitmaps.map((row) => [row.id, row]));
  if (drawable.length === 0 || !drawable.every((id) => byId.has(id))) {
    await idb.deleteCachedWork(db, meta.key);
    return false;
  }

  const plan =
    meta.plan && meta.plan.width > 0 ? meta.plan : computeProxyPlan(meta.documentWidth, meta.documentHeight);
  const session = createSession({
    requestId,
    url: message.url,
    identity: meta.key,
    documentWidth: meta.documentWidth,
    documentHeight: meta.documentHeight,
    plan,
    tree: meta.layers,
    layerById: new Map(),
  });
  sessionRef = session;
  postStructure(session, requestId);
  postProgress(requestId, 'decode', DECODE_START, '正在从本地缓存恢复图层…', {
    decodedLayers: 0,
    totalLayers: drawable.length,
  });

  let restored = 0;
  let failedRestore = 0;
  let lastFrameAt = now();
  for (const id of drawable) {
    if (requestId !== generation) {
      releaseSession();
      return true;
    }
    const row = byId.get(id);
    if (row) {
      try {
        session.bitmaps.set(id, await createImageBitmap(row.blob));
      } catch {
        failedRestore += 1;
      }
    }
    restored += 1;
    postProgress(
      requestId,
      'decode',
      DECODE_START + (DECODE_END - DECODE_START) * (restored / drawable.length),
      `正在从缓存恢复图层 ${restored} / ${drawable.length}`,
      { decodedLayers: restored, totalLayers: drawable.length },
    );
    const at = now();
    if (restored < drawable.length && at - lastFrameAt > PROGRESSIVE_FRAME_MS) {
      lastFrameAt = at;
      const frame = await composeFrame(session);
      if (requestId !== generation) {
        frame.bitmap.close();
        return true;
      }
      postFrame(requestId, 'progressive', frame);
    }
  }

  if (failedRestore > 0) {
    // Corrupt/partial cache: drop it and take the honest network path.
    releaseSession();
    await idb.deleteCachedWork(db, meta.key);
    return false;
  }
  if (requestId !== generation) return true;

  const frame = await composeFrame(session);
  postDone(session, requestId, 'cache', frame, 0);
  if (DEBUG) {
    console.debug('[psd.worker] cache hit', {
      identity: session.identity,
      layers: drawable.length,
      decodeCount: session.bitmaps.decodeCount,
      composeMs: frame.composeMs,
    });
  }
  return true;
}

async function loadFromBuffer(
  buffer: ArrayBuffer,
  identity: string,
  message: LoadRequest,
  requestId: number,
): Promise<void> {
  let psd: Psd;
  try {
    // Structure-only read: no bitmaps decoded yet (0.1-0.3 ms measured).
    psd = readPsd(buffer, {
      useRawData: true,
      useRawThumbnail: true,
      skipLinkedFilesData: true,
    });
  } catch (error) {
    if (requestId === generation) postError(requestId, 'read', `PSD 解析失败：${describe(error)}`);
    return;
  }
  if (requestId !== generation) return;

  const tree = buildLayerTree(psd.children, psd.width, psd.height);
  const layerById = new Map<string, Layer>();
  indexLayers(psd.children, null, layerById);
  const plan = computeProxyPlan(psd.width, psd.height, {
    ...(message.proxyThresholdPx !== undefined ? { thresholdPx: message.proxyThresholdPx } : {}),
    ...(message.forceProxy !== undefined ? { force: message.forceProxy } : {}),
  });

  const session = createSession({
    requestId,
    url: message.url,
    identity,
    documentWidth: psd.width,
    documentHeight: psd.height,
    plan,
    tree,
    layerById,
  });
  sessionRef = session;

  postStructure(session, requestId);
  if (plan.useProxy && DEBUG) {
    console.debug('[psd.worker] proxy plan', plan, { maxEdge: PROXY_MAX_EDGE });
  }

  await decodeAll(session, requestId);
  if (requestId !== generation) return;

  const frame = await composeFrame(session);
  postDone(session, requestId, 'network', frame, session.decodeMs);

  // Cache write is detached: it must never delay a visibility toggle.
  void persistSession(session, buffer.byteLength);
}

/* ------------------------------------------------------------------ *
 * cache persistence
 * ------------------------------------------------------------------ */

async function bitmapToPng(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(Math.max(1, bitmap.width), Math.max(1, bitmap.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
  ctx.drawImage(bitmap, 0, 0);
  return await canvas.convertToBlob({ type: 'image/png' });
}

interface StorageLike {
  storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
}

async function estimateStorage(): Promise<{ quota?: number; usage?: number } | null> {
  const navigatorLike = (scope as unknown as { navigator?: StorageLike }).navigator;
  try {
    return navigatorLike?.storage?.estimate ? await navigatorLike.storage.estimate() : null;
  } catch {
    return null;
  }
}

/**
 * Persist the decoded layer bitmaps so the next visit is instant. Bounded by the
 * cache budget and a per-work share; every failure is swallowed (best effort).
 */
async function persistSession(session: Session, bytes: number): Promise<void> {
  try {
    const db = await idb.openCache();
    if (!db || session.released || session.requestId !== generation) return;
    const budget = idb.cacheBudgetBytes(await estimateStorage());
    const perWorkBudget = Math.floor(budget / 4);
    const rows: idb.CachedBlob[] = [];
    let totalBytes = 0;

    for (const id of session.bitmaps.readyIds()) {
      if (session.released || session.requestId !== generation) return;
      if (totalBytes >= perWorkBudget) break;
      const bitmap = session.bitmaps.peek(id);
      if (!bitmap) continue;
      try {
        const blob = await bitmapToPng(bitmap);
        if (blob.size > idb.CACHE_MAX_BLOB_BYTES) continue;
        rows.push({ key: session.identity, id, sizeBytes: blob.size, blob });
        totalBytes += blob.size;
      } catch {
        /* skip this layer */
      }
    }
    if (rows.length === 0) return;

    await idb.writeCachedWork(
      db,
      {
        meta: {
          key: session.identity,
          url: session.url,
          bytes,
          documentWidth: session.documentWidth,
          documentHeight: session.documentHeight,
          plan: session.plan,
          layers: session.tree,
          layerCount: flattenLayers(session.tree).length,
        },
        bitmaps: rows,
      },
      budget,
    );
  } catch {
    /* cache is best effort */
  }
}

/* ------------------------------------------------------------------ *
 * message handling
 * ------------------------------------------------------------------ */

function handleInit(message: InitRequest): void {
  const capabilities: WorkerCapabilities = {
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    createImageBitmap: typeof createImageBitmap === 'function',
    indexedDb: idb.isIndexedDbAvailable(),
    storageEstimate: typeof (scope as unknown as { navigator?: StorageLike }).navigator?.storage?.estimate === 'function',
  };
  if (message.protocolVersion !== PSD_PROTOCOL_VERSION) {
    postError(0, 'protocol', `协议版本不匹配：页面 ${message.protocolVersion}，worker ${PSD_PROTOCOL_VERSION}。请刷新页面。`);
  }
  post({ type: 'ready', requestId: 0, protocolVersion: PSD_PROTOCOL_VERSION, capabilities });
}

async function handleLoad(message: LoadRequest): Promise<void> {
  const requestId = message.requestId;
  if (requestId < generation) {
    postError(requestId, 'stale', '已忽略过期的加载请求。');
    return;
  }
  generation = requestId;
  releaseSession();

  postProgress(requestId, 'fetch', 0, '正在下载 PSD…');
  let buffer: ArrayBuffer;
  try {
    buffer = await fetchPsd(message.url, requestId);
  } catch (error) {
    if (requestId === generation) postError(requestId, 'fetch', `无法获取 PSD：${describe(error)}`);
    return;
  }
  if (requestId !== generation) return;

  const identity = idb.fileIdentity(message.url, buffer.byteLength, idb.hashBytes(buffer));

  if (message.cache !== false) {
    postProgress(requestId, 'structure', FETCH_WEIGHT, '正在读取图层结构…');
    const db = await idb.openCache();
    if (db) {
      const entry = await idb.readCachedWork(db, identity);
      if (requestId !== generation) return;
      if (entry) {
        const served = await loadFromCache(entry, message, requestId, db);
        if (served) return;
        if (requestId !== generation) return;
      }
    }
  }
  await loadFromBuffer(buffer, identity, message, requestId);
}

async function handleSetVisibility(message: SetVisibilityRequest): Promise<void> {
  const session = sessionRef;
  if (!session) {
    postError(message.requestId, 'stale', '尚未加载作品，忽略图层可见性更新。');
    return;
  }
  if (message.requestId !== session.requestId || message.requestId !== generation) {
    postError(message.requestId, 'stale', '已忽略过期的图层可见性更新。');
    return;
  }
  session.visibility = message.replace
    ? { ...message.visibility }
    : { ...session.visibility, ...message.visibility };

  // Every layer is decoded up-front, so this list is normally empty; it only
  // fills in after a decode failure, and then it decodes just that layer.
  const planned = planComposite(session.tree, session.visibility, session.plan);
  const missing = planned
    .filter((layer) => !session.bitmaps.has(layer.id) && session.layerById.has(layer.id))
    .map((layer) => layer.id);
  for (const id of missing) {
    if (message.requestId !== generation) return;
    try {
      await session.bitmaps.get(id);
    } catch {
      session.failed.push(session.flatById.get(id)?.name ?? id);
    }
  }
  if (message.requestId !== generation) return;

  const frame = await composeFrame(session);
  if (message.requestId !== generation) {
    frame.bitmap.close();
    return;
  }
  postFrame(message.requestId, 'visibility', frame);
  if (DEBUG) {
    console.debug('[psd.worker] visibility redraw', {
      layersDrawn: planned.length,
      decodeCount: frame.decodeCount,
      composeMs: frame.composeMs,
    });
  }
}

const MAIN_TYPES = new Set(['init', 'load', 'setVisibility', 'cancel', 'dispose']);

function isMainToWorker(value: unknown): value is MainToWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && MAIN_TYPES.has(type);
}

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isMainToWorker(message)) {
    postError(0, 'protocol', '收到未知的 worker 消息。');
    return;
  }
  // Cancellation and teardown must not queue behind a long decode.
  if (message.type === 'cancel') {
    if (message.requestId >= generation) generation = message.requestId + 1;
    return;
  }
  if (message.type === 'dispose') {
    generation += 1;
    releaseSession();
    post({ type: 'disposed', requestId: message.requestId });
    return;
  }
  queue = queue
    .then(async () => {
      switch (message.type) {
        case 'init':
          handleInit(message);
          break;
        case 'load':
          await handleLoad(message);
          break;
        case 'setVisibility':
          await handleSetVisibility(message);
          break;
        default:
          break;
      }
    })
    .catch((error: unknown) => {
      const requestId = 'requestId' in message ? message.requestId : 0;
      postError(requestId, 'read', `worker 处理失败：${describe(error)}`);
    });
});
