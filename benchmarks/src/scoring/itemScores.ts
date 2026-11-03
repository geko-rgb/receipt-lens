import type { ParsedItem } from "@receipt-lens/core";
import type { GoldItem } from "../datasets/types.js";
import { tauName } from "../benchmark.config.js";
import { matchItems } from "../matching/matcher.js";
import { normalizeItemName } from "../matching/similarity.js";

/**
 * Field-level precision/recall/F1 over matched item pairs (§8 Tier 2, ticket 03b box 4).
 *
 * The cell rules, in the order they are decided — **strict at the cell level**, the same rule
 * the scalar tier applies, per §8's "Null-vs-populated counts as an error for the applicable
 * field":
 *
 * | gold cell | predicted cell | outcome |
 * |---|---|---|
 * | missing | missing | **abstention** — agreement on absence, never a hit |
 * | missing | present | **false positive** — a value asserted where the dataset annotated none |
 * | present | missing | **false negative** — a recall miss on that field |
 * | present | present, equal | **true positive** |
 * | present | present, unequal | **false positive + false negative** — a wrong value is both |
 *
 * "Missing" means `null` for the numeric fields and an empty name. The second row is the cost
 * of this reading, accepted knowingly: `dev/cord-v2` gold annotates `unitPrice` on only 49 of
 * 254 items, so a parser that correctly infers a unit price the dataset never printed is
 * charged a false positive. The alternative — excluding those cells — would be a lenient
 * reinterpretation of a spec sentence that says the opposite, and §1's claim is honest
 * accuracy, not comfortable accuracy. `unannotated` is published beside the counts so a reader
 * can see how much of a field's denominator came from this row, which is the disclosure §8
 * demands for sparse fields; `item.unitPrice` is the row to watch when a real parser lands.
 *
 * An abstention is recorded only for a **paired** cell, where both sides genuinely exist: an
 * unmatched item has no counterpart cell to agree absence with, so its absent fields count
 * nothing (its populated ones still count as fn or fp, per §8.4).
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
  /** paired cells where neither side carried a value: agreement on absence, never a hit */
  absent: number;
  /** gold cells carrying no annotation, whatever the prediction did: the sparse-field denominator */
  unannotated: number;
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
  return { tp: 0, fp: 0, fn: 0, absent: 0, unannotated: 0 };
}

export function addItemCounts(target: ItemFieldCounts, source: ItemFieldCounts): void {
  target.tp += source.tp;
  target.fp += source.fp;
  target.fn += source.fn;
  target.absent += source.absent;
  target.unannotated += source.unannotated;
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

  const counterFor = (attribute: ItemAttribute): ItemFieldCounts | undefined => counts[attribute];

  for (const pair of match.pairs) {
    const goldItem = gold[pair.goldIndex];
    const asserted = predicted[pair.predictedIndex];
    if (!goldItem || !asserted) continue;
    for (const attribute of attributes) {
      const counter = counterFor(attribute);
      if (!counter) continue;
      const expected = goldValue(attribute, goldItem);
      const actual = predictedValue(attribute, asserted);

      if (expected === null) {
        counter.unannotated += 1;
        if (actual === null) {
          counter.absent += 1;
          continue;
        }
        // §8: null-vs-populated counts as an error for the applicable field.
        counter.fp += 1;
        fieldMisses += 1;
        continue;
      }
      if (actual === null) {
        counter.fn += 1;
        fieldMisses += 1;
        continue;
      }
      if (expected === actual) {
        counter.tp += 1;
        continue;
      }
      counter.fp += 1;
      counter.fn += 1;
      fieldMisses += 1;
    }
  }

  // An unmatched gold item asserts nothing that was wrong; every field it annotates is simply
  // not recovered (§8.4). An unmatched prediction asserts values with nothing behind them, so
  // each populated field is a false positive — and a field it left null is not one, because
  // no claim was made.
  for (const index of match.unmatchedGold) {
    const missed = gold[index];
    if (!missed) continue;
    for (const attribute of attributes) {
      const counter = counterFor(attribute);
      if (!counter) continue;
      if (goldValue(attribute, missed) === null) {
        counter.unannotated += 1;
        continue;
      }
      counter.fn += 1;
      fieldMisses += 1;
    }
  }
  for (const index of match.unmatchedPredicted) {
    const asserted = predicted[index];
    if (!asserted) continue;
    for (const attribute of attributes) {
      const counter = counterFor(attribute);
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
