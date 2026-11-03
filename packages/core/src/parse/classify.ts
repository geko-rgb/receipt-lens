/**
 * Row classification (DECISIONS/0008 P7): one forward pass over clustered rows, in the pinned rule
 * order, plus §5's continuation merge.
 *
 * Rows are classified before their contents are parsed — quantities, money and typed charges are
 * ticket 06 — so an item out of this stage carries its merged text and its geometry, nothing else.
 */

import type { OcrResult } from "../ocr/types.js";
import {
  clusterRows,
  inferPriceColumn,
  priceCandidatesForRow,
  rowBandTolerance,
  weightedMedianWordHeight,
  type ParsedRow,
  type PriceColumn,
  type RowWord,
} from "./geometry.js";
import { isAllCapsStandalone, matchesChargeLabel, matchesHeaderOrNoisePattern } from "./patterns.js";
import { CONTINUATION_LENGTH_FLOOR, CONTINUATION_LENGTH_MEDIAN_MULTIPLIER } from "./constants.js";

export type RowClassification = "item" | "continuation" | "noise_header" | "ambiguous";

/** A clustered row with its class and the geometry the decision rested on. */
export interface ClassifiedRow {
  readonly row: ParsedRow;
  readonly classification: RowClassification;
  readonly priceCandidates: readonly RowWord[];
  /** Index of the item row a continuation merged into; null for every other class. */
  readonly mergedInto: number | null;
  /** Left edge of the name column this row was judged against, for an item or a continuation. */
  readonly nameColumnLeft: number | null;
}

export interface RowClassifyResult {
  readonly rows: readonly ClassifiedRow[];
  readonly column: PriceColumn | null;
  readonly bandTolerance: number;
  readonly medianWordHeight: number;
}

function isHeaderOrLabelledRow(row: ParsedRow): boolean {
  return matchesHeaderOrNoisePattern(row.words.map((word) => word.text)) || matchesChargeLabel(row.text);
}

/**
 * The lower-crossing median P4 pins for word heights, applied to item-name lengths so both halves
 * of the continuation rule reach for the same statistic: each value has weight one, and the result
 * is a length some item actually has.
 */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length / 2;
  let seen = 0;
  for (const value of sorted) {
    seen += 1;
    if (seen >= half) return value;
  }
  return sorted[sorted.length - 1]!;
}

/** §5 "length is no more than twice the median item-name length seen so far", floored per P1. */
export function continuationLengthCap(itemNameLengths: readonly number[]): number {
  return Math.max(CONTINUATION_LENGTH_FLOOR, CONTINUATION_LENGTH_MEDIAN_MULTIPLIER * medianOf(itemNameLengths));
}

/**
 * §5 "Continuation rule": all four conditions hold together or the row is not a continuation —
 * indentation within tolerance of the item's name column, no charge label or header pattern, length
 * within the cap, and not an all-caps standalone line.
 */
export function meetsContinuationConditions(
  row: ParsedRow,
  nameColumnLeft: number,
  itemNameLengths: readonly number[],
  bandTolerance: number
): boolean {
  const words = row.words.map((word) => word.text);
  return (
    Math.abs(row.left - nameColumnLeft) <= bandTolerance &&
    !isHeaderOrLabelledRow(row) &&
    row.text.trim().length <= continuationLengthCap(itemNameLengths) &&
    !isAllCapsStandalone(words)
  );
}

function collectWords(ocrResult: OcrResult): RowWord[] {
  const words: RowWord[] = [];
  for (const line of ocrResult.lines) {
    for (const word of line.words) {
      words.push({ text: word.text, box: word.box, confidence: word.confidence, sourceLineId: line.id });
    }
  }
  return words;
}

/**
 * The item-name length the §5 cap is measured against: the row text with its price-column word
 * removed. Excluding the candidate is geometry, not content parsing (P6 already identified it), and
 * it keeps the median near real name lengths — a priced row's full text runs several characters
 * longer, which would inflate the cap and let long header rows merge.
 */
function itemNameLength(row: ParsedRow, priceCandidates: readonly RowWord[]): number {
  if (priceCandidates.length !== 1) return row.text.trim().length;
  const candidate = priceCandidates[0]!;
  return row.words
    .filter((word) => word !== candidate)
    .map((word) => word.text)
    .join(" ")
    .trim()
    .length;
}

/**
 * Clusters an `OcrResult` into rows and classifies each one. Deterministic: the pass reads only
 * geometry, text and rows already classified, so output never depends on object or map ordering.
 */
export function classifyRows(ocrResult: OcrResult): RowClassifyResult {
  const words = collectWords(ocrResult);
  const medianWordHeight = weightedMedianWordHeight(words);
  const bandTolerance = rowBandTolerance(medianWordHeight);
  const rows = clusterRows(words, bandTolerance);
  const column = inferPriceColumn(rows, ocrResult.imageSize.width);

  const classified: ClassifiedRow[] = [];
  const itemNameLengths: number[] = [];
  let itemsSeen = 0;
  /** Index of the item currently open for continuation, and whether the previous row belonged to it. */
  let openItem: { index: number; nameColumnLeft: number } | null = null;
  let previousWasItemOrContinuation = false;

  for (const row of rows) {
    const candidates = priceCandidatesForRow(row, column);
    const push = (rowClass: RowClassification, mergedInto: number | null, nameColumnLeft: number | null) => {
      classified.push({ row, classification: rowClass, priceCandidates: candidates, mergedInto, nameColumnLeft });
    };

    // 1. header/noise patterns and charge labels win before any numeric row is read as a product.
    if (isHeaderOrLabelledRow(row)) {
      previousWasItemOrContinuation = false;
      push("noise_header", null, null);
      continue;
    }

    // 2. several plausible prices is never resolved by picking one.
    if (candidates.length >= 2) {
      previousWasItemOrContinuation = false;
      push("ambiguous", null, null);
      continue;
    }

    // 3. exactly one candidate makes the row an item and opens it for continuations.
    if (candidates.length === 1) {
      itemsSeen += 1;
      itemNameLengths.push(itemNameLength(row, candidates));
      openItem = { index: classified.length, nameColumnLeft: row.left };
      previousWasItemOrContinuation = true;
      push("item", null, row.left);
      continue;
    }

    // 4. price-less: a continuation only when all four conditions hold against the open item.
    if (
      openItem &&
      previousWasItemOrContinuation &&
      meetsContinuationConditions(row, openItem.nameColumnLeft, itemNameLengths, bandTolerance)
    ) {
      // The merged row does not widen the item's measured length: growth would let each accepted
      // continuation raise the cap for the next one, and a run of them could swallow a header row.
      push("continuation", openItem.index, openItem.nameColumnLeft);
      continue;
    }

    previousWasItemOrContinuation = false;

    // 5. above the first item there is nothing to continue, so the row is header noise.
    if (itemsSeen === 0) {
      push("noise_header", null, null);
      continue;
    }

    // 6. once items exist, an unmerged price-less row is set aside visibly rather than discarded.
    push("ambiguous", null, null);
  }

  return { rows: classified, column, bandTolerance, medianWordHeight };
}
