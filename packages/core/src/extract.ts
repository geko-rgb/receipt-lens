import type { ExtractOptions, ReceiptLensResult } from "./types.js";

export async function extract(
  image: ImageBitmap | Blob | File,
  options: ExtractOptions
): Promise<ReceiptLensResult> {
  throw new Error("not implemented");
}
