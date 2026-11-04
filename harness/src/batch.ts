import { createPPOCRv6Provider, type OcrResult } from "@receipt-lens/core";

/**
 * Ticket 09b — the batch OCR page the accuracy driver runs against.
 *
 * It is deliberately **not** the §9 M1 harness page. `harness/index.html` is the deployment
 * `benchmarks/results/footprint.json` measures, and DECISIONS/0012 F11 re-triggers that measurement when
 * the app bundle changes; a benchmark tool that added bytes to the measured page would either invalidate
 * a committed measurement or force a re-measure for the wrong reason. This page is a second bundle, built
 * by a second entry point, and is not what a user loads.
 *
 * One page, one model load, many receipts: `init()` once, then `run()` per image. The receipt bytes are
 * handed over as base64 and decoded here, so no receipt image is ever served from an origin and no
 * request leaves the page — the same-origin property ticket 09a proves for the product page holds by
 * construction, since this driver makes no image request at all.
 */

export interface BatchInfo {
  readonly provider: string;
  readonly version: string;
  readonly manifestHash: string | null;
  readonly assetBytes: number;
  readonly loadMs: number;
  readonly session: unknown;
}

export interface BatchOutcome {
  readonly ok: boolean;
  readonly ocr?: OcrResult;
  readonly inferenceMs?: number;
  readonly error?: { name: string; message: string; code?: string };
}

interface BatchApi {
  init(options: { assetBaseUrl: string; manifestUrl?: string }): Promise<BatchInfo>;
  run(base64: string, mimeType: string, fileName: string): Promise<BatchOutcome>;
  info: BatchInfo | null;
}

let provider: ReturnType<typeof createPPOCRv6Provider> | null = null;
let info: BatchInfo | null = null;

async function init(options: { assetBaseUrl: string; manifestUrl?: string }): Promise<BatchInfo> {
  const started = performance.now();
  provider = createPPOCRv6Provider({
    assetBaseUrl: options.assetBaseUrl,
    manifestUrl: options.manifestUrl,
    wasmPaths: "/ort/",
    numThreads: "auto",
  });
  await provider.load();
  info = {
    provider: provider.name,
    version: provider.version,
    manifestHash: provider.manifestHash,
    assetBytes: provider.assetBytes,
    loadMs: performance.now() - started,
    session: provider.sessionInfo,
  };
  return info;
}

async function run(base64: string, mimeType: string, fileName: string): Promise<BatchOutcome> {
  if (!provider) throw new Error("batch page used before init()");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const file = new File([bytes], fileName, { type: mimeType });
  const started = performance.now();
  try {
    const ocr = await provider.recognize(file);
    return { ok: true, ocr, inferenceMs: performance.now() - started };
  } catch (error) {
    const failure = error as { name?: string; message?: string; code?: string };
    // Only the error code crosses back: a receipt's text must never leave the page into a log
    // (DECISIONS/0014 M6.3), and a message could carry one.
    return {
      ok: false,
      error: { name: failure.name ?? "Error", message: failure.code ?? "unknown", code: failure.code },
    };
  }
}

const api: BatchApi = {
  init,
  run,
  get info() {
    return info;
  },
};

declare global {
  interface Window {
    __receiptLensBatch?: BatchApi;
  }
}

window.__receiptLensBatch = api;
