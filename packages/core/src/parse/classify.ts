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
  clusterRowsByTolerance,
  inferPriceColumn,
  inferPriceColumnFromWords,
  priceCandidatesForRow,
  rowBandTolerance,
  weightedMedianWordHeight,
  type ParsedRow,
  type PriceColumn,
  type RowWord,
} from "./geometry.js";
import { isAllCapsStandalone, isFooterInstructionRow, footerPhraseIn, matchesChargeLabel, matchesHeaderOrNoisePattern, matchesTenderFamily, readMetadata, type MetadataField } from "./patterns.js";
import { detectQuantityColumn } from "./quantity.js";
import { findHeaderTables, isRowShapedTable, type HeaderTable } from "./header.js";
import { isTaxTable, isTaxTableDataRow } from "./taxes.js";
import { reconstructTableRows, type ReconstructResult, type TableRecord } from "./rows.js";
import { reconstructWithoutHeader } from "./pairs.js";
import { profileForRows, readMoney } from "./money.js";
import { magnitudeOutlier, PRICE_MAGNITUDE_MULTIPLE } from "./magnitude.js";

// Re-exported for the seams that publish 0033's pinned counts: the constant and the rule are one implementation,
// and a caller that needs the number should not have to know which module holds it.
export { PRICE_MAGNITUDE_MULTIPLE };
import { CONTINUATION_LENGTH_FLOOR, CONTINUATION_LENGTH_MEDIAN_MULTIPLIER } from "./constants.js";

export type RowClassification = "item" | "continuation" | "noise_header" | "metadata" | "ignored" | "ambiguous";

/** A clustered row with its class and the geometry the decision rested on. */
export interface ClassifiedRow {
  readonly row: ParsedRow;
  readonly classification: RowClassification;
  readonly priceCandidates: readonly RowWord[];
  /** Index of the item row a continuation merged into; null for every other class. */
  readonly mergedInto: number | null;
  /** Left edge of the name column this row was judged against, for an item or a continuation. */
  readonly nameColumnLeft: number | null;
  /** Which receipt-metadata label the row printed, for a `metadata` row (DECISIONS/0034 M1). */
  readonly metadataField?: MetadataField;
  /** Why a row was confidently ignored, for an `ignored` row (DECISIONS/0034 M2, 0035's disposition audit). */
  readonly ignoredReason?: "footer_instruction" | "tax_table";
}

/**
 * `tenderFamily` exists for one thing: DECISIONS/0008 P7's revised invariant requires a pre/post
 * transition table for any rule that grows the discard class, so the base head's behaviour has to be
 * re-derivable from the shipped code rather than from a remembered number. Production never passes it.
 */
export interface ClassifyOptions {
  readonly tenderFamily?: boolean;
}

export interface RowClassifyResult {
  readonly rows: readonly ClassifiedRow[];
  readonly column: PriceColumn | null;
  readonly bandTolerance: number;
  readonly medianWordHeight: number;
  /** DECISIONS/0033: the printed column tables found on this page, each with the span it governs. */
  readonly headerTables: readonly HeaderTable[];
  /** The rows those tables reconstruct, and the rows they consumed. */
  readonly tableRows: ReconstructResult;
  /** DECISIONS/0035: the header-free pairing stage's own reading of this page. */
  readonly pairing: PairingSummary;
}

/** What the header-free stage decided, kept for provenance and for the completion report's ledger. */
export interface PairingSummary {
  readonly roleSource: "arithmetic" | "positional" | null;
  readonly roles: readonly { readonly role: "qty" | "rate" | "total"; readonly center: number }[];
  readonly records: number;
  readonly roled: boolean;
  /** The arithmetic ranking behind the role decision (Amendment C), best first. */
  readonly scored: readonly { readonly roles: readonly string[]; readonly score: number }[];
  /** Numeric rows this stage saw and refused to pair, with the reason (§7's ledger). */
  readonly unpaired: readonly { readonly rowIndex: number; readonly text: string; readonly reason: string }[];
}

function isHeaderOrLabelledRow(row: ParsedRow, tenderFamily: boolean, isHeaderRow = false): boolean {
  // DECISIONS/0034 H2: a row the header stage recognised is a header, whatever the older family predicates know.
  // `Particulars | Qty | Rate | Amount` is a real header whose name/rate words the 0008 family does not carry; it
  // is recognised here by the same stage that uses it, so the two can never disagree about the same row.
  if (isHeaderRow) return true;
  const words = row.words.map((word) => word.text);
  return (
    matchesHeaderOrNoisePattern(words) ||
    matchesChargeLabel(row.text) ||
    (tenderFamily && matchesTenderFamily(row.text))
  );
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
  bandTolerance: number,
  tenderFamily = true
): boolean {
  const words = row.words.map((word) => word.text);
  return (
    Math.abs(row.left - nameColumnLeft) <= bandTolerance &&
    !isHeaderOrLabelledRow(row, tenderFamily) &&
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
 * Does the row carry a name? A row whose only content is its price word — `1,818` on its own — is
 * not a product. §5's item is a named thing with a price, and DECISIONS/0008 P7's rule 3 was
 * promoting these number-only rows into items with an empty name: 49 in CORD, 34 in SROIE.
 */
function hasNameContent(row: ParsedRow, candidates: readonly RowWord[]): boolean {
  const [candidate] = candidates;
  return row.words.some((word) => word !== candidate && /[A-Za-z]/.test(word.text));
}

/**
 * Clusters an `OcrResult` into rows and classifies each one. Deterministic: the pass reads only
 * geometry, text and rows already classified, so output never depends on object or map ordering.
 */
export function classifyRows(ocrResult: OcrResult, options: ClassifyOptions = {}): RowClassifyResult {
  const tenderFamily = options.tenderFamily ?? true;
  const words = collectWords(ocrResult);
  const medianWordHeight = weightedMedianWordHeight(words);
  const bandTolerance = rowBandTolerance(medianWordHeight);
  // The column is inferred twice on purpose: once from words, before any row exists, so anchor rows
  // have a column to anchor to; then from the finished rows, which is the column 05 has always
  // reported and the one price candidates are read against.
  const wordColumn = inferPriceColumnFromWords(words, ocrResult.imageSize.width);
  // Anchor rows are for three-column receipts. §5's quantity column is a per-row statistic, so it is
  // measured on the y-band rows first; without it — a `name | price` page — the band rows stand, and
  // that is exactly the shape the CORD/SROIE fixtures were measured on.
  const quantityColumn = detectQuantityColumn(clusterRowsByTolerance(words, bandTolerance), ocrResult.imageSize.width, wordColumn);
  const rows = clusterRows(words, bandTolerance, wordColumn, quantityColumn !== null);
  const column = inferPriceColumn(rows, ocrResult.imageSize.width);
  const profile = profileForRows(rows);
  // Amendment E / DECISIONS/0033: an identifier that merely looks amount-shaped is not a price. One implementation
  // of that rule lives in `magnitude.ts` and is shared with the header-free stage.
  const isOutlier = magnitudeOutlier(rows, column, profile);

  // DECISIONS/0033: before any row is classified, ask whether the page prints a column table at all. A header
  // is the one piece of evidence that lets two printed lines become one record; without it, nothing here runs
  // and the classification below is exactly 0008 P7's pass.
  const headerTables = findHeaderTables(rows, column, ocrResult.imageSize.width);
  // Two different questions, deliberately asked separately: *furniture* (a header, a registration line, a
  // column-label row) is skipped while collecting a name, and a *labelled* row (a charge) both stops name
  // collection and is refused as a record — a `Total` row is not a product that happens to print a label.
  //
  // The tender family is applied *here unconditionally*, unlike in the classifier: the toggle exists so 0008 P7's
  // pre-family head can be re-derived, and a reconstruction rule that changed with it would make the seam's two
  // readings disagree about the same page for a reason that has nothing to do with classification.
  const isFurnitureRow = (row: ParsedRow): boolean => {
    const words = row.words.map((word) => word.text);
    // DECISIONS/0034: a metadata row (`Bill No: 210373`) and a footer instruction (`THANK YOU`) are furniture
    // inside a table's span too — neither can be the name of the numbers below it.
    return (
      matchesHeaderOrNoisePattern(words) ||
      matchesTenderFamily(row.text) ||
      readMetadata(words) !== null ||
      isFooterInstructionRow(words)
    );
  };
  const isLabelledRow = (row: ParsedRow): boolean =>
    matchesChargeLabel(row.text) || matchesHeaderOrNoisePattern(row.words.map((word) => word.text));

  const tableRows = reconstructTableRows(
    rows,
    headerTables,
    isFurnitureRow,
    isLabelledRow,
    (row) => matchesTenderFamily(row.text)
  );

  // DECISIONS/0035: the header-free stage. It runs only over what the header tables did **not** account for, so a
  // recognised `Product | Qty | Rate | Total` table keeps its own reading and the two stages can never publish the
  // same row twice. It reads the same bands the price column does, so both layouts share one geometry (D).
  const pairing = reconstructWithoutHeader(rows, ocrResult.imageSize.width, {
    consumed: tableRows.consumedRows,
    isFurniture: isFurnitureRow,
    headerFloorIndex: headerTables.length > 0 ? Math.min(...headerTables.map((table) => table.rowIndex)) : undefined,
    headerRowIndexes: new Set(headerTables.map((table) => table.rowIndex)),
    // A charge label is unconditional (`Total 474.00` is never a product), but the identifier families are
    // *shape* rules that a pure number row satisfies by construction: `2.00 35.00 70.00` must stay readable here.
    isLabelled: (row) =>
      matchesChargeLabel(row.text) ||
      (row.words.some((word) => /[A-Za-z]{2,}/.test(word.text)) &&
        matchesHeaderOrNoisePattern(row.words.map((word) => word.text))),
  });
  /** Every row either reconstruction stage consumed. */
  const reconstructedRows = new Set<number>([...tableRows.consumedRows, ...pairing.consumedRows]);
  const allRecords: readonly TableRecord[] = [...tableRows.records, ...pairing.records];

  // 0033 P2: a header table that names tax/HSN columns is the GST breakdown, not an item table. Its *data* rows are
  // read by the tax stage (`taxes.ts`) and are therefore understood — reporting them as rows needing review would be
  // a false positive that blocks locking on every receipt printing a tax breakdown. The test is the tax stage's own
  // column test, not the table's span: a span runs to the next header or to the end of the page, and swallowing the
  // trailing footer with it is how a row nobody understood ends up looking understood.
  const taxTables = headerTables.filter((table) => !isRowShapedTable(table) && isTaxTable(table));
  const isTaxRow = (row: ParsedRow): boolean =>
    taxTables.some((table) => row.index >= table.span.start && row.index <= table.span.end && isTaxTableDataRow(row, table, ocrResult.imageSize.width));

  const classified: ClassifiedRow[] = [];
  const itemNameLengths: number[] = [];
  const headerRowSet = new Set(headerTables.map((table) => table.rowIndex));
  /** Item-region rows seen so far, which is where §5's header zone ends. */
  let pricedRowsSeen = 0;
  /** Index of the item currently open for continuation, and whether the previous row belonged to it. */
  let openItem: { index: number; nameColumnLeft: number } | null = null;
  let previousWasItemOrContinuation = false;

  for (const row of rows) {
    // Amendment E / DECISIONS/0033: an identifier that merely looks amount-shaped is not a price.
    const candidates = priceCandidatesForRow(row, column).filter((word) => !isOutlier(word));
    const wordTexts = row.words.map((word) => word.text);
    const push = (rowClass: RowClassification, mergedInto: number | null, nameColumnLeft: number | null) => {
      classified.push({ row, classification: rowClass, priceCandidates: candidates, mergedInto, nameColumnLeft });
    };
    const pushMetadata = () => {
      const reading = readMetadata(wordTexts);
      if (!reading) return;
      classified.push({
        row,
        classification: "metadata",
        priceCandidates: candidates,
        mergedInto: null,
        nameColumnLeft: null,
        metadataField: reading.field,
      });
    };

    // 0. DECISIONS/0033: a row a printed table already accounted for is not classified again. It became an
    // item (or a named evidence warning) in the table pass, and §5 keeps the item list and the preserved rows
    // disjoint. The header row itself lands in class 1 below, which is where a header belongs.
    if (reconstructedRows.has(row.index)) {
      previousWasItemOrContinuation = false;
      // §5's item region is "rows at or below the first priced row", and a reconstructed row *is* a priced row:
      // a record exists only where the page printed money in a column. Not counting it made a page whose priced
      // rows were all read by a reconstruction stage look like it had no item region at all, so every trailing
      // row fell into rule 5's "above the item region" and was discarded as header noise instead of being
      // preserved for review (the Saravana photograph: nine rows, of which seven carry no label that would
      // justify discarding them). Counting it restores rule 7's answer below the items.
      if (!tableRows.headerRowIndexes.has(row.index) && candidates.length >= 1) pricedRowsSeen += 1;
      // A *header* row keeps class 1's answer below, so 0008 P7's `pricedRowsSeen` bookkeeping is untouched by
      // this stage. A row that only supplied a record's name word is still subject to class 1 too: whether it
      // carries a charge label is a question about that row, not about the record it helped spell.
      if (!tableRows.headerRowIndexes.has(row.index) && !isHeaderOrLabelledRow(row, tenderFamily)) {
        push("noise_header", null, null);
        continue;
      }
    }

    // 0b. DECISIONS/0034 M1 — the receipt's own metadata. A label at the start of the row (`Bill No:`, `Date:`,
    // `KOT`) is not a purchase, whatever number follows it and wherever that number sits in the price column.
    // Checked before rule 1 because a metadata row can also carry a charge word (`Bill Amount`), and before the
    // price-candidate rules because those are exactly what promoted `Bill No: 210373` into an item.
    if (readMetadata(wordTexts) !== null) {
      previousWasItemOrContinuation = false;
      pushMetadata();
      continue;
    }

    // 1. header/noise patterns and charge labels win before any numeric row is read as a product.
    if (isHeaderOrLabelledRow(row, tenderFamily, headerRowSet.has(row.index))) {
      // Family 5 is the one pattern family whose price-column entry still marks item position. A tender
      // prints at the end of the priced block, so excluding its entry would reopen P7's header zone over
      // the rows below it and silently discard 38 dev rows that are not tender-shaped at all — the
      // opposite of what the family is for. Families 1–4 and the charge labels keep 0008's rule.
      if (tenderFamily && matchesTenderFamily(row.text) && candidates.length >= 1) pricedRowsSeen += 1;
      previousWasItemOrContinuation = false;
      push("noise_header", null, null);
      continue;
    }

    // 1a. A tax-table row is understood by the tax stage, so it is not a row awaiting review.
    if (isTaxRow(row)) {
      previousWasItemOrContinuation = false;
      classified.push({
        row,
        classification: "ignored",
        priceCandidates: candidates,
        mergedInto: null,
        nameColumnLeft: null,
        ignoredReason: "tax_table",
      });
      continue;
    }

    // 1b. DECISIONS/0034 M2 — a footer phrase is never a product. Without a number it is confidently ignored;
    // with one it is preserved for review instead, because a footer that prints money is something the creator
    // should see rather than a purchase this parser is willing to invent.
    if (footerPhraseIn(wordTexts)) {
      previousWasItemOrContinuation = false;
      if (isFooterInstructionRow(wordTexts)) {
        classified.push({
          row,
          classification: "ignored",
          priceCandidates: candidates,
          mergedInto: null,
          nameColumnLeft: null,
          ignoredReason: "footer_instruction",
        });
      } else {
        push("ambiguous", null, null);
      }
      continue;
    }

    // A row that reaches here with an entry in the price column sits in the item region, whatever
    // rules 2 and 3 make of it: §5's "above the first item" is a statement about document position,
    // not classification status, so a priced row failing rule 3's name test still ends the zone.
    if (candidates.length >= 1) pricedRowsSeen += 1;

    // 2. several plausible prices is never resolved by picking one.
    if (candidates.length >= 2) {
      previousWasItemOrContinuation = false;
      push("ambiguous", null, null);
      continue;
    }

    // 3. exactly one candidate, plus something other than the price to be the item's name. A row
    // that is nothing but a number is real money but not a product, so it is preserved rather than
    // promoted — see DECISIONS/0008 P7's rule 3.
    if (candidates.length === 1 && hasNameContent(row, candidates)) {
      itemNameLengths.push(itemNameLength(row, candidates));
      openItem = { index: classified.length, nameColumnLeft: row.left };
      previousWasItemOrContinuation = true;
      push("item", null, row.left);
      continue;
    }

    // 3b. a price with no name: visible for review, never a phantom item with an empty name.
    if (candidates.length === 1) {
      previousWasItemOrContinuation = false;
      push("ambiguous", null, null);
      continue;
    }

    // 4. price-less: a continuation only when all four conditions hold against the open item.
    if (
      openItem &&
      previousWasItemOrContinuation &&
      meetsContinuationConditions(row, openItem.nameColumnLeft, itemNameLengths, bandTolerance, tenderFamily)
    ) {
      // The merged row does not widen the item's measured length: growth would let each accepted
      // continuation raise the cap for the next one, and a run of them could swallow a header row.
      push("continuation", openItem.index, openItem.nameColumnLeft);
      continue;
    }

    previousWasItemOrContinuation = false;

    // 5. above the item region there is nothing to continue, so the row is header noise.
    if (pricedRowsSeen === 0) {
      push("noise_header", null, null);
      continue;
    }

    // 7. once the item region has started, an unmerged price-less row is set aside visibly rather
    // than discarded — this class is the only one that blocks bill locking.
    push("ambiguous", null, null);
  }

  return {
    rows: classified,
    column,
    bandTolerance,
    medianWordHeight,
    headerTables,
    tableRows: { ...tableRows, records: allRecords, consumedRows: reconstructedRows },
    pairing: {
      roleSource: pairing.roleSource,
      roles: pairing.roles.map((band) => ({ role: band.role, center: band.center })),
      records: pairing.records.length,
      roled: pairing.roles.length > 0,
      scored: pairing.scored,
      unpaired: pairing.unpaired,
    },
  };
}
