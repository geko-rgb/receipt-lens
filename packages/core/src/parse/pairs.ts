/**
 * Header-free row reconstruction (DECISIONS/0035): pairing printed product descriptions with printed
 * `qty / rate / total` numbers when the receipt's column header is missing, unreadable or not row-shaped.
 *
 * The table pass (`rows.ts`) reads a *header* and reconstructs rows against the columns it names. That is
 * the right model when the header survives OCR, and it is powerless when it does not: Saravana Bhavan's real
 * page reads `Expire Qty Rate Total` with `Product` lost to `roduct`, so `nameLeft` is null and no row-shaped
 * table exists — yet the page prints four perfectly consistent money triples. This stage answers the question
 * the header would have answered, from the numbers themselves:
 *
 *   1. which money columns the page prints (`inferValueColumns`, the same band model the price column uses);
 *   2. which column is the quantity, which the rate and which the amount — by *arithmetic majority*
 *      (`qty × rate == amount` in integer paise over as many candidate rows as possible), falling back to
 *      position only when the arithmetic cannot decide (Amendment C);
 *   3. which description belongs to which numeric row — inline, above the numbers, or below them — by
 *      geometry and sequence, and by nothing else (Amendment D: one model, both layouts).
 *
 * Two rules are load-bearing and are the reason this stage exists at all:
 *
 * - **A number is not a product** (Amendment A). A numeric row with no plausibly paired description is left
 *   unconsumed, so the classifier preserves it for review. It must never become an item with an assumed
 *   quantity of 1 — that is the mechanism that sold `Bill No: 210373` as ₹2,10,373.00.
 * - **Arithmetic is evidence, never repair** (Amendment B). `qty × rate` is compared against the printed
 *   total in integer paise with ±1 paisa; a disagreement publishes every printed value with an
 *   `arithmetic_mismatch` finding, and no number is ever rewritten to make the check hold.
 */

import type { OcrBox } from "../ocr/types.js";
import { horizontalCenter, inferValueColumns, isAmountShaped, type ParsedRow, type RowWord } from "./geometry.js";
import { ROW_ROUNDING_TOLERANCE, type ReconstructionEvidence, type ReconstructResult, type TableRecord } from "./rows.js";
import { columnValue } from "./header.js";
import type { AmountToken } from "./header.js";
import { PAIRING_QUANTITY_MAX_VALUE } from "./constants.js";
import { amountGate, exceedsGate } from "./magnitude.js";

/** How many rows away from its numbers a description may print and still describe them. */
const NAME_REACH_ROWS = 2;

/** Below this many paired rows the stage treats its own result as a coincidence, not a table. */
const MIN_PAIRED_RECORDS = 2;

/** The roles this stage assigns. `total` is `rows.ts`'s `total`, `rate` its `rate`, `qty` its `qty`. */
export type PairRole = "qty" | "rate" | "total";
const ROLES: readonly PairRole[] = ["qty", "rate", "total"];

/** A money column with the role the page's arithmetic gave it. */
interface AssignedBand {
  readonly role: PairRole;
  readonly center: number;
  readonly tolerance: number;
}

/** How the roles were decided, for provenance. */
export type RoleSource = "arithmetic" | "positional";

export interface PairingResult extends ReconstructResult {
  readonly roles: readonly AssignedBand[];
  readonly roleSource: RoleSource | null;
  /** Numeric rows the stage saw but did not pair, with the reason — the ledger §7's report asks for. */
  readonly unpaired: readonly { readonly rowIndex: number; readonly text: string; readonly reason: string }[];
  /** Every role assignment the arithmetic ranked, best first: the evidence behind Amendment C. */
  readonly scored: readonly { readonly roles: readonly string[]; readonly score: number }[];
}

export interface PairingOptions {
  /** Rows a printed header table already accounted for; they are never re-read here. */
  readonly consumed?: ReadonlySet<number>;
  /** Furniture (header, registration, metadata, footer): never a product description. */
  readonly isFurniture: (row: ParsedRow) => boolean;
  /**
   * The index of the page's first printed column header, when one was found. §5's header zone ends there, so a
   * description can never be assembled from a heading fragment above it (`roduct`, the `P` in `Product` the OCR
   * lost) — that row is the header's remains, not the first product's name.
   */
  readonly headerFloorIndex?: number;
  /**
   * Rows a printed column header sits on. They bound the value columns, so they are never a product description
   * either — a header printed *between* item rows would otherwise join the neighbouring name (`Expire Qty Rate
   * Total Coffee`).
   */
  readonly headerRowIndexes?: ReadonlySet<number>;
  /** A labelled row (charge, total, tender) stops the item table and is never a name. */
  readonly isLabelled: (row: ParsedRow) => boolean;
}

function inBand(word: RowWord, band: { center: number; tolerance: number }): boolean {
  return Math.abs(word.box.x + word.box.width - band.center) <= band.tolerance;
}

/** A word that can carry a column value: `2.00`, `153.00`, `3`, `₹75.00`. */
function valueWord(word: RowWord): boolean {
  return isAmountShaped(word.text) || columnValue(word.text) !== null;
}

/** The numeric value a word prints, in the unit its column uses (currency units, not paise). */
function valueOf(word: RowWord): number | null {
  return columnValue(word.text);
}

/**
 * Amendment E's quantity gate: a small non-negative integer, at most three digits. `2.00` is how several POS
 * printers print a count, so a whole-number money token is accepted at the same value; anything fractional,
 * negative or large is not a count.
 */
function quantityOf(word: RowWord): number | null {
  const value = valueOf(word);
  if (value === null || !Number.isInteger(value) || value < 0 || value > PAIRING_QUANTITY_MAX_VALUE) return null;
  return value;
}

/**
 * The candidate numeric rows: rows in the item zone that fill at least two *assigned* value columns with
 * words that are not the name. `qty` may be a bare integer (`3`) or a whole-number money token (`2.00`).
 */
function numericRows(
  rows: readonly ParsedRow[],
  roles: readonly AssignedBand[],
  options: PairingOptions,
  gate: number | null
): Map<number, { qty: AmountToken | null; rate: AmountToken | null; total: AmountToken | null }> {
  const found = new Map<number, { qty: AmountToken | null; rate: AmountToken | null; total: AmountToken | null }>();
  for (const row of rows) {
    if (options.consumed?.has(row.index)) continue;
    if (options.isLabelled(row)) continue;
    // Furniture that carries a *word* (`Total`, `GSTIN`, a column heading) is not a value row. A row of nothing
    // but numbers is exactly what this stage reads, and the classifier's identifier families claim those too —
    // `2.00 35.00 70.00` is identifier-shaped by construction, so the furniture test cannot decide here.
    if (row.words.some((word) => /[A-Za-z]{2,}/.test(word.text)) && options.isFurniture(row)) continue;
    const byRole = new Map<PairRole, AmountToken[]>();
    for (const word of row.words) {
      if (!valueWord(word)) continue;
      const value = valueOf(word);
      if (value === null) continue;
      const role = roles.find((band) => inBand(word, band))?.role;
      if (role === undefined) continue;
      // A quantity column holds counts; a fractional or oversized number there belongs to another column.
      if (role === "qty" && quantityOf(word) === null) continue;
      // Amendment E / DECISIONS/0033: an amount-shaped identifier (a bill number, an HSN code) is not money. The
      // page's own median sets the bar, and the rule is `magnitude.ts`'s — the same one the classifier applies.
      if (role !== "qty" && exceedsGate(value, gate)) continue;
      const bucket = byRole.get(role);
      if (bucket) bucket.push({ word, value });
      else byRole.set(role, [{ word, value }]);
    }
    // Two different numbers in one column is §5's `ambiguous_row`, not a row this stage may assign.
    if ([...byRole.values()].some((bucket) => new Set(bucket.map((token) => token.value)).size > 1)) continue;
    if (byRole.size < 2) continue;
    const pick = (role: PairRole): AmountToken | null => byRole.get(role)?.[0] ?? null;
    found.set(row.index, { qty: pick("qty"), rate: pick("rate"), total: pick("total") });
  }
  return found;
}

/** Integer-paise agreement within ±1 paisa (Amendment B). */
function agrees(qty: number, rate: number, total: number): boolean {
  return Math.abs(Math.round(qty * rate * 100) - Math.round(total * 100)) <= Math.round(ROW_ROUNDING_TOLERANCE * 100);
}

/**
 * Amendment C: score every role assignment over the detected money columns by how many numeric rows it makes
 * arithmetically consistent, and take the best. A page can print more money columns than an item row needs
 * (Saravana's GS`T` breakdown sits in the same x-range as its rates), so the assignment searches *subsets* of two
 * or three bands, not just the rightmost ones. A single consistent row is supporting evidence only, so the
 * result stays `positional` unless at least two rows agree; ties prefer the rightmost, then the best-populated
 * columns, which is the positional reading by construction.
 */
function assignRoles(
  rows: readonly ParsedRow[],
  bands: readonly { center: number; tolerance: number; members: number }[],
  options: PairingOptions
): { roles: AssignedBand[]; source: RoleSource; scored: { roles: string[]; score: number }[] } | null {
  const gate = pageGate(rows);
  const usable = bands.filter((band) => band.members >= 2);
  if (usable.length < 2) return null;

  const subsets: { center: number; tolerance: number; members: number }[][] = [];
  const combine = (start: number, built: typeof subsets[number]) => {
    if (built.length >= 2) subsets.push([...built]);
    if (built.length === 3) return;
    for (let index = start; index < usable.length; index += 1) combine(index + 1, [...built, usable[index]!]);
  };
  combine(0, []);

  const ledger: { roles: string[]; score: number }[] = [];
  let best: { roles: AssignedBand[]; score: number; weight: number; rightmost: number } | null = null;
  for (const subset of subsets) {
    const ordered = [...subset].sort((a, b) => a.center - b.center);
    const rolesFor = ROLES.slice(ROLES.length - ordered.length);
    const permutations: AssignedBand[][] = [];
    const choose = (remaining: readonly PairRole[], built: AssignedBand[]) => {
      if (remaining.length === 0) {
        permutations.push([...built]);
        return;
      }
      for (const role of remaining) {
        choose(remaining.filter((entry) => entry !== role), [...built, { role, ...ordered[built.length]! }]);
      }
    };
    choose(rolesFor, []);
    for (const candidate of permutations) {
      const rowsByRoles = numericRows(rows, candidate, options, gate);
      let score = 0;
      for (const values of rowsByRoles.values()) {
        if (!values.qty || !values.rate || !values.total) continue;
        const qty = quantityOf(values.qty.word);
        if (qty === null) continue;
        if (agrees(qty, values.rate.value, values.total.value)) score += 1;
      }
      ledger.push({ roles: candidate.map((band) => `${band.role}@${Math.round(band.center)}`), score });
      const weight = ordered.reduce((sum, band) => sum + band.members, 0);
      const rightmost = Math.max(...ordered.map((band) => band.center));
      if (
        best === null ||
        score > best.score ||
        (score === best.score && rightmost > best.rightmost) ||
        (score === best.score && rightmost === best.rightmost && weight > best.weight)
      ) {
        best = { roles: candidate, score, weight, rightmost };
      }
    }
  }
  if (best === null) return null;
  const chosen: { roles: AssignedBand[]; score: number; weight: number; rightmost: number } = best;
  return {
    roles: chosen.roles,
    source: chosen.score >= 2 ? "arithmetic" : "positional",
    scored: ledger.sort((a, b) => b.score - a.score).slice(0, 6),
  };
}

/** The page's own median bar for "amount-shaped identifier, not money" (DECISIONS/0033's rule, `magnitude.ts`). */
function pageGate(rows: readonly ParsedRow[]): number | null {
  return amountGate(
    rows.flatMap((row) => row.words.filter(valueWord).map((word) => valueOf(word))).filter((value): value is number => value !== null)
  );
}

/** Words on the row that no value column claimed: the inline description, if there is one. */
function inlineName(row: ParsedRow, values: { qty: AmountToken | null; rate: AmountToken | null; total: AmountToken | null }): RowWord[] {
  const claimed = new Set([values.qty?.word, values.rate?.word, values.total?.word].filter(Boolean) as RowWord[]);
  return row.words.filter((word) => !claimed.has(word));
}

/** Can this row be a product description at all (no numbers of its own, not furniture)? */
function isDescriptionRow(row: ParsedRow, options: PairingOptions): boolean {
  if (options.consumed?.has(row.index)) return false;
  if (options.headerRowIndexes?.has(row.index)) return false;
  if (options.isFurniture(row) || options.isLabelled(row)) return false;
  if (!row.words.some((word) => /[A-Za-z]{2,}/.test(word.text))) return false;
  return !row.words.some((word) => valueWord(word));
}

/** A row's vertical centre — kept for the ledger and the tie-break. */
function yCentre(row: ParsedRow): number {
  const box: OcrBox = row.box;
  return box.y + box.height / 2;
}

/**
 * Which side of its numbers a page prints the product description on, decided by the page itself (Amendment D).
 *
 * Receipts are consistent: a page that prints `Coffee` above `2.00 35.00 70.00` does so for every row, and a page
 * that prints the name below its figures does that for every row. Counting which arrangement explains more rows
 * is a vote the page casts itself, and it is far steadier than an absolute pixel distance — the gap between a name
 * and its own numbers can be 2px away from the gap to the *next* row's numbers, and nobody reading the paper is
 * confused by it (`SAYUR` sits between two numeric rows on a CORD receipt and still belongs to the lower one).
 *
 * `above` wins a tie: a header's name column sits left of the numbers and most receipts hang the name over them.
 */
function descriptionSide(
  rows: readonly ParsedRow[],
  numericIndexes: readonly number[],
  options: PairingOptions
): -1 | 1 {
  const numeric = new Set(numericIndexes);
  const hits = { above: 0, below: 0 };
  for (const index of numericIndexes) {
    // The neighbour must be a description, i.e. a readable row that prints no money of its own.
    const above = rows[index - 1];
    const below = rows[index + 1];
    if (above && !numeric.has(above.index) && isDescriptionRow(above, options)) hits.above += 1;
    if (below && !numeric.has(below.index) && isDescriptionRow(below, options)) hits.below += 1;
  }
  return hits.below > hits.above ? 1 : -1;
}

/**
 * Which description rows belong to which numeric row.
 *
 * With the page's side known, the description for a numeric row is the contiguous run of readable, non-numeric
 * rows immediately on that side — at most `NAME_REACH_ROWS` of them, so `Combo 2 Chapati` / `P.B. Masala` can be
 * one product while a stamp three lines up cannot join it. A description already used by the row above is not
 * used twice, which is what keeps a two-line name from bleeding into its neighbour.
 *
 * A numeric row with no description on that side gets none: nothing is borrowed from a row that is not adjacent
 * (Amendment A/D). Those rows stay for review rather than becoming products with an invented name.
 */
function assignDescriptions(
  rows: readonly ParsedRow[],
  numericIndexes: readonly number[],
  options: PairingOptions
): Map<number, ParsedRow[]> {
  const assigned = new Map<number, ParsedRow[]>();
  if (numericIndexes.length === 0) return assigned;
  const side = descriptionSide(rows, numericIndexes, options);
  const claimed = new Set<number>();
  // Reading order, always: each row takes the description nearest it that is still free, so a page whose names sit
  // above their numbers cannot have the *last* product claim the second product's name.
  const ordered = [...numericIndexes].sort((a, b) => a - b);
  for (const index of ordered) {
    const run: ParsedRow[] = [];
    for (let step = 1; step <= NAME_REACH_ROWS; step += 1) {
      const candidate = rows[index + side * step];
      if (!candidate || claimed.has(candidate.index)) break;
      if (!isDescriptionRow(candidate, options)) break;
      run.push(candidate);
    }
    if (run.length === 0) continue;
    for (const entry of run) claimed.add(entry.index);
    // Reading order, so a two-line name joins the way it is printed even when the run was walked upwards.
    run.sort((a, b) => a.index - b.index);
    assigned.set(index, run);
  }
  return assigned;
}

function unionBox(boxes: readonly OcrBox[]): OcrBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Currency and unit tokens that are printed beside money, never a product name on their own. */
const NON_NAME_WORDS = new Set(["SR", "RM", "RS", "INR", "RP", "MYR", "SGD", "USD", "SEN", "SEN.", "X", "*", "QTY", "SET", "PCS"]);

/**
 * Whether a joined description can stand as a product name.
 *
 * Amendment A says a number with no description is not a product. The converse needs the same care: a row whose
 * only words are `SR 6` or `[ACCOUNT] 1 X` is a currency marker or a reader tag, not a product, and publishing it
 * as an item invents a product the paper never listed. A name therefore needs at least one word of two or more
 * Latin letters that is not a bare currency/unit token.
 */
export function isNameLike(text: string): boolean {
  // A bracketed group is a reader tag, not a product: `[ACCOUNT] 1 X` is a column marker the text extractor emitted,
  // while `[BUNDLE] Coffee` still carries a name outside the brackets.
  const outsideTags = text.replace(/\[[^\]]*\]/g, " ");
  return outsideTags
    .split(/\s+/)
    .some((word) => /[A-Za-z]{2,}/.test(word) && !NON_NAME_WORDS.has(word.replace(/[^A-Za-z.]/g, "").toUpperCase()));
}

function evidenceFor(
  qty: AmountToken | null,
  rate: AmountToken | null,
  total: AmountToken | null
): ReconstructionEvidence[] {
  const evidence: ReconstructionEvidence[] = [];
  if (!qty) {
    evidence.push({
      code: "qty_missing",
      message: "the numeric row printed no quantity in the column the page's arithmetic named",
      words: [],
    });
  }
  if (!rate) {
    evidence.push({
      code: "rate_missing",
      message: "the numeric row printed no rate in the column the page's arithmetic named",
      words: [],
    });
  }
  if (!total) {
    evidence.push({
      code: "total_missing",
      message: "the numeric row printed no line total in the column the page's arithmetic named",
      words: [],
    });
  }
  if (qty && rate && total) {
    const quantity = quantityOf(qty.word);
    if (quantity === null || !agrees(quantity, rate.value, total.value)) {
      evidence.push({
        code: "arithmetic_mismatch",
        message: `quantity ${qty.word.text} × rate ${rate.word.text} does not equal the printed total ${total.word.text}`,
        words: [qty.word, rate.word, total.word],
      });
    }
  }
  return evidence;
}

/**
 * The stage. Returns `rows.ts`'s own `ReconstructResult` shape so the classifier and item builder treat a paired
 * record exactly like a header-reconstructed one — one geometry, one item list, one set of warnings.
 */
export function reconstructWithoutHeader(
  rows: readonly ParsedRow[],
  imageWidth: number,
  options: PairingOptions
): PairingResult {
  const empty: PairingResult = {
    records: [],
    consumedRows: new Set(),
    headerRowIndexes: new Set(),
    roles: [],
    roleSource: null,
    unpaired: [],
    scored: [],
  };
  const bands = inferValueColumns(rows, imageWidth, 8);
  const assigned = assignRoles(rows, bands, options);
  if (!assigned) return empty;
  // Amendment C's floor: without at least two rows whose `qty × rate = total` holds, the bands are a guess about
  // where columns are, and a guess is not allowed to create products. The page keeps its rows for review instead.
  // The decision is reported with its own provenance (`positional`), not erased to null: "the stage looked and
  // could not prove the columns" is a different fact from "the stage never ran", and the caller needs both.
  if (assigned.source !== "arithmetic") {
    return { ...empty, roles: assigned.roles, roleSource: assigned.source, scored: assigned.scored };
  }

  const numbers = numericRows(rows, assigned.roles, options, pageGate(rows));
  const records: TableRecord[] = [];
  const consumed = new Set<number>();
  const unpaired: { rowIndex: number; text: string; reason: string }[] = [];

  const descriptions = assignDescriptions(rows, [...numbers.keys()], options);

  for (const [rowIndex, values] of numbers) {
    const row = rows.find((entry) => entry.index === rowIndex)!;
    const inline = inlineName(row, values);
    const inlineHasName = inline.some((word) => /[A-Za-z]{2,}/.test(word.text));

    let nameRows: ParsedRow[] = [];
    let nameWords: RowWord[] = inline;
    if (!inlineHasName) {
      nameRows = descriptions.get(row.index) ?? [];
      nameWords = nameRows.flatMap((entry) => entry.words);
      if (nameWords.length === 0) {
        // Amendment A: a number with no description is not a product, whatever it looks like.
        unpaired.push({ rowIndex, text: row.text, reason: "no_description" });
        continue;
      }
    }

    const name = nameWords
      .map((word) => word.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length === 0) {
      unpaired.push({ rowIndex, text: row.text, reason: "no_description" });
      continue;
    }
    if (!isNameLike(name)) {
      unpaired.push({ rowIndex, text: row.text, reason: "description_not_a_name" });
      continue;
    }

    const recordRows = [...nameRows, row];
    const evidence = evidenceFor(values.qty, values.rate, values.total);
    // Amendment B: a row whose arithmetic fails keeps every printed value and says why; nothing is rewritten.
    const mismatch = evidence.some((entry) => entry.code === "arithmetic_mismatch");
    records.push({
      id: `t${records.length + 1}`,
      valueRowIndex: row.index,
      nameRowIndexes: nameRows.map((entry) => entry.index),
      name,
      qty: mismatch ? null : values.qty,
      rate: mismatch ? null : values.rate,
      total: values.total,
      evidence,
      box: unionBox(recordRows.map((entry) => entry.box)),
      sourceRowIndexes: recordRows.map((entry) => entry.index),
    });
    for (const entry of recordRows) consumed.add(entry.index);
  }

  // One paired row can be a coincidence (a subtotal over a tax line); a column set that reads as products reads
  // as products on more than one row. Below that the stage reports the rows and publishes nothing.
  if (records.length < MIN_PAIRED_RECORDS) {
    for (const record of records) {
      unpaired.push({ rowIndex: record.valueRowIndex, text: rows[record.valueRowIndex]!.text, reason: "too_few_paired_rows" });
    }
    return {
      records: [],
      consumedRows: new Set(),
      headerRowIndexes: new Set(),
      roles: assigned.roles,
      roleSource: assigned.source,
      unpaired,
      scored: assigned.scored,
    };
  }

  return {
    records,
    consumedRows: consumed,
    headerRowIndexes: new Set(),
    roles: assigned.roles,
    roleSource: assigned.source,
    unpaired,
    scored: assigned.scored,
  };
}

/**
 * The value columns and roles a page would use, without reconstructing anything — the inspection view the
 * completion report asks for, and the seam the tests read to prove Amendment C's inference.
 */
export function inferPairingRoles(
  rows: readonly ParsedRow[],
  imageWidth: number,
  options: PairingOptions
): { roles: readonly AssignedBand[]; source: RoleSource | null } {
  const assigned = assignRoles(rows, inferValueColumns(rows, imageWidth, 8), options);
  return assigned ?? { roles: [], source: null };
}

/** Exported for the report's evidence table: the value a word prints in its column, or null. */
export const pairingInternals = { valueOf, quantityOf, horizontalCenter, numericRows, assignRoles, agrees };
