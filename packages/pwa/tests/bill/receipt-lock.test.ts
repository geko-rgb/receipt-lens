import { describe, expect, it } from "vitest";
import { parse, validate, type OcrLine, type OcrResult } from "@receipt-lens/core";

import type { BillDocument } from "../../src/lib/bill/document.js";
import { beginFrom, setUnclassifiedRowExcluded, type TransactionResult } from "../../src/lib/bill/transactions.js";

/**
 * `next.md` issue 4 and issue 6 items 12–14 — the locking consequences of DECISIONS/0034.
 *
 * The complaint: the bill could not be locked until every row the parse preserved had been ticked `Exclude`
 * by hand, even when those rows were the receipt's own `Bill No`, its column header or its `THANK YOU` footer.
 * These tests drive the **real parser** over an OCR-shaped fixture and then the **real bill validator**, so the
 * assertion is about the workflow the creator sees rather than about a hand-built `UnclassifiedRow[]`.
 */

const CREATED_AT = "2026-11-08T00:00:00.000Z";
const RIGHT = 660;

function ocrRow(id: string, y: number, entries: readonly [string, number, number][]): OcrLine {
  const words = entries.map(([text, x, width]) => ({
    text,
    box: { x, y, width, height: 10 },
    confidence: null,
  }));
  const left = Math.min(...words.map((word) => word.box.x));
  const right = Math.max(...words.map((word) => word.box.x + word.box.width));
  return { id, text: words.map((word) => word.text).join(" "), box: { x: left, y, width: right - left, height: 10 }, confidence: null, words };
}

function page(...lines: OcrLine[]): OcrResult {
  return { lines: [...lines], imageSize: { width: 720, height: 1280 }, provider: "fixture", version: "0-test" };
}

function metadata(label: string, value: string, y: number, id: string, width: number): OcrLine {
  return ocrRow(id, y, [
    [label, 40, 52],
    [value, RIGHT - width, width],
  ]);
}

const HEADER = ocrRow("h", 260, [
  ["Particulars", 40, 106],
  ["Qty", 420, 30],
  ["Rate", 500, 40],
  ["Amount", 596, 66],
]);

/** Receipt B as `next.md` describes it: metadata, one header, one product, one footer. */
const KOT_RECEIPT: OcrResult = page(
  ocrRow("t", 60, [["HOTEL", 60, 70], ["SAGAR", 140, 66]]),
  metadata("Bill No:", "210373", 100, "bill", 78),
  metadata("Date:", "05-10-26", 130, "date", 88),
  metadata("Time:", "12:01:58", 160, "time", 82),
  metadata("Table No:", "7", 190, "table", 12),
  HEADER,
  ocrRow("item", 320, [
    ["Pineapple", 40, 84],
    ["lime", 130, 38],
    ["3", 454, 10],
    ["25.00", 516, 40],
    ["75.00", 610, 50],
  ]),
  ocrRow("total", 420, [["Total", 40, 42], ["75.00", 610, 50]]),
  ocrRow("thanks", 470, [["THANK", 40, 44], ["YOU", 92, 30], ["VISIT", 130, 40], ["AGAIN", 178, 44]])
);

/**
 * A receipt with one genuinely unreadable candidate row: two amounts in the price column and a name, which the
 * parser refuses to resolve on its own (0008 P7 rule 2). That row — and only that row — must still block.
 */const UNREADABLE_RECEIPT: OcrResult = page(
  HEADER,
  ocrRow("good", 320, [
    ["Coffee", 40, 66],
    ["2", 454, 10],
    ["35.00", 516, 40],
    ["70.00", 610, 50],
  ]),
  ocrRow("bad", 380, [
    ["Mystery", 40, 76],
    ["item", 124, 34],
    ["50.00", 610, 40],
    ["41.00", 620, 40],
  ]),
  ocrRow("total", 460, [["Total", 40, 42], ["70.00", 610, 50]])
);

function begin(result: OcrResult): BillDocument {
  const parseResult = parse(result);
  return beginFrom(parseResult, validate(parseResult), {
    billId: "b1",
    createdAt: CREATED_AT,
    creatorName: "Creator",
  });
}

function lockingCodes(document: BillDocument): string[] {
  return document.billValidation.blockers.locking.map((entry) => entry.code);
}

function unclassifiedRefs(document: BillDocument): string[] {
  return (
    document.billValidation.blockers.locking.find((blocker) => blocker.code === "unclassified_rows_unreviewed")?.refs ?? []
  );
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected success, got ${result.reject.code}`);
  return result.document;
}

describe("issue 4 — metadata and structural text never block bill locking", () => {
  it("puts nothing in the review list for a receipt whose only extra text is its own metadata", () => {
    const document = begin(KOT_RECEIPT);
    expect(document.working.unclassifiedRows).toEqual([]);
    expect(lockingCodes(document)).not.toContain("unclassified_rows_unreviewed");
  });

  it("keeps the blockers that are about real work — a missing grand total still blocks", () => {
    // Item 14 of issue 6: the fix may not weaken the existing blockers while removing the metadata noise. A
    // receipt whose printed total the parse could not read is the cheapest real one to build from the same page.
    const noTotal = page(
      HEADER,
      ocrRow("item", 320, [
        ["Pineapple", 40, 84],
        ["lime", 130, 38],
        ["3", 454, 10],
        ["25.00", 516, 40],
        ["75.00", 610, 50],
      ])
    );
    const document = begin(noTotal);
    expect(document.working.unclassifiedRows).toEqual([]);
    expect(lockingCodes(document)).toContain("grand_total_missing");
  });
});

describe("issue 4 — an unreadable candidate product still blocks", () => {
  it("preserves the reservation row and blocks on it", () => {
    const document = begin(UNREADABLE_RECEIPT);
    const rows = document.working.unclassifiedRows;
    expect(rows.map((row) => row.text)).toContain("Mystery item 50.00 41.00");
    expect(unclassifiedRefs(document)).toEqual(rows.map((row) => row.id));
  });

  it("clears the blocker when the creator excludes the row explicitly", () => {
    const document = begin(UNREADABLE_RECEIPT);
    const [row] = document.working.unclassifiedRows;
    const excluded = ok(setUnclassifiedRowExcluded(document, row!.id, true));
    // Item 12: exclusion is still how a row stops blocking, and the row stays visible.
    expect(excluded.working.unclassifiedRows.map((entry) => entry.id)).toEqual([row!.id]);
    expect(unclassifiedRefs(excluded)).toEqual([]);
  });
});
