import { describe, expect, it } from "vitest";
import {
  chargeLabelOrderForTests,
  isAllCapsStandalone,
  isGroupedDigitIdentifier,
  matchesChargeLabel,
  matchesHeaderOrNoisePattern,
} from "./patterns.js";
import { ALL_CAPS_STANDALONE_MAX_LENGTH } from "./constants.js";

describe("charge-label dictionary (§5 'Label dictionary')", () => {
  it("matches longest-first so SUBTOTAL never resolves to TOTAL prematurely", () => {
    const lengths = chargeLabelOrderForTests.map((label) => label.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  it("recognises the two-part tax labels as one label rather than a product row", () => {
    for (const text of [
      "CGST 9.00",
      "SGST 9.00",
      "IGST 18.00",
      "SERVICE CHARGE 5.00",
      "SVC CHG 5.00",
      "SUBTOTAL 100.00",
      "SUB TOTAL 100.00",
      "GRAND TOTAL 120.00",
      "ROUND OFF -0.50",
      "DISCOUNT 10.00",
      "TIP 20.00",
      "PAJAK 10%",
      "SERVIS 5%",
      "DISKON 10%",
      "JUMLAH 10.000",
    ]) {
      expect(matchesChargeLabel(text)).toBe(true);
    }
  });

  it("is punctuation- and case-insensitive but never matches inside a word", () => {
    expect(matchesChargeLabel("gst*")).toBe(true);
    expect(matchesChargeLabel("Total:")).toBe(true);
    expect(matchesChargeLabel("VEGETABLE TOTALIZER")).toBe(false);
    expect(matchesChargeLabel("1 MAGGSTO 2")).toBe(false);
    expect(matchesChargeLabel("TAXI")).toBe(false);
  });

  it("leaves ordinary item names unlabelled", () => {
    for (const text of ["MIKA GORENG", "NASI PUTIH 12.000", "AYAM BAKAR", "ICE LATTE"]) {
      expect(matchesChargeLabel(text)).toBe(false);
    }
  });
});

describe("header and noise pattern families (DECISIONS/0008 P3)", () => {
  it("family 1 — column-label rows", () => {
    for (const row of ["QTY ITEM PRICE", "CODE/DESC PRICE DISC AMOUNT", "QTY RM RM", "SUB TOTAL TAX"]) {
      expect(matchesHeaderOrNoisePattern(row.split(" "))).toBe(true);
    }
  });

  it("family 2 — registration identifiers are label-anchored, never shape-only", () => {
    for (const row of ["GSTIN: 07AABCU96031R1Z", "TRN 123456789012", "SST NO : A1234", "BRN 99887766", "TAX ID 44332211"]) {
      expect(matchesHeaderOrNoisePattern(row.split(" "))).toBe(true);
    }
    // A bare registration shape inside an item row must not classify the row as noise.
    expect(matchesHeaderOrNoisePattern(["95569390", "MIKA", "GORENG"])).toBe(false);
  });

  it("family 3 — table furniture", () => {
    expect(matchesHeaderOrNoisePattern(["TABLE", "4"])).toBe(true);
    expect(matchesHeaderOrNoisePattern(["TABLE.", "12"])).toBe(true);
    expect(matchesHeaderOrNoisePattern(["TABLE", "4", "COVER", "4"])).toBe(true);
  });

  it("family 4 — grouped-digit identifiers, with money grouping protected", () => {
    expect(isGroupedDigitIdentifier("044-2356901")).toBe(true);
    expect(isGroupedDigitIdentifier("09/03/2018")).toBe(true);
    expect(isGroupedDigitIdentifier("(044) 235 6901")).toBe(true);
    // The money guard: these are formatted amounts, not identifiers (2,276 such words in dev).
    for (const amount of ["8.000", "16,500", "1.234.567", "1,23,456.78", "1,23,456", "9.00"]) {
      expect(isGroupedDigitIdentifier(amount)).toBe(false);
    }
    expect(isGroupedDigitIdentifier("95569390-40118")).toBe(false);
    expect(isGroupedDigitIdentifier("789117-W")).toBe(false);
    expect(isGroupedDigitIdentifier("25122018")).toBe(false);
  });
});


  it("suppresses a digit-only row but never a real item carrying a product code", () => {
    // Measured on dev: the date stamp is a phantom item, and `F/CASTELL 187057-75 ...` is a real one.
    expect(matchesHeaderOrNoisePattern(["09/03/2018", "21:28", "0001"])).toBe(true);
    expect(matchesHeaderOrNoisePattern(["F/CASTELL", "187057-75", "TACK-IT", "2", "SR", "12.00"])).toBe(false);
    expect(matchesHeaderOrNoisePattern(["TEL", "044-2356901"])).toBe(true);
  });

describe("all-caps standalone test (DECISIONS/0008 P2)", () => {
  const caps = (text: string) => isAllCapsStandalone(text.split(" "));

  it("flags short shout-caps rows, including those carrying digits and punctuation", () => {
    expect(caps("DESSERTS")).toBe(true);
    expect(caps("THANK YOU")).toBe(true);
    expect(caps("QTY R17")).toBe(true);
    expect(caps("TABLE 4")).toBe(true);
  });

  it("releases any row containing a lowercase letter", () => {
    expect(caps("Tanpa es")).toBe(false);
    expect(caps("Desserts")).toBe(false);
  });

  it("releases rows past the pinned length bound", () => {
    expect(caps("A".repeat(ALL_CAPS_STANDALONE_MAX_LENGTH))).toBe(true);
    expect(caps("A".repeat(ALL_CAPS_STANDALONE_MAX_LENGTH + 1))).toBe(false);
  });

  it("requires at least one uppercase letter, so digits and symbols alone are not a name", () => {
    expect(caps("1234")).toBe(false);
    expect(caps("***")).toBe(false);
    expect(caps("25/12/2018")).toBe(false);
  });
});
