import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@receipt-lens/core";
import { loadFixtureSplit } from "./fixtures/load.js";
import { measureDatasetAccuracy, renderAccuracyArtifact, type AccuracySpec, type DatasetAccuracy } from "./scoring/accuracy.js";

/**
 * Ticket 09b — the headline measurement (DECISIONS/0014 M1): the shipped `parse()` scored over the
 * committed reference-OCR fixtures, in Node, with no browser, no model file and no dataset download.
 *
 *   node benchmarks/dist/measure-accuracy.js [--split dev|eval] [--check]
 *
 * `--check` regenerates and compares against the committed bytes, which is the CI gate: the published
 * table is a function of this file, and this file is a function of the committed fixtures plus the
 * shipped parser. Deterministic by construction — no timestamp in content, fixed key order, no host
 * paths — with the date carried by the archive filename instead, exactly as `report-results.js` does.
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");
const resultsRoot = path.join(repoRoot, "benchmarks", "results");

const splitIndex = process.argv.indexOf("--split");
const split = (splitIndex === -1 ? "dev" : process.argv[splitIndex + 1]) as "dev" | "eval";
const checkMode = process.argv.includes("--check");

/** ADR-010 + DECISIONS/0002/0004: what each dataset can actually be scored on, printed beside its numbers. */
const specs: Record<string, Omit<AccuracySpec, "fieldsLabeled" | "fieldsExcluded" | "license">> = {
  "cord-v2": {
    dataset: "cord-v2",
    language: "Indonesian — out-of-language layout stress, never part of the English headline claim (ADR-010)",
    coverage:
      "item name/qty/unitPrice/lineTotal plus subtotal, grandTotal, serviceCharge, discount and taxTotal; no tip and no round-off annotation exists in the pinned snapshot",
  },
  sroie: {
    dataset: "sroie",
    language: "English — the headline language for the v1 product (ADR-010)",
    coverage:
      "grandTotal only: the dataset annotates company/date/address/total and no item, charge or subtotal field, so nothing item-level is scored from it and it cannot produce an item-price number (DECISIONS/0002)",
  },
};

const notes = [
  "confidence floors (0.50 critical / 0.70 warning) run on no cell in this mode: reference OCR supplies 0 scored words, so every receipt takes confidence_unavailable. The floors are declared defaults, not calibrated, and are exercised end-to-end only (DECISIONS/0014 M7.4).",
  "zero_items counts receipts where itemization could not be proven, not parser failures: a single-total slip and a failed parse are the same finding (DECISIONS/0014 M7.1).",
  "the arithmetic_item_sum criticals are charge and tender rows that ticket 05 classified as items, not price-parse errors, and are not cited as accuracy evidence (DECISIONS/0014 M7.2, ticket 20).",
  "detected unit prices are published as two populations — read off the row, and a line total promoted on an assumed qty 1 — never as one number (DECISIONS/0014 M7.3).",
  "item.name is reported from the matcher, matchItems(τ=0.70, money_gate=on). Ticket 05's substring-containment reachability figure is withdrawn from publication (DECISIONS/0014 M5).",
];

const datasets: DatasetAccuracy[] = [];
for (const key of ["cord-v2", "sroie"] as const) {
  const { provenance, receipts } = await loadFixtureSplit(fixturesRoot, split, key);
  datasets.push(
    measureDatasetAccuracy(
      receipts,
      {
        ...specs[key]!,
        fieldsLabeled: provenance.fieldsLabeled,
        fieldsExcluded: provenance.fieldsExcluded,
        license: provenance.license,
      },
      parse
    )
  );
}

const artifact = renderAccuracyArtifact(
  {
    mode: "parser-only",
    split,
    parser: "shipped @receipt-lens/core parse() (ticket 06), validate() (ticket 07)",
    ocr: {
      provider: "dataset-reference-ocr",
      tier: "none — no OCR runs in this mode (DECISIONS/0003)",
      version: datasets.map((dataset) => dataset.providerVersion).join(", "),
      manifestHash: null,
      assetBytes: null,
      imageSource: "none — fixtures are text and boxes, not images",
      inferenceMs: null,
    },
  },
  datasets,
  notes
);

const canonical = path.join(resultsRoot, `parser-only-${split}.json`);
if (checkMode) {
  const committed = await readFile(canonical, "utf8").catch(() => null);
  if (committed === null) {
    console.error(`missing committed result ${path.relative(repoRoot, canonical)} — run: pnpm measure:accuracy -- --split ${split}`);
    process.exit(1);
  }
  if (committed !== artifact) {
    console.error(`${path.relative(repoRoot, canonical)} does not match a fresh run of parse() over the committed ${split} fixtures`);
    process.exit(1);
  }
  console.log(`${path.relative(repoRoot, canonical)} matches a fresh run over the committed ${split} fixtures`);
} else {
  await mkdir(resultsRoot, { recursive: true });
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  await writeFile(canonical, artifact, "utf8");
  await writeFile(path.join(resultsRoot, `parser-only-${split}-${day}-${sha}.json`), artifact, "utf8");
  console.log(`wrote ${path.relative(repoRoot, canonical)} and the dated archive copy`);
}
