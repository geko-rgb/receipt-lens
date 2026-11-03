import { describe, expect, it } from "vitest";
import { classifyRows, continuationLengthCap, meetsContinuationConditions } from "./classify.js";
import { parse } from "./index.js";
import {
  COLUMN_LABELS,
  GSTIN_ROW,
  ITEM_A,
  ITEM_B,
  MISALIGNED_ROW,
  ocrRow,
  PHONE_ROW,
  receipt,
  SHOUTY_ROW,
  TABLE_ROW,
  TAX_ROW,
  TOO_LONG_ROW,
  WRAP_1,
  WRAP_2,
} from "./fixtures.js";

function classesOf(...args: Parameters<typeof receipt>) {
  return classifyRows(receipt(...args)).rows.map((entry) => entry.classification);
}
function textsOf(classification: string, ...args: Parameters<typeof receipt>) {
  return classifyRows(receipt(...args))
    .rows.filter((entry) => entry.classification === classification)
    .map((entry) => entry.row.text);
}

describe("clean item rows", () => {
  it("classify a priced row as an item carrying its source line", () => {
    const parsed = parse(receipt(COLUMN_LABELS, ITEM_A, ITEM_B));
    expect(parsed.items.map((item) => item.name)).toEqual(["MIKA GORENG", "NASI PUTIH"]);
    expect(parsed.items[0]!.sourceLineIds).toEqual(["i1"]);
    expect(parsed.unclassifiedRows).toEqual([]);
    expect(parsed.items.map((item) => item.id)).toEqual(["i1", "i2"]);
  });

  it("leave quantity, money and confidence unresolved — content parsing is ticket 06", () => {
    const parsed = parse(receipt(ITEM_A, ITEM_B));
    for (const item of parsed.items) {
      expect(item.qty).toBeNull();
      expect(item.unitPrice).toBeNull();
      expect(item.lineTotal).toBeNull();
      expect(item.confidence).toBeNull();
      expect(item.quantitySource).toBe("unresolved");
      expect(item.priceSource).toBe("unresolved");
      expect(item.warnings).toEqual([]);
    }
    expect(parsed.subtotal).toBeNull();
    expect(parsed.grandTotalSource).toBe("unresolved");
  });

  it("a row that is nothing but a number is real money, not a product", () => {
    // DECISIONS/0008 P7 rule 3: an item needs a name as well as a price.
    const thousands = ocrRow("n1", 92, [["1,818", 150, 20]]);
    const small = ocrRow("n2", 108, [["200", 155, 15]]);
    const named = ocrRow("n3", 124, [["PANEER", 10, 24], ["200", 155, 15]]);
    const result = classifyRows(receipt(ITEM_A, thousands, small, named));
    expect(result.rows.map((entry) => entry.classification)).toEqual([
      "item",
      "ambiguous",
      "ambiguous",
      "item",
    ]);
    expect(result.rows.filter((entry) => entry.classification === "ambiguous").map((entry) => entry.row.text)).toEqual([
      "1,818",
      "200",
    ]);
    expect(result.rows[3]!.row.text).toBe("PANEER 200");
  });

  it("cannot produce an item with an empty name", () => {
    const parsed = parse(
      receipt(
        COLUMN_LABELS,
        ITEM_A,
        ocrRow("n4", 92, [["1,818", 150, 20]]),
        ocrRow("n5", 108, [["200", 155, 15]]),
        ocrRow("n6", 140, [["45.000", 140, 30]]),
        ocrRow("n7", 156, [["0", 165, 8]])
      )
    );
    expect(parsed.items.length).toBeGreaterThan(0);
    for (const item of parsed.items) {
      expect(item.name.trim().length).toBeGreaterThan(0);
      expect(item.name.trim()).not.toBe("");
    }
  });

  it("do not reuse the provider's OcrLine as a row: one visual row spread over lines clusters to one item", () => {
    const quantity = ocrRow("q", 60, [["1", 10, 8]]);
    const name = ocrRow("n", 61, [["MIKA", 30, 20], ["GORENG", 54, 32]]);
    const price = ocrRow("p", 60, [["8.000", 150, 20]]);
    const parsed = parse(receipt(COLUMN_LABELS, quantity, name, price, ITEM_B));
    expect(parsed.items.map((item) => item.name)).toEqual(["1 MIKA GORENG", "NASI PUTIH"]);
    expect(parsed.items[0]!.sourceLineIds).toEqual(["q", "n", "p"]);
  });
});

describe("header and noise rows never become items", () => {
  it("catches column labels, table furniture, tax identifiers and charge labels", () => {
    const args = [COLUMN_LABELS, ITEM_A, ITEM_B, TABLE_ROW, GSTIN_ROW, TAX_ROW] as const;
    expect(parse(receipt(...args)).items.map((item) => item.name)).toEqual(["MIKA GORENG", "NASI PUTIH"]);
    expect(textsOf("noise_header", ...args)).toEqual([
      "QTY ITEM PRICE",
      "TABLE 4",
      "GSTIN: 07AABCU96031R1Z",
      "CGST 2.50",
    ]);
  });

  it("never marks a header or noise row as a price-less item", () => {
    for (const entry of classifyRows(receipt(COLUMN_LABELS, TABLE_ROW, GSTIN_ROW, ITEM_A, ITEM_B)).rows) {
      if (entry.classification !== "item") continue;
      expect(entry.priceCandidates).toHaveLength(1);
    }
  });

  it("catches a telephone-shaped row carrying an amount before it can become an item", () => {
    const args = [ITEM_A, ITEM_B, PHONE_ROW] as const;
    expect(parse(receipt(...args)).items.map((item) => item.name)).toEqual(["MIKA GORENG", "NASI PUTIH"]);
    expect(textsOf("noise_header", ...args)).toContain("044-2356901 9.00");
    expect(parse(receipt(...args)).unclassifiedRows).toHaveLength(0);
  });

  it("classifies everything above the item region as noise whatever it says", () => {
    expect(classesOf(COLUMN_LABELS, SHOUTY_ROW)).toEqual(["noise_header", "noise_header"]);
    expect(classesOf(COLUMN_LABELS, WRAP_1)).toEqual(["noise_header", "noise_header"]);
  });
});

describe("ambiguous rows are preserved, never discarded and never forced into items", () => {
  it("keeps text, geometry and source-line references for an unclassifiable row", () => {
    const parsed = parse(receipt(ITEM_A, ITEM_B, SHOUTY_ROW));
    expect(parsed.items).toHaveLength(2);
    expect(parsed.unclassifiedRows).toHaveLength(1);
    const preserved = parsed.unclassifiedRows[0]!;
    expect(preserved.text).toBe("DESSERTS 42");
    expect(preserved.reason).toBe("ambiguous");
    expect(preserved.warningCode).toBe("ambiguous_row");
    expect(preserved.sourceLineIds).toEqual(["s1"]);
    expect(preserved.box).toEqual({ x: 10, y: 220, width: 54, height: 10 });
  });

  it("warns about each preserved row through the core seam", () => {
    const parsed = parse(receipt(ITEM_A, MISALIGNED_ROW, ITEM_B, SHOUTY_ROW));
    expect(parsed.unclassifiedRows.map((row) => row.text)).toEqual(["Remarks only", "DESSERTS 42"]);
    expect(parsed.unclassifiedRows.map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(parsed.warnings.filter((warning) => warning.code === "ambiguous_row")).toHaveLength(2);
    expect(parsed.warnings[0]).toEqual(
      expect.objectContaining({ code: "ambiguous_row", sourceText: "Remarks only", sourceLineIds: ["m1"] })
    );
  });

  it("emits ambiguous_price_separator rather than choosing between two aligned amounts", () => {
    const doubled = ocrRow("i3", 60, [["MIKA", 10, 20], ["8.00", 140, 20], ["9.00", 152, 18]]);
    const parsed = parse(receipt(doubled, ITEM_B));
    expect(parsed.items.map((item) => item.name)).toEqual(["NASI PUTIH"]);
    expect(parsed.unclassifiedRows.map((row) => row.text)).toEqual(["MIKA 8.00 9.00"]);
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({ code: "ambiguous_price_separator", sourceText: "MIKA 8.00 9.00" })
    );
  });

  it("treats blank OCR as a valid zero-item result, not a parse failure", () => {
    const parsed = parse(receipt());
    expect(parsed.items).toEqual([]);
    expect(parsed.unclassifiedRows).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("the header zone ends at the first priced row, not at the first item", () => {
  const nameless = ocrRow("z3", 140, [["kaya", 10, 24], ["bred", 38, 22]]);

  it("preserves a price-less row that follows a priced row rule 3 refused", () => {
    const priceOnly1 = ocrRow("z1", 92, [["1,818", 150, 20]]);
    const priceOnly2 = ocrRow("z2", 108, [["20,000", 148, 22]]);
    expect(classesOf(COLUMN_LABELS, priceOnly1, priceOnly2, nameless)).toEqual([
      "noise_header",
      "ambiguous",
      "ambiguous",
      "ambiguous",
    ]);
  });

  it("discards the same row while no priced row has appeared, so the case above is the zone and not the text", () => {
    expect(classesOf(COLUMN_LABELS, nameless)).toEqual(["noise_header", "noise_header"]);
  });

  it("is ended by a priced row the separator rule could not resolve either", () => {
    const separator = ocrRow("z4", 92, [["8.00", 150, 20], ["9.00", 152, 18]]);
    expect(classesOf(COLUMN_LABELS, separator, nameless)).toEqual(["noise_header", "ambiguous", "ambiguous"]);
  });

  it("is not ended by a pattern-matched header row that happens to carry an amount", () => {
    expect(classesOf(COLUMN_LABELS, TAX_ROW, nameless)).toEqual(["noise_header", "noise_header", "noise_header"]);
  });
});

describe("continuation merging requires all four §5 conditions together", () => {
  it("merges consecutive wrapped rows into the item above, in document order", () => {
    const parsed = parse(receipt(ITEM_A, WRAP_1, WRAP_2, ITEM_B));
    expect(parsed.items.map((item) => item.name)).toEqual(["MIKA GORENG Tanpa es dan gula", "NASI PUTIH"]);
    expect(parsed.items[0]!.sourceLineIds).toEqual(["i1", "c1", "c2"]);
    expect(parsed.unclassifiedRows).toEqual([]);
  });

  it("condition 1 — indentation outside the item's name column refuses the merge", () => {
    expect(classesOf(ITEM_A, MISALIGNED_ROW, ITEM_B)).toEqual(["item", "ambiguous", "item"]);
  });

  it("condition 2 — a charge label or header pattern refuses the merge", () => {
    for (const row of [
      ocrRow("c4", 76, [["Service", 10, 32], ["charge", 46, 30]]),
      ocrRow("c5", 76, [["TABLE", 10, 30], ["4", 44, 6]]),
    ]) {
      expect(classesOf(ITEM_A, row, ITEM_B)).not.toContain("continuation");
    }
  });

  it("condition 3 — a row longer than twice the median item-name length refuses the merge", () => {
    expect(TOO_LONG_ROW.text.trim().length).toBeGreaterThan(continuationLengthCap([ITEM_A.text.trim().length - 6]));
    expect(classesOf(ITEM_A, TOO_LONG_ROW, ITEM_B)).toEqual(["item", "ambiguous", "item"]);
  });

  it("condition 4 — a standalone all-caps line refuses the merge", () => {
    expect(classesOf(ITEM_A, ocrRow("c6", 76, [["DESSERTS", 10, 40]]), ITEM_B)).toEqual(["item", "ambiguous", "item"]);
  });

  it("measures the cap against the name column, not the priced row text", () => {
    // "MIKA GORENG" is 11 characters; the row text including 8.000 is 17, which would raise the cap to 34.
    expect(continuationLengthCap([11])).toBe(22);
    expect(classesOf(ITEM_A, WRAP_1, TOO_LONG_ROW, ITEM_B)).toEqual(["item", "continuation", "ambiguous", "item"]);
  });

  it("the 20-character floor carries the warm-up, then the median takes over", () => {
    expect(continuationLengthCap([])).toBe(20);
    expect(continuationLengthCap([3])).toBe(20);
    expect(continuationLengthCap([13])).toBe(26);
    expect(continuationLengthCap([13, 13, 30])).toBe(26);
  });

  it("each condition is testable on its own, independent of the pass", () => {
    const row = classifyRows(receipt(WRAP_1)).rows[0]!.row;
    expect(meetsContinuationConditions(row, 10, [11], 4)).toBe(true);
    expect(meetsContinuationConditions(row, 120, [11], 4)).toBe(false);
    expect(meetsContinuationConditions(row, 10, [3], 4)).toBe(true);
  });
});
