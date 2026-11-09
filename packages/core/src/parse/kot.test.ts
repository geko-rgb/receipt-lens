import { describe, expect, it } from "vitest";
import { classifyRows } from "./classify.js";
import { parse } from "./index.js";
import {
  KOT_METADATA,
  KOT_PRODUCT,
  KOT_RECEIPT,
  RECEIPT_WITH_DIGITS_IN_NAMES,
} from "./kot-fixtures.js";
import { TABLE_RECEIPT } from "./table-fixtures.js";

/**
 * `next.md` issues 2 and 5 — the two receipts of the bug report, as regression pins.
 *
 * These are **fixture** tests: the OCR geometry is hand-authored from the printed layout, because receipt B
 * was never supplied as an image. Receipt A's own JPEG is exercised against the real model in
 * `playwright/receipt-fixtures.spec.ts`; nothing here claims image-level verification.
 */

describe("Receipt B — Restaurant KOT", () => {
  const parsed = parse(KOT_RECEIPT);

  it("reads the receipt's own metadata as metadata, not as products", () => {
    const classified = classifyRows(KOT_RECEIPT);
    const fields = classified.rows
      .filter((entry) => entry.classification === "metadata")
      .map((entry) => entry.metadataField);
    // The background receipt's `BILL NO … 998811` line is metadata too: it is a label at the start of a row.
    expect(fields).toEqual(["bill_number", "bill_number", "date", "time"]);
    expect(classified.rows.filter((entry) => entry.classification === "metadata").map((entry) => entry.row.text)).toContain(
      `Bill No: ${KOT_METADATA.billNumber}`
    );
    expect(classified.rows.find((entry) => entry.row.text === `Date: ${KOT_METADATA.date}`)?.metadataField).toBe("date");
    expect(classified.rows.find((entry) => entry.row.text === `Time: ${KOT_METADATA.time}`)?.metadataField).toBe("time");
  });

  it("yields exactly the one product the receipt printed", () => {
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.name).toBe(KOT_PRODUCT.name);
  });

  it("reads the quantity from the Qty column", () => {
    expect(parsed.items[0]!.qty).toBe(KOT_PRODUCT.qty);
    expect(parsed.items[0]!.quantitySource).toBe("explicit");
  });

  it("reads the rate from the Rate column", () => {
    expect(parsed.items[0]!.unitPrice).toBe(KOT_PRODUCT.unitPrice);
    expect(parsed.items[0]!.priceSource).toBe("detected");
  });

  it("reads the amount from the Amount column", () => {
    expect(parsed.items[0]!.lineTotal).toBe(KOT_PRODUCT.lineTotal);
  });

  it("validates quantity × rate against the amount, so no arithmetic warning is published", () => {
    expect(parsed.items[0]!.warnings).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("leaves nothing for the reviewer to exclude before locking", () => {
    expect(parsed.unclassifiedRows).toEqual([]);
  });

  it("reads the printed grand total", () => {
    expect(parsed.grandTotal).toBe(KOT_PRODUCT.lineTotal);
    expect(parsed.grandTotalSource).toBe("detected");
  });

  it("reads the header as structural text, not as an ambiguous row", () => {
    const header = classifyRows(KOT_RECEIPT).rows.find((entry) => entry.row.text === "Particulars Qty Rate Amount");
    expect(header?.classification).toBe("noise_header");
  });
});

describe("Receipt A — Saravana Bhavan (DECISIONS/0033's receipt, re-pinned)", () => {
  const parsed = parse(TABLE_RECEIPT);

  it("reads all four products with their quantity, rate and amount", () => {
    expect(parsed.items.map((item) => [item.name, item.qty, item.unitPrice, item.lineTotal])).toEqual([
      ["Coffee", 2, 3500, 7000],
      ["Vada", 2, 2500, 5000],
      ["Chappathi Empty", 2, 2400, 4800],
      ["Combo 2 Chapati / P.B. Masala", 2, 15300, 30600],
    ]);
  });

  it("keeps the 2 in `Combo 2 Chapati` in the description and takes the quantity from the Qty column", () => {
    const combo = parsed.items.find((item) => item.name.startsWith("Combo"));
    expect(combo?.name).toBe("Combo 2 Chapati / P.B. Masala");
    expect(combo?.qty).toBe(2);
  });

  it("reads CGST and SGST from the tax table, and the 474.00 grand total", () => {
    expect(parsed.taxes.map((tax) => [tax.label, tax.amount])).toEqual([
      ["CGST", 1129],
      ["SGST", 1129],
    ]);
    expect(parsed.grandTotal).toBe(47_400);
  });
});

describe("product names that contain numbers stay product names", () => {
  const parsed = parse(RECEIPT_WITH_DIGITS_IN_NAMES);

  it("keeps `7 Up 500ml` whole and takes its quantity from the column", () => {
    expect(parsed.items[0]).toMatchObject({ name: "7 Up 500ml", qty: 2, unitPrice: 2500, lineTotal: 5000 });
  });

  it("rebuilds a description that prints across two lines, in reading order", () => {
    expect(parsed.items[1]).toMatchObject({
      name: "Combo 2 Chapati / P.B. Masala",
      qty: 2,
      unitPrice: 15_300,
      lineTotal: 30_600,
    });
  });

  it("assigns each number to the column its header names", () => {
    // The same three numbers in the wrong columns would still be three numbers; this is the assignment pin.
    expect(parsed.items.map((item) => [item.qty, item.unitPrice, item.lineTotal])).toEqual([
      [2, 2500, 5000],
      [2, 15_300, 30_600],
    ]);
  });
});
