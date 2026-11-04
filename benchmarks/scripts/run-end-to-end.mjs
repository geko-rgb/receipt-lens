#!/usr/bin/env node
/**
 * Ticket 09b — the end-to-end accuracy measurement (DECISIONS/0014 M1, M2): receipt **images** in,
 * real OCR in headless Chromium, the shipped `parse()` in Node, scored by the committed scorers.
 *
 *   node benchmarks/scripts/run-end-to-end.mjs [--tier tiny|small] [--split dev|eval]
 *                                              [--limit N] [--keep-ocr] [--out path]
 *
 * Why the shape it has:
 *   - **One page, one model load, many receipts.** `harness/dist/batch.html` is a second bundle so the
 *     footprint page keeps its measured bytes (DECISIONS/0012 F11); loading the model once per run is
 *     what makes 250 or 461 receipts a minutes-long job instead of an hours-long one.
 *   - **`parse()` runs in Node, not in the page.** The parser is pure and isomorphic (§3), so the only
 *     difference between this artifact and `parser-only-<split>.json` is where the `OcrResult` came from.
 *     That is the whole point of the two modes (DECISIONS/0014 M2): the gap between the two files is the
 *     OCR gap, and nothing else moves between them.
 *   - **Images are addressed by the fixture's own row index.** `generate-fixtures.ts` names each fixture
 *     after the dataset row it was built from (`sroie/dev/7` = row 7 of the SROIE train split), so image
 *     `n` and fixture `n` are the same receipt by construction. The pairing is not trusted: every image's
 *     decoded size is checked against the size the dataset annotated for that row, and a mismatch aborts
 *     the run rather than scoring a receipt against somebody else's gold.
 *   - **Nothing identifiable is committed.** Results carry counts and outcomes. Raw OCR is written under
 *     `harness/out/` (git-ignored) only when `--keep-ocr` is passed, because the default must be the
 *     privacy-preserving one (DECISIONS/0005, DECISIONS/0014 M6.3).
 *
 * Fails loud, in the same spirit as DECISIONS/0012 F9: a missing tier manifest, an image/fixture size
 * mismatch, an OCR exception on any receipt, or a run that read no images at all writes no artifact.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { parse } from "@receipt-lens/core";
import { startServer } from "../../harness/serve.mjs";
import { loadFixtureSplit } from "../dist/fixtures/load.js";
import { measureDatasetAccuracy, renderAccuracyArtifact } from "../dist/scoring/accuracy.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resultsDir = path.join(repoRoot, "benchmarks", "results");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");
const datasetRoot = path.join(repoRoot, "benchmarks", "datasets");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const tier = flag("tier", "tiny");
const split = flag("split", "dev");
const limit = Number(flag("limit", "0"));
const keepOcr = argv.includes("--keep-ocr");
/**
 * Runs the whole pipeline and prints what it measured, but writes no artifact. `--limit` exists for
 * plumbing checks, and a partial run must never end up in `benchmarks/results/` looking like a published
 * measurement (DECISIONS/0014 M6.1).
 */
const dryRun = argv.includes("--dry-run") || limit > 0;
if (!["tiny", "small"].includes(tier)) throw new Error(`--tier must be tiny or small, got ${tier}`);
if (!["dev", "eval"].includes(split)) throw new Error(`--split must be dev or eval, got ${split}`);

/**
 * The tier under test. Tiny is the committed default in `assets/models/`; Small is fetched to
 * `assets/models/candidate/`, which is git-ignored — a candidate that has not won gate G3 does not join
 * the shipped asset set, and the footprint check keeps verifying the tier the product actually serves.
 */
const TIERS = {
  tiny: { label: "PP-OCRv6 Tiny", assetBaseUrl: "/assets/models/", manifest: "assets/models/manifest.json" },
  small: { label: "PP-OCRv6 Small", assetBaseUrl: "/assets/models/candidate/", manifest: "assets/models/candidate/manifest.json" },
};
const tierConfig = TIERS[tier];
const manifestPath = path.join(repoRoot, tierConfig.manifest);

const manifestBytes = await readFile(manifestPath).catch(() => null);
if (manifestBytes === null) {
  throw new Error(
    `no model manifest at ${path.relative(repoRoot, manifestPath)} — for the candidate tier run \`node benchmarks/scripts/fetch-candidate-model.mjs --tier ${tier}\` first: it fetches, verifies every upstream SHA-256 and writes that manifest`
  );
}
const modelManifest = JSON.parse(manifestBytes.toString("utf8"));

const notes = [
  "gold annotations are the PII-redacted fixtures (DECISIONS/0005) while predictions come from un-redacted images; no scored cell carries a redacted token — SROIE scores grandTotal only and CORD scores item and bill-level money",
  "line grouping in this mode is the provider's reading-order view (0.5 × median word height, DECISIONS/0007), not the fixture grouping, so row segmentation error is inside these numbers rather than excluded from them",
  "real OCR supplies a confidence score on every word, which is the first place the 0.50/0.70 floors run at all; running them is not calibrating them (DECISIONS/0014 M7.4)",
  "still a ceiling: the parser underneath these numbers was tuned against dev/ (DECISIONS/0004)",
];

const stats = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    max: round(sorted[sorted.length - 1]),
  };
};
const round = (value) => Math.round(value * 1e6) / 1e6;

const datasetManifest = JSON.parse(await readFile(path.join(datasetRoot, "dataset-manifest.json"), "utf8"));

/** The same file-selection rule `datasets/read.ts` uses, so images and fixtures come from one pin. */
function sourceFile(datasetKey, sourceSplit) {
  const dataset = datasetManifest.datasets[datasetKey];
  const file = dataset.files.find((entry) => entry.name.includes(sourceSplit));
  if (!file) throw new Error(`no pinned ${sourceSplit} file for ${datasetKey} in the dataset manifest`);
  return { ...file, datasetKey };
}

/** dataset/split/N in fixture order — the row index `generate-fixtures.ts` assigned from the parquet. */
function rowIndexFrom(id) {
  return Number(id.split("/").at(-1));
}

const languages = {
  "cord-v2": "Indonesian — out-of-language layout stress, never part of the English headline claim (ADR-010)",
  sroie: "English — the headline language for the v1 product (ADR-010)",
};
const coverages = {
  "cord-v2":
    "item name/qty/unitPrice/lineTotal plus subtotal, grandTotal, serviceCharge, discount and taxTotal; no tip and no round-off annotation exists in the pinned snapshot",
  sroie:
    "grandTotal only: the dataset annotates company/date/address/total and no item, charge or subtotal field, so nothing item-level is scored from it and it cannot produce an item-price number (DECISIONS/0002)",
};

console.log(`tier ${tierConfig.label} · manifest ${tierConfig.manifest} · preset ${modelManifest.preset} · ${modelManifest.assets.length} assets, ${modelManifest.assets.reduce((sum, a) => sum + a.bytes, 0)} bytes`);

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const origins = new Set();
page.on("request", (request) => {
  try {
    origins.add(new URL(request.url()).origin);
  } catch {
    /* data: / blob: URLs are not origins */
  }
});

const datasets = [];
const imageSources = [];
const inferenceTimes = [];
const failures = [];
let imageBytes = 0;

try {
  await page.goto(`${server.url}dist/batch.html`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__receiptLensBatch), undefined, { timeout: 60_000 });
  const info = await page.evaluate((options) => window.__receiptLensBatch.init(options), { assetBaseUrl: tierConfig.assetBaseUrl });
  console.log(`models loaded in ${Math.round(info.loadMs)} ms · ${info.version} · ${info.assetBytes} bytes · manifest ${info.manifestHash?.slice(0, 12)}`);

  for (const key of ["cord-v2", "sroie"]) {
    const { provenance, receipts } = await loadFixtureSplit(fixturesRoot, split, key);
    const wanted = receipts.map((receipt) => rowIndexFrom(receipt.receiptId));
    const taken = limit > 0 ? wanted.slice(0, limit) : wanted;
    if (taken.length === 0) continue;

    const source = sourceFile(key, provenance.sourceSplit);
    const parquet = path.join(datasetRoot, "raw", key, source.name);
    const buffer = await asyncBufferFromFile(parquet);
    console.log(`${key}/${split}: reading ${taken.length} images from ${source.name}`);
    // `utf8: false` because `image.bytes` is an unannotated BYTE_ARRAY: hyparquet's default decoder
    // turns binary into a lossy UTF-8 string, and a mangled JPEG decodes to IMAGE_UNREADABLE rather
    // than to a receipt.
    const rows = await parquetReadObjects({ file: buffer, columns: ["image"], rowStart: 0, rowEnd: Math.max(...taken) + 1, utf8: false });

    const scored = [];
    for (const index of taken) {
      const fixture = receipts[index];
      const image = rows[index]?.image;
      if (!fixture || !image || !image.bytes) {
        failures.push({ receiptId: fixture?.receiptId ?? `${key}/${split}/${index}`, code: "IMAGE_MISSING" });
        continue;
      }
      const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes);
      imageBytes += bytes.byteLength;
      const base64 = Buffer.from(bytes).toString("base64");
      const mime = /\.png$/i.test(image.path ?? "") ? "image/png" : "image/jpeg";
      const outcome = await page.evaluate((args) => window.__receiptLensBatch.run(...args), [base64, mime, image.path ?? "receipt.jpg"]);
      if (!outcome.ok) {
        failures.push({ receiptId: fixture.receiptId, code: outcome.error?.code ?? outcome.error?.name ?? "RECOGNIZE_FAILED" });
        continue;
      }
      // The integrity check on the row-index pairing: the dataset annotated this row's pixel size, and
      // the image that came back has to decode to it.
      if (
        outcome.ocr.imageSize.width !== fixture.ocr.imageSize.width ||
        outcome.ocr.imageSize.height !== fixture.ocr.imageSize.height
      ) {
        failures.push({
          receiptId: fixture.receiptId,
          code: "IMAGE_SIZE_MISMATCH",
          detail: { decoded: outcome.ocr.imageSize, annotated: fixture.ocr.imageSize },
        });
        continue;
      }
      inferenceTimes.push(outcome.inferenceMs);
      if (keepOcr) {
        const dir = path.join(repoRoot, "harness", "out", "end-to-end", tier, split, key);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `${path.basename(fixture.receiptId)}.ocr.json`), JSON.stringify(outcome.ocr, null, 2));
      }
      scored.push({ ...fixture, ocr: outcome.ocr });
    }

    imageSources.push({ dataset: key, file: source.name, bytes: source.bytes, sha256: source.sha256, receiptsRead: scored.length });
    datasets.push(
      measureDatasetAccuracy(
        scored,
        {
          dataset: key,
          language: languages[key],
          coverage: coverages[key],
          snapshotHash: provenance.snapshotHash,
          fieldsLabeled: provenance.fieldsLabeled,
          fieldsExcluded: provenance.fieldsExcluded,
          license: provenance.license,
        },
        parse
      )
    );
    console.log(`${key}/${split}: ${scored.length} receipts scored, strict ${datasets.at(-1).strict.matched}/${datasets.at(-1).strict.scoreable}`);
  }

  if (datasets.length === 0) throw new Error("no dataset produced a single scored receipt — nothing to publish");
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 20)) console.error(`FAILED ${failure.receiptId}: ${failure.code} ${JSON.stringify(failure.detail ?? "")}`);
    throw new Error(`${failures.length} receipt(s) did not complete: an image that cannot be paired with its gold is not a measurement`);
  }

  const artifact = renderAccuracyArtifact(
    {
      mode: "end-to-end",
      split,
      parser: "shipped @receipt-lens/core parse() (ticket 06), validate() (ticket 07) — identical code path to parser-only mode",
      ocr: {
        provider: info.provider,
        tier: tierConfig.label,
        version: info.version,
        manifestHash: info.manifestHash,
        assetBytes: info.assetBytes,
        imageSource: imageSources,
        inferenceMs: stats(inferenceTimes),
        runtime: { executionProvider: "wasm", numThreads: info.session?.numThreads ?? null, pageRequestOrigins: [...origins].sort() },
        receiptImageBytes: imageBytes,
        modelLoadMs: round(info.loadMs),
      },
    },
    datasets,
    notes
  );

  if (dryRun) {
    console.log(`dry run (${limit} per dataset max) — nothing written to benchmarks/results/`);
    for (const dataset of datasets) {
      console.log(
        `  ${dataset.dataset}: ${dataset.receipts} receipts, strict ${dataset.strict.matched}/${dataset.strict.scoreable}, ` +
          `items ${dataset.items.predicted} predicted / ${dataset.items.gold} gold / ${dataset.items.matchedPairs} pairs, ` +
          `words ${dataset.confidence.words} (${dataset.confidence.scoredWords} scored), ` +
          `grandTotal exact ${dataset.receiptRecords.filter((record) => record.grandTotal === "exact").length}`
      );
    }
  } else {
    const canonical = path.join(resultsDir, `end-to-end-${tier}-${split}.json`);
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    await mkdir(resultsDir, { recursive: true });
    await writeFile(canonical, artifact, "utf8");
    await writeFile(path.join(resultsDir, `end-to-end-${tier}-${split}-${day}-${sha}.json`), artifact, "utf8");
    console.log(`wrote ${path.relative(repoRoot, canonical)} and its dated archive copy`);
  }
  if (keepOcr) console.log(`raw OCR retained under harness/out/end-to-end/${tier}/${split}/ (git-ignored; contains un-redacted receipt text)`);
} finally {
  await browser.close();
  await server.close();
}
