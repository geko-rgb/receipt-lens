/**
 * `parse()` — ticket 05's stage: normalized OCR in, classified rows out.
 *
 * Rows are clustered and classified before any of their contents are read (§5). Quantities, money
 * and typed charges are ticket 06, so an item here carries the name text its rows produced and
 * nothing else, and every amount is honestly unresolved rather than guessed.
 */

import type { OcrBox, OcrResult } from "../ocr/types.js";
import type { ParsedItem, ParseResult, ParseWarning, UnclassifiedRow } from "../types.js";
import { classifyRows, type ClassifiedRow } from "./classify.js";

function copyBox(box: OcrBox): OcrBox {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** For each item row index, the indices of the continuation rows that merged into it, in order. */
function continuationsByItem(rows: readonly ClassifiedRow[]): Map<number, number[]> {
  const merged = new Map<number, number[]>();
  rows.forEach((entry, index) => {
    if (entry.classification !== "continuation" || entry.mergedInto === null) return;
    const bucket = merged.get(entry.mergedInto);
    if (bucket) bucket.push(index);
    else merged.set(entry.mergedInto, [index]);
  });
  return merged;
}

function itemsFromClassification(rows: readonly ClassifiedRow[]): ParsedItem[] {
  const merged = continuationsByItem(rows);
  const items: ParsedItem[] = [];
  let ordinal = 0;

  rows.forEach((entry, index) => {
    if (entry.classification !== "item") return;
    ordinal += 1;
    const continuationIndices = merged.get(index) ?? [];
    // The price-column word is dropped from the name text because P6 already identified it by
    // geometry; turning it into a paise amount is ticket 06's content parsing.
    const [priceCandidate] = entry.priceCandidates;
    const nameWords = entry.row.words.filter((word) => word !== priceCandidate).map((word) => word.text);
    const name = [...nameWords, ...continuationIndices.map((at) => rows[at]!.row.text)]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const sourceLineIds = [...entry.row.sourceLineIds];
    for (const at of continuationIndices) {
      for (const lineId of rows[at]!.row.sourceLineIds) {
        if (!sourceLineIds.includes(lineId)) sourceLineIds.push(lineId);
      }
    }

    items.push({
      id: `i${ordinal}`,
      name,
      // Content parsing — quantity, price and line total — is ticket 06. Nothing here is guessed.
      qty: null,
      quantitySource: "unresolved",
      unitPrice: null,
      priceSource: "unresolved",
      lineTotal: null,
      confidence: null,
      sourceLineIds,
      warnings: [],
    });
  });
  return items;
}

function ambiguousRows(rows: readonly ClassifiedRow[]): UnclassifiedRow[] {
  const unclassified: UnclassifiedRow[] = [];
  let ordinal = 0;
  for (const entry of rows) {
    if (entry.classification !== "ambiguous") continue;
    ordinal += 1;
    unclassified.push({
      id: `u${ordinal}`,
      text: entry.row.text,
      box: copyBox(entry.row.box),
      sourceLineIds: [...entry.row.sourceLineIds],
      reason: "ambiguous",
      warningCode: "ambiguous_row",
    });
  }
  return unclassified;
}

function rowWarnings(rows: readonly ClassifiedRow[]): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  let ordinal = 0;
  for (const entry of rows) {
    if (entry.classification !== "ambiguous") continue;
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
 * Pure and deterministic: the same `OcrResult` always produces a byte-identical `ParseResult`, the
 * input is never mutated, and no nested reference from it is shared into the output.
 */
export function parse(ocrResult: OcrResult): ParseResult {
  const { rows } = classifyRows(ocrResult);
  return {
    items: itemsFromClassification(rows),
    unclassifiedRows: ambiguousRows(rows),
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: null,
    subtotalSource: "unresolved",
    grandTotal: null,
    grandTotalSource: "unresolved",
    warnings: rowWarnings(rows),
  };
}

export { classifyRows, continuationLengthCap, meetsContinuationConditions } from "./classify.js";
export type { ClassifiedRow, RowClassification, RowClassifyResult } from "./classify.js";
