import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "@receipt-lens/core";
import { loadFixtureSplit } from "../fixtures/load.js";
import type { DatasetName, LabeledReceipt } from "../datasets/types.js";
import { measureDatasetAccuracy, type DatasetAccuracy } from "./accuracy.js";

// Ticket 09b, seam S8: the accuracy measurement behind every published number (DECISIONS/0014).
//
// Two jobs. It pins what is new in 09b — both matcher configurations published together, the price
// provenance split, the confidence surface — and it re-derives the committed
// `benchmarks/results/parser-only-dev.json` from the fixtures and the shipped parser, then checks it
// against the census ticket 07 committed in `parser/validationPins.test.ts`. If those two ever disagree,
// one of them is a story about a session, and this test says which.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

/** Mirrors `measure-accuracy.ts` exactly, so a disagreement here is a disagreement about the artifact. */
const language: Record<DatasetName, string> = {
  "cord-v2": "Indonesian — out-of-language layout stress, never part of the English headline claim (ADR-010)",
  sroie: "English — the headline language for the v1 product (ADR-010)",
};
const coverage: Record<DatasetName, string> = {
  "cord-v2":
    "item name/qty/unitPrice/lineTotal plus subtotal, grandTotal, serviceCharge, discount and taxTotal; no tip and no round-off annotation exists in the pinned snapshot",
  sroie:
    "grandTotal only: the dataset annotates company/date/address/total and no item, charge or subtotal field, so nothing item-level is scored from it and it cannot produce an item-price number (DECISIONS/0002)",
};

async function dev(key: DatasetName): Promise<readonly LabeledReceipt[]> {
  return (await loadFixtureSplit(fixturesRoot, "dev", key)).receipts;
}

async function measure(key: DatasetName): Promise<DatasetAccuracy> {
  const { provenance, receipts } = await loadFixtureSplit(fixturesRoot, "dev", key);
  return measureDatasetAccuracy(
    receipts,
    {
      dataset: key,
      language: language[key],
      coverage: coverage[key],
      fieldsLabeled: provenance.fieldsLabeled,
      fieldsExcluded: provenance.fieldsExcluded,
      license: provenance.license,
    },
    parse
  );
}

interface AccuracyArtifact {
  readonly mode: string;
  readonly accuracyIsACeiling: boolean;
  readonly protocol: Record<string, unknown>;
  readonly datasets: DatasetAccuracy[];
}

async function committed(): Promise<AccuracyArtifact> {
  return JSON.parse(await readFile(path.join(repoRoot, "benchmarks", "results", "parser-only-dev.json"), "utf8")) as AccuracyArtifact;
}

describe("the money census runs under both matcher configurations (DECISIONS/0008)", () => {
  it("publishes gate-on and gate-off side by side, each naming its τ and its gate state", async () => {
    const cord = await measure("cord-v2");

    expect(cord.money.map((census) => census.matcher)).toEqual(["matchItems(τ=0.7, money_gate=on)", "matchItems(τ=0.7, money_gate=off)"]);
    // Disabling the gate removes a precondition, so it can only ever admit pairs, never refuse one.
    expect(cord.money[1]!.pairs).toBeGreaterThanOrEqual(cord.money[0]!.pairs);
    // And the gate-on census is structurally incapable of reporting a wrong price: that is exactly why a
    // price claim that cites only the on column is not evidence (DECISIONS/0008's paired-gold rule).
    expect(cord.money[0]!.unitPrice.wrong).toBe(0);
    expect(cord.money[0]!.lineTotal.disagree).toBe(0);
    expect(cord.money[1]!.unitPrice.wrong).toBeGreaterThan(0);
  });

  it("the off-census counts are the ones ticket 07 measured: 5 reachable, 3 exact, 2 actively wrong", async () => {
    const cord = await measure("cord-v2");

    expect(cord.money[1]!.unitPrice).toEqual({ goldAnnotated: 5, exact: 3, absent: 0, wrong: 2 });
    expect(cord.money[1]!.lineTotal).toEqual({ bothPresent: 137, agree: 135, disagree: 2 });
  });

  it("SROIE has no item gold at all, so its item census is empty rather than zero-scored", async () => {
    const sroie = await measure("sroie");

    expect(sroie.items.gold).toBe(0);
    expect(sroie.money.every((census) => census.pairs === 0 && census.unitPrice.goldAnnotated === 0)).toBe(true);
    // The one money field SROIE can prove is receipt-level and exact to the integer paise.
    expect(sroie.fields.map((field) => field.field)).toEqual(["grandTotal"]);
  });
});

describe("price provenance is split before any `detected` figure is published (DECISIONS/0014 M7.3)", () => {
  // Re-measured at DECISIONS/0033's head. Ticket 07's figures were 331 / 230 / 101 over 518 items; the table
  // pass adds 39 scored SROIE items (518 → 557), all of them *direct* prices read from a printed rate column,
  // which is why `direct` rises by the whole 39 and `derivative` is unchanged at 229. The accuracy figures
  // themselves do not move (SROIE F1 0.647, CORD 0.473, both identical to the previous head) — SROIE's gold has
  // no item annotations, so the extra items are unscored, not a score claim.
  it("dev's two datasets together reproduce 428 detected / 223 derivative pair", async () => {
    const [cord, sroie] = [await measure("cord-v2"), await measure("sroie")];

    expect({
      detected: cord.provenance.priceSource.detected + sroie.provenance.priceSource.detected,
      derivative: cord.provenance.detectedDerivative + sroie.provenance.detectedDerivative,
      direct: cord.provenance.detectedDirect + sroie.provenance.detectedDirect,
      // DECISIONS/0034 H1 re-measured this: 369 → 428 and `direct` 140 → 205, because a printed `Amount` column
      // now names the line total on 46 more SROIE rows and those rows publish a *read* price, not a promoted one.
      // `derivative` falls 229 → 223 with the same rows that stopped needing the assumed-qty rescue. Every scored
      // field in the committed dev artifact is identical before and after this change, which is the pairing that
      // says the extra prices are read, not invented.
      // Ticket 25: `detected` 428 → 441 and `direct` 205 → 218 (thirteen SROIE items whose price is now read
      // off the row); `derivative` is unmoved at 223, so the split is untouched by the change.
    }).toEqual({ detected: 441, derivative: 223, direct: 218 });
  });

  it("every direct plus derivative equals the detected count, per dataset", async () => {
    for (const key of ["cord-v2", "sroie"] as const) {
      const accuracy = await measure(key);
      expect(accuracy.provenance.detectedDirect + accuracy.provenance.detectedDerivative).toBe(accuracy.provenance.priceSource.detected);
    }
  });

  it("counts every item across both dev datasets, which is the 603 validationPins publishes", async () => {
    const [cord, sroie] = [await measure("cord-v2"), await measure("sroie")];

    // DECISIONS/0033: 518 → 557. The 39 new items are SROIE rows a printed `DESCRIPTION QTY PRICE TOTAL`
    // header re-cut into one product each; CORD is untouched at 245. DECISIONS/0034 H1: 557 → 603 (245 CORD,
    // 358 SROIE), the receipts whose line-total column is headed `AMOUNT`.
    // Ticket 25: 603 → 616 (thirteen SROIE items read off four receipts whose printed quantity column qualifies).
    expect(cord.provenance.items + sroie.provenance.items).toBe(616);
  });
});

describe("confidence in the headline mode (DECISIONS/0014 M7.4)", () => {
  it("reference OCR scores no word, so no floor comparison runs and the artifact says so", async () => {
    const [cord, sroie] = [await measure("cord-v2"), await measure("sroie")];

    expect({
      words: cord.confidence.words + sroie.confidence.words,
      scoredWords: cord.confidence.scoredWords + sroie.confidence.scoredWords,
      lines: cord.confidence.lines + sroie.confidence.lines,
      scoredLines: cord.confidence.scoredLines + sroie.confidence.scoredLines,
    }).toEqual({ words: 10424, scoredWords: 0, lines: 5604, scoredLines: 0 });
    expect([cord.confidence.wordScores, sroie.confidence.wordScores]).toEqual([null, null]);
    expect(cord.confidence.items + sroie.confidence.items).toBe(616);
    expect(cord.confidence.scoredItems + sroie.confidence.scoredItems).toBe(0);
    expect(cord.confidence.itemsCappedByCritical + sroie.confidence.itemsCappedByCritical).toBe(0);
  });
});

describe("the committed dev artifact is this measurement, not a description of it", () => {
  it("re-derives from the fixtures and the shipped parser down to the JSON", async () => {
    const [cord, sroie] = [await measure("cord-v2"), await measure("sroie")];
    const artifact = await committed();

    expect(artifact.datasets).toEqual([JSON.parse(JSON.stringify(cord)), JSON.parse(JSON.stringify(sroie))]);
    expect(artifact.mode).toBe("parser-only");
    expect(artifact.accuracyIsACeiling).toBe(true);
    expect(artifact.protocol.tauName).toBe(0.7);
    expect(artifact.protocol.moneyGate).toContain("DECISIONS/0008");
  });

  // DECISIONS/0033 moved one figure: `zero_items` 42 → 41, because one SROIE receipt that previously produced
  // no items at all now reads its `DESCRIPTION QTY PRICE TOTAL` table. Every other critical count is unchanged,
  // which is the point of re-deriving this census rather than trusting it.
  it("carries ticket 07's critical census over the same 250 receipts", async () => {
    const artifact = await committed();
    const byCode = artifact.datasets.reduce((out, dataset) => {
      for (const [code, count] of Object.entries(dataset.findings.byCriticalCode)) out[code] = (out[code] ?? 0) + count;
      return out;
    }, {} as Record<string, number>);

    // DECISIONS/0034: `zero_items` 41 → 39 and `item_without_price` 2 → 1, the same receipts that gained an
    // `AMOUNT` column (and the metadata row that used to be an item with no price). `arithmetic_total`,
    // `arithmetic_item_sum` and `invalid_result_schema` are untouched, and `receiptsWithCritical` 85 → 82 falls
    // with the three receipts that stopped being empty or unreadable.
    expect(byCode).toEqual({
      zero_items: 39,
      arithmetic_total: 34,
      arithmetic_item_sum: 27,
      item_without_price: 1,
      invalid_result_schema: 1,
    });
    expect(artifact.datasets.reduce((sum, dataset) => sum + dataset.findings.receiptsWithCritical, 0)).toBe(82);
  });

  it("keeps the null-parser bootstrap at zero through the 09b wrapper", async () => {
    const artifact = await committed();

    for (const dataset of artifact.datasets) {
      expect([dataset.nullDelta.strictMatched, dataset.nullDelta.macroF1], dataset.dataset).toEqual([0, 0]);
      expect(dataset.strict.scoreable, dataset.dataset).toBeGreaterThan(0);
    }
  });

  it("publishes no amount and no receipt text, so it cannot carry what DECISIONS/0005 redacted", async () => {
    const raw = await readFile(path.join(repoRoot, "benchmarks", "results", "parser-only-dev.json"), "utf8");
    const records = (await committed()).datasets.flatMap((dataset) => dataset.receiptRecords);

    expect(records.length).toBe(250);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(["criticals", "goldItems", "grandTotal", "id", "pairs", "predictedItems", "strict", "zeroItems"]);
      expect(["exact", "wrong", "absent", "unannotated", "hallucinated"]).toContain(record.grandTotal);
      expect(record.id).toMatch(/^(cord-v2|sroie)\/dev\/\d+$/);
    }
    // A field-by-field whitelist is the real guard; these two are the tripwires for a future edit that
    // starts carrying values instead of outcomes.
    expect(raw).not.toContain('"text"');
    expect(raw).not.toContain('"name"');
  });
});
