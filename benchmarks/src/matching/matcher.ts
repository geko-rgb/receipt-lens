import type { ParsedItem } from "@receipt-lens/core";
import type { GoldItem } from "../datasets/types.js";
import { tauName } from "../benchmark.config.js";
import { nameSimilarity, normalizeItemName } from "./similarity.js";

/**
 * Deterministic predicted-to-annotated item matching (§8.2–§8.5).
 *
 * **One-to-one, order-respecting, pair count first, similarity second.** Order-respecting
 * means a match never crosses another: as gold index increases, predicted index increases.
 * That is the shape of a receipt — items are read top to bottom — and it is what makes
 * exact maximum-pairs matching tractable as a longest-common-subsequence DP rather than a
 * general assignment problem.
 *
 * §8.2 forbids greedy matching, and the difference is not cosmetic. A greedy pass that takes
 * the highest-similarity pair first can consume a prediction both items could have used and
 * come back with fewer pairs; this DP maximizes count across the whole receipt first and
 * only uses similarity to choose between equal-count alternatives. `matcher.test.ts` pins
 * exactly that case.
 */

export interface MatchedPair {
  readonly goldIndex: number;
  readonly predictedIndex: number;
  /** normalized-name similarity of the pair; always at least the tau it was matched under */
  readonly similarity: number;
}

export interface ItemMatch {
  /** ascending by `goldIndex`, which also makes it ascending by `predictedIndex` */
  readonly pairs: readonly MatchedPair[];
  /** gold indices no prediction matched — each is a false negative (§8.4) */
  readonly unmatchedGold: readonly number[];
  /** predicted indices no gold item matched — each is a false positive (§8.4) */
  readonly unmatchedPredicted: readonly number[];
  readonly tau: number;
  /** whether §8.2's money-compatibility gate ran: part of the identity of every paired-gold number */
  readonly moneyGate: boolean;
}

export interface MatchOptions {
  /**
   * §8.2's money-compatibility gate. `true` (default, production, and every published scorer) is the
   * spec's own matcher. `false` pairs on name similarity alone and is a **measurement seam only**, the
   * same kind ticket 06 added for `classifyRows` and `detectQuantityColumn`.
   *
   * It exists because of DECISIONS/0008's paired-gold rule: money compatibility is a *precondition* of
   * pairing, so a census over gate-on pairs can only ever report "0 wrong" on the money fields — the
   * gate refuses exactly the pairs that would have shown the error. A price claim therefore has to run
   * the same matcher twice and publish both, and `benchmarks/src/matching` stays the artifact of record
   * for both runs instead of a second re-implementation.
   */
  readonly moneyGate?: boolean;
}

/**
 * §8.2: a candidate pair needs name similarity of at least `tau` **and** compatible monetary
 * fields at integer-paise equality.
 *
 * "Compatible" here means *non-conflicting*: where both sides annotate a monetary field the
 * two integers must be equal, and a field one side lacks does not vote. This is the pairing
 * gate only, and it is deliberately weaker than the scoring rule — §8 also says a null-vs-
 * populated cell "counts as an error for the applicable field", which `scoring/itemScores.ts`
 * applies as a false positive. Reading the gate the same strict way would refuse about four
 * fifths of true pairs, because dev CORD gold annotates `unitPrice` on only 49 of 254 items,
 * and it would report every price-parse failure as a *missing item* rather than as a price
 * error. So: pair on name plus non-conflicting money, then charge the mismatch at field level.
 *
 * Nothing here relaxes a price. Where both sides carry a value, equality is exact and integer
 * (§8.5); there is no monetary tolerance anywhere in this harness. The gate itself is switchable for
 * measurement — see `MatchOptions.moneyGate` and DECISIONS/0008's paired-gold rule — but every published
 * scorer runs it on, which is what §8.2 specifies.
 */
export function monetaryFieldsAgree(gold: GoldItem, predicted: ParsedItem): boolean {
  if (gold.unitPrice !== null && predicted.unitPrice !== null && gold.unitPrice !== predicted.unitPrice) return false;
  if (gold.lineTotal !== null && predicted.lineTotal !== null && gold.lineTotal !== predicted.lineTotal) return false;
  return true;
}

/** Pairwise normalized-name similarity, `undefined` where §8.2 says no candidate may form. */
function similarityTable(
  gold: readonly GoldItem[],
  predicted: readonly ParsedItem[],
  tau: number,
  moneyGate: boolean
): (number | undefined)[][] {
  const goldNames = gold.map((item) => normalizeItemName(item.name));
  const predictedNames = predicted.map((item) => normalizeItemName(item.name));

  return goldNames.map((goldName, goldIndex) =>
    predictedNames.map((predictedName, predictedIndex) => {
      const similarity = nameSimilarity(goldName, predictedName);
      if (similarity < tau) return undefined;
      if (!moneyGate) return similarity;
      return monetaryFieldsAgree(gold[goldIndex]!, predicted[predictedIndex]!) ? similarity : undefined;
    })
  );
}

interface Cell {
  readonly pairs: number;
  readonly similarity: number;
}

const TAKE = 0;
const SKIP_GOLD = 1;
const SKIP_PREDICTED = 2;
type Trace = typeof TAKE | typeof SKIP_GOLD | typeof SKIP_PREDICTED;

/** Count first, similarity second — the order §8.3 states the objective in. */
function better(candidate: Cell, incumbent: Cell): boolean {
  return candidate.pairs > incumbent.pairs || (candidate.pairs === incumbent.pairs && candidate.similarity > incumbent.similarity);
}

const zero: Cell = { pairs: 0, similarity: 0 };

export function matchItems(
  gold: readonly GoldItem[],
  predicted: readonly ParsedItem[],
  tau: number = tauName,
  options: MatchOptions = {}
): ItemMatch {
  const moneyGate = options.moneyGate ?? true;
  const similarity = similarityTable(gold, predicted, tau, moneyGate);
  const height = gold.length + 1;
  const width = predicted.length + 1;

  const cells: Cell[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => zero));
  const trace: Trace[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => SKIP_GOLD as Trace));

  for (let i = 1; i < height; i += 1) {
    for (let j = 1; j < width; j += 1) {
      const pair = similarity[i - 1]![j - 1];
      const skipGold = cells[i - 1]![j]!;
      const skipPredicted = cells[i]![j - 1]!;

      // Ties resolve in this declared order: take the pair, then drop the gold item, then
      // drop the prediction. That is what makes duplicate names on one receipt — 5 of the 100
      // dev CORD receipts carry two items with identical names — pair in index order instead
      // of depending on which equal-value cell the scan happened to reach first.
      let chosen = skipGold;
      let mark: Trace = SKIP_GOLD;
      if (pair !== undefined) {
        const take: Cell = { pairs: cells[i - 1]![j - 1]!.pairs + 1, similarity: cells[i - 1]![j - 1]!.similarity + pair };
        chosen = take;
        mark = TAKE;
      }
      if (better(skipGold, chosen)) {
        chosen = skipGold;
        mark = SKIP_GOLD;
      }
      if (better(skipPredicted, chosen)) {
        chosen = skipPredicted;
        mark = SKIP_PREDICTED;
      }
      cells[i]![j] = chosen;
      trace[i]![j] = mark;
    }
  }

  const pairs: MatchedPair[] = [];
  for (let i = gold.length, j = predicted.length; i > 0 && j > 0; ) {
    const mark = trace[i]![j]!;
    if (mark === TAKE) {
      pairs.push({ goldIndex: i - 1, predictedIndex: j - 1, similarity: similarity[i - 1]![j - 1]! });
      i -= 1;
      j -= 1;
    } else if (mark === SKIP_GOLD) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();

  const matchedGold = new Set(pairs.map((pair) => pair.goldIndex));
  const matchedPredicted = new Set(pairs.map((pair) => pair.predictedIndex));
  const goldIndices = gold.map((_, index) => index).filter((index) => !matchedGold.has(index));
  const predictedIndices = predicted.map((_, index) => index).filter((index) => !matchedPredicted.has(index));

  return { pairs, unmatchedGold: goldIndices, unmatchedPredicted: predictedIndices, tau, moneyGate };
}
