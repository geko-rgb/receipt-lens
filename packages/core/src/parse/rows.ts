/**
 * Row reconstruction over a printed column table (DECISIONS/0033 P5–P8).
 *
 * The problem this solves, stated once: a receipt may print the product name on one line and that product's
 * `Qty | Rate | Total` on the line below it. Tolerance clustering (0008 P5) and anchor clustering (0032) both
 * assume one printed row per item, so neither can join those two lines — joining them by vertical proximity
 * would merge *every* consecutive pair of lines on the page.
 *
 * So the join is made by *column occupancy* instead. A physical line is a **record** when its numbers fill the
 * table's columns; the nearest name-only line above it is its **name fragment** (P5); lines that carry no table
 * value at all are skipped, and are the table's interruptions (P8). A description that spans several lines is
 * joined in reading order (P7). Nothing joins by pixel distance, and nothing is assumed about which line came
 * first except that a name prints above its numbers — with the mirror case (numbers first) handled explicitly.
 *
 * Every record is then checked against its own arithmetic (P6): `qty × rate == total` within rounding tolerance.
 * A record that fails is *not* silently repaired and *not* silently dropped — it is published with the fields
 * that disagree marked unresolved and an evidence-bearing warning, which is §7's rule and this repo's standing
 * one.
 */

import type { OcrBox } from "../ocr/types.js";
import type { ParsedRow, RowWord } from "./geometry.js";
import {
  bandsOf,
  columnOf,
  headerForRow,
  isColumnValueWord,
  isRowShapedTable,
  columnValue,
  type AmountToken,
  type HeaderTable,
} from "./header.js";

/** How many rate × quantity roundings a table row may collect and still be a row (P6). */
export const ROW_ROUNDING_TOLERANCE = 0.02;

/** A reason a reconstructed row is not fully trustworthy, with the words that show it. */
export interface ReconstructionEvidence {
  readonly code:
    | "qty_missing"
    | "qty_not_countable"
    | "rate_missing"
    | "total_missing"
    | "arithmetic_mismatch"
    | "conflicting_value";
  readonly message: string;
  readonly words: readonly RowWord[];
}

/** One reconstructed table row: the grid row, the name words that belong to it, and its evidence. */
export interface TableRecord {
  /** Stable within one pass: `t1`, `t2`, … in document order. */
  readonly id: string;
  /** The row the numbers are printed on. */
  readonly valueRowIndex: number;
  /** The rows the name was assembled from, in reading order. */
  readonly nameRowIndexes: readonly number[];
  readonly name: string;
  /** The name band the words were measured against (P5); null when the header named no name column. */
  readonly qty: AmountToken | null;
  readonly rate: AmountToken | null;
  readonly total: AmountToken | null;
  readonly evidence: readonly ReconstructionEvidence[];
  /** Union box of every row the record was assembled from, for the UI's evidence view. */
  readonly box: OcrBox;
  readonly sourceRowIndexes: readonly number[];
}

export interface ReconstructResult {
  readonly records: readonly TableRecord[];
  /** Row indexes that became part of a record; they never also become an item row or an unclassified row. */
  readonly consumedRows: ReadonlySet<number>;
  /** The header rows the records were read against. They stay subject to the classifier's own header rules. */
  readonly headerRowIndexes: ReadonlySet<number>;
}

function unionBox(boxes: readonly OcrBox[]): OcrBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The left edge of the table's first value column: a name must start left of it (P5).
 *
 * The bands carry a header word's *centre*; the column it labels begins at that word's own left edge, so the
 * header cell is the measured answer and no constant is needed.
 */
function leftmostValueColumn(table: HeaderTable): number {
  const firstValueCell = table.cells.find(
    (cell) => cell.role === "qty" || cell.role === "rate" || cell.role === "total"
  );
  if (firstValueCell) return firstValueCell.box.x;
  const bands = [table.qty, table.rate, table.total].filter((band) => band !== null);
  return bands.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...bands.map((band) => band.center));
}

/** The table's value words on a row, grouped by the column each one lands in. */
function valueWordsByRole(row: ParsedRow, table: HeaderTable): Map<string, RowWord[]> {
  const bands = bandsOf(table);
  const grouped = new Map<string, RowWord[]>();
  for (const word of row.words) {
    if (!isColumnValueWord(word)) continue;
    const role = columnOf(word, bands);
    if (role === null) continue;
    const bucket = grouped.get(role);
    if (bucket) bucket.push(word);
    else grouped.set(role, [word]);
  }
  return grouped;
}

/** Is this row a record of the table — does it fill at least one of the table's value columns? */
export function isTableRecordRow(row: ParsedRow, table: HeaderTable): boolean {
  return valueWordsByRole(row, table).size > 0;
}

/**
 * P5: is this row a name-only line waiting for its numbers? It carries no table value, it sits in the table's
 * name column, and it is not itself a header or a labelled charge row.
 */
function isNameFragmentRow(
  row: ParsedRow,
  table: HeaderTable,
  isFurniture: (row: ParsedRow) => boolean,
  isLabelled: (row: ParsedRow) => boolean
): boolean {
  if (valueWordsByRole(row, table).size > 0) return false;
  if (!/[A-Za-z]/.test(row.text)) return false;
  if (isFurniture(row)) return false;
  // `Total`, `GST`, `Rounding`: a labelled row is a charge, never the name of what the numbers below describe.
  if (isLabelled(row)) return false;
  // `SR`, `2 X`: a printed die is not a product name.
  if (isNameDie(row)) return false;
  if (table.nameLeft === null) return false;
  // P5: a name prints in the name column, *left of* the first value column. This is the check that keeps a
  // tariff row (`SR 6% 78.30`), a tender row (`CASH`, `CHANGE`) or a footer from becoming the name of the next
  // row's numbers: those rows start under the value columns, where abbreviations like `SR` defeat word lists.
  if (row.left >= leftmostValueColumn(table)) return false;
  // The name column starts at its header word; a line whose first word starts well right of it is not a
  // product name in this table (it is usually a total's label or a footer). A tolerance of one header word
  // width keeps a ragged left edge inside the column.
  const slack = Math.max(table.row.words[0]!.box.width, table.row.box.height);
  return row.left <= table.nameLeft + slack * 2;
}

/**
 * P5's other half: a name line whose *text* is a printed die (`SR`, `2 X`, a currency token) carries no product
 * name at all. Those lines are the tail of the layout's quantity column printed on its own line, and a record
 * that takes one as its name would publish `HEINEKEN (5 BTL) 2 X SR` — the product plus the column's die.
 */
const NAME_DIE_TOKENS = new Set(["SR", "RM", "RP", "RS", "INR", "@", "X", "*", "%", "-", "/"]);

function isNameDie(row: ParsedRow): boolean {
  const words = row.words.map((word) => word.text.trim()).filter((text) => text !== "");
  if (words.length === 0) return true;
  return words.every((text) => NAME_DIE_TOKENS.has(text.toUpperCase()) || /^\d+$/.test(text));
}

/**
 * A line whose words are mostly digits, dates and punctuation — a footer stamp, a document number — is not a
 * product description, however far left it starts.
 */
function isMostlyNumeric(row: ParsedRow): boolean {
  const words = row.words.map((word) => word.text).filter((text) => /[A-Za-z0-9]/.test(text));
  if (words.length === 0) return true;
  const numeric = words.filter((word) => !/[A-Za-z]{2,}/.test(word) || /^\d/.test(word));
  return numeric.length > words.length / 2;
}

/** A row with an amount token in every value column the table names, and nothing that contradicts it. */
function isCompleteRecord(roles: ReadonlyMap<string, RowWord[]>, table: HeaderTable): boolean {
  return (
    (table.qty === null || (roles.get("qty")?.length ?? 0) > 0) &&
    (table.rate === null || (roles.get("rate")?.length ?? 0) > 0) &&
    (table.total === null || (roles.get("total")?.length ?? 0) > 0)
  );
}

function tokenOf(words: RowWord[] | undefined, role: string): AmountToken | null {
  const [word] = words ?? [];
  if (!word) return null;
  const value = columnValue(word.text);
  return value === null ? null : { word, value };
}

function roleOf(token: AmountToken | null): string {
  return token ? `${token.value}` : "∅";
}

/** P6: quantity × rate against the printed total, in integer hundredths so no float ever decides equality. */
function arithmeticEvidence(qty: AmountToken | null, rate: AmountToken | null, total: AmountToken | null): ReconstructionEvidence[] {
  const evidence: ReconstructionEvidence[] = [];
  const missing = (code: ReconstructionEvidence["code"], token: AmountToken | null, label: string) => {
    if (token !== null) return;
    evidence.push({
      code,
      message: `the row printed no ${label}, so its ${label} stays unresolved rather than being inferred`,
      words: [],
    });
  };
  missing("qty_missing", qty, "quantity");
  // §10's `Item.qty` is a positive whole number of units and `ItemUnit` materializes one per count, so a printed
  // `0` or `1.5` cannot be published as an `explicit` count — the bill would hold an item it can never finalize.
  // The printed value is named in the message rather than dropped.
  if (qty && (!Number.isInteger(qty.value) || qty.value <= 0)) {
    evidence.push({
      code: "qty_not_countable",
      message:
        qty.value <= 0
          ? `the quantity column prints ${qty.value}, so the row was not sold in whole units and its quantity stays unresolved`
          : `the quantity column prints ${qty.value}, which is not a whole number of units, so the quantity stays unresolved`,
      words: [qty.word],
    });
  }
  missing("rate_missing", rate, "rate");
  missing("total_missing", total, "line total");
  if (qty && rate && total) {
    const expected = Math.round(qty.value * rate.value * 100);
    const printed = Math.round(total.value * 100);
    if (Math.abs(expected - printed) > Math.round(ROW_ROUNDING_TOLERANCE * 100)) {
      evidence.push({
        code: "arithmetic_mismatch",
        message: `quantity ${qty.value} × rate ${rate.value} is ${(expected / 100).toFixed(2)}, but the row prints ${total.value.toFixed(2)}`,
        words: [qty.word, rate.word, total.word],
      });
    }
  }
  return evidence;
}

/** Duplicate values inside one column: the receipt printed two numbers where it names one column. */
function conflictingEvidence(roles: ReadonlyMap<string, RowWord[]>, table: HeaderTable): ReconstructionEvidence[] {
  const evidence: ReconstructionEvidence[] = [];
  for (const band of [table.qty, table.rate, table.total]) {
    if (!band) continue;
    const words = roles.get(band.role) ?? [];
    if (words.length < 2) continue;
    const values = new Set(words.map((word) => columnValue(word.text)));
    if (values.size < 2) continue;
    evidence.push({
      code: "conflicting_value",
      message: `the ${band.role} column holds ${words.length} different numbers (${words.map((word) => word.text).join(", ")}), so it is unresolved`,
      words: [...words],
    });
  }
  return evidence;
}

function dropRole(roles: Map<string, RowWord[]>, role: string): void {
  roles.delete(role);
}

/**
 * P5–P8: walk a header's span and assemble its records.
 *
 * The walk is a single forward pass with one piece of state — the name fragments waiting for numbers. A
 * name-only line joins that buffer while the next line is not already a complete record; a line that *is* a
 * complete record takes the buffer as its name (the normal printed order), and a *partial* record also takes
 * it (a product whose row lost a column is still that product). A record that appears with no buffer above it
 * is the mirror case P5 allows for: the name is read from the line *below*.
 */
export function reconstructTableRows(
  rows: readonly ParsedRow[],
  tables: readonly HeaderTable[],
  isFurniture: (row: ParsedRow) => boolean,
  isLabelled: (row: ParsedRow) => boolean,
  isTender: (row: ParsedRow) => boolean = () => false
): ReconstructResult {
  const records: TableRecord[] = [];
  const consumed = new Set<number>();

  for (const table of tables) {
    if (!isRowShapedTable(table)) continue;
    const span = rows.slice(table.span.start, table.span.end);
    let buffer: ParsedRow[] = [];
    /** P8: set once a tender line has closed the item table; nothing after it is a record. */
    let ended = false;

    for (const row of span) {
      if (ended) continue;
      const roles = valueWordsByRole(row, table);
      // A labelled charge row (`Total 474.00`, `CGST 11.29`) is the charge stage's. It ends any pending name and
      // is never a record of the item table, whatever columns its numbers happen to fill.
      if (isLabelled(row)) {
        buffer = [];
        continue;
      }
      // P8: a name is the line *directly above* its numbers, so anything between them is a break. `buffer` is
      // only ever the last contiguous run of name-shaped lines, which is what keeps a footer stamp three rows
      // above the next figure from being read as that figure's product.

      // P8: once a priced record has been published, a *tender* line ends the item table. Everything below
      // `CASH : 200.00` is footer — a closing stamp, a server name, a change due — and reading those as names
      // that the tender belongs to invents products out of the receipt's own footnotes.
      if (records.length > 0 && isTender(row)) {
        buffer = [];
        ended = true;
        continue;
      }
      if (roles.size === 0) {
        if (isNameFragmentRow(row, table, isFurniture, isLabelled)) buffer.push(row);
        // A line that is neither a value row nor a name fragment is furniture *inside* the table, and it ends
        // the pending name: the name above it was already superseded by whatever printed the row above.
        else buffer = [];
        continue;
      }

      const complete = isCompleteRecord(roles, table);
      // The mirror case: this row holds numbers and the line below it is its name.
      const below = span[span.indexOf(row) + 1];
      const valueWords = new Set([...roles.values()].flat());
      // A name that shares the printed line with its numbers is the normal inline case, and it must never borrow a
      // name from the line below: that line is the *next* product. Only a record that printed no name word of its
      // own can be the mirror case (DECISIONS/0033 P5, tightened by 0034 H3).
      const rowNameWords = row.words.filter((word) => !valueWords.has(word) && /[A-Za-z]/.test(word.text));
      const nameFromBelow =
        buffer.length === 0 &&
        rowNameWords.length === 0 &&
        complete &&
        below !== undefined &&
        isNameFragmentRow(below, table, isFurniture, isLabelled) &&
        !isTableRecordRow(below, table);

      // P8: a name fragment only becomes part of a record when the record actually follows it. Once the table's
      // numbers have stopped, a mostly-numeric footer line (`CLOSED: 32 11-03-2018 00:32:02`) is not a product
      // name that the tender below it belongs to; it is footer furniture that happens to start in the name column.
      const nameRows = nameFromBelow ? [below] : buffer;
      const nameLooksLikeFurniture =
        !nameFromBelow && nameRows.length > 0 && nameRows.every((entry) => isMostlyNumeric(entry));
      if (nameLooksLikeFurniture) {
        buffer = [];
        continue;
      }
      const evidence = conflictingEvidence(roles, table);
      if (evidence.length > 0) {
        for (const finding of evidence) {
          for (const word of finding.words) {
            const role = columnOf(word, bandsOf(table));
            if (role) dropRole(roles, role);
          }
        }
      }

      const qty = tokenOf(roles.get("qty"), "qty");
      const rate = tokenOf(roles.get("rate"), "rate");
      const total = tokenOf(roles.get("total"), "total");
      const allEvidence = [...evidence, ...arithmeticEvidence(qty, rate, total)];

      // A record whose every value column is empty is not a record — it was a name line after all.
      if (qty === null && rate === null && total === null && evidence.length === 0) {
        buffer = nameFromBelow ? buffer : [...buffer, row];
        continue;
      }
      // P6/P9: a partial row is only a row of this table when a name is waiting for it. `Coffee` above
      // `2.00 70.00` is a product whose `Rate` the receipt left blank — publishing it with the rate unresolved is
      // §7's rule; dropping it would lose the product. A partial row with *no* name waiting (`CASH 85.00`, a
      // tariff, a subtotal) is none of this table's business: it leaves the table unconsumed and the loose pass
      // classifies it exactly as it did before this stage existed.
      if (!complete && buffer.length === 0) {
        continue;
      }

      // The name is the name rows, and — for an inline table where a name shares its line with its numbers —
      // the value words that line contributed are removed by position, not by pattern: `2.00 35.00 70.00` are
      // the three numbers the header's own bands claimed, and the `2` inside `Combo 2 Chapati` was never one.
      const nameWords = [
        ...nameRows.flatMap((entry) => entry.words),
        ...row.words.filter((word) => !valueWords.has(word)),
      ];
      const recordRows = [...nameRows, row];
      records.push({
        id: `t${records.length + 1}`,
        valueRowIndex: row.index,
        nameRowIndexes: nameRows.map((entry) => entry.index),
        name: nameWords.length > 0 ? nameWords.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim() : row.text,
        qty,
        rate,
        total,
        evidence: allEvidence,
        box: unionBox(recordRows.map((entry) => entry.box)),
        sourceRowIndexes: recordRows.map((entry) => entry.index),
      });
      for (const entry of recordRows) consumed.add(entry.index);
      buffer = [];
    }
  }

  return {
    records,
    consumedRows: consumed,
    headerRowIndexes: new Set(tables.filter(isRowShapedTable).map((table) => table.rowIndex)),
  };
}

/** Exposed for the evidence dump in tests: `rateOf` is only ever used to label two readings of one column. */
export const reconstructionInternals = { roleOf };

/** Defensive: a record with no name is not usable downstream, so callers ask this before publishing one. */
export function hasUsableName(record: TableRecord): boolean {
  return /[A-Za-z]/.test(record.name);
}

/** Re-export so `index.ts` has one import for the whole table stage. */
export { headerForRow };
