/**
 * DECISIONS/0018 P2, P3, P6 — the only transform pipeline in the capture flow.
 *
 * One function owns rotation, crop and contrast because all three have to land in ONE draw pass: the
 * crop is the source rectangle `drawImage` receives (P3 — it is not a decoration over the preview),
 * the rotation is 90° steps onto a canvas sized from the image's natural extent (P2), and contrast is
 * the P5 value-channel stretch applied to the drawn pixels.
 *
 * The environment is injected so the pipeline is testable in Node without a canvas: `pins.test.ts`
 * supplies a recording surface, `browserEnvironment()` supplies the real Canvas 2D one (P6 — Canvas 2D,
 * never OffscreenCanvas). The output is a **Blob**, because that is what `extract()` accepts.
 */

import { clampContrastPercent, applyContrastToPixels } from "./contrast.js";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TransformRequest {
  /** 0 | 90 | 180 | 270 (DECISIONS/0018 P2). */
  readonly rotationDegrees: number;
  /** Null means full image (P3). Reset produces null, not a zero rectangle. */
  readonly crop: Rect | null;
  /** -20..20 percent (P5). */
  readonly contrastPercent: number;
  /** Small correction from the P4 estimator, degrees. Applied on top of the 90° steps. */
  readonly deskewDegrees?: number;
}

export interface TransformResult {
  readonly blob: Blob;
  /** Effective OCR input dimensions after crop and rotation — what the pipeline actually produced. */
  readonly width: number;
  readonly height: number;
  /** Source rectangle passed to `drawImage`, in the source image's own coordinates. */
  readonly sourceRect: Rect;
  readonly rotationDegrees: number;
  readonly deskewDegrees: number;
  readonly contrastPercent: number;
}

/** The slice of `CanvasRenderingContext2D` the pipeline uses. */
export interface Surface2D {
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  translate(x: number, y: number): void;
  rotate(angleRadians: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike;
  putImageData(data: ImageDataLike, dx: number, dy: number): void;
}

export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface Surface {
  readonly width: number;
  readonly height: number;
  readonly context: Surface2D;
  /** Present on the browser surface; the encoder needs the element to call `toBlob`. */
  readonly canvas?: unknown;
}

/** A decoded, drawable source. `image` is whatever the surface's `drawImage` accepts. */
export interface DecodedSource {
  readonly image: unknown;
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface TransformEnvironment {
  /** Decode the source. Canvas `drawImage` takes an ImageBitmap, never a Blob. */
  decode(source: Blob): Promise<DecodedSource>;
  /** A 2D drawing surface of exactly these dimensions. */
  createSurface(width: number, height: number): Surface;
  /** Encode the finished surface. */
  encode(surface: Surface): Promise<Blob>;
}

/** P2: 90/270 swap the axes; a rotation never clips the image to its layout size. */
export function rotatedDimensions(
  width: number,
  height: number,
  rotationDegrees: number,
): { width: number; height: number } {
  const normalised = ((Math.round(rotationDegrees) % 360) + 360) % 360;
  return normalised === 90 || normalised === 270 ? { width: height, height: width } : { width, height };
}

/** P3: the crop, clamped into the image, or the whole image when there is no crop. */
export function effectiveSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  crop: Rect | null,
): Rect {
  if (crop === null) return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };

  // Clamp the edges, not the width: a selection that starts off-image loses that much of its extent.
  const rawX = Math.round(crop.x);
  const rawY = Math.round(crop.y);
  const x = Math.min(Math.max(0, rawX), Math.max(0, sourceWidth - 1));
  const y = Math.min(Math.max(0, rawY), Math.max(0, sourceHeight - 1));
  const right = Math.min(sourceWidth, rawX + Math.round(crop.width));
  const bottom = Math.min(sourceHeight, rawY + Math.round(crop.height));
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  return { x, y, width, height };
}

/** The pipeline. Returns the blob plus the geometry it used, so callers and tests can see both. */
export async function applyTransformations(
  source: Blob,
  request: TransformRequest,
  env: TransformEnvironment,
): Promise<TransformResult> {
  const rotationDegrees = ((Math.round(request.rotationDegrees) % 360) + 360) % 360;
  const deskewDegrees = Number.isFinite(request.deskewDegrees) ? request.deskewDegrees! : 0;
  const decoded = await env.decode(source);
  const { width: sourceWidth, height: sourceHeight } = decoded;
  const sourceRect = effectiveSourceRect(sourceWidth, sourceHeight, request.crop);
  const target = rotatedDimensions(sourceRect.width, sourceRect.height, rotationDegrees);

  const surface = env.createSurface(target.width, target.height);
  const context = surface.context;

  // Rotate about the centre of the target; the drawn extent is the source rect itself, so nothing
  // outside the crop is ever sampled and a 90° turn fills the swapped canvas exactly.
  context.translate(target.width / 2, target.height / 2);
  const totalDegrees = rotationDegrees + deskewDegrees;
  if (totalDegrees !== 0) context.rotate((totalDegrees * Math.PI) / 180);
  context.drawImage(
    decoded.image,
    sourceRect.x,
    sourceRect.y,
    sourceRect.width,
    sourceRect.height,
    -sourceRect.width / 2,
    -sourceRect.height / 2,
    sourceRect.width,
    sourceRect.height,
  );

  const contrastPercent = clampContrastPercent(request.contrastPercent);
  if (contrastPercent !== 0) {
    const image = context.getImageData(0, 0, target.width, target.height);
    applyContrastToPixels(image.data, contrastPercent);
    context.putImageData(image, 0, 0);
  }

  const blob = await env.encode(surface);
  decoded.close();
  return {
    blob,
    width: target.width,
    height: target.height,
    sourceRect,
    rotationDegrees,
    deskewDegrees,
    contrastPercent,
  };
}

/** Real browser environment: Canvas 2D on the main thread (P6), JPEG output. */
export function browserEnvironment(): TransformEnvironment {
  return {
    async decode(source) {
      const bitmap = await createImageBitmap(source);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    },
    createSurface(width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      return { width, height, context: context as unknown as Surface2D, canvas };
    },
    async encode(surface) {
      const canvas = surface.canvas as HTMLCanvasElement | undefined;
      if (canvas) {
        return await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob produced null"))),
            "image/jpeg",
            0.95,
          );
        });
      }
      throw new Error("surface is missing its canvas");
    },
  };
}

/** Kept for the caller: the stretch is clamped exactly where it is applied. */
export { clampContrastPercent, applyContrastToPixels };
