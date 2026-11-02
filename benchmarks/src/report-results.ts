import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadFixtureSplit } from "./fixtures/load.js";
import { renderReport, scoreReceipts } from "./scoring/report.js";

/**
 * Writes the machine-readable benchmark result to a stable committed location, so a
 * published number can always be regenerated from the fixtures it came from
 * (ADR-003: README numbers are generated, never hand-typed).
 *
 *   node benchmarks/dist/report-results.js [--split dev|eval] [--check]
 *
 * Deterministic output: no timestamp inside the file. The date belongs in the filename
 * of an eval run, never in content that is diffed.
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");
const resultsRoot = path.join(repoRoot, "benchmarks", "results");

const splitIndex = process.argv.indexOf("--split");
const split = (splitIndex === -1 ? "dev" : process.argv[splitIndex + 1]) as "dev" | "eval";
const checkMode = process.argv.includes("--check");

const scores = [];
for (const dataset of ["cord-v2", "sroie"] as const) {
  const { provenance, receipts } = await loadFixtureSplit(fixturesRoot, split, dataset);
  scores.push(
    scoreReceipts(receipts, {
      dataset,
      fieldsLabeled: provenance.fieldsLabeled,
      fieldsExcluded: provenance.fieldsExcluded,
    })
  );
}

const report = renderReport(scores);
const target = path.join(resultsRoot, `${split}-null-bootstrap.json`);

if (checkMode) {
  const committed = await readFile(target, "utf8").catch(() => null);
  if (committed === null) {
    console.error(`missing committed result ${path.relative(repoRoot, target)} — run: pnpm report:results --split ${split}`);
    process.exit(1);
  }
  if (committed !== report) {
    console.error(`${path.relative(repoRoot, target)} does not match a fresh run over the committed fixtures`);
    process.exit(1);
  }
  console.log(`${path.relative(repoRoot, target)} matches a fresh run over the committed fixtures`);
} else {
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(target, report, "utf8");
  console.log(`wrote ${path.relative(repoRoot, target)}`);
}
