import type { OcrResult } from "./types.js";

export interface OcrProvider {
  name: string;
  version: string;
  recognize(image: ImageBitmap | Blob | File): Promise<OcrResult>;
}

export interface OcrOptions {
  provider: OcrProvider;
}

export async function ocr(
  image: ImageBitmap | Blob | File,
  options: OcrOptions
): Promise<OcrResult> {
  return options.provider.recognize(image);
}
