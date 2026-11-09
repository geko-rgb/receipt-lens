import type { OcrLine, OcrResult } from "../ocr/types.js";
import { ocrRow } from "./fixtures.js";

/**
 * The second bug receipt from `next.md` (issue 1 / issue 2 / issue 5, "Receipt B: Restaurant KOT").
 *
 * What the photo prints:
 *
 * ```text
 * Bill No: 210373
 * Date: 05-10-26
 * Time: 12:01:58
 *
 * Particulars       Qty    Rate    Amount
 * Pineapple lime     3     25.00    75.00
 * Total                              75.00
 * ```
 *
 * Three properties of that layout are the whole bug and each is reproduced here on purpose:
 *
 * 1. **The metadata values sit at the right margin**, exactly where the table's `Amount` column prints. The
 *    price column is *inferred from right edges*, so those numbers are what it anchors to — and the app's
 *    report is what that produces: `Bill No: 210373` sold as a product for ₹2,10,373.00 with an assumed
 *    quantity of 1.
 * 2. **The item row carries its name and all three numbers on one line**, under a header whose last column is
 *    `Amount` rather than `Total`.
 * 3. **The footer is an instruction**, not a purchase.
 *
 * Geometry matches the repository's other fixtures: a 720-wide image, columns right-aligned under their own
 * header words. The width is the photographed page's width (720×1280).
 */

export const KOT_IMAGE_WIDTH = 720;

/** The photographed page's own size, so the parser's page-relative tolerances are the ones it really uses. */
function receipt(...rows: OcrLine[]): OcrResult {
  return {
    lines: [...rows],
    imageSize: { width: KOT_IMAGE_WIDTH, height: 1280 },
    provider: "fixture",
    version: "0-test",
  };
}

/** Right edges of the three printed value columns, taken from the header words below. */
export const KOT_COLUMN_RIGHTS = { qty: 464, rate: 556, total: 660 } as const;

/** The receipt's own identifiers, as `next.md` states them. */
export const KOT_METADATA = { billNumber: "210373", date: "05-10-26", time: "12:01:58" } as const;

/** The one product, as the structured output must read it. */
export const KOT_PRODUCT = { name: "Pineapple lime", qty: 3, unitPrice: 2500, lineTotal: 7500 } as const;

function right(text: string, rightEdge: number, y: number, id: string, width: number): ReturnType<typeof ocrRow> {
  return ocrRow(id, y, [[text, rightEdge - width, width]]);
}

/** One labelled metadata line: its label at the left margin, its value at the right one. */
function metadataLine(label: string, value: string, y: number, id: string, labelWidth = 52, valueWidth = 84): ReturnType<typeof ocrRow>[] {
  return [
    ocrRow(`${id}-label`, y, [[label, 40, labelWidth]]),
    right(value, KOT_COLUMN_RIGHTS.total, y, `${id}-value`, valueWidth),
  ];
}

export const KOT_HEADER = ocrRow("h-kot", 260, [
  ["Particulars", 40, 106],
  ["Qty", 420, 30],
  ["Rate", 500, 40],
  ["Amount", 596, 66],
]);

/**
 * The product row: name, then `Qty | Rate | Amount` on the same printed line.
 *
 * `7 Up 500ml` (below, in {@link RECEIPT_WITH_DIGITS_IN_NAMES}) and this receipt's `Combo 2 Chapati` case are
 * why the band — not a pattern — decides which numbers are values: `500ml` and `2` are name words because no
 * column band claims them, and `3` is a quantity because the `Qty` band does.
 */
export const KOT_ITEM = ocrRow("i-kot", 320, [
  ["Pineapple", 40, 84],
  ["lime", 130, 38],
  ["3", KOT_COLUMN_RIGHTS.qty - 10, 10],
  ["25.00", KOT_COLUMN_RIGHTS.rate - 40, 40],
  ["75.00", KOT_COLUMN_RIGHTS.total - 50, 50],
]);

export const KOT_TOTAL = ocrRow("x-kot-total", 420, [
  ["Total", 40, 42],
  ["75.00", KOT_COLUMN_RIGHTS.total - 50, 50],
]);

/** Semantically empty text at the bottom of every Indian bill, and a *different* bill's number in the frame. */
export const KOT_FOOTER = ocrRow("x-kot-thanks", 470, [
  ["THANK", 40, 44],
  ["YOU", 92, 30],
  ["VISIT", 130, 40],
  ["AGAIN", 178, 44],
]);

export const KOT_BACKGROUND = ocrRow("bg-1", 90, [
  ["BILL", 40, 36],
  ["NO", 84, 24],
  ["OF", 116, 20],
  ["THE", 144, 28],
  ["ADJACENT", 180, 70],
  ["RECEIPT", 258, 60],
  ["998811", KOT_COLUMN_RIGHTS.total - 56, 56],
]);

/** Receipt B, complete. */
export const KOT_RECEIPT: OcrResult = receipt(
  KOT_BACKGROUND,
  ...metadataLine("Bill No:", KOT_METADATA.billNumber, 130, "m-bill"),
  ...metadataLine("Date:", KOT_METADATA.date, 160, "m-date"),
  ...metadataLine("Time:", KOT_METADATA.time, 190, "m-time"),
  KOT_HEADER,
  KOT_ITEM,
  KOT_TOTAL,
  KOT_FOOTER
);

/**
 * A second product line whose description prints across two physical lines, and whose name carries digits —
 * the two remaining layout facts issues 2 and 6 ask about (`Combo 2 Chapati / P.B. Masala` on the bug-report
 * photo, `7 Up 500ml` in the wild).
 */
export const MULTILINE_ITEM_NAME = ocrRow("i-multi-1", 380, [
  ["Combo", 40, 50],
  ["2", 96, 10],
  ["Chapati", 114, 62],
]);

export const MULTILINE_ITEM_DETAIL = ocrRow("i-multi-2", 404, [["/", 40, 8], ["P.B.", 54, 34], ["Masala", 94, 54]]);

export const MULTILINE_ITEM_VALUES = ocrRow("i-multi-3", 428, [
  ["2", KOT_COLUMN_RIGHTS.qty - 10, 10],
  ["153.00", KOT_COLUMN_RIGHTS.rate - 52, 52],
  ["306.00", KOT_COLUMN_RIGHTS.total - 56, 56],
]);

export const RECEIPT_WITH_DIGITS_IN_NAMES: OcrResult = receipt(
  KOT_HEADER,
  ocrRow("i-seven-1", 300, [
    ["7", 40, 10],
    ["Up", 56, 22],
    ["500ml", 84, 46],
    ["2", KOT_COLUMN_RIGHTS.qty - 10, 10],
    ["25.00", KOT_COLUMN_RIGHTS.rate - 40, 40],
    ["50.00", KOT_COLUMN_RIGHTS.total - 44, 44],
  ]),
  MULTILINE_ITEM_NAME,
  MULTILINE_ITEM_DETAIL,
  MULTILINE_ITEM_VALUES,
  ocrRow("x-digits-total", 520, [["Total", 40, 42], ["356.00", KOT_COLUMN_RIGHTS.total - 56, 56]])
);
