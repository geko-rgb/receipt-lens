/**
 * The lazy OCR boundary (DECISIONS/0017 D4).
 *
 * Core may be imported statically only by views that need it eagerly; the capture flow must reach it
 * through this module so `onnxruntime-web` stays out of the entry chunk and out of first paint. The
 * first call pays the chunk load, subsequent calls reuse both the module promise and the provider.
 */

type CoreModule = typeof import("@receipt-lens/core");

let loaded: Promise<CoreModule> | null = null;
let provider: import("@receipt-lens/core").OcrProvider | null = null;

export function loadOcr(): Promise<CoreModule> {
  loaded ??= import("@receipt-lens/core");
  return loaded;
}

/**
 * Adopt a provider that has already loaded and smoke-tested a model set (DECISIONS/0027 W5's hand-off).
 *
 * The preparation protocol builds a provider to run its one inference. Throwing that away would mean the
 * user's first capture paid for the runtime and both sessions a second time, which is the difference between
 * "prepared in the background" and "prepared twice, slowly".
 */
export function adoptProvider(next: import("@receipt-lens/core").OcrProvider): void {
  provider = next;
}

/** The provider is created once, on the far side of the import — never at module scope. */
async function ocrProvider(): Promise<import("@receipt-lens/core").OcrProvider> {
  if (provider) return provider;
  const core = await loadOcr();
  provider = core.createPPOCRv6Provider();
  return provider;
}

/** `extract()` with the lazy boundary and the shared provider already resolved. */
export async function extractInBrowser(
  image: Blob,
  options: Omit<import("@receipt-lens/core").ExtractOptions, "provider">,
): Promise<import("@receipt-lens/core").ReceiptLensResult> {
  const core = await loadOcr();
  return await core.extract(image, { ...options, provider: await ocrProvider() });
}
