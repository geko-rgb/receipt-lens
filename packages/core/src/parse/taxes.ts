/**
 * The GST breakdown as a *table* (DECISIONS/0033 P10–P12).
 *
 * §5's charge path reads a labelled row's amount from the price column. A GST breakdown defeats it: its rows are
 * `996331  2.5  1.67  1.67  0` — five numbers, none of them under the item table's `Total`, and the row carries no
 * label at all (the label is in the header, four rows above). Before this module such a page produced **no taxes**
 * and an `unclassified_charge` warning, which is precisely the "GST is unresolved" bug this fixes.
 *
 * The rule is the item table's rule applied to the tax table: find the header (`HSN | Tax% | CGST | SGST | Cess`),
 * take each tax column's band from its own header word, read each row's value *by position*, and — P11 — take the
 * **total row's** value for each column rather than adding the rows up. The rows and the total are the same money
 * printed twice; adding both is the double-count this must not do.
 *
 * P12: nothing here decides whether the tax is inside the printed prices. The result carries no `included` flag
 * and no arithmetic is performed with it, so `validate()`'s inclusion question (0011 V4) stays open for the
 * creator, exactly as §7 requires.
 */

import type { ParsedTax } from "../types.js";
import type { ParsedRow, RowWord } from "./geometry.js";
import { columnValue, isColumnValueWord, type ColumnBand, type HeaderTable } from "./header.js";
import { labelFragments } from "./patterns.js";
import { readRate, type NumberProfile } from "./money.js";

/** Tax labels a GST table may head a column with, mapped to the label published in `taxes[]`. */
const TAX_COLUMN_LABELS: Readonly<Record<string, string>> = {
  CGST: "CGST",
  SGST: "SGST",
  UTGST: "UTGST",
  IGST: "IGST",
  CESS: "Cess",
  VAT: "VAT",
  TAX: "Tax",
  GST: "GST",
};

/** The words a GST table's header prints besides its tax columns. */
const TAX_TABLE_HEADER_WORDS = new Set(["HSN", "SAC", "TAX", "RATE", "PERCENT", "%", "CESS", "AMOUNT", "VALUE"]);

/** One tax column: what to call it, where it sits, and the rate printed above it if the table shows one. */
interface TaxColumn {
  readonly label: string;
  readonly band: ColumnBand;
  readonly rateHundredths: number | null;
}

/** The total row of a GST table: the row whose numbers are the columns' sums. */
export interface TaxTableRead {
  readonly taxes: readonly ParsedTax[];
  /** Rows the table accounted for; each leaves the charge path's row list. */
  readonly consumedRows: ReadonlySet<number>;
  /** P11: the total row's own text, when the table printed one. */
  readonly totalRowText: string | null;
  /** A rate the table's `Tax%` column states, carried onto every tax as display-only. */
  readonly rateHundredths: number | null;
}

/** Is this header a GST/tax breakdown rather than an item table? */
export function isTaxTable(table: HeaderTable): boolean {
  const roles = table.cells.map((cell) => cell.role);
  if (!roles.includes("tax")) return false;
  // The HSN marker is what distinguishes the breakdown from an item table that happens to print a `Tax` column.
  const fragments = table.cells.flatMap((cell) => labelFragments(cell.text));
  return roles.includes("hsn") || fragments.some((fragment) => TAX_TABLE_HEADER_WORDS.has(fragment));
}

function taxColumnsOf(table: HeaderTable, imageWidth: number): TaxColumn[] {
  const columns: TaxColumn[] = [];
  for (const cell of table.cells) {
    const fragments = labelFragments(cell.text);
    const label = fragments.map((fragment) => TAX_COLUMN_LABELS[fragment]).find((entry) => entry !== undefined);
    if (!label || cell.role !== "tax") continue;
    columns.push({
      label,
      band: { role: "tax", center: cell.box.x + cell.box.width / 2, tolerance: Math.max(cell.box.width * 1.25, imageWidth * 0.04) },
      rateHundredths: null,
    });
  }
  return columns;
}

/** The `Tax%` column's band, if the header prints one. */
function rateBandOf(table: HeaderTable, imageWidth: number): ColumnBand | null {
  for (const cell of table.cells) {
    const fragments = labelFragments(cell.text);
    if (!fragments.some((fragment) => fragment === "TAX" || fragment === "RATE")) continue;
    if (!fragments.some((fragment) => fragment === "PERCENT" || fragment === "%" || fragment === "TAX")) continue;
    if (fragments.some((fragment) => fragment === "CGST" || fragment === "SGST" || fragment === "IGST")) continue;
    return {
      role: "tax",
      center: cell.box.x + cell.box.width / 2,
      tolerance: Math.max(cell.box.width * 1.25, imageWidth * 0.04),
    };
  }
  // `Tax%` prints as one token on the receipt; `%` is not an alphabetic fragment, so the label is just `TAX`.
  const percentCell = table.cells.find((cell) => /%/.test(cell.text));
  if (!percentCell) return null;
  return {
    role: "tax",
    center: percentCell.box.x + percentCell.box.width / 2,
    tolerance: Math.max(percentCell.box.width * 1.25, imageWidth * 0.04),
  };
}

function wordIn(word: RowWord, band: ColumnBand | null): boolean {
  if (!band) return false;
  return Math.abs(word.box.x + word.box.width / 2 - band.center) <= band.tolerance;
}

/** The nearest tax column a word sits under, so two adjacent columns never claim the same number. */
function taxColumnOf(word: RowWord, columns: readonly TaxColumn[]): TaxColumn | null {
  let best: { column: TaxColumn; distance: number } | null = null;
  for (const column of columns) {
    const distance = Math.abs(word.box.x + word.box.width / 2 - column.band.center);
    if (distance > column.band.tolerance) continue;
    if (best === null || distance < best.distance) best = { column, distance };
  }
  return best?.column ?? null;
}

/** The words of a tax-table row that sit under a tax column, or under the rate column, by position. */
function taxValues(row: ParsedRow, columns: readonly TaxColumn[], rateBand: ColumnBand | null) {
  const values = new Map<string, number>();
  let rate: number | null = null;
  for (const word of row.words) {
    if (!isColumnValueWord(word)) continue;
    const column = taxColumnOf(word, columns);
    if (column) {
      const value = columnValue(word.text);
      if (value !== null) values.set(column.label, value);
      continue;
    }
    if (wordIn(word, rateBand)) rate ??= columnValue(word.text);
  }
  return { values, rate };
}

/**
 * Is this row one of a tax table's *data* rows — i.e. does it print a value under one of the table's tax columns?
 * The span alone is too coarse: a table's span runs to the next header or to the end of the page, so treating the
 * span as the tax block would sweep the receipt's trailing footer and identity lines into "understood" territory and
 * hide rows the creator should see. This predicate is the same positional test {@link readTaxTables} reads rows by,
 * so the classifier and the tax stage cannot disagree about which rows a GST breakdown owns.
 */
export function isTaxTableDataRow(row: ParsedRow, table: HeaderTable, imageWidth: number): boolean {
  const columns = taxColumnsOf(table, imageWidth);
  if (columns.length === 0) return false;
  return taxValues(row, columns, rateBandOf(table, imageWidth)).values.size >= 1;
}

/**
 * Read a GST table's total row (P11). Preference order, pinned so the result is a function of the page:
 * the row labelled `Total`/`Grand Total`; failing that a row whose label cell is empty and which prints a value in
 * every tax column; failing that the last row that prints a value in every tax column.
 */
function totalRowOf(rows: readonly ParsedRow[], columns: readonly TaxColumn[], rateBand: ColumnBand | null) {
  const candidates = rows.map((row) => ({ row, ...taxValues(row, columns, rateBand) }));
  const labelled = candidates.filter((entry) => /\btotal\b/i.test(entry.row.text));
  const isTotal = (entry: (typeof candidates)[number]) => columns.every((column) => entry.values.has(column.label));
  const labelledTotal = labelled.findLast(isTotal);
  if (labelledTotal) return labelledTotal;
  const unlabelledTotal = candidates.filter((entry) => isTotal(entry) && !isColumnValueWord(entry.row.words[0]!));
  if (unlabelledTotal.length > 0) return unlabelledTotal[unlabelledTotal.length - 1]!;
  const anyTotal = candidates.filter(isTotal);
  return anyTotal.length > 0 ? anyTotal[anyTotal.length - 1]! : null;
}

/**
 * Read every GST table on the page. Deterministic and row-ordered: tables in document order, columns in reading
 * order, and each tax labelled with its own column's name.
 */
export function readTaxTables(
  rows: readonly ParsedRow[],
  tables: readonly HeaderTable[],
  imageWidth: number,
  profile: NumberProfile
): TaxTableRead {
  const taxes: ParsedTax[] = [];
  const consumed = new Set<number>();
  let totalRowText: string | null = null;
  let rateHundredths: number | null = null;

  for (const table of tables) {
    if (!isTaxTable(table)) continue;
    const columns = taxColumnsOf(table, imageWidth);
    if (columns.length === 0) continue;
    const rateBand = rateBandOf(table, imageWidth);
    const span = rows.slice(table.span.start, table.span.end);

    // The rate the table prints, taken from the first data row that shows one: `2.5` is a display-only fact about
    // the receipt's tax, not an operand.
    for (const row of span) {
      if (readRateRatio(row, rateBand, profile) !== null) {
        rateHundredths ??= readRateRatio(row, rateBand, profile);
        break;
      }
    }
    const total = totalRowOf(span, columns, rateBand);
    if (total) {
      totalRowText ??= total.row.text;
      for (const column of columns) {
        const value = total.values.get(column.label);
        if (value === undefined) continue;
        // A tax column whose total is zero (`Cess 0`) is a real printed column and a real zero, and it is still not
        // a charge: it cannot change any amount, and publishing it would ask the creator to confirm inclusion for
        // ₹0.00. Nothing is invented by leaving it out — the column is read, and its value is zero.
        if (value === 0) continue;
        taxes.push({
          label: column.label,
          amount: Math.round(value * 100),
          rate: rateHundredths,
          source: "detected",
        });
      }
      // P11: consume the tax table's own rows — the ones that print a value under a tax column. The grand total
      // prints under `Total`, which belongs to the item table's columns, and is read by the charge path as it
      // always was.
      for (const entry of span) {
        if (columnValues(entry, columns, rateBand) > 0) consumed.add(entry.index);
      }
    }
  }

  return { taxes, consumedRows: consumed, totalRowText, rateHundredths };
}

/** How many of the table's tax/rate columns a row actually fills. */
function columnValues(row: ParsedRow, columns: readonly TaxColumn[], rateBand: ColumnBand | null): number {
  const { values } = taxValues(row, columns, rateBand);
  return values.size + (rateBand && row.words.some((word) => isColumnValueWord(word) && wordIn(word, rateBand)) ? 1 : 0);
}

/** The `Tax%` cell read as hundredths of a percent, for the display-only `rate`. */
function readRateRatio(row: ParsedRow, rateBand: ColumnBand | null, profile: NumberProfile): number | null {
  if (!rateBand) return null;
  for (const word of row.words) {
    if (!wordIn(word, rateBand)) continue;
    // `2.5` prints without a percent sign in the cell, so the number itself is the rate: 2.5% → 250 hundredths.
    const value = columnValue(word.text);
    if (value !== null && value > 0 && value <= 100) return Math.round(value * 100);
    const rate = readRate(`${word.text}%`, profile);
    if (rate !== null) return rate;
  }
  return null;
}
