/**
 * Helpers for writing sample PSDs with a *correct* flattened composite.
 *
 * WHY THIS EXISTS
 * ---------------
 * ag-psd's writer and reader agree with each other about layer data (verified:
 * a half-transparent layer written by ag-psd reads back as rgba(0,0,0,0) exactly
 * where it is transparent), but for a layered document `writePsdBuffer()` emits
 * an all-BLACK composite section. psd-tools, by contrast, writes a correct
 * composite but its RGBA layers decode as fully OPAQUE through ag-psd - so the
 * viewer's per-layer compositing comes out dark.
 *
 * Neither library alone produces a sample that is correct on both counts, and
 * the manifest builder renders gallery previews from the composite while the
 * viewer composites the layers. So: write the layers with ag-psd, then splice in
 * a composite image-data section built from our own canvas so both paths are
 * correct.
 *
 * The PSD color-mode image-data section is the last section of the file:
 *
 *   2 bytes  compression (0 = raw, 1 = RLE, 2 = ZIP, 3 = ZIP w/ prediction)
 *   then     the composite data, compressed according to that value.
 *
 * For 8-bit RGB raw that is 3 planes of width*height bytes, in R,G,B order.
 */
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, getLayerCanvas, getCompositeCanvas, writePsdBuffer } from 'ag-psd';

export interface SampleLayer {
  name: string;
  canvas: Canvas;
  opacity?: number;
  blendMode?: string;
  hidden?: boolean;
}

/** Offset of the color-mode image-data section: after header (26) + color mode + image resources + layer/mask info. */
export function compositeOffset(buffer: Buffer): number {
  let offset = 26; // file header
  offset += 4 + buffer.readUInt32BE(offset); // color mode data section
  offset += 4 + buffer.readUInt32BE(offset); // image resources section
  offset += 4 + buffer.readUInt32BE(offset); // layer and mask information section
  return offset;
}

/** Build the last section: compression marker (0 = raw) followed by R,G,B planes. */
export function buildRawCompositeSection(width: number, height: number, rgb: Buffer): Buffer {
  const plane = width * height;
  const header = Buffer.alloc(2);
  header.writeUInt16BE(0, 0); // 0 = raw
  if (rgb.length !== plane * 3) {
    throw new Error(`composite needs ${plane * 3} bytes, got ${rgb.length}`);
  }
  return Buffer.concat([header, rgb]);
}

/** Render a document the way the viewer does: bottom-most layer first, honouring visibility. */
export function renderComposite(width: number, height: number, layers: SampleLayer[]): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // `layers` arrives top-most first (Photoshop panel order) -> paint backwards.
  for (const layer of [...layers].reverse()) {
    if (layer.hidden) continue;
    ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.blendMode) ctx.globalCompositeOperation = layer.blendMode as GlobalCompositeOperation;
    ctx.drawImage(layer.canvas, 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const data = ctx.getImageData(0, 0, width, height).data;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    // Composite onto white: PSD's flattened image is opaque.
    const a = data[i + 3] / 255;
    rgb[j] = Math.round(data[i] * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
  }
  return rgb;
}

export interface WriteResult {
  bytes: Buffer;
  composite: { avg: number; max: number };
  layersRead: string[];
}

/**
 * Write one sample PSD: ag-psd for the layer stack, our canvas for the composite.
 * Verifies the result by reading it back through both code paths.
 */
export function writeSamplePsd(
  width: number,
  height: number,
  layers: SampleLayer[],
): WriteResult {
  initializeCanvas((w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement);

  const raw = writePsdBuffer({
    width,
    height,
    children: layers.map((layer) => ({
      name: layer.name,
      top: 0,
      left: 0,
      bottom: height,
      right: width,
      canvas: layer.canvas as unknown as HTMLCanvasElement,
      ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
      ...(layer.blendMode ? { blendMode: layer.blendMode as never } : {}),
      ...(layer.hidden ? { hidden: true } : {}),
    })),
  });

  const rgb = renderComposite(width, height, layers);
  const patched = Buffer.concat([
    Buffer.from(raw.subarray(0, compositeOffset(Buffer.from(raw)))),
    buildRawCompositeSection(width, height, rgb),
  ]);

  // --- verify both paths on the bytes we are about to commit ---
  // Under `useRawData` the composite lives in `rawCompositeData`; the helper
  // decodes it (the layer path is `getLayerCanvas`).
  const check = readPsd(patched, { useRawData: true, useRawThumbnail: true });
  const composite = getCompositeCanvas(check);
  if (!composite) throw new Error('patched PSD has no composite');
  const compositeCtx = composite.getContext('2d');
  if (!compositeCtx) throw new Error('composite canvas has no 2d context');
  const data = compositeCtx.getImageData(0, 0, width, height).data;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += l;
    if (l > max) max = l;
  }
  const pixels = data.length / 4;
  if (max <= 0) throw new Error('patched composite is all black');

  // every layer must decode with real alpha (the psd-tools failure mode)
  const layersRead: string[] = [];
  for (const layer of check.children ?? []) {
    const canvas = getLayerCanvas(layer);
    if (!canvas) {
      layersRead.push(`${layer.name}:NO-PIXELS`);
      continue;
    }
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) {
      layersRead.push(`${layer.name}:NO-CONTEXT`);
      continue;
    }
    const ld = ctx2d.getImageData(0, 0, width, height).data;
    let minAlpha = 255;
    for (let i = 3; i < ld.length; i += 4) if (ld[i] < minAlpha) minAlpha = ld[i];
    layersRead.push(`${layer.name}:alphaMin=${minAlpha}`);
  }

  return { bytes: patched, composite: { avg: sum / pixels, max }, layersRead };
}
