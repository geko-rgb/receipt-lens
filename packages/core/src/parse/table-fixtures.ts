import type { OcrResult } from "../ocr/types.js";
import { ocrRow, receipt } from "./fixtures.js";

/**
 * DECISIONS/0033's regression fixture: the receipt from the bug report, laid out the way the photo shows it.
 *
 * The defining property — and the reason the pre-0033 parser could not read it — is that **no product name
 * shares a printed line with its numbers**. Each product prints `Coffee` on one line and `2.00 35.00 70.00` on
 * the next, under a five-column header (`Product | Expire | Qty | Rate | Total`). Nothing about the numbers is
 * special: `2.00` under `Qty` is a quantity printed to two decimals, and `Combo 2 Chapati` contains a `2` that
 * is part of the product's name and not a quantity.
 *
 * Geometry: a 720-wide image (the photo's own width) makes the 5% price band 36px. The columns are right-aligned
 * under their header words, as the printed receipt's are.
 */

export const RECEIPT_WITH_TABLE_IMAGE_WIDTH = 720;

/** Right edges of the four printed columns on the bug-report receipt. */
export const TABLE_COLUMNS = { qty: 470, rate: 560, total: 660 } as const;

function rightAligned(text: string, right: number, y: number, id: string, width: number): ReturnType<typeof ocrRow> {
  return ocrRow(id, y, [[text, right - width, width]]);
}

/** `Product | Expire | Qty | Rate | Total`, the header the photo prints (and `Expire` has no role here). */
export const TABLE_HEADER = ocrRow("h-table", 300, [
  ["Product", 40, 78],
  ["Expire", 330, 62],
  ["Qty", 442, 28],
  ["Rate", 520, 40],
  ["Total", 610, 50],
]);

/** One product: its name on its own line, then its three numbers on the line below. */
function product(name: string, y: number, numbers: readonly [string, string, string], id: string): ReturnType<typeof ocrRow>[] {
  const nameWords = name.split(" ").map((word, index) => [word, 40 + index * 46, Math.max(18, word.length * 11)] as [string, number, number]);
  return [
    ocrRow(`n-${id}`, y, nameWords),
    rightAligned(numbers[0], TABLE_COLUMNS.qty, y + 22, `q-${id}`, 36),
    rightAligned(numbers[1], TABLE_COLUMNS.rate, y + 22, `r-${id}`, 50),
    rightAligned(numbers[2], TABLE_COLUMNS.total, y + 22, `t-${id}`, 56),
  ];
}

export const GST_HEADER = ocrRow("h-gst", 560, [
  ["HSN", 40, 36],
  ["Tax%", 170, 44],
  ["CGST", 260, 44],
  ["SGST", 350, 44],
  ["Cess", 440, 40],
]);

function gstRow(y: number, id: string, cgst = "1.67", sgst = "1.67"): ReturnType<typeof ocrRow> {
  return ocrRow(id, y, [
    ["996331", 40, 50],
    ["2.5", 176, 24],
    [cgst, 278, 34],
    [sgst, 368, 34],
    ["0", 452, 8],
  ]);
}

export const GST_TOTAL_ROW = ocrRow("x-gst-total", 700, [
  ["Total", 40, 42],
  ["11.29", 268, 44],
  ["11.29", 358, 44],
  ["0", 452, 8],
]);

export const GRAND_TOTAL = ocrRow("x-grand", 760, [
  ["Total", 40, 42],
  ["474.00", 596, 64],
]);

/**
 * The whole receipt. `rowIds` names each product so a test can say which record it is looking at.
 */
export const TABLE_RECEIPT: OcrResult = receipt(
  TABLE_HEADER,
  ...product("Coffee", 340, ["2.00", "35.00", "70.00"], "coffee"),
  ...product("Vada", 390, ["2.00", "25.00", "50.00"], "vada"),
  ...product("Chappathi Empty", 440, ["2.00", "24.00", "48.00"], "chappathi"),
  ...product("Combo 2 Chapati / P.B. Masala", 490, ["2.00", "153.00", "306.00"], "combo"),
  GST_HEADER,
  gstRow(600, "gst-1"),
  gstRow(625, "gst-2", "1.19", "1.19"),
  gstRow(650, "gst-3", "1.14", "1.14"),
  gstRow(675, "gst-4", "7.29", "7.29"),
  GST_TOTAL_ROW,
  GRAND_TOTAL
);

/** The same four products with the name printed on the *same* line as the numbers (a normal 3-column table). */
export const INLINE_TABLE_RECEIPT: OcrResult = receipt(
  TABLE_HEADER,
  ocrRow("in-coffee", 340, [
    ["Coffee", 40, 66],
    ["2.00", 434, 36],
    ["35.00", 510, 50],
    ["70.00", 604, 56],
  ]),
  ocrRow("in-vada", 390, [
    ["Vada", 40, 44],
    ["2.00", 434, 36],
    ["25.00", 510, 50],
    ["50.00", 604, 56],
  ]),
  GRAND_TOTAL
);
