import { describe, expect, it } from "vitest";
import type { ParsedItem } from "@receipt-lens/core";
import type { GoldItem } from "../datasets/types.js";
import { scoreReceiptItems } from "./itemScores.js";

// Ticket 03b, seam S6: field-level scorers with the owner's Option A null semantics.
//
//   gold cell   predicted cell   outcome
//   missing     anything         excluded — neither a hit nor a miss
//   present     missing          false negative (a recall miss on that field)
//   present     present, equal   true positive
//   present     present, differ  false positive + false negative
//
// The excluded row is the ordinary case, not an edge case: dev/cord-v2 gold annotates
// `unitPrice` on 49 of 254 items.

const allAttributes = ["name", "qty", "unitPrice", "lineTotal"] as const;

function goldItem(overrides: Partial<GoldItem> = {}): GoldItem {
  return { name: "NASI GORENG", qty: 1, unitPrice: 2300000, lineTotal: 2300000, ...overrides };
}

function predictedItem(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id: "p0",
    name: "NASI GORENG",
    qty: 1,
    quantitySource: "explicit",
    unitPrice: 2300000,
    priceSource: "detected",
    lineTotal: 2300000,
    confidence: null,
    sourceLineIds: [],
    warnings: [],
    ...overrides,
  };
}

function score(gold: readonly GoldItem[], predicted: readonly ParsedItem[]) {
  return scoreReceiptItems(gold, predicted, allAttributes);
}

describe("a perfect prediction", () => {
  it("scores every annotated cell as a true positive and the receipt as strict", () => {
    const outcome = score([goldItem()], [predictedItem()]);

    expect(outcome.matchedPairs).toBe(1);
    expect(outcome.strictlyAgrees).toBe(true);
    for (const attribute of allAttributes) {
      expect(outcome.counts[attribute], attribute).toEqual({ tp: 1, fp: 0, fn: 0, excluded: 0 });
    }
  });

  it("treats case, punctuation and spacing differences as agreement", () => {
    const outcome = score([goldItem({ name: "Se'I Sapi Sambal Matah ( R )" })], [predictedItem({ name: "  se i sapi  sambal   matah  r  " })]);

    expect(outcome.counts.name).toEqual({ tp: 1, fp: 0, fn: 0, excluded: 0 });
    expect(outcome.strictlyAgrees).toBe(true);
  });
});

describe("the excluded row: gold did not annotate the cell", () => {
  it("excludes a populated prediction instead of calling it a false positive", () => {
    const outcome = score([goldItem({ unitPrice: null })], [predictedItem({ unitPrice: 99900 })]);

    expect(outcome.counts.unitPrice).toEqual({ tp: 0, fp: 0, fn: 0, excluded: 1 });
  });

  it("excludes both cells absent, and does not credit it as a hit", () => {
    const outcome = score([goldItem({ qty: null })], [predictedItem({ qty: null })]);

    expect(outcome.counts.qty).toEqual({ tp: 0, fp: 0, fn: 0, excluded: 1 });
  });

  it("treats an empty name as unannotated rather than as a name that matched nothing", () => {
    const outcome = score([goldItem({ name: "   " })], [predictedItem({ name: "AYAM BAKAR" })]);

    // Two separate facts: the gold cell carries no annotation (excluded), and the prediction
    // asserted a name with nothing behind it (a false positive).
    expect(outcome.counts.name).toEqual({ tp: 0, fp: 1, fn: 0, excluded: 1 });
  });

  it("keeps a receipt strict when the only disagreements sit in excluded cells", () => {
    const outcome = score([goldItem({ unitPrice: null, lineTotal: null })], [predictedItem({ unitPrice: 1, lineTotal: 2 })]);

    expect(outcome.strictlyAgrees).toBe(true);
    expect(outcome.counts.unitPrice.excluded).toBe(1);
  });
});

describe("a gold value with no prediction behind it", () => {
  it("is a recall miss, and nothing else", () => {
    const outcome = score([goldItem()], [predictedItem({ lineTotal: null })]);

    expect(outcome.counts.lineTotal).toEqual({ tp: 0, fp: 0, fn: 1, excluded: 0 });
    expect(outcome.strictlyAgrees).toBe(false);
  });

  it("is a recall miss for every annotated field of an item that was never matched", () => {
    const outcome = score([goldItem()], []);

    expect(outcome.matchedPairs).toBe(0);
    expect(outcome.unmatchedGold).toBe(1);
    for (const attribute of allAttributes) {
      expect(outcome.counts[attribute], attribute).toEqual({ tp: 0, fp: 0, fn: 1, excluded: 0 });
    }
    // This is the null-parser shape: every field recall 0, precision undefined-by-nothing,
    // and the harness renders that as 0 rather than NaN.
  });
});

describe("a wrong value is both a false positive and a false negative", () => {
  it("pairs on tolerance but scores on exactness: τ never relaxes a field", () => {
    // "NASI GORENQ" is 0.909 similar, so §8.2 admits the pair; the names still differ.
    const outcome = score([goldItem()], [predictedItem({ name: "NASI GORENQ" })]);

    expect(outcome.matchedPairs).toBe(1);
    expect(outcome.counts.name).toEqual({ tp: 0, fp: 1, fn: 1, excluded: 0 });
    expect(outcome.counts.qty).toEqual({ tp: 1, fp: 0, fn: 0, excluded: 0 });
  });

  it("counts a quantity mismatch by integer equality", () => {
    // qty is not a monetary gate field, so the pair still forms and only qty is charged.
    const outcome = score([goldItem({ qty: 3 })], [predictedItem({ qty: 1 })]);

    expect(outcome.matchedPairs).toBe(1);
    expect(outcome.counts.qty).toEqual({ tp: 0, fp: 1, fn: 1, excluded: 0 });
    expect(outcome.counts.name.tp).toBe(1);
  });

  it("lets a conflicting amount break the pairing, not just the field", () => {
    // §8.2 admits a candidate only where the annotated money agrees. One minor unit of
    // disagreement on a field both sides annotate is a conflict, so no pair forms and every
    // annotated gold cell becomes a false negative while every asserted prediction cell
    // becomes a false positive — the item is reported as missed, not as mispriced.
    const outcome = score([goldItem()], [predictedItem({ unitPrice: 2299999 })]);

    expect(outcome.matchedPairs).toBe(0);
    for (const attribute of allAttributes) {
      expect(outcome.counts[attribute], attribute).toEqual({ tp: 0, fp: 1, fn: 1, excluded: 0 });
    }
    expect(outcome.strictlyAgrees).toBe(false);
  });
});

describe("unmatched predictions", () => {
  it("are one false positive per field they actually assert", () => {
    const outcome = score([], [predictedItem()]);

    expect(outcome.unmatchedPredicted).toBe(1);
    for (const attribute of allAttributes) {
      expect(outcome.counts[attribute], attribute).toEqual({ tp: 0, fp: 1, fn: 0, excluded: 0 });
    }
  });

  it("are not a false positive on a field they left null, because no claim was made", () => {
    const outcome = score([], [predictedItem({ unitPrice: null, lineTotal: null })]);

    expect(outcome.counts.name).toEqual({ tp: 0, fp: 1, fn: 0, excluded: 0 });
    expect(outcome.counts.unitPrice).toEqual({ tp: 0, fp: 0, fn: 0, excluded: 0 });
  });

  it("break strict even when gold has nothing to disagree with", () => {
    expect(score([], [predictedItem()]).strictlyAgrees).toBe(false);
  });
});

describe("matching several items in one receipt", () => {
  const gold = [goldItem({ name: "TEH MANIS", unitPrice: 5000, lineTotal: 5000 }), goldItem({ name: "NASI GORENG", unitPrice: 12000, lineTotal: 12000 })];
  const predicted = [predictedItem({ id: "a", name: "TEH MANIS", unitPrice: 5000, lineTotal: 5000 }), predictedItem({ id: "b", name: "NASI GORENG", unitPrice: 12000, lineTotal: 12000 })];

  it("pairs both and reports full coverage", () => {
    const outcome = score(gold, predicted);

    expect(outcome).toMatchObject({ matchedPairs: 2, goldItems: 2, predictedItems: 2, unmatchedGold: 0, unmatchedPredicted: 0, strictlyAgrees: true });
  });

  it("keeps a hallucinated third item out of the true positives", () => {
    const outcome = score(gold, [...predicted, predictedItem({ id: "c", name: "AYAM BAKAR", unitPrice: 100, lineTotal: 100 })]);

    expect(outcome.matchedPairs).toBe(2);
    expect(outcome.unmatchedPredicted).toBe(1);
    expect(outcome.counts.lineTotal).toEqual({ tp: 2, fp: 1, fn: 0, excluded: 0 });
    expect(outcome.strictlyAgrees).toBe(false);
  });

  it("reports the τ it matched under, so a published number carries its threshold", () => {
    expect(score(gold, predicted).tau).toBe(0.7);
    expect(scoreReceiptItems(gold, predicted, allAttributes, 0.95).tau).toBe(0.95);
  });
});

describe("the item tier against an empty gold set", () => {
  it("adds nothing to any counter and stays strict", () => {
    const outcome = score([], []);

    for (const attribute of allAttributes) {
      expect(outcome.counts[attribute], attribute).toEqual({ tp: 0, fp: 0, fn: 0, excluded: 0 });
    }
    expect(outcome.strictlyAgrees).toBe(true);
    expect(outcome.matchedPairs).toBe(0);
  });

  it("scores only the attributes the dataset labels", () => {
    const outcome = scoreReceiptItems([goldItem()], [predictedItem()], ["name"]);

    expect(Object.keys(outcome.counts)).toEqual(["name"]);
    expect(outcome.counts.qty).toBeUndefined();
  });
});
