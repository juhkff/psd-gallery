/**
 * PSD blend mode -> canvas `globalCompositeOperation`.
 *
 * Verified against the ag-psd `BlendMode` union and the CSS/MDN list of
 * `globalCompositeOperation` values (the same set `mix-blend-mode` uses).
 * IMPORTANT: `globalCompositeOperation` values are space separated
 * ("color-burn", "hard-light"); casing differences silently fall back to
 * "source-over", which is how a layer viewer quietly renders wrong.
 */

/** Canonical key used in the manifest (ag-psd's own camelCase spelling). */
export type PsdBlendMode = string;

interface BlendInfo {
  /** Spec-correct `globalCompositeOperation` value, or "source-over" fallback. */
  composite: string;
  /** Human label for the UI. */
  label: string;
  /** False when the browser cannot reproduce this PSD mode. */
  exact: boolean;
}

const TABLE: Record<string, BlendInfo> = {
  normal: { composite: 'source-over', label: '正常', exact: true },
  dissolve: { composite: 'source-over', label: '溶解', exact: false },
  darken: { composite: 'darken', label: '变暗', exact: true },
  multiply: { composite: 'multiply', label: '正片叠底', exact: true },
  colorBurn: { composite: 'color-burn', label: '颜色加深', exact: true },
  linearBurn: { composite: 'source-over', label: '线性加深', exact: false },
  darkerColor: { composite: 'darken', label: '深色', exact: false },
  lighten: { composite: 'lighten', label: '变亮', exact: true },
  screen: { composite: 'screen', label: '滤色', exact: true },
  colorDodge: { composite: 'color-dodge', label: '颜色减淡', exact: true },
  linearDodge: { composite: 'lighter', label: '线性减淡（添加）', exact: true },
  lighterColor: { composite: 'lighten', label: '浅色', exact: false },
  overlay: { composite: 'overlay', label: '叠加', exact: true },
  softLight: { composite: 'soft-light', label: '柔光', exact: true },
  hardLight: { composite: 'hard-light', label: '强光', exact: true },
  vividLight: { composite: 'source-over', label: '亮光', exact: false },
  linearLight: { composite: 'source-over', label: '线性光', exact: false },
  pinLight: { composite: 'source-over', label: '点光', exact: false },
  hardMix: { composite: 'source-over', label: '实色混合', exact: false },
  difference: { composite: 'difference', label: '差值', exact: true },
  exclusion: { composite: 'exclusion', label: '排除', exact: true },
  subtract: { composite: 'source-over', label: '减去', exact: false },
  divide: { composite: 'source-over', label: '划分', exact: false },
  hue: { composite: 'hue', label: '色相', exact: true },
  saturation: { composite: 'saturation', label: '饱和度', exact: true },
  color: { composite: 'color', label: '颜色', exact: true },
  luminosity: { composite: 'luminosity', label: '明度', exact: true },
  passThrough: { composite: 'source-over', label: '穿透', exact: true },
};

const UNKNOWN: BlendInfo = { composite: 'source-over', label: '未知', exact: false };

/** Normalize loose input ("color burn", "color-burn", "ColorBurn") to a table key. */
export function normalizeBlendMode(mode: string | undefined): string {
  if (!mode) return 'normal';
  const compact = mode.replace(/[\s_-]/g, '').toLowerCase();
  if (!compact) return 'normal';
  const direct = Object.keys(TABLE).find((k) => k.toLowerCase() === compact);
  return direct ?? compact;
}

export function blendInfo(mode: string | undefined): BlendInfo {
  return TABLE[normalizeBlendMode(mode)] ?? UNKNOWN;
}

/** `globalCompositeOperation` value for a PSD blend mode. */
export function toCompositeOperation(mode: string | undefined): string {
  return blendInfo(mode).composite;
}

/** Localized label for a PSD blend mode. */
export function blendLabel(mode: string | undefined): string {
  const info = blendInfo(mode);
  return info.label === '未知' ? (mode ?? '正常') : info.label;
}

/** True when this PSD mode cannot be reproduced exactly by canvas blending. */
export function isApproximate(mode: string | undefined): boolean {
  return !blendInfo(mode).exact;
}
