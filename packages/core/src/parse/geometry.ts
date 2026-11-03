/**
 * Parser geometry (DECISIONS/0008 P4, P5, P6): y-band row clustering and right-aligned price
 * column inference, computed from `OcrWord`s only.
 *
 * The parser re-clusters words from scratch rather than reusing `OcrLine`s: the provider's lines
 * are a reading-order view banded at 0.5 × an unweighted median against a running band mean, and
 * §5's rows are a parsing decision at 0.4 × a word-count-weighted median. Collapsing the two is
 * forbidden — see DECISIONS/0007.
 */

import type { OcrBox, OcrWord } from "../ocr/types.js";
import { unionBoxes } from "../ocr/pp-ocrv6/lines.js";
import { MIN_ROW_BAND_TOLERANCE, PRICE_COLUMN_WIDTH_RATIO, ROW_BAND_HEIGHT_RATIO } from "./constants.js";

/** A word placed in a parser row, carrying the provider line it came from. */
export interface RowWord {
  readonly text: string;
  readonly box: OcrBox;
  readonly confidence: number | null;
  readonly sourceLineId: string;
}

/** One clustered visual row: words left-to-right, plus the union of their boxes. */
export interface ParsedRow {
  readonly index: number;
  readonly text: string;
  readonly box: OcrBox;
  /** Left edge of the row's leftmost word — the name-column position the indent gate compares to. */
  readonly left: number;
  readonly words: readonly RowWord[];
  readonly sourceLineIds: readonly string[];
}

/** The inferred right-aligned price column, or its absence. */
export interface PriceColumn {
  readonly center: number;
  readonly tolerance: number;
  /** True when no cluster reached the 2-member minimum and rows fall back to their own rightmost amount. */
  readonly fallback: boolean;
  readonly qualifiedClusters: number;
}

const byHeightAscending = (a: number, b: number) => a - b;

function verticalCenter(word: { box: OcrBox }): number {
  return word.box.y + word.box.height / 2;
}

/**
 * P4: the word-count-weighted median word height, resolved by the lower crossing — the smallest
 * height whose cumulative word count reaches half the receipt's words.
 *
 * The observation unit is the word, which is what makes it word-count-weighted rather than a median
 * of line heights: a line of eight words votes eight times. Counting is what §5's phrasing asks
 * for; the height values themselves are never weights. No interpolation, so the result is always a
 * height some word actually has.
 */
export function weightedMedianWordHeight(words: readonly { box: OcrBox }[]): number {
  if (words.length === 0) return 0;
  const heights = words.map((entry) => entry.box.height).sort(byHeightAscending);
  const half = heights.length / 2;
  let seen = 0;
  for (const height of heights) {
    seen += 1;
    if (seen >= half) return height;
  }
  return heights[heights.length - 1]!;
}

/** P5: the y-band tolerance, 0.4 × the weighted median, floored so a degenerate page stays parseable. */
export function rowBandTolerance(medianWordHeight: number): number {
  return Math.max(MIN_ROW_BAND_TOLERANCE, medianWordHeight * ROW_BAND_HEIGHT_RATIO);
}

/**
 * P5: single-linkage clustering on vertical centres. A new row starts when the gap between
 * consecutive centres exceeds the tolerance; ties break on left edge. Chain rather than radius, so
 * the result never depends on the order words were fed in.
 */
export function clusterRows(words: readonly RowWord[], tolerance: number): ParsedRow[] {
  if (words.length === 0) return [];
  const ordered = [...words].sort(
    (a, b) => verticalCenter(a) - verticalCenter(b) || a.box.x - b.box.x || a.text.localeCompare(b.text),
  );

  const bands: RowWord[][] = [[ordered[0]!]];
  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i]!;
    const previous = ordered[i - 1]!;
    if (verticalCenter(current) - verticalCenter(previous) <= tolerance) bands[bands.length - 1]!.push(current);
    else bands.push([current]);
  }

  return bands.map((band, index) => toParsedRow(band, index));
}

function toParsedRow(band: readonly RowWord[], index: number): ParsedRow {
  const words = [...band].sort((a, b) => a.box.x - b.box.x || a.text.localeCompare(b.text));
  const sourceLineIds: string[] = [];
  for (const word of words) {
    if (!sourceLineIds.includes(word.sourceLineId)) sourceLineIds.push(word.sourceLineId);
  }
  return {
    index,
    text: words.map((word) => word.text).join(" "),
    box: unionBoxes(words.map((word) => word.box)),
    left: words[0]!.box.x,
    words,
    sourceLineIds,
  };
}

/**
 * P6: candidate-amount shape. After stripping currency tokens and the space after them, the word
 * must be digits with optional `,`/`.`, and must either carry a separator or have at least three
 * digits — bare 1–2 digit integers are the quantity column's population, and admitting them puts
 * quantity right edges into the price alignment test.
 *
 * This is a geometry predicate only: it never produces a paise value. Locale profiles and the
 * integer-paise boundary are ticket 06.
 */
export function isAmountShaped(text: string): boolean {
  const token = text.replace(/[₹]|(?:^|\s)Rs\.?|(?:^|\s)INR/g, "").replace(/\s+/g, "");
  if (!/^\d[\d.,]*$/.test(token)) return false;
  const digits = token.replace(/[.,]/g, "");
  return token.includes(",") || token.includes(".") || digits.length >= 3;
}

/** Right edges of a row's amount-shaped words, and the row they belong to. */
interface EdgePoint {
  readonly right: number;
  readonly word: RowWord;
}

function amountEdges(rows: readonly ParsedRow[]): EdgePoint[] {
  const points: EdgePoint[] = [];
  for (const row of rows) {
    for (const word of row.words) {
      if (isAmountShaped(word.text)) points.push({ right: word.box.x + word.box.width, word });
    }
  }
  return points;
}

/**
 * P6: group amount-shaped right edges from the right inward, keep groups of two or more, and take
 * the rightmost such group as the price column. With no group of two the column is unverifiable
 * and the per-row fallback applies.
 */
export function inferPriceColumn(rows: readonly ParsedRow[], imageWidth: number): PriceColumn | null {
  const points = amountEdges(rows);
  if (points.length < 2) return null;
  const tolerance = imageWidth * PRICE_COLUMN_WIDTH_RATIO;
  const sorted = [...points].sort((a, b) => b.right - a.right);

  const groups: { anchor: number; members: EdgePoint[] }[] = [];
  for (const point of sorted) {
    const current = groups[groups.length - 1];
    if (!current || current.anchor - point.right > tolerance) groups.push({ anchor: point.right, members: [point] });
    else current.members.push(point);
  }

  const qualified = groups.filter((group) => group.members.length >= 2);
  if (qualified.length === 0) return { center: sorted[0]!.right, tolerance, fallback: true, qualifiedClusters: 0 };
  const rightmost = qualified.reduce((best, group) => (group.anchor > best.anchor ? group : best));
  return { center: rightmost.anchor, tolerance, fallback: false, qualifiedClusters: qualified.length };
}

/**
 * The amount-shaped words on a row that sit inside the price column band. More than one is an
 * `ambiguous_price_separator`, never an arbitrary choice.
 */
export function priceCandidatesForRow(row: ParsedRow, column: PriceColumn | null): readonly RowWord[] {
  if (!column) return [];
  const amounts = row.words.filter(isAmountWord);
  if (column.fallback) {
    const rightmost = amounts.reduce<RowWord | null>(
      (best, word) => (best === null || word.box.x + word.box.width > best.box.x + best.box.width ? word : best),
      null,
    );
    return rightmost ? [rightmost] : [];
  }
  return amounts.filter((word) => Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance);
}

function isAmountWord(word: RowWord): boolean {
  return isAmountShaped(word.text);
}
