/***
 * Ticket 01 added this as "the placeholder PWA page loads in a real browser". Ticket 10a replaced the
 * placeholder with the shell, so the file now checks the shape of the BUILT artifact instead: what the
 * entry document loads, and that the OCR runtime is not in it.
 *
 * Why this is not redundant with shell.spec.ts: that file proves behaviour in Chromium against a running
 * server; this one fails on the bundle itself, so an accidental eager import of the ONNX runtime is
 * caught by the artifact that would ship it, not only by a request a test happens to watch for.
 */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shellDir = path.join(repoRoot, "packages/pwa/dist/app");

function builtShell(): { html: string; chunks: { name: string; source: string }[] } {
  const indexPath = path.join(shellDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`missing ${path.relative(repoRoot, indexPath)} — run \`pnpm build\` before Playwright`);
  }
  const html = readFileSync(indexPath, "utf8");
  const assetsDir = path.join(shellDir, "assets");
  const chunks = readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: readFileSync(path.join(assetsDir, name), "utf8") }));
  return { html, chunks };
}

/** The chunk(s) the entry document itself loads — everything else is reachable only behind a dynamic import. */
function entryChunks(): { name: string; source: string }[] {
  const { html } = builtShell();
  const entryNames = [...html.matchAll(/<script[^>]+src="\/assets\/([^"]+)"/g)].map((match) => match[1]!);
  return builtShell()
    .chunks.filter((chunk) => entryNames.includes(chunk.name));
}

test("the shell entry document mounts the app from relative build assets only", () => {
  const { html } = builtShell();

  expect(html).toContain("<title>receipt-lens</title>");
  expect(html).toContain('id="app"');

  const scriptSources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  expect(scriptSources.length).toBe(1);
  for (const src of scriptSources) {
    // A protocol here would be a third-party origin in the entry document (§9: self-hosted, no CDN).
    expect(src).toMatch(/^\/assets\/index-[\w-]+\.js$/);
  }
});

test("the ONNX runtime stays behind the lazy boundary, never in the entry chunk", () => {
  const entry = entryChunks();
  expect(entry.length).toBeGreaterThan(0);

  for (const chunk of entry) {
    expect(chunk.source, `${chunk.name} references onnxruntime`).not.toContain("onnxruntime");
    expect(chunk.source, `${chunk.name} references the threaded WASM`).not.toContain("ort-wasm-simd-threaded");
  }

  // The boundary is only real if the runtime exists somewhere behind it — ticket 10 makes the shell
  // able to OCR, so the runtime and its WASM asset are now produced, just never on first paint.
  const { chunks } = builtShell();
  const lazy = chunks.filter((chunk) => !entry.some((e) => e.name === chunk.name));
  expect(
    lazy.some((chunk) => chunk.source.includes("ort-wasm-simd-threaded")),
    "no lazy chunk carries the ONNX runtime",
  ).toBe(true);

  const assets = readdirSync(path.join(shellDir, "assets"));
  expect(assets.filter((name) => name.endsWith(".wasm")).length).toBeGreaterThan(0);
});

/** The build's own chunk graph — the artifact D4's claim is about ("dynamicEntries … firstPaintClosure"). */
interface ManifestChunk {
  file: string;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  assets?: string[];
}

function manifest(): Record<string, ManifestChunk> {
  const manifestPath = path.join(shellDir, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`missing ${path.relative(repoRoot, manifestPath)} — run \`pnpm build\` before Playwright`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
}

test("the OCR runtime is reachable only behind a dynamic import, never in the entry's static closure", () => {
  const graph = manifest();
  const entry = Object.values(graph).find((chunk) => chunk.isEntry === true);
  expect(entry, "the manifest has no entry chunk").toBeDefined();

  const ort = Object.entries(graph).find(([, chunk]) => chunk.name === "ort.wasm.bundle.min");
  expect(ort, "the ONNX runtime is not in the build at all").toBeDefined();
  const [ortKey, ortChunk] = ort!;

  expect(ortChunk.isDynamicEntry, "the runtime chunk is not marked dynamic").toBe(true);
  expect((entry!.imports ?? []).includes(ortKey), "the entry statically imports the runtime").toBe(false);
  expect(entry!.dynamicImports ?? [], "the runtime is not behind a dynamic import").toContain(ortKey);
  expect(ortChunk.assets?.some((asset) => asset.endsWith(".wasm")), "no WASM asset behind the runtime").toBe(true);

  // The runtime's code and its WASM asset name stay out of the entry source. Ticket 11 did put *core* into
  // that source, and said so: §6 line 400 makes every bill edit run core's `validate()` synchronously, which
  // is the consequence DECISIONS/0017 D4 recorded in advance — "core itself cannot split out — only what sits
  // behind core's own internal `await import("onnxruntime-web/wasm")` does". The boundary the footprint and
  // privacy claims rest on is the runtime, and it is still a boundary: shell.spec.ts's first-paint request
  // walk fetches no `.wasm`/onnx/ort asset on any route.
  const entrySource = entryChunks()
    .map((chunk) => chunk.source)
    .join("\n");
  expect(entrySource).toMatch(/import\((["'`])\/*[^"'`]*\1\)/);
  expect(entrySource).not.toContain("onnxruntime");
  expect(entrySource).not.toContain("ort-wasm-simd-threaded");
});
