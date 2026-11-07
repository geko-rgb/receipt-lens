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
import {
  ANCHOR_DOWN_REACH_RATIO,
  ANCHOR_MERGE_PX,
  ANCHOR_MIN_COLUMN_MEMBERS,
  ANCHOR_UP_REACH_RATIO,
  MIN_ROW_BAND_TOLERANCE,
  PRICE_COLUMN_WIDTH_RATIO,
  ROW_BAND_HEIGHT_RATIO,
} from "./constants.js";

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
export function clusterRowsByTolerance(words: readonly RowWord[], tolerance: number): ParsedRow[] {
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
 * P6: group amount-shaped right edges from the right inward and take the rightmost group of at least
 * `minMembers` as the column. Groups are built from the right so a stray amount left of the column
 * cannot shift an anchor that a real column already fixed.
 */
function columnFromEdges(
  points: readonly EdgePoint[],
  tolerance: number,
  minMembers: number
): { column: PriceColumn; members: readonly EdgePoint[] } | null {
  if (points.length < minMembers) return null;
  const sorted = [...points].sort((a, b) => b.right - a.right);

  const groups: { anchor: number; members: EdgePoint[] }[] = [];
  for (const point of sorted) {
    const current = groups[groups.length - 1];
    if (!current || current.anchor - point.right > tolerance) groups.push({ anchor: point.right, members: [point] });
    else current.members.push(point);
  }

  const qualified = groups.filter((group) => group.members.length >= minMembers);
  if (qualified.length === 0) return null;
  const rightmost = qualified.reduce((best, group) => (group.anchor > best.anchor ? group : best));
  return {
    column: { center: rightmost.anchor, tolerance, fallback: false, qualifiedClusters: qualified.length },
    members: rightmost.members,
  };
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
  const found = columnFromEdges(points, tolerance, 2);
  if (!found) {
    const rightmost = Math.max(...points.map((point) => point.right));
    return { center: rightmost, tolerance, fallback: true, qualifiedClusters: 0 };
  }
  return found.column;
}

/**
 * P6, before any rows exist: the price column read from raw words alone, so anchor row clustering
 * has something to anchor to. Returns null unless at least `ANCHOR_MIN_COLUMN_MEMBERS` amounts align
 * — a column the page repeats is the only evidence strong enough to re-cut every row against it.
 */
export function inferPriceColumnFromWords(words: readonly RowWord[], imageWidth: number): PriceColumn | null {
  const points: EdgePoint[] = [];
  for (const word of words) {
    if (isAmountShaped(word.text)) points.push({ right: word.box.x + word.box.width, word });
  }
  return columnFromEdges(points, imageWidth * PRICE_COLUMN_WIDTH_RATIO, ANCHOR_MIN_COLUMN_MEMBERS)?.column ?? null;
}

function inPriceColumn(word: RowWord, column: PriceColumn): boolean {
  return Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance;
}

/** One anchor line: where a row's amount sits, and how tall that amount's box is. */
interface AnchorLine {
  readonly centre: number;
  readonly height: number;
}

/**
 * The anchor lines: vertical centres of the amount words printing in the price column, merged within
 * `ANCHOR_MERGE_PX` and ascending. Each line is one printed row's money, whatever the word heights
 * on that row happen to be. The tallest box wins a merge, because reach is scaled by height.
 */
function anchorLines(words: readonly RowWord[], column: PriceColumn): AnchorLine[] {
  const centre = (word: RowWord) => verticalCenter(word);
  const inColumn = words
    .filter((word) => isAmountShaped(word.text) && inPriceColumn(word, column))
    .map((word) => ({ centre: centre(word), height: word.box.height }))
    .sort((a, b) => a.centre - b.centre);

  const anchors: AnchorLine[] = [];
  for (const line of inColumn) {
    const previous = anchors[anchors.length - 1];
    if (previous && line.centre - previous.centre <= ANCHOR_MERGE_PX) {
      if (line.height > previous.height) anchors[anchors.length - 1] = { ...previous, height: line.height };
      continue;
    }
    anchors.push(line);
  }
  return anchors;
}

/**
 * P5 anchor rows (DECISIONS/0008 P5 extension): rows cut against the price column's amount lines
 * rather than a single y-band. A band sized at 0.4 × the weighted median cannot hold a row whose
 * words range from 22px to 79px tall — on the dev receipt that split ten priced rows into five —
 * while the amount column repeats once per row regardless of how badly the name words are boxed.
 *
 * Each word goes to the first anchor line whose asymmetric reach holds its centre — reach is scaled
 * by the anchor word's own height and extends further down than up, because names print below their
 * amount, and is clamped to the neighbouring line so it can never reach past the next row's amount.
 * Words no line reaches (receipt header, footer, and short printed lines like `Round off`) are
 * clustered on the y-band as before, so furniture keeps the rows it always had.
 *
 * Returns null — the caller keeps its band rows — when the anchors cannot describe the page: fewer
 * than two lines, an empty line, or a line that still carries two price-column amounts.
 */
export function clusterRowsByAnchor(
  words: readonly RowWord[],
  column: PriceColumn,
  tolerance: number
): ParsedRow[] | null {
  const anchors = anchorLines(words, column);
  if (anchors.length < 2) return null;

  const bands: RowWord[][] = anchors.map(() => []);
  const unanchored: RowWord[] = [];
  for (const word of words) {
    const centre = verticalCenter(word);
    // An anchor's own amount belongs to its own line, whatever a taller neighbour's reach claims:
    // without this, a tall row above swallowed the next row's price and the row below lost its seed.
    if (isAmountShaped(word.text) && inPriceColumn(word, column)) {
      let nearest = 0;
      for (let index = 1; index < anchors.length; index += 1) {
        if (Math.abs(centre - anchors[index]!.centre) < Math.abs(centre - anchors[nearest]!.centre)) nearest = index;
      }
      bands[nearest]!.push(word);
      continue;
    }
    const index = anchors.findIndex((anchor, at) => {
      const previous = anchors[at - 1];
      const next = anchors[at + 1];
      const up = Math.min(
        anchor.height * ANCHOR_UP_REACH_RATIO,
        previous ? anchor.centre - previous.centre : Number.POSITIVE_INFINITY
      );
      const down = Math.min(
        anchor.height * ANCHOR_DOWN_REACH_RATIO,
        next ? next.centre - anchor.centre : Number.POSITIVE_INFINITY
      );
      return centre >= anchor.centre - up && centre < anchor.centre + down;
    });
    if (index < 0) unanchored.push(word);
    else bands[index]!.push(word);
  }

  if (bands.some((band) => band.length === 0)) return null;

  const rows: ParsedRow[] = bands.map((band) => toParsedRow(band, 0));
  rows.push(...clusterRowsByTolerance(unanchored, tolerance));
  // Two anchors' rows collapsing into one would put two amounts on a row; that is an overlap, not a
  // reading, so the band rows stand.
  if (rows.some((row) => priceCandidatesForRow(row, column).length >= 2)) return null;

  return [...rows]
    .sort((a, b) => a.box.y - b.box.y || a.left - b.left)
    .map((row, index) => ({ ...row, index }));
}

/**
 * The anchor lines a row's price-column amounts land on. One printed row can print two amounts into
 * the price column — that is P6's `ambiguous_price_separator`, a decision this stage must not make —
 * but two *different* anchor lines on one row means the y-band merged two printed rows.
 */
function anchorIndexesOf(row: ParsedRow, anchors: readonly AnchorLine[], column: PriceColumn): Set<number> {
  const found = new Set<number>();
  for (const word of row.words) {
    if (!isAmountShaped(word.text) || !inPriceColumn(word, column)) continue;
    const centre = verticalCenter(word);
    let nearest = 0;
    for (let index = 1; index < anchors.length; index += 1) {
      if (Math.abs(centre - anchors[index]!.centre) < Math.abs(centre - anchors[nearest]!.centre)) nearest = index;
    }
    found.add(nearest);
  }
  return found;
}

/**
 * P5: rows for an `OcrResult`'s words. The y-band is the normal reading; anchor rows take over only
 * on a three-column receipt — one that prints a quantity column beside the price column, which the
 * caller establishes and passes as `anchorEligible` — and only when the band demonstrably failed on
 * it, by putting two amount lines on one row. Two-column pages (`name | price`, which is every
 * CORD/SROIE fixture) keep exactly the rows they were measured with.
 */
export function clusterRows(
  words: readonly RowWord[],
  tolerance: number,
  column: PriceColumn | null = null,
  anchorEligible = false
): ParsedRow[] {
  if (words.length === 0) return [];
  const bands = clusterRowsByTolerance(words, tolerance);
  if (!anchorEligible || !column || column.fallback) return bands;
  const anchors = anchorLines(words, column);
  if (anchors.length < 2) return bands;
  if (!bands.some((row) => anchorIndexesOf(row, anchors, column).size >= 2)) return bands;
  return clusterRowsByAnchor(words, column, tolerance) ?? bands;
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
