import { describe, expect, it } from "vitest";
import { emptyParseResult, nullParse } from "./null-parser.js";
import { renderReport, scoreReceipts, type ScoreSpec, type ScoredField } from "./report.js";
import type { GoldAnnotation, LabeledReceipt } from "../datasets/types.js";
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

  it("refuses to score items without the 03b matcher rather than publishing a fake pair count", () => {
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

    expect(() =>
      scoreReceipts([receipt({ gold: gold({ items: [{ name: "Nasi Goreng", qty: 1, unitPrice: 2300000, lineTotal: 2300000 }] }) })], {
        dataset: "cord-v2",
        fieldsLabeled: ["item.name"],
        fieldsExcluded: [],
      }, cheating)
    ).toThrowError(/03b matcher/);
  });

  it("does not credit an unlabelled receipt to a parser that outputs nothing", () => {
    const scores = scoreReceipts(
      [receipt(), receipt({ receiptId: "sroie/dev/1", gold: gold({ grandTotal: null }) })],
      { dataset: "sroie", fieldsLabeled: [...sroieFields], fieldsExcluded: [] }
    );

    expect(scores.strict).toEqual({ receipts: 2, scoreable: 1, goldless: 1, matched: 0, rate: 0 });
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
});
