#!/usr/bin/env node
/**
 * Ticket 09b — fetch the PP-OCRv6 Small candidate tier for the gate G3 comparison.
 *
 *   node benchmarks/scripts/fetch-candidate-model.mjs            # download + verify + write manifest
 *   node benchmarks/scripts/fetch-candidate-model.mjs --check     # verify what is already on disk
 *
 * Writes to `assets/models/candidate/`, which is git-ignored (see `.gitignore`). A candidate that has
 * not won the gate does not join the shipped asset set: `assets/models/` keeps holding the tier the
 * product serves, and ticket 08's footprint check keeps verifying those bytes.
 *
 * **Every byte is verified against the upstream browser manifest before it is trusted**, per ADR-002's
 * swap procedure step 1: each model's SHA-256 is pinned to the value the pinned upstream revision
 * publishes, and the fetch refuses a mismatch. The dictionary has no SHA-256 in that manifest — it is a
 * plain (non-LFS) file — so its byte count is pinned and its hash is computed here, then written into
 * the manifest the provider verifies on every load.
 *
 * Two values in the manifest it writes are **upstream claims, not measurements**: the detection output
 * shape and the recognition output activation. Both were wrong for Tiny, in the direction that produces
 * plausible garbage rather than an error (ticket 04, `assets/models/manifest.json`'s own comments). ADR-002
 * step 2 says preprocessing must travel with the weights, so the next step after this script is
 * `node scripts/inspect-ocr-sessions.mjs --dir assets/models/candidate`, and the manifest is corrected to
 * whatever that measures — never left at the advertised value.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const candidateDir = path.join(repoRoot, "assets/models/candidate");
const checkOnly = process.argv.includes("--check");

/** The pinned upstream browser manifest these records were read from (same commit as the Tiny pins). */
const BROWSER_MANIFEST = "https://huggingface.co/chenmohan/web-sdk-pp-ocrv6/blob/fcb55226431520f397cbc93a80119f5cf32f355a/manifest.json";

const ASSETS = [
  {
    role: "det",
    file: "PP-OCRv6_small_det.onnx",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.onnx",
    revision: "PaddlePaddle/PP-OCRv6_small_det_onnx@28fe5895c24fd108c19eb3e8479f4ab385fbfc62",
    bytes: 9880512,
    sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
  },
  {
    role: "rec",
    file: "PP-OCRv6_small_rec.onnx",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx",
    revision: "PaddlePaddle/PP-OCRv6_small_rec_onnx@b8f84f0b80c529de40b4fbb3544b84fa7233a513",
    bytes: 21159378,
    sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
  },
  {
    role: "dict",
    file: "PP-OCRv6_small_rec.txt",
    url: "https://huggingface.co/chenmohan/web-sdk-pp-ocrv6/resolve/fcb55226431520f397cbc93a80119f5cf32f355a/dictionaries/PP-OCRv6_small_rec.txt",
    revision: "chenmohan/web-sdk-pp-ocrv6@fcb55226431520f397cbc93a80119f5cf32f355a",
    bytes: 93658,
    // No upstream SHA-256 exists for a plain file: the byte count is the pin, and the hash below is
    // computed on fetch and then enforced by the provider on every model load.
    sha256: null,
  },
];

/**
 * Preprocessing for these weights. Everything below is transcribed from the pinned upstream browser
 * manifest **except two values, which are measured**, because the same two vendor claims were false for
 * Tiny and both fail quietly (ticket 04, DECISIONS/0015 C4):
 *
 *   detection output — advertised `["N",1,"H/4","W/4"]`; `node scripts/inspect-ocr-sessions.mjs --dir
 *   assets/models/candidate` measured 96×160 → [1,1,96,160] and 480×640 → [1,1,480,640], i.e. full
 *   resolution, exactly as Tiny behaves.
 *
 *   recognition activation — advertised `ctc_logits`; the same probe measured every output row summing
 *   to 1.000, i.e. the graph already normalizes. Declaring `logits` would make the provider softmax
 *   again and every word confidence would collapse to ~0.0003 — the failure ticket 04 hit first.
 *
 * Measured 2026-11-04 on the revisions pinned below. If a future revision changes the export, the probe
 * must be re-run and this object corrected; the provider rejects a contradiction rather than shipping it.
 */
const UPSTREAM_PREPROCESSING = {
  detection: {
    inputName: "x",
    outputName: "fetch_name_0",
    inputShape: ["N", 3, "H", "W"],
    outputShape: ["N", 1, "H", "W"],
    preprocessing: {
      colorOrder: "BGR",
      scale: 1 / 255,
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      limitSideLen: 960,
      sizeMultiple: 32,
    },
    postprocessing: { name: "DBPostProcess", threshold: 0.2, boxThreshold: 0.45, unclipRatio: 1.4, minSize: 3, maxCandidates: 3000 },
  },
  recognition: {
    inputName: "x",
    outputName: "fetch_name_0",
    inputShape: ["N", 3, "48", "W"],
    preprocessing: { colorOrder: "BGR", scale: 1 / 255, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], height: 48, baseWidth: 320, maxWidth: 960 },
    decoder: {
      name: "CTCLabelDecode",
      blankIndex: 0,
      dictionaryEntries: 18709,
      // Measured, not advertised: output rows sum to 1.000. Upstream says `ctc_logits`, which is what
      // the Tiny export was wrongly declared too, and a pre-softmax graph run through softmax again
      // silently destroys every confidence value.
      outputActivation: "softmax",
    },
  },
};

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(candidateDir, { recursive: true });
const recorded = [];
for (const spec of ASSETS) {
  const target = path.join(candidateDir, spec.file);
  let bytes = checkOnly ? await readFile(target).catch(() => null) : null;
  if (bytes === null) {
    process.stdout.write(`fetching ${spec.file} from ${spec.revision}\n`);
    const response = await fetch(spec.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${spec.file}: ${response.status} ${response.statusText} from ${spec.url}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(target, bytes);
  }
  if (bytes.byteLength !== spec.bytes) {
    throw new Error(`${spec.file}: ${bytes.byteLength} bytes, pinned ${spec.bytes} — not trusted, not written into a manifest`);
  }
  const digest = sha256Hex(bytes);
  if (spec.sha256 !== null && digest !== spec.sha256) {
    throw new Error(`${spec.file}: sha256 ${digest} does not match the upstream pin ${spec.sha256}`);
  }
  if (spec.sha256 === null) {
    process.stdout.write(`${spec.file}: no upstream hash pin exists for a plain file — recorded ${digest}\n`);
  }
  recorded.push({ role: spec.role, file: spec.file, url: `/assets/models/candidate/${spec.file}`, bytes: bytes.byteLength, sha256: digest, revision: spec.revision });
}

const total = recorded.reduce((sum, asset) => sum + asset.bytes, 0);
const manifest = {
  schemaVersion: 1,
  provider: "pp-ocrv6",
  providerVersion: "1.0.0",
  preset: "small",
  license: "Apache-2.0",
  // Marks this set as a candidate measured by ticket 09b, never as the shipped default.
  status: "candidate — gate G3 comparison only (DECISIONS/0015); not served by the product",
  upstream: { collection: "https://huggingface.co/collections/PaddlePaddle/pp-ocrv6", browserManifest: BROWSER_MANIFEST, revisions: Object.fromEntries(recorded.map((asset) => [asset.role, asset.revision])) },
  assets: recorded.map(({ role, file, url, bytes, sha256 }) => ({ role, file, url, bytes, sha256 })),
  ...UPSTREAM_PREPROCESSING,
  readingOrder: { toleranceRatio: 0.5 },
};

await writeFile(path.join(candidateDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(
  `${checkOnly ? "verified" : "fetched and verified"} ${recorded.length} assets, ${total} bytes (${(total / 1e6).toFixed(2)} MB) into assets/models/candidate/\n` +
    `next: node scripts/inspect-ocr-sessions.mjs --dir assets/models/candidate  # measures the two declared values\n`
);
