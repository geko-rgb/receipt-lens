import type { ParsedItem } from "@receipt-lens/core";
import type { GoldItem } from "../datasets/types.js";
import { tauName } from "../benchmark.config.js";
import { matchItems } from "../matching/matcher.js";
import { normalizeItemName } from "../matching/similarity.js";

/**
 * Field-level precision/recall/F1 over matched item pairs (§8 Tier 2, ticket 03b box 4).
 *
 * The cell rules, in the order they are decided:
 *
 * | gold cell | predicted cell | outcome |
 * |---|---|---|
 * | missing | anything | **excluded** — unannotated, never a hit and never a miss |
 * | present | missing | **false negative** — a recall miss on that field |
 * | present | present, equal | **true positive** |
 * | present | present, unequal | **false positive + false negative** — a wrong value is both |
 *
 * "Missing" means `null` for the numeric fields and an empty name; §8's own words are the
 * authority: unannotated fields are excluded, never treated as false negatives or as null
 * ground truth. `dev/cord-v2` gold has no `unitPrice` on 205 of 254 items, so the excluded
 * row is the common case rather than an edge case — and it is why `excluded` is published
 * next to tp/fp/fn: a reader must be able to see how much of a field's denominator the
 * dataset actually annotated.
 *
 * A field is compared by **exact** agreement — normalized string equality for names, integer
 * equality for amounts and quantities. τ loosens *pairing*, never scoring: two names that
 * needed tolerance to be paired are still a field miss (§8.5).
 */

export type ItemAttribute = "name" | "qty" | "unitPrice" | "lineTotal";

export interface ItemFieldCounts {
  tp: number;
  fp: number;
  fn: number;
  /** cells the dataset did not annotate: excluded, counted nowhere else */
  excluded: number;
}

export interface ReceiptItemScore {
  readonly counts: Readonly<Record<ItemAttribute, ItemFieldCounts>>;
  readonly matchedPairs: number;
  readonly goldItems: number;
  readonly predictedItems: number;
  readonly unmatchedGold: number;
  readonly unmatchedPredicted: number;
  /**
   * Gold cells that actually carry an annotation (`tp + fn`). An item line with a blank name
   * and no amounts is not evidence of anything, and 03a's strict denominator rule says a
   * receipt with nothing labelled never counts — the item tier must agree with the scalar tier
   * about what makes a receipt scoreable.
   */
  readonly annotatedGoldCells: number;
  /** every annotated item field agreed and both item sets were fully paired */
  readonly strictlyAgrees: boolean;
  readonly tau: number;
}

function emptyCounts(): ItemFieldCounts {
  return { tp: 0, fp: 0, fn: 0, excluded: 0 };
}

export function addItemCounts(target: ItemFieldCounts, source: ItemFieldCounts): void {
  target.tp += source.tp;
  target.fp += source.fp;
  target.fn += source.fn;
  target.excluded += source.excluded;
}

/** The gold side's own vocabulary: `null` amounts and empty names are both "not annotated". */
function goldValue(attribute: ItemAttribute, item: GoldItem): string | number | null {
  const value = item[attribute === "name" ? "name" : attribute];
  if (value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : normalizeItemName(value);
  return value;
}

function predictedValue(attribute: ItemAttribute, item: ParsedItem): string | number | null {
  const value = item[attribute];
  if (value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : normalizeItemName(value);
  return value;
}

export function scoreReceiptItems(
  gold: readonly GoldItem[],
  predicted: readonly ParsedItem[],
  attributes: readonly ItemAttribute[],
  tau: number = tauName
): ReceiptItemScore {
  const match = matchItems(gold, predicted, tau);
  const counts = Object.fromEntries(attributes.map((attribute) => [attribute, emptyCounts()])) as Record<ItemAttribute, ItemFieldCounts>;
  let fieldMisses = 0;

  const scoreCell = (attribute: ItemAttribute, goldItem: GoldItem | null, predictedItem: ParsedItem | null): void => {
    const counter = counts[attribute];
    if (!counter) return;
    const expected = goldItem === null ? null : goldValue(attribute, goldItem);
    const actual = predictedItem === null ? null : predictedValue(attribute, predictedItem);

    if (expected === null) {
      counter.excluded += 1;
      return;
    }
    if (actual === null) {
      counter.fn += 1;
      fieldMisses += 1;
      return;
    }
    if (expected === actual) {
      counter.tp += 1;
      return;
    }
    counter.fp += 1;
    counter.fn += 1;
    fieldMisses += 1;
  };

  for (const pair of match.pairs) {
    for (const attribute of attributes) {
      scoreCell(attribute, gold[pair.goldIndex] ?? null, predicted[pair.predictedIndex] ?? null);
    }
  }
  // An unmatched gold item asserts nothing that was wrong; every field it annotates is simply
  // not recovered (§8.4). An unmatched prediction asserts values with nothing behind them, so
  // each populated field is a false positive — and a field it left null is not one, because
  // no claim was made.
  for (const index of match.unmatchedGold) {
    for (const attribute of attributes) scoreCell(attribute, gold[index] ?? null, null);
  }
  for (const index of match.unmatchedPredicted) {
    const asserted = predicted[index];
    if (!asserted) continue;
    for (const attribute of attributes) {
      const counter = counts[attribute];
      if (!counter || predictedValue(attribute, asserted) === null) continue;
      counter.fp += 1;
      fieldMisses += 1;
    }
  }

  return {
    counts,
    matchedPairs: match.pairs.length,
    goldItems: gold.length,
    predictedItems: predicted.length,
    unmatchedGold: match.unmatchedGold.length,
    unmatchedPredicted: match.unmatchedPredicted.length,
    annotatedGoldCells: attributes.reduce((sum, attribute) => sum + counts[attribute].tp + counts[attribute].fn, 0),
    strictlyAgrees: match.unmatchedGold.length === 0 && match.unmatchedPredicted.length === 0 && fieldMisses === 0,
    tau: match.tau,
  };
}
