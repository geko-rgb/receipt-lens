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
import { consumedQuantityWords, readQuantity, type QuantityColumn } from "./quantity.js";
import type { ReconstructionEvidence, TableRecord } from "./rows.js";

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

/** A small integer or a printed rate is not "another amount on the row" — Q1 and Q5 already own it. */
function isOtherAmount(word: RowWord, profile: NumberProfile): boolean {
  const text = word.text.trim();
  if (/%/.test(text)) return false;
  if (BARE_INTEGER.test(text)) return false;
  return readMoney(text, profile).paise !== null;
}

/**
 * Q6: `MIKA KECIL 0`. A row the geometry gave no price for can still print a line total — as a bare `0`
 * in the price column, which P6 excludes from the candidate band to keep quantity edges out of it.
 * Position distinguishes quantity-0 from total-0, and three preconditions keep the rescue honest: no
 * candidate, no other amount on the row, and the value `0`.
 *
 * "No other amount" excludes the row's own quantity — `2 TUTUP SEAL 0` prints a count and a total, and
 * refusing small integers here would throw away exactly the rows that demonstrate the distinction.
 */
export function zeroTotalWord(row: ClassifiedRow, column: PriceColumn | null, profile: NumberProfile): RowWord | null {
  if (row.priceCandidates.length !== 0) return null;
  const zero = row.row.words.find(
    (word) => BARE_INTEGER.test(word.text.trim()) && Number(word.text.trim()) === 0 && inPriceBand(word, column)
  );
  if (!zero) return null;
  return row.row.words.some((word) => word !== zero && isOtherAmount(word, profile)) ? null : zero;
}

/**
 * The name is the row minus what the parser consumed: the price-column word (05), and — only when the
 * quantity was actually *read* — the quantity words. An assumed or unresolved quantity consumes nothing,
 * because removing a word the parser could not attribute would hide the evidence a reviewer needs.
 */
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

/** Integer paise for a table column's value, or null when the row left the column empty. */
function paiseOf(token: TableRecord["qty"]): number | null {
  return token === null ? null : Math.round(token.value * 100);
}

/**
 * DECISIONS/0033 P9: items reconstructed from a printed column table. Provenance follows the evidence and
 * nothing else — a quantity the row printed in its `Qty` column is `explicit`, one the table did not print is
 * `unresolved` (never `assumed`: the table proves the column exists and this row left it blank), and a row whose
 * `qty × rate` disagrees with its printed total keeps all three printed values **and** an evidence-bearing
 * warning, because §7 forbids repairing one printed number with two others.
 *
 * `firstId` is the ordinal this group starts at: ids stay `i1…iN` across both groups, in document order.
 */
function buildTableItems(
  rows: readonly ClassifiedRow[],
  records: readonly TableRecord[],
  band: QuantityColumn | null,
  column: PriceColumn | null,
  profile: NumberProfile,
  firstId: number
): ItemBuild {
  const items: ParsedItem[] = [];
  const warnings: ParseWarning[] = [];
  const promotedRowIndexes = new Set<number>();
  const byIndex = new Map(rows.map((entry) => [entry.row.index, entry]));

  for (const record of records) {
    const codes = new Set(record.evidence.map((entry) => entry.code));
    // A column the table named arrives already marked in `codes` by the reconstruction; the evidence is what
    // decides, so the two can never disagree.
    // A quantity that is not a whole number of units is *printed* and still not usable: §10's `Item.qty` is a
    // positive integer and `ItemUnit` materializes one unit per count, so `0` or `1.5` would publish an item the
    // bill could never finalize. The value stays in the evidence message and `qty` stays unresolved, which is what
    // §7 asks for — the receipt said something, the parser just cannot claim it as a count.
    const printedQty = record.qty?.value ?? null;
    const qty = codes.has("qty_missing") || codes.has("qty_not_countable") ? null : printedQty;
    const unitPrice = codes.has("rate_missing") ? null : paiseOf(record.rate);
    const lineTotal = codes.has("total_missing") ? null : paiseOf(record.total);

    const sourceLineIds: string[] = [];
    for (const index of record.sourceRowIndexes) {
      promotedRowIndexes.add(index);
      for (const lineId of byIndex.get(index)?.row.sourceLineIds ?? []) {
        if (!sourceLineIds.includes(lineId)) sourceLineIds.push(lineId);
      }
    }
    const confidence = confidenceOf(
      record.sourceRowIndexes.flatMap((index) => byIndex.get(index)?.row.words ?? [])
    );

    const item: ParsedItem = {
      id: `i${firstId + items.length}`,
      name: record.name,
      qty,
      quantitySource: qty === null ? "unresolved" : "explicit",
      unitPrice,
      priceSource: unitPrice === null ? "unresolved" : "detected",
      lineTotal,
      confidence,
      sourceLineIds,
      warnings: [],
    };

    for (const finding of record.evidence) {
      const warning: ParseWarning = {
        // P9's vocabulary: an arithmetic disagreement has its own code so a reviewer can filter for it.
        code: itemWarningCode(finding.code),
        message: `Item ${item.id} ("${record.name}"): ${finding.message}`,
        itemRef: item.id,
        sourceLineIds: [...sourceLineIds],
        sourceText: record.name,
        sourceBox: { ...record.box },
      };
      item.warnings.push(warning);
      warnings.push(warning);
    }
    items.push(item);
  }

  // The band and price column are not consulted here: a table row's values come from its columns, which is the
  // whole point of the table pass. They stay in the signature because a table record and a loose row are built
  // by the same caller and a divergence between the two would be a bug worth seeing at the call site.
  void band;
  void column;
  void profile;

  return { items, promotedRowIndexes, warnings };
}

/** The `ParseWarningCode` a reconstruction finding is published under (DECISIONS/0033 P9). */
function itemWarningCode(code: ReconstructionEvidence["code"]): ParseWarning["code"] {
  switch (code) {
    case "arithmetic_mismatch":
      return "row_arithmetic_mismatch";
    case "qty_missing":
      return "row_qty_missing";
    case "qty_not_countable":
      return "row_qty_not_countable";
    case "rate_missing":
      return "row_rate_missing";
    case "total_missing":
      return "row_total_missing";
    // Two different numbers in one column is §5's `ambiguous_row` (the same condition 0008 P7 rule 2 names for
    // a row printing two price-column amounts) and gets that code, not a new one.
    case "conflicting_value":
      return "ambiguous_row";
  }
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
  profile: NumberProfile,
  tableRecords: readonly TableRecord[] = []
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
    const reading = readQuantity(row.row, band, column, drop);
    const nameDrop = [...drop, ...consumedQuantityWords(row.row, band, column, drop)];
    const name = nameOf(row, nameDrop, continuationText);
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

  const table = buildTableItems(rows, tableRecords, band, column, profile, items.length + 1);
  for (const entry of table.promotedRowIndexes) promotedRowIndexes.add(entry);
  for (const warning of table.warnings) warnings.push(warning);
  return { items: [...items, ...table.items], promotedRowIndexes, warnings };
}
