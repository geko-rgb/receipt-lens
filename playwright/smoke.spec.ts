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

test("no shell chunk carries the ONNX runtime — it stays behind the lazy boundary", () => {
  const { chunks } = builtShell();
  expect(chunks.length).toBeGreaterThan(0);

  for (const chunk of chunks) {
    expect(chunk.source, `${chunk.name} references onnxruntime`).not.toContain("onnxruntime");
    expect(chunk.source, `${chunk.name} references the threaded WASM`).not.toContain("ort-wasm-simd-threaded");
  }

  // And the bundler must not have hoisted a WASM asset into the shell's own output.
  const assets = readdirSync(path.join(shellDir, "assets"));
  expect(assets.filter((name) => name.endsWith(".wasm"))).toEqual([]);
});

test("the shell does not import @receipt-lens/core at all (no product behaviour yet)", () => {
  const { chunks } = builtShell();
  const combined = chunks.map((chunk) => chunk.source).join("\n");
  // core's only public entry symbols the shell could pull in; none of them may appear yet.
  for (const marker of ["classifyRows", "createPPOCRv6Provider", "unclassifiedRows"]) {
    expect(combined, `shell bundle contains ${marker}`).not.toContain(marker);
  }
});
