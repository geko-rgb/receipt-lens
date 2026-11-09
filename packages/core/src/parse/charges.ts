/**
 * Labelled money rows become typed charges (§5 "Label dictionary", §4's DQ-03 charge shape), pinned in
 * `DECISIONS/0010` (Q5).
 *
 * These rows arrive as `noise_header` from ticket 05 — labelled so they never become products — and this
 * is the one place 06 reads a class 05 discarded. A charge amount is decided over *money* tokens: a `%`
 * token is a printed rate, and a bare 1–2 digit integer is a count unless it is `0` — the same
 * distinction Q6 makes for item rows, for the same reason (`Total Item 7` is not seven paise).
 */

import type { ParseWarning, ParsedOtherCharge, ParsedTax, ValueSource } from "../types.js";
import type { ClassifiedRow } from "./classify.js";
import type { PriceColumn, RowWord } from "./geometry.js";
import { isGroupedDigitIdentifier, isRegistrationRow, labelFragments } from "./patterns.js";
import { chooseCategory, hasInclusionCue, matchLabels, type LabelCategory, type LabelMatch } from "./labels.js";
import { readMoney, readRate, type NumberProfile } from "./money.js";

export interface ChargeRead {
  readonly taxes: readonly ParsedTax[];
  readonly serviceCharge: number | null;
  readonly tip: number | null;
  readonly discount: number | null;
  readonly roundOff: number | null;
  readonly otherCharges: readonly ParsedOtherCharge[];
  readonly subtotal: number | null;
  readonly subtotalSource: ValueSource;
  readonly grandTotal: number | null;
  readonly grandTotalSource: ValueSource;
  readonly warnings: readonly ParseWarning[];
}

const BARE_INTEGER = /^\d{1,2}$/;

interface AmountToken {
  readonly word: RowWord;
  readonly paise: number;
}

/** Q5: which words on this row are money. A printed rate is not, and neither is a non-zero bare integer. */
export function chargeAmountTokens(row: readonly RowWord[], profile: NumberProfile): AmountToken[] {
  const out: AmountToken[] = [];
  for (const word of row) {
    const text = word.text.trim();
    if (/%/.test(text)) continue;
    const reading = readMoney(text, profile);
    if (reading.paise === null) continue;
    if (BARE_INTEGER.test(text) && reading.paise !== 0) continue;
    out.push({ word, paise: reading.paise });
  }
  return out;
}

function inPriceBand(word: RowWord, column: PriceColumn | null): boolean {
  if (!column) return false;
  return Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance;
}

/** The row's amount: one money token, or the one sitting in the price column. Never an arbitrary pick. */
export function resolveChargeAmount(amounts: readonly AmountToken[], column: PriceColumn | null): number | null {
  if (amounts.length === 1) return amounts[0]!.paise;
  if (amounts.length === 0) return null;
  const inBand = amounts.filter((amount) => inPriceBand(amount.word, column));
  return inBand.length === 1 ? inBand[0]!.paise : null;
}

/**
 * `grand total` / `net amount` / `bill amount` are more specific than a bare `total`, so when a receipt
 * prints both the specific one wins; equal specificity keeps the earlier row. Document order and label
 * length are the only inputs, so reordering a fixture cannot change the answer.
 */
function pickAggregate(current: { value: number; rank: number } | null, value: number, label: string) {
  const rank = label.length;
  return current === null || rank > current.rank ? { value, rank } : current;
}

function taxEntries(matches: readonly LabelMatch[], amount: number | null): ParsedTax[] {
  const labels = matches.filter((match) => match.category === "tax");
  return labels.map((label, index) => ({
    label: label.label,
    // One amount and two tax labels is a row the receipt did not separate: the first keeps the printed
    // value, the rest stay null so 07 reports them as unresolved rather than 06 inventing a split.
    amount: index === 0 ? (amount === null ? null : Math.abs(amount)) : null,
    source: "detected" as const,
  }));
}

/**
 * Read every labelled row 05 preserved as `noise_header`. Deterministic: rows are visited in document
 * order, additive charges sum, aggregates take the most specific label and then the earlier row.
 */
/** The `HSN`/`SAC` vocabulary: DECISIONS/0033's marker for "this row is a tax breakdown, not a taxed line". */
const BREAKDOWN_MARKERS = new Set(["HSN", "SAC"]);

export function isTaxBreakdownRow(row: { readonly text: string; readonly words: readonly { readonly text: string }[] }): boolean {
  const fragments = labelFragments(row.text);
  if (fragments.some((fragment) => BREAKDOWN_MARKERS.has(fragment))) return true;
  // An HSN/SAC code is a bare integer of 4, 6 or 8 digits with no separator; money on these receipts always has a
  // decimal point, so the two never collide.
  return row.words.some((word) => /^\d{4}$|^\d{6}$|^\d{8}$/.test(word.text.trim()));
}

export function readCharges(
  rows: readonly ClassifiedRow[],
  column: PriceColumn | null,
  profile: NumberProfile,
  skipRows: ReadonlySet<number> = new Set()
): ChargeRead {
  const taxes: ParsedTax[] = [];
  const otherCharges: ParsedOtherCharge[] = [];
  const warnings: ParseWarning[] = [];
  const additive = { service: null as number | null, tip: null as number | null, discount: null as number | null, roundOff: null as number | null };
  let subtotal: { value: number; rank: number } | null = null;
  let grandTotal: { value: number; rank: number } | null = null;

  for (const entry of rows) {
    if (entry.classification !== "noise_header") continue;
    // DECISIONS/0033 P11: a row a GST table already accounted for is not read again here. The table's total row
    // is the whole tax; its itemised rows are the same money twice, and re-reading them is the double-count.
    if (skipRows.has(entry.row.index)) continue;
    const matches = matchLabels(entry.row.text);
    const category = chooseCategory(matches, hasInclusionCue(entry.row.text));
    if (category === null) continue;
    // A registration identifier row (`GST NO: 0010 9010 5344`) carries a tax word and no tax amount.
    if (isRegistrationRow(entry.row.words.map((word) => word.text)) ||
      entry.row.words.some((word) => isGroupedDigitIdentifier(word.text))) {
      continue;
    }
    // DECISIONS/0035 P4: a GST breakdown the tax-table stage could not read is structural text, not a charge. The
    // marker is the one `isTaxTable` already trusts — an `HSN`/`SAC` heading or an HSN-shaped code — because that is
    // what distinguishes a printed breakdown from a taxed line: a clustered `GST 996331 … HSN … CGST SGST` row is
    // the receipt's tax columns, and one unamounted charge made from it blocks the lock while telling the creator
    // nothing (the printed total already includes the tax). `CGST SGST 5.00` carries no such marker and stays a
    // charge, unamounted or not.
    if (isTaxBreakdownRow(entry.row)) continue;

    const amounts = chargeAmountTokens(entry.row.words, profile);
    if (amounts.length === 0) continue;
    const amount = resolveChargeAmount(amounts, column);
    const source = {
      sourceLineIds: [...entry.row.sourceLineIds],
      sourceText: entry.row.text,
      sourceBox: { ...entry.row.box },
    };

    if (amount === null) {
      otherCharges.push({ label: matches[0]!.label, amount: null, type: "other", sign: "unknown", source: "detected" });
      warnings.push({
        code: "unclassified_charge",
        message: `Row "${entry.row.text}" carries ${amounts.length} amounts with no price-column entry to choose between, so its value is unresolved`,
        ...source,
      });
      continue;
    }

    if (category === "tax") {
      const rate = entry.row.words.map((word) => readRate(word.text, profile)).find((value) => value !== null);
      for (const tax of taxEntries(matches, amount)) {
        if (rate !== undefined && tax.amount !== null) tax.rate = rate;
        taxes.push(tax);
      }
      if (matches.filter((match) => match.category === "tax").length > 1 && amount !== null) {
        warnings.push({
          code: "unclassified_charge",
          message: `Row "${entry.row.text}" names more than one tax and prints one amount; the unattributed tax entries stay unresolved`,
          ...source,
        });
      }
      continue;
    }

    if (category === "subtotal") {
      subtotal = pickAggregate(subtotal, amount, matches[0]!.label);
      continue;
    }
    if (category === "grandTotal") {
      grandTotal = pickAggregate(grandTotal, amount, matches[0]!.label);
      continue;
    }

    // §4: every additive charge is a positive magnitude, and `roundOff` alone keeps its printed sign.
    const value = category === "roundOff" ? amount : Math.abs(amount);
    additive[category] = additive[category] === null ? value : additive[category]! + value;
  }

  return {
    taxes,
    serviceCharge: additive.service,
    tip: additive.tip,
    discount: additive.discount,
    roundOff: additive.roundOff,
    otherCharges,
    subtotal: subtotal?.value ?? null,
    subtotalSource: subtotal === null ? "unresolved" : "detected",
    grandTotal: grandTotal?.value ?? null,
    grandTotalSource: grandTotal === null ? "unresolved" : "detected",
    warnings,
  };
}
