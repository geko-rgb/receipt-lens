/**
 * Quantity detection and provenance (§5 "Quantity rules", §7 "Quantity provenance"), pinned in
 * `DECISIONS/0010` (Q1, Q6).
 *
 * A bare integer is only evidence of a quantity when something says so — the printed `N ×` pattern, or a
 * column that behaves like a quantity column across most of its rows. Dev shows why the gate is needed
 * rather than decorative: `SR 6` is an SST rate, `P.Rest 10 %` a percentage, `12 GLASSES` part of a name
 * and `8970669` an item code. A row with an integer that cannot be attributed is `unresolved`, not
 * `assumed`: §5's assumed branch is for quantity confidently *absent*, and a stray number is not that.
 */

import type { QuantitySource } from "../types.js";
import {
  PRICE_COLUMN_WIDTH_RATIO,
  QUANTITY_BAND_MIN_ROWS,
  QUANTITY_MAX_VALUE,
  QUANTITY_QUALIFY_SHARE,
} from "./constants.js";
import { isAmountShaped, type ParsedRow, type PriceColumn, type RowWord } from "./geometry.js";

/** `N x` / `N×` printed as one word, with or without a space. */
const GLUED_QUANTITY = /^(\d{1,2})\s*[x×]$/i;
/** The same pattern with the multiply glyph printed as its own word — 33 dev occurrences vs 63 glued. */
const MULTIPLY_WORD = /^[x×*]$/i;
const BARE_INTEGER = /^\d{1,2}$/;

export interface QuantityColumn {
  readonly side: "left" | "right";
  readonly anchor: number;
  readonly tolerance: number;
  /** Distinct rows carrying a numeric word in the band — the denominator of the 60% test. */
  readonly rows: number;
  readonly share: number;
}

export interface QuantityReading {
  readonly qty: number | null;
  readonly quantitySource: QuantitySource;
  readonly warning: "qty_assumed" | "qty_unresolved" | null;
  readonly via: "pattern" | "column" | "absent" | "unattributed" | "conflicting";
}

interface NumericWord {
  readonly left: number;
  readonly right: number;
  readonly row: number;
  readonly small: boolean;
}

interface BandEdge {
  readonly edge: number;
  readonly row: number;
  readonly small: boolean;
}

function cluster(edges: readonly BandEdge[], tolerance: number): BandEdge[][] {
  const sorted = [...edges].sort((a, b) => b.edge - a.edge);
  const groups: BandEdge[][] = [];
  for (const edge of sorted) {
    const current = groups[groups.length - 1];
    if (!current || current[0]!.edge - edge.edge > tolerance) groups.push([edge]);
    else current.push(edge);
  }
  return groups;
}

/** An integer glued to a percent sign, or followed by a `%` word, is a rate — never a quantity. */
function isPercentAttached(words: readonly RowWord[], index: number): boolean {
  const text = words[index]!.text.trim();
  if (/%/.test(text)) return true;
  return /%/.test(words[index + 1]?.text ?? "");
}

/** The number a quantity word prints — `1X`, `1 x` and `1` all name the count in front of them. */
function patternValue(word: RowWord | undefined): number | null {
  const match = word ? /^(\d{1,2})(?:\s*[x×])?$/i.exec(word.text.trim()) : null;
  if (!match) return null;
  const value = Number(match[1]);
  return value <= QUANTITY_MAX_VALUE ? value : null;
}

function smallInteger(word: string): number | null {
  if (!BARE_INTEGER.test(word.trim())) return null;
  const value = Number(word.trim());
  return value <= QUANTITY_MAX_VALUE ? value : null;
}

/**
 * Q1: candidate bands are clustered over *every* numeric word, so the 60% test asks whether the rows
 * touching a band mostly hold small integers or mostly hold money. Building the band from integers ≤ 20
 * instead would make the rule unfailable — 100% of its own rows qualify by construction.
 */
export interface QuantityColumnOptions {
  /** Row floor and majority share; the defaults are the pinned constants. A seam for the sensitivity
   *  table DECISIONS/0010 Q1 publishes, so the alternatives are measured by CI, not asserted by prose. */
  readonly minRows?: number;
  readonly share?: number;
}

export function detectQuantityColumn(
  rows: readonly ParsedRow[],
  imageWidth: number,
  column: PriceColumn | null,
  options: QuantityColumnOptions = {}
): QuantityColumn | null {
  const minRows = options.minRows ?? QUANTITY_BAND_MIN_ROWS;
  const requiredShare = options.share ?? QUANTITY_QUALIFY_SHARE;
  const tolerance = imageWidth * PRICE_COLUMN_WIDTH_RATIO;
  const numeric: NumericWord[] = [];
  rows.forEach((row, rowIndex) => {
    row.words.forEach((word, wordIndex) => {
      const text = word.text.trim();
      if (!(BARE_INTEGER.test(text) || GLUED_QUANTITY.test(text) || isAmountShaped(text))) return;
      const small = smallInteger(text) !== null && !isPercentAttached(row.words, wordIndex);
      numeric.push({ left: word.box.x, right: word.box.x + word.box.width, row: rowIndex, small });
    });
  });
  if (numeric.length < minRows) return null;

  const qualified: QuantityColumn[] = [];
  for (const side of ["left", "right"] as const) {
    const edges = numeric.map((entry) => ({ edge: side === "left" ? entry.left : entry.right, row: entry.row, small: entry.small }));
    for (const group of cluster(edges, tolerance)) {
      const anchor = group[0]!.edge;
      const bandRows = new Set(group.map((e) => e.row));
      if (bandRows.size < minRows) continue;
      const smallRows = new Set(group.filter((e) => e.small).map((e) => e.row));
      const share = smallRows.size / bandRows.size;
      if (share < requiredShare) continue;
      if (column && Math.abs(anchor - column.center) <= column.tolerance) continue;
      qualified.push({ side, anchor, tolerance, rows: bandRows.size, share });
    }
  }
  if (qualified.length === 0) return null;
  // Leftmost wins; a quantity column sits left of the prices it counts. Ties break on share, then side.
  return qualified.reduce((best, candidate) =>
    candidate.anchor < best.anchor - 1e-9 ||
    (Math.abs(candidate.anchor - best.anchor) <= 1e-9 &&
      (candidate.share > best.share || (candidate.share === best.share && candidate.side === "left" && best.side === "right")))
      ? candidate
      : best
  );
}

function inBand(word: RowWord, band: QuantityColumn): boolean {
  const edge = band.side === "left" ? word.box.x : word.box.x + word.box.width;
  return Math.abs(edge - band.anchor) <= band.tolerance;
}

/** §5's first clause: a leading `N x` / `N×` pattern needs no column to be read. */
export function quantityPatternWords(words: readonly RowWord[]): readonly RowWord[] | null {
  for (let i = 0; i < words.length; i += 1) {
    if (isPercentAttached(words, i)) continue;
    const glued = GLUED_QUANTITY.exec(words[i]!.text.trim());
    if (glued) {
      if (Number(glued[1]) <= QUANTITY_MAX_VALUE) return [words[i]!];
      continue;
    }
    if (smallInteger(words[i]!.text) === null) continue;
    const next = words[i + 1]?.text.trim();
    if (next && MULTIPLY_WORD.test(next)) return [words[i]!, words[i + 1]!];
  }
  return null;
}

export function quantityPattern(words: readonly RowWord[]): number | null {
  return patternValue(quantityPatternWords(words)?.[0]);
}

/** An integer inside the price band is a printed total, not a quantity (Q6). */
function inPriceBand(word: RowWord, column: PriceColumn | null): boolean {
  if (!column) return false;
  return Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance;
}

/**
 * The three states §7 allows the parser to emit. `explicit` needs the pattern or the column; `assumed` is
 * quantity confidently absent; anything else that leaves a visible-but-unattributable integer is
 * `unresolved`, which blocks unit creation until a human reads the line.
 */
export function readQuantity(
  row: ParsedRow,
  band: QuantityColumn | null,
  column: PriceColumn | null,
  exclude: readonly RowWord[] = []
): QuantityReading {
  const pattern = quantityPatternWords(row.words);
  if (pattern) return { qty: patternValue(pattern[0]), quantitySource: "explicit", warning: null, via: "pattern" };

  const integers = row.words
    .map((word, index) => ({ word, index }))
    .filter(({ word, index }) => !exclude.includes(word))
    .filter(({ word, index }) => smallInteger(word.text) !== null && !isPercentAttached(row.words, index))
    .filter(({ word }) => !inPriceBand(word, column));

  if (integers.length === 0) {
    return { qty: 1, quantitySource: "assumed", warning: "qty_assumed", via: "absent" };
  }
  if (!band) {
    return { qty: null, quantitySource: "unresolved", warning: "qty_unresolved", via: "unattributed" };
  }
  const bandHits = integers.filter(({ word }) => inBand(word, band)).map(({ word }) => word);
  if (bandHits.length === 0) {
    return { qty: null, quantitySource: "unresolved", warning: "qty_unresolved", via: "unattributed" };
  }
  const values = new Set(bandHits.map((word) => smallInteger(word.text)));
  if (values.size > 1) {
    return { qty: null, quantitySource: "unresolved", warning: "qty_unresolved", via: "conflicting" };
  }
  return { qty: [...values][0]!, quantitySource: "explicit", warning: null, via: "column" };
}

/**
 * The words an explicit read consumed from the row, so the item's name can drop them: a name that still
 * carries `2 x` is a name the parser claims to have read a quantity out of and then left in.
 */
export function consumedQuantityWords(
  row: ParsedRow,
  band: QuantityColumn | null,
  column: PriceColumn | null,
  exclude: readonly RowWord[] = []
): readonly RowWord[] {
  const reading = readQuantity(row, band, column, exclude);
  if (reading.quantitySource !== "explicit") return [];
  if (reading.via === "pattern") return quantityPatternWords(row.words) ?? [];
  return row.words.filter((word, index) => {
    if (exclude.includes(word) || smallInteger(word.text) === null) return false;
    if (isPercentAttached(row.words, index) || inPriceBand(word, column)) return false;
    return band !== null && inBand(word, band);
  });
}

/** Exposed for the pin test in `benchmarks/src/parser/`, which re-derives DECISIONS/0010 Q1's counts. */
export const quantityPredicatesForTests = { BARE_INTEGER, GLUED_QUANTITY, MULTIPLY_WORD, smallInteger };
