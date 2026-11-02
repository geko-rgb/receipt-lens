import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CORD_EXCLUDED_FIELDS, CORD_LABELED_FIELDS, mapCordReceipt } from "./datasets/cord.js";
import {
  readCordRows,
  readManifest,
  readSroieRows,
  snapshotHashOf,
  verifyPins,
} from "./datasets/read.js";
import { SROIE_EXCLUDED_FIELDS, SROIE_LABELED_FIELDS, mapSroieReceipt } from "./datasets/sroie.js";
import type { BenchmarkField, DatasetName, LabeledReceipt } from "./datasets/types.js";
import { redactWords, type HeaderEntities, type Redaction, type UnmatchedEntity } from "./fixtures/redact.js";
import { assertSplitsDisjoint, serializeFixtureFile, serializeReceiptFile, tallyRedactions } from "./fixtures/serialize.js";

// Runs from benchmarks/dist/ after tsc, so the repo root is two levels up.
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const datasetRoot = path.join(repoRoot, "benchmarks", "datasets");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

/** DECISIONS/0004: dev comes from CORD valid + a leading SROIE train slice, eval from the test splits. */
const devSroieReceipts = 150;
/** docs/storage.md: 50 MB ceiling on benchmarks/fixtures, and nothing over 1 MB committed. */
const fixturesCeilingBytes = 50 * 1024 * 1024;
const singleFileCeilingBytes = 1024 * 1024;

interface Target {
  readonly dataset: DatasetName;
  readonly split: "dev" | "eval";
  readonly sourceSplit: string;
  readonly limit?: number;
  readonly fieldsLabeled: readonly BenchmarkField[];
  readonly fieldsExcluded: readonly BenchmarkField[];
  readonly exclusionReason: string;
  readonly referenceOcrSource: string;
}

const targets: Target[] = [
  {
    dataset: "cord-v2",
    split: "dev",
    sourceSplit: "validation",
    fieldsLabeled: CORD_LABELED_FIELDS,
    fieldsExcluded: CORD_EXCLUDED_FIELDS,
    exclusionReason:
      "CORD annotates no tip line and no round-off line; those fields are excluded from scoring, never null-scored (DECISIONS/0004, ADR-003)",
    referenceOcrSource: "CORD ground_truth.valid_line words and quads (the dataset's own line grouping)",
  },
  {
    dataset: "cord-v2",
    split: "eval",
    sourceSplit: "test",
    fieldsLabeled: CORD_LABELED_FIELDS,
    fieldsExcluded: CORD_EXCLUDED_FIELDS,
    exclusionReason:
      "CORD annotates no tip line and no round-off line; those fields are excluded from scoring, never null-scored (DECISIONS/0004, ADR-003)",
    referenceOcrSource: "CORD ground_truth.valid_line words and quads (the dataset's own line grouping)",
  },
  {
    dataset: "sroie",
    split: "dev",
    sourceSplit: "train",
    limit: devSroieReceipts,
    fieldsLabeled: SROIE_LABELED_FIELDS,
    fieldsExcluded: SROIE_EXCLUDED_FIELDS,
    exclusionReason:
      "SROIE annotates company/date/address/total only, so it is a grand-total-only contract; item-level and charge fields do not exist in this dataset (DECISIONS/0002)",
    referenceOcrSource: "SROIE words + rectangles, lines reconstructed by fixed-tolerance y-clustering (harness-derived, DECISIONS/0003)",
  },
  {
    dataset: "sroie",
    split: "eval",
    sourceSplit: "test",
    fieldsLabeled: SROIE_LABELED_FIELDS,
    fieldsExcluded: SROIE_EXCLUDED_FIELDS,
    exclusionReason:
      "SROIE annotates company/date/address/total only, so it is a grand-total-only contract; item-level and charge fields do not exist in this dataset (DECISIONS/0002)",
    referenceOcrSource: "SROIE words + rectangles, lines reconstructed by fixed-tolerance y-clustering (harness-derived, DECISIONS/0003)",
  },
];

interface Generated {
  readonly receipts: readonly LabeledReceipt[];
  /** one log per receipt, index-aligned with `receipts` */
  readonly redactionLogs: readonly (readonly Redaction[])[];
  readonly unmatchedEntities: readonly UnmatchedEntity[];
  /** dataset/sourceSplit/row — the identity used to prove dev and eval cannot overlap */
  readonly sourceIds: readonly string[];
}

function redactReceipt(receipt: LabeledReceipt, entities: HeaderEntities): { receipt: LabeledReceipt; redactions: readonly Redaction[]; unmatched: readonly UnmatchedEntity[] } {
  const wordLines = receipt.ocr.lines.map((line) => line.words.map((word) => word.text));
  const result = redactWords(wordLines, entities);
  const lines = receipt.ocr.lines.map((line, lineIndex) => {
    const words = line.words.map((word, wordIndex) => ({ ...word, text: result.lines[lineIndex]![wordIndex]! }));
    return { ...line, text: words.map((word) => word.text).join(" "), words };
  });
  return {
    receipt: { ...receipt, ocr: { ...receipt.ocr, lines } },
    redactions: result.redactions,
    unmatched: result.unmatchedEntities,
  };
}

async function generate(target: Target, snapshotHash: string): Promise<Generated> {
  const manifest = await readManifest(datasetRoot);
  const dataset = manifest.datasets[target.dataset];
  const receipts: LabeledReceipt[] = [];
  const redactionLogs: (readonly Redaction[])[] = [];
  const unmatched: UnmatchedEntity[] = [];

  if (target.dataset === "cord-v2") {
    const rows = await readCordRows(datasetRoot, dataset, target.sourceSplit as "validation" | "test");
    for (const [index, row] of rows.slice(0, target.limit).entries()) {
      const mapped = mapCordReceipt(row, { receiptId: `${target.dataset}/${target.split}/${index}`, snapshotHash });
      // CORD's snapshot carries no business or address annotation, so header anchoring has
      // nothing to work from here; label-anchored rules still apply (DECISIONS/0005).
      const result = redactReceipt(mapped, {});
      receipts.push(result.receipt);
      redactionLogs.push(result.redactions);
    }
  } else {
    const rows = await readSroieRows(datasetRoot, dataset, target.sourceSplit as "train" | "test");
    for (const [index, row] of rows.slice(0, target.limit).entries()) {
      const mapped = mapSroieReceipt(row, { receiptId: `${target.dataset}/${target.split}/${index}`, snapshotHash });
      // company and address anchor the header redaction, then disappear: only `total`
      // survives as an annotation (DECISIONS/0005).
      const result = redactReceipt(mapped, { company: row.entities.company, address: row.entities.address });
      receipts.push(result.receipt);
      redactionLogs.push(result.redactions);
      unmatched.push(...result.unmatched);
    }
  }

  return {
    receipts,
    redactionLogs,
    unmatchedEntities: unmatched,
    sourceIds: receipts.map((receipt) => `${receipt.dataset}/${target.sourceSplit}/${receipt.receiptId.split("/").at(-1)}`),
  };
}

async function collectExpected(): Promise<Map<string, string>> {
  const manifest = await readManifest(datasetRoot);
  const files = new Map<string, string>();
  const devIds: string[] = [];
  const evalIds: string[] = [];

  for (const [key, dataset] of Object.entries(manifest.datasets)) {
    await verifyPins(datasetRoot, key as "cord-v2" | "sroie", dataset);
  }

  for (const target of targets) {
    const dataset = manifest.datasets[target.dataset];
    const snapshotHash = snapshotHashOf(dataset);
    const generated = await generate(target, snapshotHash);
    (target.split === "dev" ? devIds : evalIds).push(...generated.sourceIds);

    const header = serializeFixtureFile({
      provenance: {
        dataset: target.dataset,
        split: target.split,
        sourceSplit: target.sourceSplit,
        snapshotHash,
        source: dataset.source,
        license: dataset.license,
        fieldsLabeled: target.fieldsLabeled,
        fieldsExcluded: target.fieldsExcluded,
        exclusionReason: target.exclusionReason,
        referenceOcrSource: target.referenceOcrSource,
        receipts: generated.receipts.length,
      },
      receipts: generated.receipts,
      redactionCounts: tallyRedactions(generated.redactionLogs.flat()),
      unmatchedEntities: generated.unmatchedEntities,
    });
    files.set(path.join(fixturesRoot, target.split, `${target.dataset}.provenance.json`), header);

    generated.receipts.forEach((receipt, index) => {
      files.set(
        path.join(fixturesRoot, target.split, target.dataset, `${String(index).padStart(3, "0")}.json`),
        serializeReceiptFile(receipt, generated.redactionLogs[index]!)
      );
    });
    console.log(
      `${target.split}/${target.dataset} (${target.sourceSplit}): ${generated.receipts.length} receipts, ${generated.redactionLogs.flat().length} redactions, ${generated.unmatchedEntities.length} unmatched entities`
    );
  }

  assertSplitsDisjoint(devIds, evalIds);
  return files;
}

async function writeFiles(files: Map<string, string>): Promise<void> {
  for (const [file, contents] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }
  // remove stale outputs so a deleted receipt cannot linger in the committed set
  for (const split of ["dev", "eval"] as const) {
    for (const dataset of ["cord-v2", "sroie"] as const) {
      const dir = path.join(fixturesRoot, split, dataset);
      const wanted = new Set(
        [...files.keys()].filter((file) => file.startsWith(`${dir}${path.sep}`)).map((file) => path.basename(file))
      );
      const existing = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of existing) {
        if (entry.isFile() && entry.name.endsWith(".json") && !wanted.has(entry.name)) {
          await rm(path.join(dir, entry.name));
        }
      }
    }
  }
}

function guardSizes(files: Map<string, string>): void {
  let total = 0;
  for (const [file, contents] of files) {
    const bytes = Buffer.byteLength(contents);
    total += bytes;
    if (bytes > singleFileCeilingBytes) {
      throw new Error(`${file} is ${bytes} bytes, over the 1 MB commit ceiling (docs/storage.md) — split it before committing`);
    }
  }
  if (total > fixturesCeilingBytes) {
    throw new Error(`benchmarks/fixtures totals ${total} bytes, over the 50 MB ceiling (docs/storage.md)`);
  }
  console.log(`fixtures: ${files.size} files, ${total} bytes total`);
}

async function check(files: Map<string, string>): Promise<boolean> {
  const problems: string[] = [];
  for (const [file, contents] of files) {
    const onDisk = await readFile(file, "utf8").catch(() => null);
    if (onDisk === null) problems.push(`missing ${path.relative(repoRoot, file)}`);
    else if (onDisk !== contents) problems.push(`differs ${path.relative(repoRoot, file)}`);
  }
  for (const split of ["dev", "eval"] as const) {
    for (const dataset of ["cord-v2", "sroie"] as const) {
      const dir = path.join(fixturesRoot, split, dataset);
      const wanted = new Set([...files.keys()].filter((file) => file.startsWith(`${dir}${path.sep}`)));
      const existing = await readdir(dir).catch(() => []);
      for (const entry of existing) {
        const full = path.join(dir, entry);
        if (entry.endsWith(".json") && !wanted.has(full)) problems.push(`stale ${path.relative(repoRoot, full)}`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(`generate:fixtures --check found ${problems.length} problem(s):`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    return false;
  }
  console.log(`generate:fixtures --check: ${files.size} files byte-identical to the committed fixtures`);
  return true;
}

const checkMode = process.argv.includes("--check");
const files = await collectExpected();
guardSizes(files);

if (checkMode) {
  process.exit((await check(files)) ? 0 : 1);
} else {
  await writeFiles(files);
  console.log(`wrote ${files.size} fixture files`);
}
