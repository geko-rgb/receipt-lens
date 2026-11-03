/**
 * Drives the harness page in headless Chromium with a real receipt photo and writes
 * the raw OcrResult plus timings to harness/out/ for manual inspection.
 *
 *   node harness/run-acceptance.mjs [path/to/receipt.jpg]
 *
 * Default image is the SROIE sample already pinned in benchmarks/datasets (real
 * photographed receipt, CC-BY-4.0). Output is git-ignored: it is evidence for the
 * ticket, not committed fixture data.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "./serve.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const imagePath = path.resolve(
  process.argv[2] ?? path.join(repoRoot, "benchmarks/datasets/raw/sroie/assets/ex.jpg"),
);
const outDir = path.join(repoRoot, "harness", "out");
const stem = path.basename(imagePath, path.extname(imagePath));

await mkdir(outDir, { recursive: true });

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
const origins = new Set();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("request", (request) => {
  try {
    origins.add(new URL(request.url()).origin);
  } catch {
    /* data: / blob: URLs are not origins we care about */
  }
});

try {
  await page.goto(server.url, { waitUntil: "load" });
  await page.setInputFiles("#file", imagePath);

  // Wait on a boolean (cheap to serialize), then read the run through an explicit
  // JSON round-trip: the live object carries functions and typed handles that a
  // direct handle serialization silently drops.
  await page.waitForFunction(
    () => Boolean(window.__receiptLensHarness?.last || window.__receiptLensHarness?.error),
    undefined,
    { timeout: 240_000, polling: 500 },
  );
  const state = await page.evaluate(() => {
    const harness = window.__receiptLensHarness;
    if (!harness) return null;
    if (harness.error) return { ok: false, error: harness.error };
    if (harness.last) return { ok: true, run: JSON.parse(JSON.stringify(harness.last)) };
    return null;
  });
  if (!state) throw new Error("harness produced neither a result nor an error");

  await page.screenshot({ path: path.join(outDir, `${stem}.png`), fullPage: true });

  if (!state.ok) {
    process.stderr.write(`harness failed: ${JSON.stringify(state.error, null, 2)}\n`);
    if (consoleErrors.length > 0) {
      process.stderr.write(`console errors:\n- ${consoleErrors.join("\n- ")}\n`);
    }
    process.exitCode = 1;
  } else {
    const run = state.run;
    const payload = {
      image: path.relative(repoRoot, imagePath),
      recordedAt: new Date().toISOString(),
      executionProvider: run.executionProvider,
      timings: run.timings,
      assets: run.assets,
      session: run.session,
      requestOrigins: [...origins].sort(),
      result: run.result,
    };
    const jsonPath = path.join(outDir, `${stem}.ocr.json`);
    await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

    const lines = run.result.lines;
    const words = lines.reduce((count, line) => count + line.words.length, 0);
    process.stdout.write(
      [
        `image:        ${path.relative(repoRoot, imagePath)}`,
        `provider:     ${run.result.provider} ${run.result.version}`,
        `runtime:      ${run.executionProvider}, ${run.session?.numThreads ?? "?"} wasm thread(s)`,
        `load:         ${Math.round(run.timings.loadMs)} ms`,
        `inference:    ${Math.round(run.timings.inferenceMs)} ms`,
        `assets:       ${run.assets.bytes} bytes (det + rec + dictionary)`,
        `image size:   ${run.result.imageSize.width}x${run.result.imageSize.height}`,
        `lines/words:  ${lines.length}/${words}`,
        `origins:      ${[...origins].sort().join(", ")}`,
        `json:         ${path.relative(repoRoot, jsonPath)}`,
        "",
        "first lines:",
        ...lines.slice(0, 15).map((line) => `  ${line.text}`),
      ].join("\n") + "\n",
    );
    if (consoleErrors.length > 0) {
      process.stderr.write(`console errors:\n- ${consoleErrors.join("\n- ")}\n`);
    }
    if (lines.length === 0) {
      process.stderr.write("WARNING: zero lines — the pipeline ran but found no text.\n");
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
  await server.close();
}
