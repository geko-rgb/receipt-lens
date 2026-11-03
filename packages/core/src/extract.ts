import type { ExtractOptions, ReceiptLensResult } from "./types.js";
import type { OcrProvider } from "./ocr/provider.js";
import { ocr } from "./ocr/provider.js";
import { createPPOCRv6Provider } from "./ocr/pp-ocrv6.js";
import { parse } from "./parse/index.js";
import { validate } from "./validate/index.js";

/**
 * `extract()` — §4's one-call convenience, composing the three staged stages. It owns no logic of its own:
 * the same `OcrProvider` seam, the same pure `parse()`, and the same `validate()` a caller reaches when
 * they want the stages separately, so the two paths cannot disagree.
 *
 * The provider option is `"pp-ocrv6"` or an `OcrProvider` instance; provider tuning (`assetBaseUrl`,
 * `wasmPaths`, `numThreads`) is available by passing `createPPOCRv6Provider({ … })`, which keeps §4's
 * option shape exactly as specified.
 */
export async function extract(
  image: ImageBitmap | Blob | File,
  options: ExtractOptions
): Promise<ReceiptLensResult> {
  const provider: OcrProvider = options.provider === "pp-ocrv6" ? createPPOCRv6Provider() : options.provider;
  const ocrResult = await ocr(image, { provider });
  const parseResult = parse(ocrResult);
  return { ocr: ocrResult, parse: parseResult, validation: validate(parseResult, options) };
}
