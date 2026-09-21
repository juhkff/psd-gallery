/**
 * React binding for `psd.worker.ts`.
 *
 * Design constraints this hook exists to satisfy:
 *  - the main thread never decodes anything (all work happens in the worker)
 *  - the first paint is the build-time `display.webp` preview; the live canvas
 *    only replaces it once the worker has a composited frame
 *  - `toggleLayer()` sends a visibility map and gets a re-composited bitmap back
 *    from the per-layer cache - it never triggers another PSD decode
 *
 * One worker is shared for the whole page (module-level hub), created lazily on
 * first use and never terminated, so switching works stays cheap and no
 * React StrictMode double-effect can kill it mid-flight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayerNode, WorkEntry } from '../../shared/manifest';
import { findFlatLayer, resolveVisibility } from './composite';
import {
  PSD_PROTOCOL_VERSION,
  isWorkerResponse,
  type MainToWorkerRequest,
  type ReadyResponse,
  type VisibilityMap,
  type WorkerCapabilities,
  type WorkerResponse,
} from './protocol';

export type PsdStatus = 'idle' | 'loading' | 'decoding' | 'ready' | 'error';

export interface PsdFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Monotonic id so the canvas can skip redundant draws. */
  seq: number;
}

export interface PsdWorkState {
  status: PsdStatus;
  /** Overall progress 0..1 (fetch + structure + decode + compose). */
  progress: number;
  /** Short Chinese status line. */
  progressLabel: string;
  /** Layer tree: the PSD's own tree once `structure` arrived, else the manifest's. */
  layers: LayerNode[];
  layerCount: number;
  /** True once the worker reported the authoritative tree (toggles are safe). */
  layersReady: boolean;
  /** Layer id -> explicit user override (missing = PSD default). */
  visibility: VisibilityMap;
  /** Effective visibility after group propagation (for the eye buttons). */
  effectiveVisibility: Map<string, boolean>;
  /** Latest composited frame, or null before the first one. */
  frame: PsdFrame | null;
  useProxy: boolean;
  scaleX: number;
  scaleY: number;
  documentWidth: number;
  documentHeight: number;
  frameWidth: number;
  frameHeight: number;
  /** getLayerCanvas() calls performed for this work (0 on a cache hit). */
  decodeCount: number;
  composeCount: number;
  composeMs: number;
  source: 'network' | 'cache' | 'memory' | null;
  caveats: string[];
  failedLayers: string[];
  error: string | null;
  /** False when the runtime has no Worker support at all. */
  workerAvailable: boolean;
  capabilities: WorkerCapabilities | null;
  toggleLayer: (id: string, next?: boolean) => void;
  setAllVisible: (visible: boolean) => void;
  reset: () => void;
  retry: () => void;
}

interface InternalState {
  status: PsdStatus;
  progress: number;
  progressLabel: string;
  layers: LayerNode[];
  layerCount: number;
  layersReady: boolean;
  visibility: VisibilityMap;
  frame: PsdFrame | null;
  useProxy: boolean;
  scaleX: number;
  scaleY: number;
  documentWidth: number;
  documentHeight: number;
  frameWidth: number;
  frameHeight: number;
  decodeCount: number;
  composeCount: number;
  composeMs: number;
  source: 'network' | 'cache' | 'memory' | null;
  caveats: string[];
  failedLayers: string[];
  error: string | null;
  workerAvailable: boolean;
  capabilities: WorkerCapabilities | null;
  requestId: number;
}

const INITIAL_STATE: InternalState = {
  status: 'idle',
  progress: 0,
  progressLabel: '',
  layers: [],
  layerCount: 0,
  layersReady: false,
  visibility: {},
  frame: null,
  useProxy: false,
  scaleX: 1,
  scaleY: 1,
  documentWidth: 0,
  documentHeight: 0,
  frameWidth: 0,
  frameHeight: 0,
  decodeCount: 0,
  composeCount: 0,
  composeMs: 0,
  source: null,
  caveats: [],
  failedLayers: [],
  error: null,
  workerAvailable: true,
  capabilities: null,
  requestId: 0,
};

type WorkerListener = (message: WorkerResponse) => void;

interface WorkerHub {
  worker: Worker;
  listeners: Set<WorkerListener>;
  /** The `ready` handshake may land before the first listener subscribes. */
  lastReady: ReadyResponse | null;
  globalError: string | null;
}

let hub: WorkerHub | null = null;
let workerUnavailable = false;
let requestCounter = 0;

function post(activeHub: WorkerHub, message: MainToWorkerRequest): void {
  activeHub.worker.postMessage(message);
}

function getHub(): WorkerHub | null {
  if (hub) return hub;
  if (workerUnavailable) return null;
  if (typeof Worker === 'undefined') {
    workerUnavailable = true;
    return null;
  }
  try {
    // Static URL so Vite bundles the worker as its own chunk (worker.format=es).
    const worker = new Worker(new URL('./psd.worker.ts', import.meta.url), { type: 'module' });
    const created: WorkerHub = { worker, listeners: new Set(), lastReady: null, globalError: null };
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!isWorkerResponse(data)) return;
      if (data.type === 'ready') created.lastReady = data;
      for (const listener of [...created.listeners]) listener(data);
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      created.globalError = event.message || '解码 worker 崩溃';
      for (const listener of [...created.listeners]) {
        listener({
          type: 'error',
          requestId: 0,
          code: 'unsupported',
          message: `解码 worker 崩溃：${created.globalError}`,
        });
      }
    });
    worker.postMessage({ type: 'init', protocolVersion: PSD_PROTOCOL_VERSION } satisfies MainToWorkerRequest);
    hub = created;
    return hub;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

function defaultVisible(layers: readonly LayerNode[], id: string): boolean {
  const flat = findFlatLayer(layers, id);
  return flat ? !flat.hidden : true;
}

/**
 * Loads `work` into the shared worker and exposes the resulting viewer state.
 *
 * `forceProxy` is a debug affordance (`#/date/name?proxy=1`): it forces the
 * reduced-resolution path so it can be exercised on small sample PSDs.
 */
export function usePsdWork(work: WorkEntry | null, forceProxy = false): PsdWorkState {
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const stateRef = useRef<InternalState>(INITIAL_STATE);
  const frameRef = useRef<PsdFrame | null>(null);
  const requestRef = useRef(0);

  const commit = useCallback((updater: (prev: InternalState) => InternalState) => {
    setState((prev) => {
      const next = updater(prev);
      stateRef.current = next;
      return next;
    });
  }, []);

  const applyFrame = useCallback(
    (bitmap: ImageBitmap, width: number, height: number) => {
      const previous = frameRef.current;
      const next: PsdFrame = { bitmap, width, height, seq: (previous?.seq ?? 0) + 1 };
      frameRef.current = next;
      if (previous) previous.bitmap.close();
      commit((prev) => ({ ...prev, frame: next }));
    },
    [commit],
  );

  const handleMessage = useCallback(
    (message: WorkerResponse) => {
      const current = stateRef.current;
      if (message.type === 'ready') {
        if (message.protocolVersion !== PSD_PROTOCOL_VERSION) {
          commit((prev) => ({
            ...prev,
            status: 'error',
            error: `解码 worker 协议版本不匹配（页面 ${PSD_PROTOCOL_VERSION}，worker ${message.protocolVersion}），请刷新页面。`,
          }));
          return;
        }
        commit((prev) => ({ ...prev, capabilities: message.capabilities, workerAvailable: true }));
        return;
      }
      if (message.type === 'disposed') return;
      if (message.type === 'error') {
        if (message.code === 'stale') return;
        if (message.requestId !== 0 && message.requestId !== current.requestId) return;
        commit((prev) => ({ ...prev, status: 'error', error: message.message }));
        return;
      }
      if (message.requestId !== current.requestId || message.requestId !== requestRef.current) return;

      switch (message.type) {
        case 'progress':
          commit((prev) => ({
            ...prev,
            status: message.phase === 'fetch' ? 'loading' : 'decoding',
            progress: message.progress,
            progressLabel: message.label,
          }));
          break;
        case 'structure': {
          const previous = frameRef.current;
          if (previous) {
            previous.bitmap.close();
            frameRef.current = null;
          }
          commit((prev) => ({
            ...prev,
            status: 'decoding',
            layers: message.layers,
            layerCount: message.layerCount,
            layersReady: true,
            visibility: {},
            frame: null,
            useProxy: message.plan.useProxy,
            scaleX: message.plan.scaleX,
            scaleY: message.plan.scaleY,
            documentWidth: message.documentWidth,
            documentHeight: message.documentHeight,
            caveats: message.caveats,
            error: null,
          }));
          break;
        }
        case 'frame':
          applyFrame(message.bitmap, message.width, message.height);
          commit((prev) => ({
            ...prev,
            status: prev.status === 'ready' ? 'ready' : 'decoding',
            composeMs: message.composeMs,
            composeCount: message.composeCount,
            decodeCount: message.decodeCount,
          }));
          break;
        case 'done':
          applyFrame(message.bitmap, message.width, message.height);
          commit((prev) => ({
            ...prev,
            status: 'ready',
            progress: 1,
            progressLabel: '已完成',
            layers: message.layers,
            layerCount: message.layerCount,
            layersReady: true,
            useProxy: message.plan.useProxy,
            scaleX: message.plan.scaleX,
            scaleY: message.plan.scaleY,
            documentWidth: message.documentWidth,
            documentHeight: message.documentHeight,
            frameWidth: message.width,
            frameHeight: message.height,
            decodeCount: message.decodeCount,
            composeCount: message.composeCount,
            composeMs: message.composeMs,
            source: message.source,
            caveats: message.caveats,
            failedLayers: message.failedLayers,
            error: null,
          }));
          break;
        default:
          break;
      }
    },
    [applyFrame, commit],
  );

  const handleRef = useRef(handleMessage);
  handleRef.current = handleMessage;

  useEffect(() => {
    const activeHub = getHub();
    if (!activeHub) {
      commit((prev) => ({
        ...prev,
        workerAvailable: false,
        error: '当前浏览器不支持 Web Worker，无法在线解码 PSD；仍可查看预览图并下载源文件。',
      }));
      return;
    }
    const listener: WorkerListener = (message) => handleRef.current(message);
    activeHub.listeners.add(listener);
    if (activeHub.lastReady) listener(activeHub.lastReady);
    if (activeHub.globalError) {
      listener({ type: 'error', requestId: 0, code: 'unsupported', message: activeHub.globalError });
    }
    return () => {
      activeHub.listeners.delete(listener);
    };
  }, [commit]);

  // Close the last frame when the viewer goes away.
  useEffect(
    () => () => {
      const previous = frameRef.current;
      if (previous) previous.bitmap.close();
      frameRef.current = null;
    },
    [],
  );

  const load = useCallback(
    (target: WorkEntry) => {
      const activeHub = getHub();
      const requestId = (requestCounter += 1);
      requestRef.current = requestId;
      const previous = frameRef.current;
      if (previous) {
        previous.bitmap.close();
        frameRef.current = null;
      }
      stateRef.current = {
        ...INITIAL_STATE,
        status: 'loading',
        progress: 0,
        progressLabel: '正在准备…',
        layers: target.layers,
        layerCount: target.layerCount,
        documentWidth: target.width,
        documentHeight: target.height,
        workerAvailable: activeHub !== null,
        requestId,
      };
      setState(stateRef.current);
      if (!activeHub) return;
      post(activeHub, {
        type: 'load',
        requestId,
        url: target.psd,
        bytes: target.bytes,
        ...(forceProxy ? { forceProxy: true, cache: false } : {}),
      });
    },
    [forceProxy],
  );

  useEffect(() => {
    if (!work) {
      requestRef.current = 0;
      requestCounter += 1;
      const previous = frameRef.current;
      if (previous) {
        previous.bitmap.close();
        frameRef.current = null;
      }
      stateRef.current = INITIAL_STATE;
      setState(INITIAL_STATE);
      return;
    }
    load(work);
    return () => {
      const activeHub = getHub();
      if (activeHub && requestRef.current > 0) {
        post(activeHub, { type: 'cancel', requestId: requestRef.current });
      }
    };
    // `work` is a stable object from the parsed manifest.
  }, [work, load]);

  const visibility = state.visibility;
  const layers = state.layers;

  const effectiveVisibility = useMemo(
    () => resolveVisibility(layers, visibility),
    [layers, visibility],
  );

  const toggleLayer = useCallback(
    (id: string, next?: boolean) => {
      const current = stateRef.current;
      if (!current.layersReady || !current.requestId) return;
      const base = current.visibility[id] ?? defaultVisible(current.layers, id);
      const value = next ?? !base;
      const nextVisibility: VisibilityMap = { ...current.visibility, [id]: value };
      commit((prev) => ({ ...prev, visibility: nextVisibility }));
      const activeHub = getHub();
      if (activeHub) {
        post(activeHub, { type: 'setVisibility', requestId: current.requestId, visibility: nextVisibility });
      }
    },
    [commit],
  );

  const setAllVisible = useCallback(
    (visible: boolean) => {
      const current = stateRef.current;
      if (!current.layersReady || !current.requestId) return;
      const nextVisibility: VisibilityMap = {};
      for (const flat of collectIds(current.layers)) nextVisibility[flat] = visible;
      commit((prev) => ({ ...prev, visibility: nextVisibility }));
      const activeHub = getHub();
      if (activeHub) {
        post(activeHub, {
          type: 'setVisibility',
          requestId: current.requestId,
          visibility: nextVisibility,
          replace: true,
        });
      }
    },
    [commit],
  );

  const reset = useCallback(() => {
    const current = stateRef.current;
    if (!current.requestId) return;
    commit((prev) => ({ ...prev, visibility: {} }));
    const activeHub = getHub();
    if (activeHub) {
      post(activeHub, { type: 'setVisibility', requestId: current.requestId, visibility: {}, replace: true });
    }
  }, [commit]);

  const retry = useCallback(() => {
    if (work) load(work);
  }, [work, load]);

  return {
    status: state.status,
    progress: state.progress,
    progressLabel: state.progressLabel,
    layers: state.layers,
    layerCount: state.layerCount,
    layersReady: state.layersReady,
    visibility,
    effectiveVisibility,
    frame: state.frame,
    useProxy: state.useProxy,
    scaleX: state.scaleX,
    scaleY: state.scaleY,
    documentWidth: state.documentWidth,
    documentHeight: state.documentHeight,
    frameWidth: state.frameWidth,
    frameHeight: state.frameHeight,
    decodeCount: state.decodeCount,
    composeCount: state.composeCount,
    composeMs: state.composeMs,
    source: state.source,
    caveats: state.caveats,
    failedLayers: state.failedLayers,
    error: state.error,
    workerAvailable: state.workerAvailable,
    capabilities: state.capabilities,
    toggleLayer,
    setAllVisible,
    reset,
    retry,
  };
}

/** All layer ids in the tree, top-most first (matches the worker's ids). */
function collectIds(layers: readonly LayerNode[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly LayerNode[], parentId: string | null): void => {
    nodes.forEach((node, index) => {
      const id = parentId === null ? String(index) : `${parentId}.${index}`;
      ids.push(id);
      if (node.children && node.children.length > 0) walk(node.children, id);
    });
  };
  walk(layers, null);
  return ids;
}
