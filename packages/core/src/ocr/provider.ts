import type { OcrResult } from "./types.js";

export interface OcrProvider {
  name: string;
  version: string;
  recognize(image: ImageBitmap | Blob | File): Promise<OcrResult>;
}

export interface OcrOptions {
  provider: OcrProvider;
}

/**
 * Runs the supplied provider. This wrapper owns no OCR logic: the provider is the
 * swappable seam, and parsing never sees provider-specific output.
 *
 * Typed errors are operational only (`IMAGE_UNREADABLE`, `MODEL_LOAD_FAILED`,
 * `RECOGNIZE_FAILED`); a blank image is a valid zero-word `OcrResult`. Misuse — calling
 * without a provider — is a programming error, not an operational one, so it throws a
 * plain `TypeError` rather than borrowing an operational code.
 */
export async function ocr(image: ImageBitmap | Blob | File, options: OcrOptions): Promise<OcrResult> {
  const provider = options?.provider;
  if (!provider || typeof provider.recognize !== "function") {
    throw new TypeError("ocr() requires an OcrProvider in options.provider");
  }
  return provider.recognize(image);
}
