/**
 * `ParsedItem` assembly: name, quantity, printed unit price and line total, each with the provenance §7
 * requires (`DECISIONS/0010` Q1, Q6, Q8).
 *
 * 05 gave every item its name and nothing else. Here the row's numbers become integer paise, and the two
 * fields stay separate claims: `lineTotal` is the amount printed in the price column, `unitPrice` is a
 * price the receipt actually printed as a unit price. Dividing a total by a quantity to manufacture a
 * unit price is the inference §7's provenance tables forbid, so it does not happen — except at quantity 1,
 * where the row's one printed amount *is* the unit price and no arithmetic is involved.
 */

import type { ParsedItem, ParseWarning, PriceSource, QuantitySource } from "../types.js";
import type { ClassifiedRow } from "./classify.js";
import type { PriceColumn, RowWord } from "./geometry.js";
import type { NumberProfile } from "./money.js";
import { readMoney } from "./money.js";
import { readQuantity, type QuantityColumn } from "./quantity.js";

const BARE_INTEGER = /^\d{1,2}$/;

/** For each item-row index, the continuation rows that merged into it, in order. */
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

function inPriceBand(word: RowWord, column: PriceColumn | null): boolean {
  if (!column) return false;
  return Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance;
}

/**
 * Q6: `MIKA KECIL 0`. A row the geometry gave no price for can still print a line total — as a bare `0`
 * in the price column, which P6 excludes from the candidate band to keep quantity edges out of it.
 * Position distinguishes quantity-0 from total-0, and three preconditions keep the rescue honest: no
 * candidate, no other readable money on the row, and the value `0`.
 */
export function zeroTotalWord(row: ClassifiedRow, column: PriceColumn | null, profile: NumberProfile): RowWord | null {
  if (row.priceCandidates.length !== 0) return null;
  const zero = row.row.words.find(
    (word) => BARE_INTEGER.test(word.text.trim()) && Number(word.text.trim()) === 0 && inPriceBand(word, column)
  );
  if (!zero) return null;
  const otherMoney = row.row.words.some(
    (word) => word !== zero && readMoney(word.text, profile).paise !== null
  );
  return otherMoney ? null : zero;
}

function nameOf(row: ClassifiedRow, drop: readonly RowWord[], continuations: readonly string[]): string {
  const words = row.row.words.filter((word) => !drop.includes(word)).map((word) => word.text);
  return [...words, ...continuations].join(" ").replace(/\s+/g, " ").trim();
}

/** The mean of the word scores the provider supplied, or null when it supplied none. Never imputed. */
function confidenceOf(words: readonly RowWord[]): number | null {
  const scores = words.map((word) => word.confidence).filter((value): value is number => value !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

export interface ItemBuild {
  readonly items: ParsedItem[];
  /** Row indexes 06 promoted to items; they leave `unclassifiedRows`, where §5 keeps the two lists disjoint. */
  readonly promotedRowIndexes: ReadonlySet<number>;
  readonly warnings: ParseWarning[];
}

/**
 * Items in document order with ids `i1…`, quantities in §7's three states and prices carrying their own
 * provenance. Deterministic: every value is a function of the rows already classified, never of input
 * ordering or object key order.
 */
export function buildItems(
  rows: readonly ClassifiedRow[],
  band: QuantityColumn | null,
  column: PriceColumn | null,
  profile: NumberProfile
): ItemBuild {
  const merged = continuationsByItem(rows);
  const items: ParsedItem[] = [];
  const warnings: ParseWarning[] = [];
  const promotedRowIndexes = new Set<number>();

  const candidates: { index: number; row: ClassifiedRow; promoted: boolean; totalWord: RowWord | null }[] = [];
  rows.forEach((row, index) => {
    if (row.classification === "item") {
      candidates.push({ index, row, promoted: false, totalWord: row.priceCandidates[0] ?? null });
      return;
    }
    if (row.classification !== "ambiguous" || !row.row.words.some((word) => /[A-Za-z]/.test(word.text))) return;
    const totalWord = zeroTotalWord(row, column, profile);
    if (!totalWord) return;
    promotedRowIndexes.add(index);
    candidates.push({ index, row, promoted: true, totalWord });
  });

  for (const candidate of candidates) {
    const { row } = candidate;
    const continuationIndices = row.classification === "item" ? merged.get(candidate.index) ?? [] : [];
    const continuationText = continuationIndices.map((at) => rows[at]!.row.text);
    const drop = candidate.totalWord ? [candidate.totalWord] : [];
    const name = nameOf(row, drop, continuationText);

    const reading = readQuantity(row.row, band, column, drop);
    const total = candidate.totalWord ? readMoney(candidate.totalWord.text, profile).paise : null;

    const printed = row.row.words
      .map((word) => ({ word, reading: readMoney(word.text, profile) }))
      .find((entry) => entry.reading.unitPriceMarker && entry.reading.paise !== null);
    let unitPrice: number | null = printed ? printed.reading.paise : null;
    let priceSource: PriceSource = unitPrice === null ? "unresolved" : "detected";
    if (unitPrice === null && total !== null && reading.qty === 1) {
      unitPrice = total;
      priceSource = "detected";
    }

    const sourceLineIds = [...row.row.sourceLineIds];
    for (const at of continuationIndices) {
      for (const lineId of rows[at]!.row.sourceLineIds) {
        if (!sourceLineIds.includes(lineId)) sourceLineIds.push(lineId);
      }
    }

    const item: ParsedItem = {
      id: `i${items.length + 1}`,
      name,
      qty: reading.qty,
      quantitySource: reading.quantitySource as QuantitySource,
      unitPrice,
      priceSource,
      lineTotal: total,
      confidence: confidenceOf([...row.row.words, ...continuationIndices.flatMap((at) => rows[at]!.row.words)]),
      sourceLineIds,
      warnings: [],
    };

    if (reading.warning) {
      const warning: ParseWarning = {
        code: reading.warning,
        message:
          reading.warning === "qty_assumed"
            ? `Item ${item.id} prints no quantity, so 1 is assumed and needs review before lock`
            : `Item ${item.id} has a number that is not attributable to a quantity column, so its quantity is unresolved`,
        itemRef: item.id,
        sourceLineIds: [...sourceLineIds],
        sourceText: row.row.text,
        sourceBox: { ...row.row.box },
      };
      item.warnings.push(warning);
      warnings.push(warning);
    }

    items.push(item);
  }

  return { items, promotedRowIndexes, warnings };
}
