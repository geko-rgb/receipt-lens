import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ModelManifest } from "./model-manifest.js";

/**
 * `assets/models/` is served verbatim by `scripts/serve-app.mjs` under `/assets/models/*` and is the directory
 * `scripts/inspect-ocr-sessions.mjs` reads by default, so a file sitting there is reachable by name even when no
 * manifest names it. That is how the PP-OCRv6 Small experiment tier ended up next to the shipped Tiny set after the
 * ticket-26 preprocessing benchmark: harmless to every gate (the manifest, the precache and the footprint all read
 * the manifest's own asset list), but one edited `ASSETS` line — or one `/assets/models/PP-OCRv6_small_rec.onnx` in a
 * harness URL — away from being measured as if it were the product.
 *
 * The quarantine is `assets/models/candidate/`, which `.gitignore` excludes: a tier that has not won a
 * `DECISIONS/0015` gate is not committed, and is never pinned. These two pins make the directory's contents the
 * manifest's own statement rather than a convention.
 */
const modelsUrl = new URL("../../../../assets/models/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", modelsUrl), "utf8")) as ModelManifest;

describe("the served model directory holds exactly what the manifest pins", () => {
  it("carries no asset file the manifest does not name", async () => {
    const entries = await readdir(modelsUrl, { withFileTypes: true });
    const pinned = new Set(manifest.assets.map((asset) => asset.file));
    const stray = entries
      .filter((entry) => entry.isFile() && entry.name !== "manifest.json" && !pinned.has(entry.name))
      .map((entry) => entry.name);
    // A stray tier here would be served at /assets/models/<file> and offered to the OCR harness by name.
    expect(stray).toEqual([]);
  });

  it("pins nothing outside this directory, so a quarantine subdirectory can never be an asset", () => {
    // `candidate/` is git-ignored and is where an unproven tier lives until it has benchmark evidence.
    for (const asset of manifest.assets) {
      expect(asset.file).not.toContain("/");
      expect(asset.url).toBe(`/assets/models/${asset.file}`);
    }
  });

  it("names only the tier DECISIONS/0015 put in front of users", () => {
    expect(manifest.assets.map((asset) => asset.file).sort()).toEqual([
      "PP-OCRv6_tiny_det.onnx",
      "PP-OCRv6_tiny_rec.onnx",
      "PP-OCRv6_tiny_rec.txt",
    ]);
  });
});
