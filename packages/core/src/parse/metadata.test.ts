import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "../ocr/types.js";
import { classifyRows } from "./classify.js";
import { ocrRow } from "./fixtures.js";
import { parse } from "./index.js";
import { isMetadataRow, matchesHeaderOrNoisePattern, readMetadata } from "./patterns.js";
import { KOT_RECEIPT } from "./kot-fixtures.js";

/**
 * DECISIONS/0034 M1/M2 — the receipt's own metadata and its footer text, `next.md` issues 1 and 4.
 *
 * The bug being pinned: `Bill No: 210373` printed its number at the right margin, the price column is inferred
 * from right edges, and the row was sold as a product for ₹2,10,373.00 with an assumed quantity of 1. A
 * keyword filter would not have stopped it either — the row carries letters and money in equal measure — so
 * what is pinned here is the contextual rule: the label must open the row, and the value behind it decides
 * whether the row is metadata at all.
 */

/** A 720×1280 page, so the parser's page-relative bands are the ones it really uses. */
function page(...rows: OcrLine[]): OcrResult {
  return { lines: [...rows], imageSize: { width: 720, height: 1280 }, provider: "fixture", version: "0-test" };
}

/** The right edge every value on this page aligns to: one price column, shared by metadata and items. */
const RIGHT = 660;

/** A metadata line: its label at the left margin, its value in the price column. */
function metadataRow(label: string, value: string, y: number, id: string, valueWidth?: number) {
  const width = valueWidth ?? Math.max(40, value.length * 12);
  return ocrRow(id, y, [
    [label, 40, 52],
    [value, RIGHT - width, width],
  ]);
}

const TITLE = ocrRow("t", 60, [["HOTEL", 60, 70], ["SAGAR", 140, 66]]);
const BILL = metadataRow("Bill No:", "210373", 100, "bill", 78);
const DATE = metadataRow("Date:", "05-10-26", 130, "date", 88);
const TIME = metadataRow("Time:", "12:01:58", 160, "time", 82);
const TABLE = metadataRow("Table No:", "7", 190, "table", 12);
const KOT = metadataRow("KOT", "31", 220, "kot", 24);
const GSTIN = metadataRow("GSTIN:", "33AABCU9603R1Z5", 250, "gstin", 150);
const PHONE = metadataRow("Phone:", "9840012345", 280, "phone", 104);
const CASHIER = metadataRow("Cashier:", "Ramesh", 310, "cashier", 72);
const WAITER = metadataRow("Waiter", "Suresh", 340, "waiter", 66);
const TABLE_HEADER = ocrRow("h", 380, [
  ["Particulars", 40, 106],
  ["Qty", 420, 30],
  ["Rate", 500, 40],
  ["Amount", 596, 66],
]);
const ITEM = ocrRow("item", 410, [
  ["Pineapple", 40, 84],
  ["lime", 130, 38],
  ["3", 454, 10],
  ["25.00", 516, 40],
  ["75.00", 610, 50],
]);
const TOTAL = ocrRow("total", 470, [["Total", 40, 42], ["75.00", 610, 50]]);

const EVERY_METADATA: OcrResult = page(
  TITLE,
  BILL,
  DATE,
  TIME,
  TABLE,
  KOT,
  GSTIN,
  PHONE,
  CASHIER,
  WAITER,
  TABLE_HEADER,
  ITEM,
  TOTAL
);

describe("receipt metadata is recognised by what it is, not by having numbers", () => {
  it("reads each label the receipt prints, and the value behind it", () => {
    expect(readMetadata(["Bill", "No:", "210373"])).toEqual({
      field: "bill_number",
      label: "Bill No:",
      value: ["210373"],
    });
    // The bug report's own OCR: the label arrives as one token with no space.
    expect(readMetadata(["BillNo", "210373"])?.field).toBe("bill_number");
    expect(readMetadata(["Date:", "05-10-26"])?.field).toBe("date");
    expect(readMetadata(["Time:", "12:01:58"])?.field).toBe("time");
    expect(readMetadata(["KOT", "31"])?.field).toBe("kot");
    expect(readMetadata(["Table", "No:", "7"])?.field).toBe("table");
    expect(readMetadata(["GSTIN:", "33AABCU9603R1Z5"])?.field).toBe("gstin");
    expect(readMetadata(["Cashier:", "Ramesh"])?.field).toBe("cashier");
  });

  it("reads the staff and sales-type labels a counter prints, without eating a product", () => {
    // Owner decision, 2026-11-10 (DECISIONS/0034 amendment). The Saravana photograph prints both of these below its
    // totals, where they were preserved as unreadable rows: `Sman :-3` is a staff line and `Sales Type ： DINING` is
    // the receipt's own metadata. Neither may become a product, and neither may swallow one:
    expect(readMetadata(["Sman", ":-3"])).toEqual({ field: "waiter", label: "Sman", value: [":-3"] });
    // The numeric suffix is the *value*, never part of the label match — `Salesman - 2` and `Captain 4` read the
    // same way, and a name after the label is still staff metadata (`alphaValue` on the label, not on the suffix).
    expect(readMetadata(["Salesman", "-", "2"])?.field).toBe("waiter");
    expect(readMetadata(["Captain", "4"])?.field).toBe("waiter");
    expect(readMetadata(["Steward:", "Ramesh"])?.field).toBe("waiter");
    expect(readMetadata(["Sales", "Type", "：", "DINING"])).toEqual({
      field: "sales_type",
      label: "Sales Type",
      value: ["：", "DINING"],
    });
    expect(readMetadata(["Sale", "type:", "Dine-in"])?.field).toBe("sales_type");
    // `Steward` keeps the family's existing `alphaValue` (a name after it is staff, exactly like `Cashier:` and
    // `Waiter:`), which is why only the three new words are asserted narrow here.
    expect(readMetadata(["Steward", "Ramesh"])?.field).toBe("waiter");
    // Narrow on purpose: without a separator or a letters-free value, these three words are product names.
    for (const words of [
      ["Sman", "special", "180.00"],
      ["Salesman", "combo", "220.00"],
      ["Captain", "Fries", "200.00"],
    ]) {
      expect(isMetadataRow(words), words.join(" ")).toBe(false);
    }
  });

  it("refuses the rows a product could legitimately open with", () => {
    for (const words of [
      ["Table", "water", "20.00"],
      ["Date", "pudding", "120.00"],
      ["Time", "passes", "30.00"],
      ["Pineapple", "lime", "3", "25.00"],
      ["Combo", "2", "Chapati"],
    ]) {
      expect(isMetadataRow(words), words.join(" ")).toBe(false);
    }
  });

  it("makes every metadata row on a page metadata, never an item", () => {
    const classified = classifyRows(EVERY_METADATA);
    expect(classified.rows.filter((entry) => entry.classification === "metadata").map((entry) => entry.metadataField)).toEqual([
      "bill_number",
      "date",
      "time",
      "table",
      "kot",
      "gstin",
      "phone",
      "cashier",
      "waiter",
    ]);
  });

  it("keeps metadata out of the item list and out of the review rows", () => {
    const parsed = parse(EVERY_METADATA);
    expect(parsed.items.map((item) => item.name)).toEqual(["Pineapple lime"]);
    expect(parsed.items[0]!.qty).toBe(3);
    expect(parsed.unclassifiedRows).toEqual([]);
    // Nothing that blocked bill locking before this stage survives as a review row.
    const texts = parsed.unclassifiedRows.map((row) => row.text).join(" ");
    for (const label of ["Bill No", "Date", "Time", "Table No", "KOT", "GSTIN", "Phone", "Cashier", "Waiter"]) {
      expect(texts).not.toContain(label);
    }
  });

  it("never classifies a metadata row as a header or as an identifier-only row", () => {
    // The two older families answered `false` for these rows, which is how they became products: the row has
    // letters, so it is not identifier-only, and it names no column, so it is not a header.
    for (const words of [["Bill", "No:", "210373"], ["Date:", "05-10-26"], ["KOT", "31"]]) {
      expect(matchesHeaderOrNoisePattern(words)).toBe(false);
      expect(isMetadataRow(words)).toBe(true);
    }
  });
});

describe("footer instructions are not purchases and do not block locking", () => {
  const header = ocrRow("fh", 240, [["ITEM", 40, 40], ["PRICE", 596, 56]]);
  const item = ocrRow("i1", 300, [["MIKA", 40, 20], ["GORENG", 74, 32], ["8.00", 620, 40]]);
  const total = ocrRow("ft", 340, [["Total", 40, 42], ["8.00", 620, 40]]);
  const thanks = ocrRow("f1", 380, [["THANK", 40, 44], ["YOU", 92, 30], ["VISIT", 130, 40], ["AGAIN", 178, 44]]);
  const powered = ocrRow("f2", 410, [["Powered", 40, 52], ["by", 96, 20], ["Receipt", 120, 52], ["Lens", 176, 34]]);

  it("classifies a footer phrase as ignored, with its reason kept", () => {
    const classified = classifyRows(page(header, item, total, thanks, powered));
    const footer = classified.rows.filter((entry) => entry.classification === "ignored");
    expect(footer.map((entry) => entry.ignoredReason)).toEqual(["footer_instruction", "footer_instruction"]);
  });

  it("does not publish ignored rows as unclassified, and does not make an item of them", () => {
    const parsed = parse(page(header, item, total, thanks, powered));
    expect(parsed.items.map((entry) => entry.name)).toEqual(["MIKA GORENG"]);
    expect(parsed.unclassifiedRows).toEqual([]);
  });

  it("refuses a footer phrase that carries a number, because a number is never decorative", () => {
    const priced = ocrRow("f3", 380, [["THANK", 40, 44], ["YOU", 92, 30], ["200.00", 620, 40]]);
    const parsed = parse(page(header, item, total, priced));
    expect(parsed.unclassifiedRows.map((row) => row.text)).toEqual(["THANK YOU 200.00"]);
  });

  it("leaves a price-less line that is not a known footer phrase preserved for review", () => {
    // The rule must not become "discard everything after the last price": a missed product row is exactly the
    // shape this row has, and only a phrase the receipt prints as an instruction may be ignored.
    const missed = ocrRow("x1", 380, [["Extra", 40, 30], ["cheese", 74, 34], ["topping", 112, 40]]);
    const parsed = parse(page(header, item, total, missed));
    expect(parsed.unclassifiedRows.map((row) => row.text)).toEqual(["Extra cheese topping"]);
  });
});

describe("the KOT receipt's metadata does not become a purchase", () => {
  it("extracts exactly one product from it", () => {
    const parsed = parse(KOT_RECEIPT);
    expect(parsed.items.map((item) => item.name)).toEqual(["Pineapple lime"]);
    expect(parsed.grandTotal).toBe(7500);
  });

  it("does not invent a ₹2,10,373.00 item out of the bill number", () => {
    const parsed = parse(KOT_RECEIPT);
    expect(parsed.items.some((item) => item.lineTotal === 21_037_300)).toBe(false);
    expect(parsed.items.some((item) => /bill\s*no/i.test(item.name))).toBe(false);
  });

  it("does not leave the header or the footer in the review list", () => {
    const parsed = parse(KOT_RECEIPT);
    expect(parsed.unclassifiedRows).toEqual([]);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual([]);
  });
});
