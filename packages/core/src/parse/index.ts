/**
 * `parse()` — ticket 06's stage: normalized OCR in, a complete `ParseResult` out.
 *
 * Rows are still classified before any of their contents are read (§5); that is ticket 05's contract and
 * it is unchanged. On top of it, item rows become named items with quantities, printed prices and a line
 * total, each value carrying where it came from (§7); labelled rows that 05 preserved as `noise_header`
 * become typed charges; and a labelled amount this parser cannot type keeps its text and its warning
 * instead of becoming an item. `validate()` is still ticket 07's.
 */

import type { OcrBox, OcrResult } from "../ocr/types.js";
import type { ParseResult, ParseWarning, UnclassifiedRow } from "../types.js";
import { classifyRows, type ClassifiedRow } from "./classify.js";
import { readCharges } from "./charges.js";
import { buildItems } from "./items.js";
import { profileForRows } from "./money.js";
import { detectQuantityColumn } from "./quantity.js";

function copyBox(box: OcrBox): OcrBox {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Rows §5 says stay visible: `ambiguous`, minus the ones this ticket turned into items (Q6). */
function preservedRows(rows: readonly ClassifiedRow[], promoted: ReadonlySet<number>): UnclassifiedRow[] {
  const unclassified: UnclassifiedRow[] = [];
  rows.forEach((entry, index) => {
    if (entry.classification !== "ambiguous" || promoted.has(index)) return;
    unclassified.push({
      id: `u${unclassified.length + 1}`,
      text: entry.row.text,
      box: copyBox(entry.row.box),
      sourceLineIds: [...entry.row.sourceLineIds],
      reason: "ambiguous",
      warningCode: "ambiguous_row",
    });
  });
  return unclassified;
}

function rowWarnings(rows: readonly ClassifiedRow[], promoted: ReadonlySet<number>): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  let ordinal = 0;
  for (const [index, entry] of rows.entries()) {
    if (entry.classification !== "ambiguous" || promoted.has(index)) continue;
    ordinal += 1;
    const rowRef = `u${ordinal}`;
    const source = {
      sourceLineIds: [...entry.row.sourceLineIds],
      sourceText: entry.row.text,
      sourceBox: copyBox(entry.row.box),
    };
    warnings.push({
      code: "ambiguous_row",
      message: `Row ${rowRef} could not be classified as an item, a continuation or header noise, and is preserved for review`,
      ...source,
    });
    // §6 keeps the two codes distinct by condition: a separator row is preserved *and* says why.
    if (entry.priceCandidates.length >= 2) {
      const candidates = entry.priceCandidates.map((word) => word.text).join(", ");
      warnings.push({
        code: "ambiguous_price_separator",
        message: `Row ${rowRef} has ${entry.priceCandidates.length} words aligned to the price column: ${candidates}`,
        ...source,
      });
    }
  }
  return warnings;
}

/**
 * Pure and deterministic: the same `OcrResult` always produces a byte-identical `ParseResult`, the input
 * is never mutated, and no nested reference from it is shared into the output.
 */
export function parse(ocrResult: OcrResult): ParseResult {
  const { rows, column } = classifyRows(ocrResult);
  const parsed = rows.map((entry) => entry.row);
  const profile = profileForRows(parsed);
  const band = detectQuantityColumn(parsed, ocrResult.imageSize.width, column);

  const { items, promotedRowIndexes, warnings: itemWarnings } = buildItems(rows, band, column, profile);
  const unclassifiedRows = preservedRows(rows, promotedRowIndexes);
  const charges = readCharges(rows, column, profile);

  return {
    items,
    unclassifiedRows,
    taxes: [...charges.taxes],
    serviceCharge: charges.serviceCharge,
    tip: charges.tip,
    discount: charges.discount,
    roundOff: charges.roundOff,
    otherCharges: [...charges.otherCharges],
    subtotal: charges.subtotal,
    subtotalSource: charges.subtotalSource,
    grandTotal: charges.grandTotal,
    grandTotalSource: charges.grandTotalSource,
    warnings: [...rowWarnings(rows, promotedRowIndexes), ...itemWarnings, ...charges.warnings],
  };
}

export { classifyRows, continuationLengthCap, meetsContinuationConditions } from "./classify.js";
export type { ClassifiedRow, ClassifyOptions, RowClassification, RowClassifyResult } from "./classify.js";
