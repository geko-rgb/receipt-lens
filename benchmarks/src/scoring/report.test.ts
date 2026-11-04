import { describe, expect, it } from "vitest";
import { emptyParseResult, nullParse } from "./null-parser.js";
import { renderReport, scoreReceipts, type ScoreSpec, type ScoredField } from "./report.js";
import type { BenchmarkField, GoldAnnotation, LabeledReceipt } from "../datasets/types.js";
import type { OcrResult } from "@receipt-lens/core";

// Seam S4: the null-parser bootstrap (ADR-003, non-negotiable). A parser that produces
// nothing must score exactly zero against non-empty annotated data, so a scoring bug can
// never be mistaken for accuracy. NaN is treated as a failure, not a formatting choice.

const ocr = {
  lines: [{ id: "L0", text: "TOTAL: 19300", box: { x: 0, y: 0, width: 10, height: 10 }, confidence: null, words: [] }],
  imageSize: { width: 100, height: 200 },
  provider: "dataset-reference-ocr",
  version: "sroie@abc",
} satisfies OcrResult;

function gold(overrides: Partial<GoldAnnotation> = {}): GoldAnnotation {
  return {
    grandTotal: 19300,
    subtotal: null,
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    taxTotal: null,
    items: [],
    ...overrides,
  };
}

function receipt(overrides: Partial<LabeledReceipt> = {}): LabeledReceipt {
  return {
    receiptId: "sroie/dev/0",
    dataset: "sroie",
    split: "dev",
    ocr,
    gold: gold(),
    unreadableAnnotations: [],
    ...overrides,
  };
}

const sroieFields = ["grandTotal"] as const;

describe("nullParse", () => {
  it("produces a well-formed result that carries no values at all", () => {
    const parsed = nullParse(ocr);

    expect(parsed.items).toEqual([]);
    expect(parsed.grandTotal).toBe(null);
    expect(parsed.subtotal).toBe(null);
    expect(parsed.serviceCharge).toBe(null);
    expect(parsed.tip).toBe(null);
    expect(parsed.discount).toBe(null);
    expect(parsed.roundOff).toBe(null);
    expect(parsed.taxes).toEqual([]);
    expect(parsed.otherCharges).toEqual([]);
    expect(parsed.unclassifiedRows).toEqual([]);
  });

  it("is the same object shape a future stub adapter can reuse", () => {
    expect(emptyParseResult()).toEqual(nullParse(ocr));
  });
});

describe("scoreReceipts with the null parser", () => {
  it("scores exactly 0 on every field against non-empty gold data", () => {
    const scores = scoreReceipts([receipt(), receipt({ receiptId: "sroie/dev/1", gold: gold({ grandTotal: 250 }) })], {
      dataset: "sroie",
      fieldsLabeled: [...sroieFields],
      fieldsExcluded: ["subtotal", "item.name"],
    });

    const grandTotal = scores.fields.find((field) => field.field === "grandTotal") as ScoredField;
    // A missing prediction where gold exists is a false negative only — there is no
    // false positive without a prediction to be wrong about.
    expect([grandTotal.tp, grandTotal.fp, grandTotal.fn]).toEqual([0, 0, 2]);
    expect([grandTotal.precision, grandTotal.recall, grandTotal.f1]).toEqual([0, 0, 0]);
    expect(scores.strict.matched).toBe(0);
    expect(scores.strict.receipts).toBe(2);
    expect(scores.strict.rate).toBe(0);
  });

  it("scores the item tier through the matcher instead of refusing to look", () => {
    const cheating = () => ({
      ...emptyParseResult(),
      items: [
        {
          id: "i0",
          name: "Nasi Goreng",
          qty: 1,
          quantitySource: "explicit" as const,
          unitPrice: 2300000,
          priceSource: "detected" as const,
          lineTotal: 2300000,
          confidence: null,
          sourceLineIds: [],
          warnings: [],
        },
      ],
    });

    const scores = scoreReceipts(
      [
        receipt({
          gold: gold({
            grandTotal: null,
            items: [
              { name: "Nasi Goreng", qty: 1, unitPrice: 2300000, lineTotal: 2300000 },
              { name: "Teh Manis", qty: 2, unitPrice: 5000, lineTotal: 10000 },
            ],
          }),
        }),
      ],
      {
        dataset: "cord-v2",
        fieldsLabeled: ["item.name", "item.qty", "item.unitPrice", "item.lineTotal"],
        fieldsExcluded: [],
      },
      cheating
    );

    const name = scores.fields.find((field) => field.field === "item.name") as ScoredField;
    // One of two gold items recovered: recall 0.5, precision 1.0, and the second gold item
    // is a false negative rather than an invisible gap.
    expect(name.tp).toBe(1);
    expect(name.fn).toBe(1);
    expect(name.fp).toBe(0);
    expect(name.goldCells).toBe(2);
    expect(scores.items).toEqual({ gold: 2, predicted: 1, matchedPairs: 1, unmatchedGold: 1, unmatchedPredicted: 0, tau: 0.7 });
    expect(scores.strict.matched).toBe(0);
  });

  it("does not credit an unlabelled receipt to a parser that outputs nothing", () => {
    const scores = scoreReceipts(
      [receipt(), receipt({ receiptId: "sroie/dev/1", gold: gold({ grandTotal: null }) })],
      { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] }
    );

    expect(scores.strict).toEqual({ receipts: 2, scoreable: 1, goldless: 1, matched: 0, rate: 0, perReceipt: [0, null] });
  });

  it("publishes a per-receipt strict flag that agrees with its own aggregate", () => {
    // Ticket 09b reads this array to write per-receipt rows into the accuracy artifact. It has to come
    // from the scorer that produced the rate, not from a second implementation of strict's rules, and a
    // row that is `null` must be exactly the receipt the aggregate left out of the denominator.
    const scores = scoreReceipts(
      [receipt(), receipt({ receiptId: "sroie/dev/1", gold: gold({ grandTotal: null }) }), receipt({ receiptId: "sroie/dev/2", gold: gold({ grandTotal: 250 }) })],
      { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] },
      (source) => ({ ...emptyParseResult(), grandTotal: source === ocr ? 19300 : null })
    );

    expect(scores.strict.perReceipt).toEqual([1, null, 0]);
    expect(scores.strict.perReceipt.filter((verdict) => verdict === 1).length).toBe(scores.strict.matched);
    expect(scores.strict.perReceipt.filter((verdict) => verdict !== null).length).toBe(scores.strict.scoreable);
  });

  it("makes NaN impossible: a field with no gold and no prediction stays 0, never undefined-over-zero", () => {
    const empty = receipt({ gold: gold({ grandTotal: null }) });
    const scores = scoreReceipts([empty], { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] });

    for (const field of scores.fields) {
      for (const value of [field.precision, field.recall, field.f1]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("excludes fields the dataset does not label instead of null-scoring them", () => {
    const scores = scoreReceipts([receipt()], {
      dataset: "sroie",
      fieldsLabeled: [...sroieFields],
      fieldsExcluded: ["subtotal", "item.name"],
    });

    expect(scores.fields.map((field) => field.field)).toEqual(["grandTotal"]);
    expect(scores.excludedFields).toEqual(["item.name", "subtotal"]);
  });

  it("scores an empty dataset as 0 across the board rather than dividing by zero", () => {
    const scores = scoreReceipts([], { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] });

    expect(scores.strict.rate).toBe(0);
    expect(scores.strict.receipts).toBe(0);
    expect(scores.fields.every((field) => field.f1 === 0)).toBe(true);
  });

  it("is byte-identical across runs", () => {
    const spec: ScoreSpec = { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] };
    const first = renderReport([scoreReceipts([receipt()], spec)]);
    const second = renderReport([scoreReceipts([receipt()], spec)]);

    expect(first).toBe(second);
  });

  it("states its own limits in the output, not only in a comment", () => {
    const spec: ScoreSpec = { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] };
    const report = JSON.parse(renderReport([scoreReceipts([receipt()], spec)]));

    expect(report.headlineMode).toBe("cached-reference-ocr-node");
    expect(report.parser).toBe("null");
    expect(report.nullSemantics).toContain("null");
    expect(report.accuracyIsACeiling).toBe(true);
    expect(report.strictTier).toContain("scalar");
  });

  it("carries the fixture provenance so a published number can be regenerated", () => {
    const scores = scoreReceipts([receipt()], { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] });

    expect(scores.snapshotHash).toBe("abc");
  });

  it("pins attribution into the report, not only into the fixture header", () => {
    const scores = scoreReceipts([receipt()], { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [], license: "CC-BY-4.0" });
    const report = JSON.parse(renderReport([scores])).datasets[0];

    expect(report.provider).toBe("dataset-reference-ocr");
    expect(report.providerVersion).toBe("sroie@abc");
    expect(report.license).toBe("CC-BY-4.0");
    expect(report.macro.fields).toBe(1);
  });
});

describe("two-tier composition: macro averaging and coverage", () => {
  const cordSpec = {
    dataset: "cord-v2" as const,
    fieldsLabeled: ["grandTotal", "item.name", "item.qty"] as const as readonly BenchmarkField[],
    fieldsExcluded: ["tip"] as const as readonly BenchmarkField[],
  };

  function receiptWith(items: readonly { name: string; qty: number | null; unitPrice: number | null; lineTotal: number | null }[], grandTotal: number | null) {
    return receipt({ dataset: "cord-v2", gold: gold({ grandTotal, items }) });
  }

  it("averages the labeled fields with equal weight, regardless of their denominators", () => {
    // grandTotal has one gold cell and item.name has two, so a micro mean over cells would
    // not equal the macro mean over fields. Macro is unweighted across fields, by definition.
    const parsed = {
      ...emptyParseResult(),
      grandTotal: 100,
      items: [
        { id: "i0", name: "A", qty: null, quantitySource: "explicit" as const, unitPrice: null, priceSource: "detected" as const, lineTotal: null, confidence: null, sourceLineIds: [], warnings: [] },
        { id: "i1", name: "B", qty: null, quantitySource: "explicit" as const, unitPrice: null, priceSource: "detected" as const, lineTotal: null, confidence: null, sourceLineIds: [], warnings: [] },
      ],
    };
    const scores = scoreReceipts([receiptWith([{ name: "A", qty: null, unitPrice: null, lineTotal: null }, { name: "C", qty: null, unitPrice: null, lineTotal: null }], 100)], cordSpec, () => parsed);

    const grandTotal = scores.fields.find((field) => field.field === "grandTotal")!;
    const name = scores.fields.find((field) => field.field === "item.name")!;
    expect([grandTotal.f1, name.f1]).toEqual([1, 0.5]);
    // `item.qty` is annotated nowhere here and asserted by nobody, so it has no denominator:
    // it is listed with its zero counts but stays out of the mean, which is what makes the
    // macro the average of two measurements rather than three-quarters of one.
    expect(scores.fields.find((field) => field.field === "item.qty")).toMatchObject({ tp: 0, fp: 0, fn: 0 });
    expect(scores.macro).toEqual({
      precision: (1 + 0.5) / 2,
      recall: (1 + 0.5) / 2,
      f1: (1 + 0.5) / 2,
      fields: 2,
      listed: 3,
    });
  });

  it("keeps an excluded field out of the macro mean entirely", () => {
    const scores = scoreReceipts([receipt()], { dataset: "sroie", fieldsLabeled: ["grandTotal"] as readonly BenchmarkField[], fieldsExcluded: ["item.name", "subtotal"] as readonly BenchmarkField[] });

    expect(scores.fields.map((field) => field.field)).toEqual(["grandTotal"]);
    expect(scores.macro).toMatchObject({ fields: 1, listed: 1 });
    expect(scores.excludedFields).toEqual(["item.name", "subtotal"]);
  });

  it("publishes item coverage so a reader can see what the ratios were computed over", () => {
    const scores = scoreReceipts([receiptWith([{ name: "A", qty: 1, unitPrice: null, lineTotal: null }], 100)], cordSpec);

    expect(scores.items).toEqual({ gold: 1, predicted: 0, matchedPairs: 0, unmatchedGold: 1, unmatchedPredicted: 0, tau: 0.7 });
    const name = scores.fields.find((field) => field.field === "item.name")!;
    expect([name.tp, name.fp, name.fn, name.goldCells, name.unannotatedGoldCells]).toEqual([0, 0, 1, 1, 0]);
  });
});

describe("edge fixtures: no NaN and no misleading non-zero", () => {
  const cordSpec = {
    dataset: "cord-v2" as const,
    fieldsLabeled: ["grandTotal", "item.name", "item.qty", "item.unitPrice", "item.lineTotal"] as readonly BenchmarkField[],
    fieldsExcluded: ["tip", "roundOff"] as readonly BenchmarkField[],
  };

  it("an empty dataset scores 0 everywhere and says it scored nothing", () => {
    const scores = scoreReceipts([], cordSpec);

    expect(scores.receipts).toBe(0);
    expect(scores.strict).toEqual({ receipts: 0, scoreable: 0, goldless: 0, matched: 0, rate: 0, perReceipt: [] });
    expect(scores.macro).toEqual({ precision: 0, recall: 0, f1: 0, fields: 0, listed: 5 });
    expect(scores.items).toEqual({ gold: 0, predicted: 0, matchedPairs: 0, unmatchedGold: 0, unmatchedPredicted: 0, tau: 0.7 });
    for (const field of scores.fields) {
      expect([field.tp, field.fp, field.fn, field.precision, field.recall, field.f1], field.field).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });

  it("a dataset with no applicable fields at all excludes every field and still renders", () => {
    const scores = scoreReceipts([receipt()], { dataset: "sroie", fieldsLabeled: [], fieldsExcluded: [...cordSpec.fieldsLabeled] });

    expect(scores.fields).toEqual([]);
    expect(scores.macro).toEqual({ precision: 0, recall: 0, f1: 0, fields: 0, listed: 0 });
    expect(scores.strict.scoreable).toBe(0);
    const report = renderReport([scores]);

    expect(report).not.toContain("NaN");
    expect(report).not.toContain("null,");
    expect(JSON.parse(report).datasets[0].fields).toEqual([]);
  });

  it("a receipt whose every gold cell is unannotated is no evidence, and never scores 1.0", () => {
    const emptyGold = receipt({ gold: gold({ grandTotal: null, items: [{ name: " ", qty: null, unitPrice: null, lineTotal: null }] }) });
    const scores = scoreReceipts([emptyGold], cordSpec);

    for (const field of scores.fields) {
      expect([field.precision, field.recall, field.f1], field.field).toEqual([0, 0, 0]);
    }
    // Nothing is annotated here, so strict has no denominator to be generous about — and the
    // unannotated cells stay visible rather than vanishing from the report.
    expect(scores.strict).toEqual({ receipts: 1, scoreable: 0, goldless: 1, matched: 0, rate: 0, perReceipt: [null] });
    expect(scores.fields.filter((field) => field.tier === "item").map((field) => field.unannotatedGoldCells)).toEqual([1, 1, 1, 1]);
    expect(scores.items).toMatchObject({ gold: 1, predicted: 0, matchedPairs: 0, unmatchedGold: 1 });
  });

  it("a value asserted over an unannotated gold cell is charged, per §8's strict cell rule", () => {
    const emptyGold = receipt({ gold: gold({ grandTotal: null, items: [{ name: " ", qty: null, unitPrice: null, lineTotal: null }] }) });
    const parser = () => ({
      ...emptyParseResult(),
      items: [
        { id: "i0", name: "AYAM BAKAR", qty: 2, quantitySource: "explicit" as const, unitPrice: 8000, priceSource: "detected" as const, lineTotal: 16000, confidence: null, sourceLineIds: [], warnings: [] },
      ],
    });
    const scores = scoreReceipts([emptyGold], cordSpec, parser);

    // The name normalizes to empty, so no pair can form: the prediction is unmatched and every
    // field it asserts is a false positive, while the gold cells stay unannotated rather than
    // becoming false negatives.
    const qty = scores.fields.find((field) => field.field === "item.qty")!;
    expect([qty.tp, qty.fp, qty.fn, qty.absentAgreements, qty.unannotatedGoldCells]).toEqual([0, 1, 0, 0, 1]);
    expect(scores.strict).toEqual({ receipts: 1, scoreable: 0, goldless: 1, matched: 0, rate: 0, perReceipt: [null] });
  });

  it("produces the identical bytes on a second run, item tier included", () => {
    const receipts = [receipt({ dataset: "cord-v2", gold: gold({ items: [{ name: "Nasi Goreng", qty: 1, unitPrice: 2300000, lineTotal: 2300000 }] }) })];
    const parser = () => ({
      ...emptyParseResult(),
      items: [
        { id: "i0", name: "nasi  goreng", qty: 1, quantitySource: "explicit" as const, unitPrice: 2300000, priceSource: "detected" as const, lineTotal: 2300000, confidence: null, sourceLineIds: [], warnings: [] },
      ],
    });

    const first = renderReport([scoreReceipts(receipts, cordSpec, parser)]);
    const second = renderReport([scoreReceipts(receipts, cordSpec, parser)]);

    expect(first).toBe(second);
    expect(JSON.parse(first).datasets[0].fields.find((field: { field: string }) => field.field === "item.name").tp).toBe(1);
    expect(JSON.parse(first).protocol.tauName).toBe(0.7);
  });
});

