import { ReceiptLensError } from "../../errors.js";
import type { Box, ImagePixels } from "./detect.js";

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** True when this call created the bitmap and must close it. */
  owned: boolean;
}

/**
 * The two browser-only operations the OCR pipeline needs. Injectable so the provider's
 * geometry, decoding and error mapping can be exercised in Node without a DOM; the
 * default is the real browser implementation.
 */
export interface OcrEnvironment {
  decode(image: ImageBitmap | Blob | File): Promise<DecodedImage>;
  render(bitmap: ImageBitmap, region: Box, outWidth: number, outHeight: number): ImagePixels;
}

/** Decodes a Blob/File/ImageBitmap, mapping every failure to IMAGE_UNREADABLE. */
export async function decodeImage(image: ImageBitmap | Blob | File): Promise<DecodedImage> {
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    return { bitmap: image, width: image.width, height: image.height, owned: false };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch (cause) {
    throw new ReceiptLensError("IMAGE_UNREADABLE", "the supplied file could not be decoded as an image", {
      cause,
    });
  }

  if (bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close();
    throw new ReceiptLensError("IMAGE_UNREADABLE", "the decoded image has zero width or height");
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, owned: true };
}

/**
 * Renders a source rectangle of the bitmap into an RGBA buffer of exactly
 * `outWidth × outHeight`. The browser's `drawImage` does the resampling, which keeps
 * the same filter chain for detection and recognition crops.
 */
export function renderRegion(
  bitmap: ImageBitmap,
  region: Box,
  outWidth: number,
  outHeight: number,
): ImagePixels {
  if (typeof OffscreenCanvas === "undefined") {
    throw new ReceiptLensError(
      "IMAGE_UNREADABLE",
      "this environment has no OffscreenCanvas, so the image cannot be sampled for OCR",
    );
  }

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new ReceiptLensError("IMAGE_UNREADABLE", "a 2D canvas context could not be created");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    outWidth,
    outHeight,
  );

  return context.getImageData(0, 0, outWidth, outHeight);
}

export const browserOcrEnvironment: OcrEnvironment = {
  decode: decodeImage,
  render: renderRegion,
};
