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
    // Re-measured at ticket 06's head against `20e4459` (05's shipped 713 / 43 / 3,517 / 926): pattern
    // family 5 (tenders, DECISIONS/0010 Q7) discards 307 rows that are each individually attributable to
    // the family predicate — 209 were being sold as items, 92 were preserved, 6 were continuations of
    // phantom items. The revised P7 invariant is `3,517 + named-family rows`, and the attribution test in
    // `quantityMoneyPins.test.ts` is what enforces it; a rise with no family behind it still fails.
    expect(totals.items).toBe(504);
    expect(totals.continuations).toBe(37);
    expect(totals.noiseHeader).toBe(3517 + 307);
    expect(totals.ambiguous).toBe(834);
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
    // 834 ambiguous rows minus the 14 ticket 06 promotes to items (DECISIONS/0010 Q6).
    expect(preserved).toBe(820);
  });

  it("accounts for every CORD gold item name by the class of the row that carries it", async () => {
    // DECISIONS/0008 P7's reachability claim, measured rather than asserted: a gold name whose only
    // carrier row is `noise_header` is unrecoverable from `ParseResult`, so that count is the cost of
    // the discard class and the reason the header zone is keyed to price rather than to rule 3.
    const { receipts } = await loadFixtureSplit(fixturesRoot, "dev", "cord-v2");
    const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
    const buckets = { reached: 0, dropped: 0, preserved: 0, absent: 0, total: 0 };
    for (const fixture of receipts) {
      const ocr = fixture.ocr as unknown as OcrResult;
      const names = parse(ocr).items.map((item) => norm(item.name)).filter((name) => name.length > 0);
      const rows = classifyRows(ocr).rows;
      for (const gold of fixture.gold.items) {
        const name = norm(gold.name);
        if (name.length === 0) continue;
        buckets.total += 1;
        if (names.some((item) => item.includes(name))) buckets.reached += 1;
        else {
          const carriers = rows.filter((entry) => norm(entry.row.text).includes(name));
          if (carriers.length === 0) buckets.absent += 1;
          else if (carriers.some((entry) => entry.classification === "noise_header")) buckets.dropped += 1;
          else buckets.preserved += 1;
        }
      }
    }
    // 06's head vs `20e4459` (156/37/45/16): four more names reached while 209 rows left the item class,
    // because the rows that were discarded were phantom tenders and the ones that survived got their money
    // parsed. `absent` is unchanged at 16 — that is the floor 09b reports, and 06's ticket file carries the
    // investigation of why those names appear in no classified row at all.
    expect(buckets).toEqual({ total: 254, reached: 164, dropped: 37, preserved: 37, absent: 16 });
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

  it("splits CORD's preserved rows into the causes DECISIONS/0008 P7 publishes", async () => {
    const { receipts } = await loadFixtureSplit(fixturesRoot, "dev", "cord-v2");
    // The predicates are the ones P7's table states, applied in that order: tender before bare
    // integer (`CHANGE: 0` is both), and a split-layout name row only when the row beneath it is
    // nothing but numbers.
    const TENDER = /(^|\W)(cash|change|tender|balance|payment|pay|mode\s*pay|round\s*off|diskon|kembali)(\W|$)/i;
    const BARE_INTEGER = /(^|\s)\d{1,2}(\s|$)/;
    const NUMBER_ONLY = /^[\d.,+-]+$/;
    const causes = new Map<string, number>();
    for (const fixture of receipts) {
      const rows = classifyRows(fixture.ocr as unknown as OcrResult).rows;
      for (const [index, entry] of rows.entries()) {
        if (entry.classification !== "ambiguous") continue;
        const below = rows[index + 1];
        const cause =
          entry.priceCandidates.length >= 2
            ? "more than one price candidate"
            : entry.priceCandidates.length === 1
              ? "priced row with no lettered name word"
              : TENDER.test(entry.row.text)
                ? "tender or payment line"
                : entry.row.text.includes("%")
                  ? "percent or modifier line"
                  : BARE_INTEGER.test(entry.row.text)
                    ? "money prints as a bare 1–2 digit integer"
                    : below !== undefined && below.row.text.split(/\s+/).every((word) => NUMBER_ONLY.test(word))
                      ? "name row above an all-number row"
                      : "other price-less content";
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
      }
    }
    const total = [...causes.values()].reduce((sum, count) => sum + count, 0);
    // CORD's preserved rows: 198 at `20e4459`, 162 here. The tender bucket empties completely (family 5
    // classifies those rows at rule 1), and 14 bare-integer rows leave through Q6's zero-total promotion.
    expect(total).toBe(162);
    expect(Object.fromEntries(causes)).toEqual({
      "priced row with no lettered name word": 64,
      "money prints as a bare 1–2 digit integer": 49,
      "other price-less content": 31,
      "name row above an all-number row": 12,
      "percent or modifier line": 4,
      "more than one price candidate": 2,
    });
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

  it("parses the first real receipt end to end, and still invents no item out of the header block", async () => {
    // SROIE reference OCR: identity block, column labels, one item row, charges, footer notice. This test
    // was written while parse() returned every amount unresolved; ticket 06 fills them, so it now checks
    // that the filling happens *and* that the header discipline 05 pinned still holds.
    const [fixture] = await devReceipts();
    const result = parse(fixture!.ocr as unknown as OcrResult);
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.name.trim().length).toBeGreaterThan(0);
      // §7's three quantity states and only those; §4's two price states and only those.
      expect(["explicit", "assumed", "unresolved"]).toContain(item.quantitySource);
      expect(["detected", "unresolved"]).toContain(item.priceSource);
      if (item.priceSource === "detected") expect(item.lineTotal).not.toBeNull();
    }
    expect(result.items.some((item) => /document no|gstin|table\s+\d/i.test(item.name))).toBe(false);
  });
});
