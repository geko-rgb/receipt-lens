/**
 * Generates (or verifies) `assets/models/manifest.json` — the content-hashed model
 * manifest from PROJECT(1).md §9.
 *
 * The manifest is the single source of truth for three things:
 *   1. What the OCR provider downloads: one URL, byte size and SHA-256 per asset.
 *   2. How to preprocess/postprocess for *these* weights (channel order, mean/std,
 *      DB thresholds, CTC decoder vocabulary size). The provider reads these values
 *      from the manifest instead of hardcoding them, so an asset swap that changes
 *      preprocessing cannot silently produce garbage text.
 *   3. The cache key for ticket 17: provider version + hash of this file's bytes.
 *
 * Every asset's SHA-256 is pinned below against the upstream browser manifest
 * (chenmohan/web-sdk-pp-ocrv6), which is itself a pinned revision. A swapped or
 * re-exported file fails this script instead of shipping.
 *
 *   node scripts/model-manifest.mjs           # regenerate
 *   node scripts/model-manifest.mjs --check   # verify only, non-zero on drift
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const modelsDir = path.resolve(import.meta.dirname, "../assets/models");
const manifestPath = path.join(modelsDir, "manifest.json");
const checkOnly = process.argv.includes("--check");

/** Upstream manifest these pins and preprocessing values were read from. */
const UPSTREAM = {
  collection: "https://huggingface.co/collections/PaddlePaddle/pp-ocrv6",
  browserManifest:
    "https://huggingface.co/chenmohan/web-sdk-pp-ocrv6/blob/fcb55226431520f397cbc93a80119f5cf32f355a/manifest.json",
  revisions: {
    det: "PaddlePaddle/PP-OCRv6_tiny_det_onnx@2ba1506c0380b8f0b03dd142459aac66d4421f6c",
    rec: "PaddlePaddle/PP-OCRv6_tiny_rec_onnx@2612ab37152ae0a677521bae4e1e3d4fb4cf7c30",
    dict: "PaddlePaddle/PP-OCRv6_tiny_rec_onnx@2612ab37152ae0a677521bae4e1e3d4fb4cf7c30",
  },
};

const ASSETS = [
  {
    role: "det",
    file: "PP-OCRv6_tiny_det.onnx",
    bytes: 1780590,
    sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8",
  },
  {
    role: "rec",
    file: "PP-OCRv6_tiny_rec.onnx",
    bytes: 4462639,
    sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6",
  },
  {
    role: "dict",
    file: "PP-OCRv6_tiny_rec.txt",
    bytes: 34063,
    sha256: "65f694d6e8cd39efa1c5480bbfd2fe90e631a6b17bbb3190089f261eb5e6f043",
  },
];

const assets = [];
for (const spec of ASSETS) {
  const buf = await readFile(path.join(modelsDir, spec.file));
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (sha256 !== spec.sha256) {
    throw new Error(
      `${spec.file}: sha256 ${sha256} does not match the pinned upstream hash ${spec.sha256}. ` +
        "Do not re-pin without re-verifying preprocessing against the upstream manifest.",
    );
  }
  if (buf.byteLength !== spec.bytes) {
    throw new Error(`${spec.file}: ${buf.byteLength} bytes, pinned ${spec.bytes}`);
  }
  assets.push({
    role: spec.role,
    file: spec.file,
    url: `/assets/models/${spec.file}`,
    bytes: buf.byteLength,
    sha256,
  });
}

const manifest = {
  schemaVersion: 1,
  provider: "pp-ocrv6",
  providerVersion: "1.0.0",
  preset: "tiny",
  license: "Apache-2.0",
  upstream: UPSTREAM,
  assets,
  // Values transcribed from the upstream browser manifest for THESE weights.
  // The provider reads them at runtime; changing them here changes inference.
  detection: {
    inputName: "x",
    outputName: "fetch_name_0",
    inputShape: ["N", 3, "H", "W"],
    // Measured, not assumed: the upstream browser manifest advertises H/4, but these
    // exports emit the DB probability map at the resized input resolution (verified
    // 2026-11-03 with scripts/inspect-ocr-sessions.mjs at two input sizes). Box
    // coordinates are scaled by imageWidth/mapWidth, which holds either way.
    outputShape: ["N", 1, "H", "W"],
    preprocessing: {
      // Channel order of the tensor: "BGR" means channel 0 is blue. Upstream reads
      // images as BGR in OpenCV and never swaps to RGB — reversing this is silent garbage.
      colorOrder: "BGR",
      scale: 1 / 255,
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      limitSideLen: 960,
      sizeMultiple: 32,
    },
    postprocessing: {
      name: "DBPostProcess",
      threshold: 0.2,
      boxThreshold: 0.45,
      unclipRatio: 1.4,
      minSize: 3,
      maxCandidates: 3000,
    },
  },
  recognition: {
    inputName: "x",
    outputName: "fetch_name_0",
    inputShape: ["N", 3, 48, "W"],
    preprocessing: {
      colorOrder: "BGR",
      scale: 1 / 255,
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
      height: 48,
      // Upstream pads every crop to at least 320 wide; long lines widen instead of
      // being squashed, capped so one very wide line cannot dominate WASM runtime.
      baseWidth: 320,
      maxWidth: 960,
    },
    decoder: {
      name: "CTCLabelDecode",
      // class 0 is CTC blank; class i (1..N) maps to dictionary line i-1.
      blankIndex: 0,
      dictionaryEntries: 6905,
      // Measured, not assumed: the upstream manifest labels this output "ctc_logits",
      // but the exported graph already applies softmax — every timestep row sums to
      // 1.0 (verified 2026-11-03). Applying softmax again silently turns every
      // confidence into ~1/6906. On real receipts this yielded 0.0003 for every word.
      outputActivation: "softmax",
    },
  },
  readingOrder: { toleranceRatio: 0.5 },
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (checkOnly) {
  const committed = await readFile(manifestPath, "utf8");
  if (committed !== serialized) {
    process.stderr.write(
      "assets/models/manifest.json is stale — run `node scripts/model-manifest.mjs` and commit the result.\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("model manifest: up to date\n");
  }
} else {
  await writeFile(manifestPath, serialized);
  process.stdout.write(serialized);
}

const manifestHash = createHash("sha256").update(serialized).digest("hex");
process.stdout.write(`manifestHash: ${manifestHash}\n`);
