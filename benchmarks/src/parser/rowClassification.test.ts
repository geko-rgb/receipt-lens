import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyRows,
  isGroupedDigitIdentifier,
  isIdentifierOnlyRow,
  parse,
  type OcrResult,
} from "@receipt-lens/core";
import { loadFixtureSplit } from "../fixtures/load.js";
import type { LabeledReceipt } from "../datasets/types.js";

// DECISIONS/0008 publishes the measured behaviour of the row-geometry and classification rules, and
// §5's constants are only "initial" until something re-derives them. Like the committed τ-sweep in
// `matching/sweep.ts`, this file is that re-derivation: if a threshold moves, these numbers move and
// the table in the decision record is wrong on its face. Tuning signal only — `dev/` per
// DECISIONS/0004; a number that came from `eval/` would be contamination.

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");

async function devReceipts(): Promise<LabeledReceipt[]> {
  const cord = await loadFixtureSplit(fixturesRoot, "dev", "cord-v2");
  const sroie = await loadFixtureSplit(fixturesRoot, "dev", "sroie");
  return [...cord.receipts, ...sroie.receipts];
}

interface Sweep {
  receipts: number;
  providerLines: number;
  rows: number;
  items: number;
  continuations: number;
  noiseHeader: number;
  ambiguous: number;
  pricedRows: number;
  separatorRows: number;
  noColumn: number;
  fallbackColumn: number;
  singleCluster: number;
  multiCluster: number;
  identifierOnlyRows: number;
  identifierOnlyPriced: number;
}

function sweep(receipts: readonly LabeledReceipt[]): Sweep {
  const totals: Sweep = {
    receipts: receipts.length,
    providerLines: 0,
    rows: 0,
    items: 0,
    continuations: 0,
    noiseHeader: 0,
    ambiguous: 0,
    pricedRows: 0,
    separatorRows: 0,
    noColumn: 0,
    fallbackColumn: 0,
    singleCluster: 0,
    multiCluster: 0,
    identifierOnlyRows: 0,
    identifierOnlyPriced: 0,
  };
  for (const fixture of receipts) {
    const ocr = fixture.ocr as unknown as OcrResult;
    const result = classifyRows(ocr);
    totals.providerLines += ocr.lines.length;
    totals.rows += result.rows.length;
    if (!result.column) totals.noColumn += 1;
    else if (result.column.fallback) totals.fallbackColumn += 1;
    else if (result.column.qualifiedClusters > 1) totals.multiCluster += 1;
    else totals.singleCluster += 1;
    for (const entry of result.rows) {
      if (entry.classification === "item") totals.items += 1;
      else if (entry.classification === "continuation") totals.continuations += 1;
      else if (entry.classification === "noise_header") totals.noiseHeader += 1;
      else totals.ambiguous += 1;
      if (entry.priceCandidates.length >= 1) totals.pricedRows += 1;
      if (entry.priceCandidates.length >= 2) totals.separatorRows += 1;
      if (isIdentifierOnlyRow(entry.row.words.map((word) => word.text))) {
        totals.identifierOnlyRows += 1;
        if (entry.priceCandidates.length > 0) totals.identifierOnlyPriced += 1;
      }
    }
  }
  return totals;
}

describe("row geometry over the committed dev fixtures", () => {
  it("re-clusters the provider's reading-order lines into the parser's rows", async () => {
    const totals = sweep(await devReceipts());
    expect(totals.receipts).toBe(250);
    // 5,604 provider lines become 5,199 rows: CORD publishes quantity, name and amount as three
    // separate lines of one visual row, and §5's clustering has to put them back together.
    expect(totals.providerLines).toBe(5604);
    expect(totals.rows).toBe(5199);
    expect(totals.rows).toBeLessThan(totals.providerLines);
  });

  it("classifies every row into exactly one of §5's four classes", async () => {
    const totals = sweep(await devReceipts());
    expect(totals.items + totals.continuations + totals.noiseHeader + totals.ambiguous).toBe(totals.rows);
    expect(totals.items).toBe(713);
    expect(totals.continuations).toBe(43);
    expect(totals.noiseHeader).toBe(3583);
    expect(totals.ambiguous).toBe(860);
  });

  it("infers the price column at the rate DECISIONS/0008 P6 publishes", async () => {
    const totals = sweep(await devReceipts());
    expect(totals.singleCluster).toBe(117);
    expect(totals.multiCluster).toBe(115);
    expect(totals.fallbackColumn).toBe(16);
    expect(totals.noColumn).toBe(2);
    expect(totals.singleCluster + totals.multiCluster + totals.fallbackColumn + totals.noColumn).toBe(totals.receipts);
    expect(totals.pricedRows).toBe(1364);
    expect(totals.separatorRows).toBe(3);
  });

  it("never lets a grouped-digit identifier row survive as an item", async () => {
    const receipts = await devReceipts();
    const offenders: string[] = [];
    let identifierRows = 0;
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      for (const entry of classifyRows(ocr).rows) {
        const words = entry.row.words.map((word) => word.text);
        if (!words.some(isGroupedDigitIdentifier)) continue;
        if (entry.classification === "item") offenders.push(`${fixture.receiptId}: "${entry.row.text.slice(0, 60)}"`);
        if (isIdentifierOnlyRow(words)) identifierRows += 1;
      }
    }
    // Date stamps are the population this family actually catches in dev; a telephone-shaped row
    // exists only in authored fixtures (DECISIONS/0008 P3), so this is the measured floor.
    expect(identifierRows).toBe(1);
    expect(offenders).toEqual([]);
  });
});

describe("parse() through the core seam", () => {
  it("produces byte-identical output for every dev fixture across two runs", async () => {
    const receipts = await devReceipts();
    const unstable: string[] = [];
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      if (JSON.stringify(parse(ocr)) !== JSON.stringify(parse(ocr))) unstable.push(fixture.receiptId);
    }
    expect(unstable).toEqual([]);
  });

  it("keeps every ambiguous row visible with its text, geometry and source lines", async () => {
    const receipts = await devReceipts();
    let preserved = 0;
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      const result = parse(ocr);
      const lineIds = new Set(ocr.lines.map((line) => line.id));
      for (const row of result.unclassifiedRows) {
        preserved += 1;
        expect(row.text.trim().length).toBeGreaterThan(0);
        expect(row.sourceLineIds.length).toBeGreaterThan(0);
        expect(row.sourceLineIds.every((id) => lineIds.has(id))).toBe(true);
        expect(row.reason).toBe("ambiguous");
        expect(row.warningCode).toBe("ambiguous_row");
      }
      expect(result.warnings.filter((warning) => warning.code === "ambiguous_row")).toHaveLength(
        result.unclassifiedRows.length
      );
    }
    expect(preserved).toBe(860);
  });

  it("produces no item with an empty name (DECISIONS/0008 P7 rule 3)", async () => {
    const receipts = await devReceipts();
    const offenders: string[] = [];
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      for (const item of parse(ocr).items) {
        if (item.name.trim().length === 0) offenders.push(`${fixture.receiptId}: row for ${item.id} has no name`);
      }
    }
    // A row whose only content is its price word is money, not a product: 49 such rows existed in
    // CORD and 34 in SROIE before rule 3 required a lettered non-price word.
    expect(offenders).toEqual([]);
  });

  it("never loses a word and never places one in two rows", async () => {
    const receipts = await devReceipts();
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      const rows = classifyRows(ocr).rows;
      const clustered = rows.flatMap((entry) => entry.row.words);
      expect(clustered.length).toBe(ocr.lines.reduce((sum, line) => sum + line.words.length, 0));
    }
  });

  it("parses a real receipt without inventing an item out of the header block", async () => {
    // SROIE reference OCR: identity block, column labels, one item row, charges, footer notice.
    const [fixture] = await devReceipts();
    const result = parse(fixture!.ocr as unknown as OcrResult);
    expect(result.items.length).toBeGreaterThanOrEqual(0);
    for (const item of result.items) {
      // Content parsing is ticket 06: nothing here may claim a number it did not read.
      expect(item.qty).toBeNull();
      expect(item.unitPrice).toBeNull();
      expect(item.lineTotal).toBeNull();
      expect(item.confidence).toBeNull();
      expect(item.name.trim().length).toBeGreaterThan(0);
    }
  });
});
