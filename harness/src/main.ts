import { createPPOCRv6Provider, type OcrResult } from "@receipt-lens/core";

interface HarnessRun {
  result: OcrResult;
  timings: { loadMs: number; inferenceMs: number; totalMs: number };
  assets: { bytes: number; manifestHash: string | null; version: string };
  executionProvider: "wasm";
  session: unknown;
}

declare global {
  interface Window {
    __receiptLensHarness?: {
      run: (file: File) => Promise<HarnessRun>;
      last?: HarnessRun;
      error?: { name: string; message: string; code?: string };
    };
  }
}

const provider = createPPOCRv6Provider({
  assetBaseUrl: "/assets/models/",
  wasmPaths: "/ort/",
  numThreads: "auto",
});

const fileInput = document.querySelector<HTMLInputElement>("#file");
const status = document.querySelector<HTMLElement>("#status");
const metrics = document.querySelector<HTMLElement>("#metrics");
const resultElement = document.querySelector<HTMLElement>("#result");

async function run(file: File): Promise<HarnessRun> {
  const started = performance.now();

  status!.textContent = "loading models…";
  const loadStart = performance.now();
  await provider.load();
  const loadMs = performance.now() - loadStart;

  status!.textContent = "running detection + recognition…";
  const inferenceStart = performance.now();
  const result = await provider.recognize(file);
  const inferenceMs = performance.now() - inferenceStart;
  const totalMs = performance.now() - started;

  const words = result.lines.reduce((count, line) => count + line.words.length, 0);
  const finished: HarnessRun = {
    result,
    timings: { loadMs, inferenceMs, totalMs },
    assets: { bytes: provider.assetBytes, manifestHash: provider.manifestHash, version: provider.version },
    executionProvider: "wasm",
    session: provider.sessionInfo,
  };

  metrics!.textContent = JSON.stringify(
    {
      executionProvider: "wasm (CPU; WebGPU is not attempted on this host)",
      wasmThreads: provider.sessionInfo?.numThreads ?? null,
      loadMs: Math.round(loadMs),
      inferenceMs: Math.round(inferenceMs),
      totalMs: Math.round(totalMs),
      assetBytes: provider.assetBytes,
      manifestHash: provider.manifestHash,
      version: provider.version,
      imageSize: result.imageSize,
      lines: result.lines.length,
      words,
      session: provider.sessionInfo,
    },
    null,
    2,
  );
  resultElement!.textContent = JSON.stringify(result, null, 2);
  status!.textContent = `done — ${result.lines.length} lines, ${words} words`;
  return finished;
}

const harness = {
  run,
  last: undefined as HarnessRun | undefined,
  error: undefined as { name: string; message: string; code?: string } | undefined,
};
window.__receiptLensHarness = harness;

fileInput?.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    harness.error = undefined;
    harness.last = await run(file);
  } catch (error) {
    const failure = error as { name?: string; message?: string; code?: string };
    harness.error = { name: failure.name ?? "Error", message: failure.message ?? String(error), code: failure.code };
    status!.textContent = `failed: ${harness.error.code ?? harness.error.name} — ${harness.error.message}`;
  }
});
