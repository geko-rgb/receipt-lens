import type { DetPostprocessing, DetPreprocessing, Normalization } from "../model-manifest.js";

export interface ImagePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetResizePlan {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Detection resize: longest side capped at `limitSideLen`, both sides rounded to a
 * multiple of `sizeMultiple` (32) so the H/4 probability map stays integral.
 * Mirrors PaddleOCR's `limit_type="max"` resize.
 */
export function planDetResize(width: number, height: number, pre: DetPreprocessing): DetResizePlan {
  const longest = Math.max(width, height);
  const ratio = longest > pre.limitSideLen ? pre.limitSideLen / longest : 1;
  const snapped = (value: number) =>
    Math.max(pre.sizeMultiple, Math.round((value * ratio) / pre.sizeMultiple) * pre.sizeMultiple);
  const resizedWidth = snapped(width);
  const resizedHeight = snapped(height);
  return {
    width: resizedWidth,
    height: resizedHeight,
    scaleX: width / resizedWidth,
    scaleY: height / resizedHeight,
  };
}

/**
 * Maps tensor channel index → source RGBA byte offset. This is the channel-order trap:
 * PP-OCR reads images as BGR, so channel 0 must carry the blue byte. Getting this
 * backwards still produces a full probability map, just an unusable one.
 */
function channelOffsets(colorOrder: Normalization["colorOrder"]): readonly [number, number, number] {
  return colorOrder === "BGR" ? [2, 1, 0] : [0, 1, 2];
}

/**
 * Converts RGBA pixels into a normalized NCHW float tensor. `targetWidth` may exceed
 * the pixel width; the surplus columns stay 0 (the padding upstream uses for crops
 * shorter than the minimum recognition width).
 */
export function toChwTensor(pixels: ImagePixels, pre: Normalization, targetWidth = pixels.width): Float32Array {
  const { data, width, height } = pixels;
  const offsets = channelOffsets(pre.colorOrder);
  const out = new Float32Array(3 * targetWidth * height);

  for (let channel = 0; channel < 3; channel += 1) {
    const offset = offsets[channel]!;
    const mean = pre.mean[channel]!;
    const std = pre.std[channel]!;
    const channelBase = channel * targetWidth * height;
    for (let y = 0; y < height; y += 1) {
      const srcRow = y * width;
      const dstRow = channelBase + y * targetWidth;
      for (let x = 0; x < width; x += 1) {
        const rgba = (srcRow + x) * 4 + offset;
        out[dstRow + x] = (data[rgba]! * pre.scale - mean) / std;
      }
    }
  }
  // CHW: each channel is a contiguous targetWidth × height plane, padding included.
  return out;
}

export interface DbDetection extends Box {
  /** Mean probability inside the binary component; the DB box score. */
  score: number;
}

/**
 * DB post-processing (PaddleOCR `DBPostProcess`): binarize the probability map, label
 * 8-connected components, filter by size and box score, then unclip each box so it
 * covers the strokes the shrunk probability map drops.
 */
export function dbPostprocess(
  probability: Float32Array,
  mapWidth: number,
  mapHeight: number,
  post: DetPostprocessing,
): DbDetection[] {
  const total = mapWidth * mapHeight;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const found: DbDetection[] = [];

  for (let seed = 0; seed < total; seed += 1) {
    if (visited[seed] === 1 || probability[seed]! < post.threshold) continue;

    let top = 0;
    stack[top++] = seed;
    visited[seed] = 1;

    let minX = mapWidth;
    let minY = mapHeight;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let sum = 0;

    while (top > 0) {
      const index = stack[--top]!;
      const y = Math.floor(index / mapWidth);
      const x = index - y * mapWidth;
      count += 1;
      sum += probability[index]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= mapHeight) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= mapWidth) continue;
          const neighbour = ny * mapWidth + nx;
          if (visited[neighbour] === 1 || probability[neighbour]! < post.threshold) continue;
          visited[neighbour] = 1;
          stack[top++] = neighbour;
        }
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width < post.minSize || height < post.minSize) continue;

    const score = sum / count;
    if (score < post.boxThreshold) continue;

    // PaddleOCR's unclip distance for a contour: area * ratio / perimeter.
    const perimeter = 2 * (width + height);
    const grow = perimeter > 0 ? (width * height * post.unclipRatio) / perimeter : 0;
    found.push({
      x: minX - grow,
      y: minY - grow,
      width: width + 2 * grow,
      height: height + 2 * grow,
      score,
    });

    if (found.length >= post.maxCandidates) break;
  }

  // Reading order: top-to-bottom, then left-to-right.
  found.sort((a, b) => a.y - b.y || a.x - b.x);
  return found;
}

/**
 * Probability-map coordinates → original image coordinates, clamped to the image.
 * The map is a uniform 1/4 downsample of the resized image, so one ratio converts
 * straight from map space to source space.
 */
export function scaleBoxesToImage(
  boxes: readonly Box[],
  mapWidth: number,
  mapHeight: number,
  imageWidth: number,
  imageHeight: number,
): Box[] {
  const scaleX = imageWidth / mapWidth;
  const scaleY = imageHeight / mapHeight;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const result: Box[] = [];
  for (const box of boxes) {
    const left = clamp(box.x * scaleX, imageWidth);
    const top = clamp(box.y * scaleY, imageHeight);
    const right = clamp((box.x + box.width) * scaleX, imageWidth);
    const bottom = clamp((box.y + box.height) * scaleY, imageHeight);
    const width = right - left;
    const height = bottom - top;
    // Nothing this small can carry a character; DB noise often produces slivers.
    if (width < 3 || height < 3) continue;
    result.push({ x: left, y: top, width, height });
  }
  return result;
}
