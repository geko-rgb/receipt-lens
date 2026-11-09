import { describe, expect, it } from "vitest";
import type { OcrBox } from "../ocr/types.js";
import {
  clusterRows,
  inferPriceColumn,
  inferValueColumns,
  isAmountShaped,
  isQuantityShaped,
  priceCandidatesForRow,
  rowBandTolerance,
  weightedMedianWordHeight,
  type RowWord,
} from "./geometry.js";

function word(text: string, x: number, y: number, width = 20, height = 10, sourceLineId = "l1"): RowWord {
  return { text, box: { x, y, width, height } satisfies OcrBox, confidence: null, sourceLineId };
}

function cluster(words: readonly RowWord[]) {
  return clusterRows(words, rowBandTolerance(weightedMedianWordHeight(words)));
}

describe("word-count-weighted median word height (§5.1, DECISIONS/0008 P4)", () => {
  it("is zero with no words, and the tolerance floors at 1px", () => {
    expect(weightedMedianWordHeight([])).toBe(0);
    expect(rowBandTolerance(0)).toBe(1);
  });

  it("weights by word, not by line: eight thin words on one line outweigh one tall header word", () => {
    const thin = "01234567".split("").map((digit, index) => word(digit, index * 12, 100, 10, 8));
    const tall = [word("HEADER", 0, 0, 80, 60), ...thin];
    // A median of line heights would land near the 60px header; the word-weighted median is 8.
    expect(weightedMedianWordHeight(tall)).toBe(8);
  });

  it("resolves the crossing downward, so the result is a height a real word has", () => {
    // Four words: the count-weighted crossing lands on the lower middle height (30), and never on
    // the 35 an interpolated median would invent — no word here is 35px tall.
    const heights = [30, 40, 50, 10].map((height, index) => word(`w${index}`, index * 25, 100, 20, height));
    expect(weightedMedianWordHeight(heights)).toBe(30);
    expect(heights.map((entry) => entry.box.height)).toContain(30);
  });
});

describe("y-band clustering (§5.1, DECISIONS/0008 P5)", () => {
  it("merges words whose centres fall inside the band across separate source lines", () => {
    const rows = cluster([
      word("1", 10, 100, 12, 10, "l1"),
      word("MIKA", 40, 101, 40, 10, "l2"),
      word("GORENG", 90, 99, 50, 10, "l3"),
      word("8.000", 200, 100, 30, 10, "l4"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("1 MIKA GORENG 8.000");
    expect(rows[0]!.sourceLineIds).toEqual(["l1", "l2", "l3", "l4"]);
  });

  it("splits rows whose centres differ by more than the band", () => {
    expect(cluster([word("NASI", 10, 100, 30, 10), word("GORENG", 10, 130, 40, 10)])).toHaveLength(2);
  });

  it("keeps a baseline that spans more than the band, because linkage is consecutive", () => {
    // CORD's reference OCR publishes quantity, name and amount as three separate lines of one row.
    const rows = cluster([
      word("1", 176, 556, 18, 30, "L0"),
      word("REAL", 202, 554, 64, 32, "L1"),
      word("GANACHE", 272, 554, 100, 32, "L1"),
      word("16,500", 560, 554, 104, 32, "L2"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("1 REAL GANACHE 16,500");
  });

  it("orders words left-to-right whatever order they arrived in", () => {
    const forward = [word("A", 10, 100), word("B", 60, 101), word("C", 110, 99)];
    expect(cluster(forward)[0]!.text).toBe("A B C");
    expect(cluster([...forward].reverse())[0]!.text).toBe("A B C");
  });
});

describe("price-column inference (§5.2, DECISIONS/0008 P6)", () => {
  it("recognises grouped amounts and rejects bare small integers, dates and codes", () => {
    expect(["9.00", "16,500", "800000", "Rs 45.50"].every(isAmountShaped)).toBe(true);
    expect(["2", "00", "25/12/2018", "789117-W", "QTY"].every((text) => !isAmountShaped(text))).toBe(true);
  });

  it("infers the right-aligned column from right edges aligning within 5% of image width", () => {
    const rows = cluster([
      word("MIKA", 30, 100, 40, 10),
      word("8.000", 240, 100, 30, 10),
      word("NASI", 30, 130, 40, 10),
      word("12.000", 232, 130, 38, 10),
    ]);
    const column = inferPriceColumn(rows, 300);
    expect(column).toEqual(expect.objectContaining({ center: 270, qualifiedClusters: 1, fallback: false }));
    expect(rows.every((row) => priceCandidatesForRow(row, column).length === row.text.split(" ").filter(isAmountShaped).length)).toBe(true);
    expect(rows.map((row) => priceCandidatesForRow(row, column).length)).toEqual([1, 1]);
  });

  it("excludes the quantity column from the price band", () => {
    const rows = cluster([
      word("1", 20, 100, 8, 10),
      word("MIKA", 40, 100, 40, 10),
      word("8.000", 240, 100, 30, 10),
      word("2", 20, 130, 8, 10),
      word("NASI", 40, 130, 40, 10),
      word("12.000", 240, 130, 30, 10),
    ]);
    const column = inferPriceColumn(rows, 300);
    const candidates = rows.flatMap((row) => priceCandidatesForRow(row, column).map((found) => found.text));
    expect(candidates).toEqual(["8.000", "12.000"]);
  });

  it("returns two candidates for a row with two aligned amounts rather than picking one", () => {
    const rows = cluster([
      word("MIKA", 30, 100, 40, 10),
      word("8.00", 250, 100, 20, 10),
      word("9.00", 257, 100, 18, 10),
      word("NASI", 30, 130, 40, 10),
      word("5.00", 252, 130, 20, 10),
    ]);
    const column = inferPriceColumn(rows, 300);
    expect(column?.fallback).toBe(false);
    expect(priceCandidatesForRow(rows[0]!, column).map((found) => found.text)).toEqual(["8.00", "9.00"]);
    expect(priceCandidatesForRow(rows[1]!, column).map((found) => found.text)).toEqual(["5.00"]);
  });

  it("falls back to a row's own rightmost amount when no cluster reaches two members", () => {
    const rows = cluster([
      word("MIKA", 30, 100, 40, 10),
      word("8.000", 240, 100, 30, 10),
      word("NASI", 30, 130, 40, 10),
      word("16.00", 90, 130, 30, 10),
    ]);
    const column = inferPriceColumn(rows, 300);
    expect(column?.fallback).toBe(true);
    expect(priceCandidatesForRow(rows[1]!, column).map((found) => found.text)).toEqual(["16.00"]);
  });

  it("returns no column at all for fewer than two amounts", () => {
    const rows = cluster([word("THANK", 30, 100, 40, 10), word("YOU", 80, 100, 30, 10)]);
    expect(inferPriceColumn(rows, 300)).toBeNull();
  });

  it("treats image width as the scale: the same pixel offsets align on a wide receipt", () => {
    const rows = cluster([
      word("MIKA", 100, 100, 40, 10),
      word("8.00", 900, 100, 20, 10),
      word("NASI", 100, 130, 40, 10),
      word("5.00", 940, 130, 20, 10),
    ]);
    expect(inferPriceColumn(rows, 1000)?.qualifiedClusters).toBe(1);
    expect(inferPriceColumn(rows, 10000)?.qualifiedClusters).toBe(1);
  });
});

describe("value-column bands and bare-integer quantities (ticket 25)", () => {
  // A three-column page whose count column prints `1`, `2`, `3` — not money — and whose rate and total columns
  // print money. `isAmountShaped("1")` is false, so before ticket 25 this page contributed no point for its
  // quantity column at all and the band model could not see it.
  const page = () =>
    cluster([
      word("1", 60, 100, 8, 10),
      word("199.00", 160, 100, 30, 10),
      word("2", 62, 130, 8, 10),
      word("250.00", 158, 130, 32, 10),
      word("3", 61, 160, 8, 10),
      word("120.00", 159, 160, 32, 10),
    ]);

  it("treats a bare integer as a quantity-shaped candidate and nothing more", () => {
    expect(["1", "2", "3", "999"].every(isQuantityShaped)).toBe(true);
    expect(["0.00", "1,999", "2026", "2x", "QTY"].every((text) => !isQuantityShaped(text))).toBe(true);
  });

  it("leaves the count column out of the bands unless the caller admits quantities", () => {
    // One money band (the amount at right edge 190) and no second: the `1 2 3` column is invisible to it.
    expect(inferValueColumns(page(), 300, 8).map((band) => band.members)).toEqual([3]);
    // With the caller saying the page prints a quantity column, the count column joins at its own right edge (68).
    const withCounts = inferValueColumns(page(), 300, 8, true);
    expect(withCounts.map((band) => band.members)).toEqual([3, 3]);
    expect(withCounts.some((band) => Math.abs(band.center - 68) <= 2)).toBe(true);
  });

  it("still needs a whole column before a count becomes a band", () => {
    // Two rows are below `ANCHOR_MIN_COLUMN_MEMBERS`, so nothing forms and no count is admitted on a page that
    // merely prints a `1` here and a `2` there.
    const sparse = cluster([
      word("1", 60, 100, 8, 10),
      word("199.00", 160, 100, 30, 10),
      word("2", 62, 130, 8, 10),
      word("250.00", 158, 130, 32, 10),
    ]);
    expect(inferValueColumns(sparse, 300, 8, true).some((band) => Math.abs(band.center - 68) <= 2)).toBe(false);
  });
});
