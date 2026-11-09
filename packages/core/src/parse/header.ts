/**
 * Table-aware reading (DECISIONS/0033): find the receipt's printed column table, reconstruct the rows it
 * describes, and expose the vertical column bands so a later stage can read a value by *position* rather
 * than by guesswork.
 *
 * Why this exists at all: §5's row clustering (0008 P5, 0032) assumes one printed row per item — name and
 * numbers on the same line. A great many restaurant and retail receipts do not print that. They print a
 * column header once (`Product | Expire | Qty | Rate | Total`), then the product name on its own line with
 * the numbers on the line *below*. Tolerance clustering can never join those two lines: the gap between them
 * is a normal line gap, so joining them would merge every consecutive pair of printed lines on the page.
 *
 * The header is the missing evidence. Once it is found, each numeric column's right edge is a measured band,
 * and a row is reconstructed from *which column each number landed in* rather than from how close two lines
 * happen to be vertically. That is the rule DECISIONS/0033 P5 pins.
 *
 * Nothing here is specific to one receipt: the column roles come from a vocabulary, the bands from the
 * header's own word boxes, and every row is validated arithmetically before it is published.
 */

import type { OcrBox } from "../ocr/types.js";
import { HEADER_COLUMN_VOCABULARY, labelFragments } from "./patterns.js";
import { horizontalCenter, type ParsedRow, type PriceColumn, type RowWord } from "./geometry.js";

/** A column of the printed table, named by what it holds rather than by the word the receipt chose. */
export type ColumnRole = "name" | "qty" | "rate" | "total" | "hsn" | "tax";

/**
 * How a header word becomes a role. `expire`/`expiry` is deliberately absent: it is a real column on the
 * receipt that motivated this module and it has no role here, so it is recognised (which keeps the row a
 * header) and then carried as `null` — read, and not used.
 */
const ROLE_OF_LABEL: Readonly<Record<string, ColumnRole>> = {
  // `Tax%` names the rate the table applies, not one tax: it is a *rate* column, and the label match is exact on
  // the alphabetic fragment (`TAX`) with the sign stripped, which is why the percent sign is normalised away below.
  TAX: "rate",
  PRODUCT: "name",
  PRODUCTS: "name",
  ITEM: "name",
  ITEMS: "name",
  ITEMNAME: "name",
  NAME: "name",
  DESC: "name",
  DESCRIPTION: "name",
  PARTICULARS: "name",
  PARTICULAR: "name",
  NARRATION: "name",
  DETAILS: "name",
  QTY: "qty",
  QNTY: "qty",
  QUANTITY: "qty",
  NOS: "qty",
  COUNT: "qty",
  PCS: "qty",
  UNIT: "qty",
  UNITS: "qty",
  RATE: "rate",
  PRICE: "rate",
  MRP: "rate",
  SP: "rate",
  // DECISIONS/0034 H1: `Amount` is what the row costs, not what one of it costs. A receipt that prints both
  // `Rate` and `Amount` is printing a unit price and a line total, and the old mapping read `Amount` as a second
  // rate — which made `Particulars | Qty | Rate | Amount` name no total column at all, so the whole table was
  // refused and its product row fell back to the loose path (`Pineapple lime 3 25.00`, quantity unresolved).
  AMOUNT: "total",
  AMT: "total",
  VALUE: "total",
  TOTAL: "total",
  TOT: "total",
  SUBTOTAL: "total",
  NET: "total",
  // DECISIONS/0033 P2: a GST/HSN breakdown is a table too — of *food*, not of items. Naming its columns lets it
  // be recognised as its own table (so it terminates the item table's span) without letting a row of it ever
  // become a product. The two tax columns deliberately resolve to no role: the charge stage reads them by label.
  HSN: "hsn",
  SAC: "hsn",
  CGST: "tax",
  SGST: "tax",
  IGST: "tax",
  CESS: "tax",
  UTGST: "tax",
};

/**
 * Whole-token die markers. A header row is allowed to be almost all punctuation and currency tokens — a real
 * one prints `# | Description | Qty | Rate | Rs.` — so those words cannot count against the vocabulary test,
 * and they cannot carry a role either.
 */
const DIE_MARKERS = new Set(["#", "NO", "SNO", "SL", "SLNO", "SR", "SRNO", "RM", "RP", "RS", "INR", "ID"]);

/** One header word: the printed text, the column role it names (or null), and its box. */
export interface HeaderCell {
  readonly text: string;
  readonly role: ColumnRole | null;
  readonly box: OcrBox;
}

/** The portion of the receipt the header governs: row indexes `[start, end)`, end exclusive. */
export interface HeaderSpan {
  readonly start: number;
  readonly end: number;
}

export interface HeaderTable {
  /** The header row the table was read from. */
  readonly rowIndex: number;
  readonly row: ParsedRow;
  readonly cells: readonly HeaderCell[];
  /** The quantity column's band, when the header names one. */
  readonly qty: ColumnBand | null;
  /** The rate column's band, when the header names one. */
  readonly rate: ColumnBand | null;
  /** The line-total column's band, when the header names one. */
  readonly total: ColumnBand | null;
  /** Where the name column begins (its word's left edge), when the header names one. */
  readonly nameLeft: number | null;
  /**
   * Where the table stops: the next header below it, or the receipt's end. Taken to the *next* header so a
   * page printing two grids (items, then a GST table) reads each against its own header.
   */
  readonly span: HeaderSpan;
}

/**
 * A right-aligned numeric column as the page prints it (DECISIONS/0033 P3): the header word's own centre is
 * only approximate — `Qty` is centred in its cell while its values are right-aligned — so the band is widened,
 * and the row reader prefers the *nearest* band when two could claim one number.
 */
export interface ColumnBand {
  readonly role: ColumnRole;
  readonly center: number;
  readonly tolerance: number;
}

/** A parsed integer or decimal token, as JSON-safe evidence. */
export interface AmountToken {
  readonly word: RowWord;
  readonly value: number;
}

/** Monetary columns read as decimals; a bare integer is accepted only in a small column (`Qty`, `3`). */
const DECIMAL = /^\d[\d,]*\.\d{1,3}$/;
const BARE_INTEGER = /^\d{1,3}$/;

function stripCurrency(text: string): string {
  return text.replace(/^(?:₹|\$|rs\.?|inr|rp\.?)(?![a-z])/i, "").trim();
}

/** The numeric value a word prints in a column, or null when it is not a plain decimal/integer token. */
export function columnValue(text: string): number | null {
  const token = stripCurrency(text).replace(/^[:\s]+/, "");
  if (DECIMAL.test(token)) {
    const value = Number(token.replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }
  if (BARE_INTEGER.test(token)) return Number(token);
  return null;
}

/** Is this word usable as a column value at all (before any band decides which column)? */
export function isColumnValueWord(word: RowWord): boolean {
  return columnValue(word.text) !== null;
}

/**
 * A column band: the header word's centre, widened because values are right-aligned while the label is centred.
 *
 * The width is capped relative to the *image*, not to the header word. A long label (`U.PRICE`, `DESCRIPTION`)
 * would otherwise produce a band wide enough to claim half the page — on one dev receipt a 240px-wide `U.PRICE`
 * header gave a rate band covering everything from the name column to the total — and a band that wide reads
 * every stray number as a rate.
 */
const MAX_COLUMN_TOLERANCE_RATIO = 0.08;

function bandFor(role: ColumnRole, box: OcrBox, imageWidth: number): ColumnBand {
  return {
    role,
    center: horizontalCenter({ box }),
    tolerance: Math.min(
      Math.max(box.width * 0.9, imageWidth * 0.04),
      imageWidth * MAX_COLUMN_TOLERANCE_RATIO
    ),
  };
}

/**
 * DECISIONS/0033 P1/P2: a row is a header row when it names at least two columns, counts that come from the
 * header vocabulary outnumber the words that do not, and — P4 — it does not read as a data row itself.
 *
 * The density test in P4 is what stops `MIKA GORENG 8.000` from being read as a header: a row carrying an
 * amount is data, whatever words it also carries. `column` is the price column, if one was inferred, and is
 * used to exclude the row's own price word from the count, because a header may legitimately print a currency
 * amount in its price cell (`PRICE` … `12.00` does not happen, but a `Rs.` cell does).
 */
export function readHeaderRow(row: ParsedRow, column: PriceColumn | null, imageWidth: number): HeaderTable | null {
  if (row.words.length < 2) return null;
  // P4: a row with a number in the price column is data, not a header.
  if (
    column !== null &&
    row.words.some(
      (word) =>
        isColumnValueWord(word) &&
        !BARE_INTEGER.test(word.text.trim()) &&
        Math.abs(word.box.x + word.box.width - column.center) <= column.tolerance,
    )
  ) {
    return null;
  }

  const cells: HeaderCell[] = [];
  let vocabularyWords = 0;
  let otherWords = 0;
  const claimed = new Set<ColumnRole>();
  for (const word of row.words) {
    const fragments = labelFragments(word.text);
    if (fragments.length === 0) {
      // `%`, `/`, `@` — punctuation inside a header, never evidence against it.
      cells.push({ text: word.text, role: null, box: word.box });
      continue;
    }
    const known = fragments.every((fragment) => HEADER_COLUMN_VOCABULARY.has(fragment) || DIE_MARKERS.has(fragment));
    // Two tax columns are two columns, not one: `CGST` and `SGST` are distinct `label`s that both hold a `tax`
    // value, so the "no column claimed twice" rule is keyed on the *label*, and a role like `tax` may repeat.
    const repeatable = (role: ColumnRole) => role === "tax";
    const role =
      fragments
        .map((fragment) => ROLE_OF_LABEL[fragment])
        .find((entry) => entry !== undefined && (repeatable(entry) || !claimed.has(entry))) ?? null;
    if (role && !repeatable(role)) claimed.add(role);
    if (known) vocabularyWords += 1;
    else otherWords += 1;
    cells.push({ text: word.text, role, box: word.box });
  }

  if (claimed.size < 2) return null;
  if (vocabularyWords <= otherWords) return null;

  const cellFor = (role: ColumnRole) => cells.find((cell) => cell.role === role);
  const qtyCell = cellFor("qty");
  const rateCell = cellFor("rate");
  const totalCell = cellFor("total");
  const nameCell = cellFor("name");

  return {
    rowIndex: row.index,
    row,
    cells,
    qty: qtyCell ? bandFor("qty", qtyCell.box, imageWidth) : null,
    rate: rateCell ? bandFor("rate", rateCell.box, imageWidth) : null,
    total: totalCell ? bandFor("total", totalCell.box, imageWidth) : null,
    nameLeft: nameCell ? nameCell.box.x : null,
    span: { start: row.index, end: row.index + 1 },
  };
}

/** Every header row on the page, top to bottom, each given the span up to the next header (P2). */
export function findHeaderTables(rows: readonly ParsedRow[], column: PriceColumn | null, imageWidth: number): HeaderTable[] {
  const found: HeaderTable[] = [];
  for (const row of rows) {
    const header = readHeaderRow(row, column, imageWidth);
    if (header) found.push(header);
  }
  return found.map((header, index) => {
    const next = found[index + 1];
    return { ...header, span: { start: header.rowIndex + 1, end: next ? next.rowIndex : rows.length } };
  });
}

/** The header governing a row, or null when the row sits above every header. */
export function headerForRow(tables: readonly HeaderTable[], rowIndex: number): HeaderTable | null {
  let found: HeaderTable | null = null;
  for (const table of tables) {
    if (rowIndex >= table.span.start && rowIndex < table.span.end) found = table;
  }
  return found;
}

/**
 * Which column a word belongs to (P3). The *nearest* band within its tolerance wins, so a value right-aligned
 * under `Total` is never stolen by a wide `Rate` band next door. Returns null when no band claims it, and that
 * is a real answer: the word is not part of this table's numeric grid.
 */
export function columnOf(word: RowWord, bands: readonly (ColumnBand | null)[]): ColumnRole | null {
  const centre = horizontalCenter(word);
  let best: { role: ColumnRole; distance: number } | null = null;
  for (const band of bands) {
    if (!band) continue;
    const distance = Math.abs(centre - band.center);
    if (distance > band.tolerance) continue;
    if (best === null || distance < best.distance) best = { role: band.role, distance };
  }
  return best?.role ?? null;
}

/** A table's bands, in reading order, for {@link columnOf}. */
export function bandsOf(table: HeaderTable): readonly (ColumnBand | null)[] {
  return [table.qty, table.rate, table.total];
}

/**
 * The table columns a table names, which is what says whether it can reconstruct *items* at all.
 *
 * P2: `Product | Expire | Qty | Rate | Total` qualifies; `HSN | Tax% | CGST | SGST | Cess` does not, because it
 * names a tax column or an HSN column and no line total — it is the GST breakdown, and its rows are read by the
 * charge stage's label path, never as products.
 */
export function isRowShapedTable(table: HeaderTable): boolean {
  const hasTaxColumns = table.cells.some((cell) => cell.role === "hsn" || cell.role === "tax");
  if (hasTaxColumns) return false;
  // A row needs a quantity, a rate and a total to be validated (P6) and a name band to be placed under (P5).
  return table.qty !== null && table.rate !== null && table.total !== null && table.nameLeft !== null;
}
