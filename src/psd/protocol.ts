/**
 * Typed message contract between the main thread and `psd.worker.ts`.
 *
 * Versioned: bump {@link PSD_PROTOCOL_VERSION} on any breaking change and let
 * the worker/hook refuse to talk to a mismatched peer (a stale service-worker
 * or cached worker chunk is otherwise a very confusing bug).
 */

import type { LayerNode } from '../../shared/manifest';
import type { ProxyPlan } from './composite';

export const PSD_PROTOCOL_VERSION = 1;

/** Resolution plan chosen for a document (see `composite.ts#computeProxyPlan`). */
export type { ProxyPlan };

/** `layerId -> visible?` overrides. Ids are dotted index paths ("0", "0.2"). */
export type VisibilityMap = Record<string, boolean>;

/* ------------------------------------------------------------------ *
 * main thread -> worker
 * ------------------------------------------------------------------ */

export interface InitRequest {
  type: 'init';
  protocolVersion: number;
}

export interface LoadRequest {
  type: 'load';
  /** Generation counter; responses carry it back so stale loads can be ignored. */
  requestId: number;
  /** Site-absolute URL of the source PSD (from the manifest). */
  url: string;
  /** Manifest byte size, mixed into the cache identity when known. */
  bytes?: number;
  /** Force the proxy path even for small documents (dev / e2e). */
  forceProxy?: boolean;
  /** Override the proxy trigger threshold in pixels. */
  proxyThresholdPx?: number;
  /** Set false to bypass the IndexedDB cache entirely. */
  cache?: boolean;
}

export interface SetVisibilityRequest {
  type: 'setVisibility';
  requestId: number;
  visibility: VisibilityMap;
  /** Replace the whole map instead of merging into it. */
  replace?: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

export interface DisposeRequest {
  type: 'dispose';
  requestId: number;
}

export type MainToWorkerRequest =
  | InitRequest
  | LoadRequest
  | SetVisibilityRequest
  | CancelRequest
  | DisposeRequest;

/* ------------------------------------------------------------------ *
 * worker -> main thread
 * ------------------------------------------------------------------ */

export interface WorkerCapabilities {
  offscreenCanvas: boolean;
  createImageBitmap: boolean;
  indexedDb: boolean;
  storageEstimate: boolean;
}

export interface ReadyResponse {
  type: 'ready';
  requestId: 0;
  protocolVersion: number;
  capabilities: WorkerCapabilities;
}

export type WorkerPhase = 'fetch' | 'structure' | 'decode' | 'compose';

export interface ProgressResponse {
  type: 'progress';
  requestId: number;
  phase: WorkerPhase;
  /** Overall 0..1 progress including fetch + structure + decode + compose. */
  progress: number;
  /** Short Chinese status line for the UI. */
  label: string;
  decodedLayers?: number;
  totalLayers?: number;
  layerName?: string;
  bytesReceived?: number;
  bytesTotal?: number;
}

export interface DecodedFrame {
  /** Composited RGBA bitmap, already transferred to the main thread. */
  bitmap: ImageBitmap;
  /** Proxy/composite size in pixels. */
  width: number;
  height: number;
  /** Compose wall time for this frame (ms). */
  composeMs: number;
  /** Total `getLayerCanvas()` decodes performed for this work (proof for toggles). */
  decodeCount: number;
  /** Total composites performed for this work. */
  composeCount: number;
  /** Visibility map this frame was composed with. */
  visibility: VisibilityMap;
}

export interface StructureResponse {
  type: 'structure';
  requestId: number;
  documentWidth: number;
  documentHeight: number;
  /** Authoritative layer tree read from the PSD (top-most layer first). */
  layers: LayerNode[];
  /** Total layer count including nested groups. */
  layerCount: number;
  /** Count of layers that carry decodable pixels. */
  drawableCount: number;
  plan: ProxyPlan;
  /** Chinese caveats about what the browser cannot reproduce. */
  caveats: string[];
}

export type FrameReason = 'progressive' | 'visibility' | 'background';

export interface FrameResponse extends DecodedFrame {
  type: 'frame';
  requestId: number;
  reason: FrameReason;
}

export interface DoneResponse extends Omit<StructureResponse, 'type'>, DecodedFrame {
  type: 'done';
  /** Where the pixels came from. */
  source: 'network' | 'cache' | 'memory';
  /** Milliseconds spent decoding layer pixels. */
  decodeMs: number;
  /** Layers that failed to decode. */
  failedLayers: string[];
}

export type WorkerErrorCode = 'unsupported' | 'protocol' | 'fetch' | 'read' | 'decode' | 'compose' | 'stale';

export interface ErrorResponse {
  type: 'error';
  requestId: number;
  code: WorkerErrorCode;
  message: string;
}

export interface DisposedResponse {
  type: 'disposed';
  requestId: number;
}

export type WorkerResponse =
  | ReadyResponse
  | ProgressResponse
  | StructureResponse
  | FrameResponse
  | DoneResponse
  | ErrorResponse
  | DisposedResponse;

/** Narrow an untrusted `message` event payload. */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'ready' ||
    type === 'progress' ||
    type === 'structure' ||
    type === 'frame' ||
    type === 'done' ||
    type === 'error' ||
    type === 'disposed'
  );
}
