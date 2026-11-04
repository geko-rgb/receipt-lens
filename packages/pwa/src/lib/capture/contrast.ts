/**
 * DECISIONS/0018 P5 — conservative contrast as an HSV **value-channel** stretch.
 *
 * Not an RGB→grayscale conversion: a colour receipt stays in colour, only V moves, H and S are held.
 * Sharpening the value channel is what improves a faded thermal print without destroying the hue cues
 * the preview (and the reviewer) rely on.
 */

/** DECISIONS/0018 P5: percent, symmetric. */
export const CONTRAST_LIMIT_PERCENT = 20;

/** P5: clamp a requested adjustment into [-20, +20]. Non-finite input is no adjustment. */
export function clampContrastPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(-CONTRAST_LIMIT_PERCENT, Math.min(CONTRAST_LIMIT_PERCENT, percent));
}

/**
 * P5: the value-channel stretch itself, applied to one 0..255 value for a factor of -0.2..+0.2.
 * Result is clamped to 0..255 so a hot highlight saturates instead of wrapping.
 */
export function stretchValue(value: number, factor: number): number {
  const stretched = value * (1 + factor);
  return Math.min(255, Math.max(0, stretched));
}

/** rgb (0..255 each) → [hue 0..360, saturation 0..1, value 0..1]. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let hue = 0;
  if (delta > 0) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2);
    else hue = 60 * ((rn - gn) / delta + 4);
  }
  if (hue < 0) hue += 360;

  const saturation = max === 0 ? 0 : delta / max;
  return [hue, saturation, max];
}

/** [hue, saturation 0..1, value 0..1] → rgb (0..255 each, rounded). */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const chroma = v * s;
  const sector = (((h % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const floor = v - chroma;

  let rgb: [number, number, number];
  if (sector < 1) rgb = [chroma, second, 0];
  else if (sector < 2) rgb = [second, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, second];
  else if (sector < 4) rgb = [0, second, chroma];
  else if (sector < 5) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];

  return [
    Math.round((rgb[0] + floor) * 255),
    Math.round((rgb[1] + floor) * 255),
    Math.round((rgb[2] + floor) * 255),
  ];
}

/**
 * Applies the stretch to an RGBA buffer in place, round-tripping each pixel through HSV and writing
 * only the value channel back. Alpha is untouched.
 */
export function applyContrastToPixels(rgba: Uint8ClampedArray, percent: number): void {
  const clamped = clampContrastPercent(percent);
  if (clamped === 0) return;
  const factor = clamped / 100;

  for (let i = 0; i < rgba.length; i += 4) {
    const [hue, saturation, value] = rgbToHsv(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    if (saturation === 0 && value === 0) continue;
    const stretched = Math.min(1, Math.max(0, value * (1 + factor)));
    const [r, g, b] = hsvToRgb(hue, saturation, stretched);
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
  }
}
