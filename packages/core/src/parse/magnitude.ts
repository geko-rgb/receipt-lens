import type { NumberProfile } from "./money.js";
import { readMoney } from "./money.js";
import type { ParsedRow, PriceColumn, RowWord } from "./geometry.js";
import { priceCandidatesForRow } from "./geometry.js";

/**
 * DECISIONS/0033's magnitude gate, in one place.
 *
 * An identifier — a bill number, an order id, a telephone number — is *amount-shaped*: `isAmountShaped` admits any
 * run of three or more digits. Column alignment alone cannot tell `Bill No: 210373` from a ₹2,10,373.00 line, and
 * the page's own money can: a value more than `PRICE_MAGNITUDE_MULTIPLE` times the median amount the page prints is
 * an identifier wearing a price's shape.
 *
 * Three stages read columns off a page — the classifier's single price column (`0008` P7), a printed header table
 * (`0033`), and the header-free pairing stage (`0035`). The *rule* must be one rule, so it lives here; each stage
 * supplies the values it can read (the classifier is profile-aware and works in paise, the pairing stage reads
 * strict column tokens) and gets back the same predicate.
 */
export const PRICE_MAGNITUDE_MULTIPLE = 1000;

/** Median of an ascending-sorted list; 0 for an empty one. */
export function medianOfSorted(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * The gate for a set of printed values, in any unit: a value above `median × PRICE_MAGNITUDE_MULTIPLE` is an
 * identifier. Returns `null` when there is no median to compare against, which means "no gate" and not "reject
 * everything" — a page with one number on it has no distribution to be an outlier of.
 */
export function amountGate(values: readonly number[]): number | null {
  const positives = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positives.length === 0) return null;
  const median = medianOfSorted(positives);
  if (median <= 0) return null;
  return median * PRICE_MAGNITUDE_MULTIPLE;
}

/** Is `value` beyond the gate? A null gate never rejects. */
export function exceedsGate(value: number | null, gate: number | null): boolean {
  return gate !== null && value !== null && value > gate;
}

/**
 * The classifier's form of the gate: every amount-shaped word in the price column of the page, read through the
 * page's number profile. Unknown or fallback columns get no gate, because there is no column to be an outlier of.
 */
export function magnitudeOutlier(
  rows: readonly ParsedRow[],
  column: PriceColumn | null,
  profile: NumberProfile
): (word: RowWord) => boolean {
  if (!column || column.fallback) return () => false;
  const gate = amountGate(
    rows
      .flatMap((row) => priceCandidatesForRow(row, column))
      .map((word) => readMoney(word.text, profile).paise)
      .filter((value): value is number => value !== null)
  );
  return (word: RowWord) => {
    if (gate === null) return false;
    return exceedsGate(readMoney(word.text, profile).paise, gate);
  };
}
