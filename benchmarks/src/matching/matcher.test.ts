import { describe, expect, it } from "vitest";
import type { ParsedItem } from "@receipt-lens/core";
import type { GoldItem } from "../datasets/types.js";
import { matchItems, monetaryFieldsAgree } from "./matcher.js";
import { normalizeItemName } from "./similarity.js";

// Ticket 03b, seam S5: deterministic one-to-one item matching (§8.2–§8.5).
//
// The fixture below is the reason the objective is stated as *count first, similarity
// second*. Both sides carry three items; the highest-similarity pair (gold 0 ↔ predicted 1,
// sim 1.000) is the pair a greedy pass takes first, and taking it makes the middle item
// unpairable because its only remaining candidate crosses. The DP refuses the tempting pair
// and returns all three. The similarity numbers are measured, not illustrative:
//
//             NASI GORENQ  NASI GORENG  TEH MANIS
// NASI GORENG     0.909       1.000       0.091
// NASI GORENG SP  0.714       0.786       0.214
// TEH MANIS       0.091       0.091       1.000

const goldNames = ["NASI GORENG", "NASI GORENG SP", "TEH MANIS"];
const predictedNames = ["NASI GORENQ", "NASI GORENG", "TEH MANIS"];

function goldItem(name: string, overrides: Partial<GoldItem> = {}): GoldItem {
  return { name, qty: 1, unitPrice: null, lineTotal: null, ...overrides };
}

function predictedItem(name: string, overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id: `p-${name}`,
    name,
    qty: 1,
    quantitySource: "explicit",
    unitPrice: null,
    priceSource: "detected",
    lineTotal: null,
    confidence: null,
    sourceLineIds: [],
    warnings: [],
    ...overrides,
  };
}

const gold = goldNames.map((name) => goldItem(name));
const predicted = predictedNames.map((name) => predictedItem(name));

describe("matchItems is a pair-count-maximizing DP, not a greedy pass", () => {
  it("matches all three pairs where similarity-first greedy can only match two", () => {
    const match = matchItems(gold, predicted);

    expect(match.pairs.map((pair) => [pair.goldIndex, pair.predictedIndex])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(match.unmatchedGold).toEqual([]);
    expect(match.unmatchedPredicted).toEqual([]);
    // 3 pairs at total similarity 2.695 beats greedy's 2 pairs at 2.000 — and count decides
    // first, so this outcome does not depend on the similarity sum.
    expect(match.pairs.reduce((sum, pair) => sum + pair.similarity, 0)).toBeCloseTo(2.695, 3);
  });

  it("prefers the higher total similarity among pair-count-equal solutions", () => {
    // Only one pair can be made either way, so count ties and similarity decides: 0.9167
    // beats the 0.750 candidate that comes first in the array.
    const match = matchItems([goldItem("ES TEH MANIS")], [predictedItem("TEH MANIS"), predictedItem("ES TEH MANIR")]);

    expect(match.pairs).toEqual([{ goldIndex: 0, predictedIndex: 1, similarity: expect.closeTo(0.9167, 4) }]);
    expect(match.unmatchedPredicted).toEqual([0]);
  });

  it("refuses a crossing pair rather than trading count for similarity", () => {
    const match = matchItems([goldItem("TEH MANIS"), goldItem("NASI GORENG")], [predictedItem("NASI GORENG"), predictedItem("TEH MANIS")]);

    // Both candidates score 1.000 and only one can be taken; the declared tie order (take,
    // then drop gold, then drop predicted) settles which, and this pins that it does.
    expect(match.pairs).toEqual([{ goldIndex: 0, predictedIndex: 1, similarity: 1 }]);
    expect(match.unmatchedGold).toEqual([1]);
    expect(match.unmatchedPredicted).toEqual([0]);
  });
});

describe("determinism", () => {
  it("returns the identical match for the identical input, every time", () => {
    const first = JSON.stringify(matchItems(gold, predicted));

    for (let run = 0; run < 200; run += 1) {
      expect(JSON.stringify(matchItems(gold, predicted))).toBe(first);
    }
  });

  it("rebuilds its input arrays each run and still agrees byte for byte", () => {
    // The risk this rules out: output depending on object identity, Set iteration of a
    // freshly built set, or any other accidental state.
    const again = goldNames.map((name) => goldItem(name));
    const againPredicted = predictedNames.map((name) => predictedItem(name));

    expect(JSON.stringify(matchItems(again, againPredicted))).toBe(JSON.stringify(matchItems(gold, predicted)));
  });

  it("never produces a crossing pair and never reuses an index", () => {
    // Nine gold items against six predictions, all names repeated, so a matcher that ignored
    // either constraint would have room to break it.
    const match = matchItems([...gold, ...gold, ...gold], [...predicted, ...predicted]);
    const goldSeen = new Set<number>();
    const predictedSeen = new Set<number>();

    for (const [position, pair] of match.pairs.entries()) {
      expect(goldSeen.has(pair.goldIndex)).toBe(false);
      expect(predictedSeen.has(pair.predictedIndex)).toBe(false);
      goldSeen.add(pair.goldIndex);
      predictedSeen.add(pair.predictedIndex);
      if (position > 0) {
        const previous = match.pairs[position - 1]!;
        expect(pair.goldIndex > previous.goldIndex && pair.predictedIndex > previous.predictedIndex).toBe(true);
      }
    }
  });

  it("pairs duplicate names in index order, which is a declared tie-break not a coincidence", () => {
    // 5 of the 100 dev CORD receipts carry two items with identical names, so τ ties at 1.0
    // are a real fixture case (DECISIONS/0006).
    const match = matchItems([goldItem("TOP OREO"), goldItem("TOP OREO")], [predictedItem("TOP OREO"), predictedItem("TOP OREO")]);

    expect(match.pairs.map((pair) => [pair.goldIndex, pair.predictedIndex])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("the τ gate is configurable", () => {
  const pair = [goldItem("NASI GORENG SP")];
  const against = [predictedItem("NASI GORENQ")]; // similarity 0.714

  it("admits a pair at 0.70 and refuses the same pair at 0.75", () => {
    expect(matchItems(pair, against, 0.7).pairs).toHaveLength(1);
    expect(matchItems(pair, against, 0.75).pairs).toEqual([]);
    expect(matchItems(pair, against, 0.95).pairs).toEqual([]);
  });

  it("defaults to the pinned τ from benchmark.config", () => {
    expect(matchItems(pair, against).tau).toBe(0.7);
    expect(matchItems(pair, against).pairs).toHaveLength(1);
  });
});

describe("monetary compatibility (§8.2, Option A: unannotated does not vote)", () => {
  it("refuses a pair whose annotated amounts disagree", () => {
    const match = matchItems([goldItem("TEH MANIS", { lineTotal: 8000 })], [predictedItem("TEH MANIS", { lineTotal: 8001 })]);

    expect(match.pairs).toEqual([]);
    expect(match.unmatchedGold).toEqual([0]);
    expect(match.unmatchedPredicted).toEqual([0]);
  });

  it("compares amounts as integers, so one minor unit of disagreement is a refusal", () => {
    expect(monetaryFieldsAgree(goldItem("x", { unitPrice: 2300000 }), predictedItem("x", { unitPrice: 2300000 }))).toBe(true);
    expect(monetaryFieldsAgree(goldItem("x", { unitPrice: 2300000 }), predictedItem("x", { unitPrice: 2299999 }))).toBe(false);
  });

  it("lets an unannotated side through on both directions, without calling it agreement", () => {
    expect(monetaryFieldsAgree(goldItem("x", { unitPrice: null }), predictedItem("x", { unitPrice: 2300000 }))).toBe(true);
    expect(monetaryFieldsAgree(goldItem("x", { unitPrice: 2300000 }), predictedItem("x", { unitPrice: null }))).toBe(true);
    expect(matchItems([goldItem("TEH MANIS", { unitPrice: null, lineTotal: null })], [predictedItem("TEH MANIS", { unitPrice: 9000, lineTotal: 27000 })]).pairs).toHaveLength(1);
  });

  it("gates on money in addition to the name, so an exact name with wrong money stays unmatched", () => {
    const match = matchItems([goldItem("ES TEH", { unitPrice: 5000 })], [predictedItem("ES TEH", { unitPrice: 6000 })]);

    expect(match.pairs).toEqual([]);
  });
});

describe("names are compared after §8.1 normalization, never raw", () => {
  it("matches a name that differs only in case, punctuation and spacing", () => {
    const match = matchItems([goldItem("Se'I Sapi Sambal Matah ( R )")], [predictedItem("  se i sapi  sambal   matah  r  ")]);

    expect(match.pairs).toHaveLength(1);
    expect(match.pairs[0]!.similarity).toBe(1);
  });

  it("keeps digits meaningful instead of discarding them", () => {
    expect(normalizeItemName("S-Ovaltine 50%")).toBe("s ovaltine 50");
    expect(normalizeItemName("70%")).toBe("70");

    // Two names differing only in a digit still clear τ: the difference is charged to the
    // `item.name` field by the scorer, not to whether the item exists at all.
    const match = matchItems([goldItem("OVO BLASTER 220")], [predictedItem("OVO BLASTER 22")]);
    expect(match.pairs).toHaveLength(1);
    expect(normalizeItemName(goldItem("OVO BLASTER 220").name)).not.toBe(normalizeItemName(predictedItem("OVO BLASTER 22").name));
  });

  it("treats an empty normalized name as matching nothing but another empty name", () => {
    // One dev CORD gold item prints `-` and normalizes to "" (DECISIONS/0006).
    const dash = goldItem("-");
    const empty = predictedItem("/");

    expect(normalizeItemName(dash.name)).toBe("");
    expect(matchItems([dash], [empty]).pairs).toEqual([{ goldIndex: 0, predictedIndex: 0, similarity: 1 }]);
    expect(matchItems([dash], [predictedItem("TEH MANIS")]).pairs).toEqual([]);
  });
});

describe("empty and degenerate inputs", () => {
  it("returns an empty match for an empty gold list without inventing false positives", () => {
    const match = matchItems([], predicted);

    expect(match.pairs).toEqual([]);
    expect(match.unmatchedGold).toEqual([]);
    expect(match.unmatchedPredicted).toEqual([0, 1, 2]);
  });

  it("returns an empty match for an empty prediction list", () => {
    const match = matchItems(gold, []);

    expect(match.pairs).toEqual([]);
    expect(match.unmatchedGold).toEqual([0, 1, 2]);
    expect(match.unmatchedPredicted).toEqual([]);
  });

  it("scores nothing on nothing at all, and never returns NaN", () => {
    const match = matchItems([], []);

    expect(match.pairs).toEqual([]);
    for (const pair of match.pairs) expect(Number.isFinite(pair.similarity)).toBe(true);
  });
});
