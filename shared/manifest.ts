/**
 * Manifest contract between the build-time generator (`scripts/build-manifest.ts`)
 * and the browser viewer (`src/**`).
 *
 * FROZEN: treat as an interface. Bump MANIFEST_VERSION on any breaking change.
 */

export const MANIFEST_VERSION = 1 as const;

/** A rectangle in document pixel space (already scaled to the work's own size). */
export interface LayerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One entry of the Photoshop layer panel (nested groups included). */
export interface LayerNode {
  name: string;
  /** Photoshop layer kind, when the PSD declares one. */
  kind?: string;
  /** PSD `hidden` flag: false means visible. */
  hidden: boolean;
  /** 0..1 */
  opacity: number;
  /** PSD blend mode key, e.g. "normal", "multiply", "screen". */
  blendMode: string;
  /** Position and size of this layer's bitmap inside the document. */
  rect: LayerRect;
  /** True when this layer carries pixel data that can be decoded and drawn. */
  hasImage: boolean;
  /** True for group/folder layers. */
  isGroup: boolean;
  /** Non-pixel layers (text, shape, adjustment, smart object) get a hint. */
  note?: string;
  children?: LayerNode[];
}

/** Build-time generated previews, served as plain static files. */
export interface PreviewAssets {
  /** ~480px longest edge, for the gallery grid. */
  thumb: string;
  /** ~1600px longest edge, for the instant viewer preview. */
  display: string;
  thumbWidth: number;
  thumbHeight: number;
  displayWidth: number;
  displayHeight: number;
}

export interface WorkEntry {
  /** Numeric file stem, e.g. 1 for "1.psd". Used for sorting. */
  index: number;
  /** File name without extension, e.g. "1". */
  name: string;
  /** Absolute-from-site-root URL of the source PSD (for download). */
  psd: string;
  /** Byte size of the source PSD. */
  bytes: number;
  /** Document size in pixels. */
  width: number;
  height: number;
  preview: PreviewAssets;
  /** Total layer count, including nested ones. */
  layerCount: number;
  /** Depth-first layer tree, top-most Photoshop layer first. */
  layers: LayerNode[];
}

export interface DateGroup {
  /** "YYYY-MM-DD", also the folder name. */
  date: string;
  works: WorkEntry[];
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  /** ISO timestamp of generation. */
  generatedAt: string;
  /** Site-relative prefix the manifest paths are written against ("" or "/repo/"). */
  base: string;
  totals: { works: number; bytes: number };
  groups: DateGroup[];
}

/** Server-side (deploy) endpoint that lets the site discover newly added PSDs. */
export interface IndexEntry {
  name: string;
  bytes: number;
  category: 'psd' | 'ai' | 'image' | 'other';
}

export interface IndexResponse {
  /** "YYYY-MM-DD" folder -> files inside it. */
  dates: Record<string, IndexEntry[]>;
  generatedAt: string;
}
