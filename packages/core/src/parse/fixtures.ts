import type { OcrBox, OcrLine, OcrResult, OcrWord } from "../ocr/types.js";

/**
 * Hand-authored `OcrResult` fixtures for the row-geometry and classification suite.
 *
 * Neither dataset can supply these: DECISIONS/0004 establishes that the CORD and SROIE snapshots
 * carry only annotated financial lines, so they contain no column-label row, no table furniture and
 * no wrapped-name continuation. Row classes are tested here; the cached dataset fixtures are run
 * through the same `parse()` seam from `benchmarks/src/parser/`.
 *
 * Geometry: a 200px-wide image makes the price band 10px, and a 10px word height makes the y-band 4px.
 */

export const FIXTURE_IMAGE_WIDTH = 200;

export function ocrRow(id: string, y: number, entries: readonly [string, number, number][]): OcrLine {
  const words: OcrWord[] = entries.map(([text, x, width]) => ({
    text,
    box: { x, y, width, height: 10 } satisfies OcrBox,
    confidence: null,
  }));
  const left = Math.min(...words.map((word) => word.box.x));
  const right = Math.max(...words.map((word) => word.box.x + word.box.width));
  return {
    id,
    text: words.map((word) => word.text).join(" "),
    box: { x: left, y, width: right - left, height: 10 },
    confidence: null,
    words,
  };
}

export function receipt(...rows: OcrLine[]): OcrResult {
  return {
    lines: [...rows],
    imageSize: { width: FIXTURE_IMAGE_WIDTH, height: 400 },
    provider: "fixture",
    version: "0-test",
  };
}

export const COLUMN_LABELS = ocrRow("h1", 20, [["QTY", 10, 16], ["ITEM", 40, 24], ["PRICE", 90, 30]]);
export const MERCHANT = ocrRow("h2", 40, [["WARUNG", 10, 40], ["SEHAT", 54, 32]]);
export const ITEM_A = ocrRow("i1", 60, [["MIKA", 10, 20], ["GORENG", 34, 32], ["8.000", 150, 20]]);
export const ITEM_B = ocrRow("i2", 120, [["NASI", 10, 20], ["PUTIH", 34, 28], ["5.000", 150, 20]]);
export const WRAP_1 = ocrRow("c1", 76, [["Tanpa", 10, 28], ["es", 42, 12]]);
export const WRAP_2 = ocrRow("c2", 92, [["dan", 10, 16], ["gula", 30, 22]]);
export const TABLE_ROW = ocrRow("t1", 140, [["TABLE", 10, 30], ["4", 44, 6]]);
export const GSTIN_ROW = ocrRow("g1", 160, [["GSTIN:", 10, 32], ["07AABCU96031R1Z", 46, 76]]);
export const TAX_ROW = ocrRow("x1", 180, [["CGST", 10, 22], ["2.50", 150, 20]]);
export const PHONE_ROW = ocrRow("p1", 200, [["044-2356901", 10, 50], ["9.00", 152, 18]]);
export const SHOUTY_ROW = ocrRow("s1", 220, [["DESSERTS", 10, 40], ["42", 54, 10]]);
export const TOO_LONG_ROW = ocrRow("w1", 92, [
  ["Extra", 10, 24],
  ["cheese", 38, 30],
  ["and", 72, 16],
  ["some", 92, 24],
  ["more", 120, 26],
  ["things", 150, 30],
]);
export const MISALIGNED_ROW = ocrRow("m1", 76, [["Remarks", 90, 40], ["only", 134, 16]]);

/** A whole small receipt: header, two priced items, one wrapped name, charges and a footer. */
export const FULL_RECEIPT = receipt(
  COLUMN_LABELS,
  MERCHANT,
  ITEM_A,
  WRAP_1,
  WRAP_2,
  ITEM_B,
  TABLE_ROW,
  GSTIN_ROW,
  TAX_ROW,
  PHONE_ROW,
  SHOUTY_ROW
);
