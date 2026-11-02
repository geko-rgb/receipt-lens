import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtureSplit } from "./fixtures/load.js";
import { renderReport, scoreReceipts, type DatasetScore } from "./scoring/report.js";

// The permanent null-parser bootstrap (ADR-003, ticket 03a's non-negotiable):
// against the *real* committed dev fixtures, a parser that produces nothing must score
// exactly zero on strict match and on every field, and must not produce NaN anywhere.
// If this file goes red, no published number from this harness can be trusted.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

async function devScores(): Promise<DatasetScore[]> {
  const scores: DatasetScore[] = [];
  for (const dataset of ["cord-v2", "sroie"] as const) {
    const { provenance, receipts } = await loadFixtureSplit(fixturesRoot, "dev", dataset);
    scores.push(
      scoreReceipts(receipts, {
        dataset,
        fieldsLabeled: provenance.fieldsLabeled,
        fieldsExcluded: provenance.fieldsExcluded,
      })
    );
  }
  return scores;
}

describe("null-parser bootstrap over the committed dev fixtures", () => {
  it("runs against non-empty data from both datasets", async () => {
    const scores = await devScores();

    expect(scores.map((score) => score.receipts)).toEqual([100, 150]);
    for (const score of scores) expect(score.receipts).toBeGreaterThan(0);
  });

  it("scores exactly 0 on the strict tier and on every field", async () => {
    for (const score of await devScores()) {
      expect(score.strict.matched).toBe(0);
      expect(score.strict.rate).toBe(0);
      for (const field of score.fields) {
        expect([field.tp, field.precision, field.recall, field.f1], `${score.dataset}.${field.field}`).toEqual([0, 0, 0, 0]);
      }
    }
  });

  it("produces no NaN and no non-finite ratio anywhere in the report", async () => {
    const report = renderReport(await devScores());

    expect(report).not.toContain("NaN");
    const parsed = JSON.parse(report) as { datasets: { fields: { precision: number; recall: number; f1: number }[] }[] };
    for (const dataset of parsed.datasets) {
      for (const field of dataset.fields) {
        for (const value of [field.precision, field.recall, field.f1]) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it("fails the build the same way twice: the report is byte-identical across runs", async () => {
    const first = renderReport(await devScores());
    const second = renderReport(await devScores());

    expect(first).toBe(second);
    expect(JSON.parse(first).parser).toBe("null");
  });

  it("reports false negatives, never false positives, since nothing was predicted", async () => {
    for (const score of await devScores()) {
      for (const field of score.fields) {
        expect(field.fp, `${score.dataset}.${field.field}`).toBe(0);
      }
    }
  });

  it("excludes the fields each dataset never labelled instead of null-scoring them", async () => {
    const scores = await devScores();
    const sroie = scores.find((score) => score.dataset === "sroie")!;
    const cord = scores.find((score) => score.dataset === "cord-v2")!;

    expect(sroie.fields.map((field) => field.field)).toEqual(["grandTotal"]);
    expect(sroie.excludedFields).toContain("item.name");
    expect(cord.fields.map((field) => field.field)).toContain("item.name");
    expect(cord.excludedFields).toEqual(["roundOff", "tip"]);
  });
});
