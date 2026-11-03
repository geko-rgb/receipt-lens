import { describe, expect, it } from "vitest";
import { classifyRows } from "./classify.js";
import { detectQuantityColumn, quantityPattern, readQuantity } from "./quantity.js";
import { FIXTURE_IMAGE_WIDTH, ocrRow, receipt } from "./fixtures.js";
import type { OcrLine } from "../ocr/types.js";

/**
 * DECISIONS/0010 Q1 in behaviour: a column is inferred only where one exists, the `N ×` pattern needs no
 * column, and an integer that belongs to neither is `unresolved` rather than a confident guess.
 *
 * Geometry follows `parse/fixtures.ts`: a 200 px page makes every band tolerance 10 px, a 10 px word
 * height makes the y-band 4 px, and prices right-edge at 170 so the price column is unambiguous.
 */

function row(index: number, qtyX: number, name: string, price: string): OcrLine {
  return ocrRow(`r${index}`, 20 + index * 20, [
    [String(qtyX === 10 ? 1 : 2), qtyX, 8],
    [name, 30 + index % 3, name.length * 3],
    [price, 150, 20],
  ]);
}

function doc(lines: readonly OcrLine[]) {
  const ocr = receipt(...lines);
  const { rows, column } = classifyRows(ocr);
  return { rows: rows.map((entry) => entry.row), column, ocr };
}

describe("quantity column qualification (§5, DECISIONS/0010 Q1)", () => {
  it("infers a column where ≥5 rows carry an aligned integer ≤20", () => {
    const { rows, column } = doc([row(0, 10, "MIKA", "8.000"), row(1, 10, "NASI", "5.000"), row(2, 10, "TEH", "3.000"), row(3, 10, "AIR", "2.000"), row(4, 10, "KOPI", "9.000")]);
    const band = detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column);
    expect(band).not.toBeNull();
    expect(band!.rows).toBe(5);
    expect(band!.share).toBeGreaterThanOrEqual(0.6);
  });

  it("refuses a band with fewer than 5 rows of evidence — the majority would be the item count agreeing with itself", () => {
    const { rows, column } = doc([row(0, 10, "MIKA", "8.000"), row(1, 10, "NASI", "5.000"), row(2, 10, "TEH", "3.000")]);
    expect(detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column)).toBeNull();
  });

  it("refuses a band where most rows hold money rather than small integers", () => {
    const lines = [
      ocrRow("m0", 20, [["1", 10, 8], ["250.000", 150, 20]]),
      ocrRow("m1", 40, [["1", 10, 8], ["480.000", 150, 20]]),
      ocrRow("m2", 60, [["1.500", 10, 14], ["6.000", 150, 20]]),
      ocrRow("m3", 80, [["2.250", 10, 14], ["7.000", 150, 20]]),
      ocrRow("m4", 100, [["18.000", 10, 14], ["9.000", 150, 20]]),
    ];
    const { rows, column } = doc(lines);
    const band = detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column);
    expect(band === null || band.anchor > 10).toBe(true);
  });

  it("never mistakes the price column for a quantity column", () => {
    // Small integers right-aligned onto the price column: the band that forms IS the price band, and §5's
    // quantity column is the one that counts units, not the one that prints amounts.
    const lines = [0, 1, 2, 3, 4].map((i) =>
      ocrRow(`p${i}`, 20 + i * 20, [["TEH", 10, 12], ["8.000", 150, 20], [String(i + 3), 162, 8]])
    );
    const { rows, column } = doc(lines);
    expect(column).not.toBeNull();
    expect(Math.abs(column!.center - 170)).toBeLessThanOrEqual(10);
    expect(detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column)).toBeNull();
  });

  it("takes the leftmost qualified band when more than one qualifies", () => {
    const lines = [0, 1, 2, 3, 4].map((i) =>
      ocrRow(`t${i}`, 20 + i * 20, [
        ["3", 10, 8],
        ["NASI", 40, 16],
        ["2", 70, 8],
        ["8.000", 150, 20],
      ])
    );
    const { rows, column } = doc(lines);
    const band = detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column);
    expect(band!.anchor).toBe(10);
  });
});

describe("the leading N × pattern (§5's first quantity clause)", () => {
  const words = (texts: readonly string[]) =>
    texts.map((text, index) => ({ text, box: { x: index * 20, y: 0, width: 16, height: 10 }, confidence: null, sourceLineId: "L0" }));

  it("reads the glued and the two-word form", () => {
    expect(quantityPattern(words(["1X", "MIKA", "8.000"]))).toBe(1);
    expect(quantityPattern(words(["3", "x", "@", "6500"]))).toBe(3);
    expect(quantityPattern(words(["2", "×", "NASI", "5.000"]))).toBe(2);
    expect(quantityPattern(words(["4", "*", "TEH", "3.000"]))).toBe(4);
  });

  it("leaves a bare integer to the column rule, and refuses an integer over 20", () => {
    expect(quantityPattern(words(["1", "MIKA", "8.000"]))).toBeNull();
    expect(quantityPattern(words(["25", "x", "MIKA"]))).toBeNull();
  });

  it("never reads a percentage as a quantity", () => {
    expect(quantityPattern(words(["10", "%"]))).toBeNull();
    expect(quantityPattern(words(["40%"]))).toBeNull();
    expect(quantityPattern(words(["6", "%", "OFF", "x"]))).toBeNull();
  });
});

describe("quantity provenance (§7): explicit, assumed, unresolved — and nothing else", () => {
  const fiveRowColumn = [0, 1, 2, 3, 4].map((i) => ocrRow(`q${i}`, 20 + i * 20, [["1", 10, 8], ["MIKA", 40, 16], ["8.000", 150, 20]]));

  it("explicit from the column when the row's integer sits in a qualified band", () => {
    const { rows, column } = doc(fiveRowColumn);
    const band = detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column);
    expect(readQuantity(rows[0]!, band, column).quantitySource).toBe("explicit");
  });

  it("explicit from the pattern even with no column at all", () => {
    const { rows, column } = doc([ocrRow("x0", 20, [["2", 10, 8], ["X", 22, 8], ["MIKA", 34, 16], ["8.000", 150, 20]])]);
    const reading = readQuantity(rows[0]!, detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column), column);
    expect(reading).toMatchObject({ qty: 2, quantitySource: "explicit", warning: null });
  });

  it("assumed 1 with a warning when no quantity-shaped token exists", () => {
    const { rows, column } = doc([ocrRow("y0", 20, [["MIKA", 10, 16], ["GORENG", 30, 22], ["8.000", 150, 20]])]);
    const reading = readQuantity(rows[0]!, null, column);
    expect(reading).toMatchObject({ qty: 1, quantitySource: "assumed", warning: "qty_assumed" });
  });

  it("unresolved when an integer is visible but attributable to nothing — confidently absent is not the same as unknown", () => {
    const { rows, column } = doc([ocrRow("z0", 20, [["1", 10, 8], ["OREO", 30, 14], ["SPREAD", 50, 22], ["52,000", 150, 20]])]);
    const reading = readQuantity(rows[0]!, null, column);
    expect(reading).toMatchObject({ qty: null, quantitySource: "unresolved", warning: "qty_unresolved" });
  });

  it("unresolved when two different integers sit in the same qualified band", () => {
    const lines = [0, 1, 2, 3].map((i) => ocrRow(`c${i}`, 20 + i * 20, [["1", 10, 8], ["MIKA", 40, 16], ["8.000", 150, 20]]));
    const both = [...lines, ocrRow("c4", 100, [["1", 10, 8], ["2", 12, 8], ["MIKA", 40, 16], ["8.000", 150, 20]])];
    const { rows, column } = doc(both);
    const band = detectQuantityColumn(rows, FIXTURE_IMAGE_WIDTH, column);
    const reading = readQuantity(rows[4]!, band, column);
    expect(band).not.toBeNull();
    expect(reading.quantitySource).toBe("unresolved");
  });

  it("treats an integer inside the price band as a printed total, not a quantity (Q6)", () => {
    const prices = [0, 1].map((i) => ocrRow(`w${i}`, 20 + i * 20, [["NASI", 10, 16], ["5.000", 150, 20]]));
    const { rows, column } = doc([...prices, ocrRow("b0", 60, [["MIKA", 10, 16], ["KECIL", 30, 18], ["0", 162, 8]])]);
    expect(column).not.toBeNull();
    const reading = readQuantity(rows[2]!, null, column);
    expect(reading).toMatchObject({ qty: 1, quantitySource: "assumed", via: "absent" });
  });
});
