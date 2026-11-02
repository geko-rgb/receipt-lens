import { describe, expect, it } from "vitest";
import { parseAmountToMinorUnits } from "./money.js";

// Seam S2 support: gold annotation amounts have to be integers before anything can
// compare them, and the same printed string means different things per locale
// profile. Every expectation below is a worked literal, not a recomputation.

describe("parseAmountToMinorUnits", () => {
  it("reads a plain decimal amount under the en profile", () => {
    expect(parseAmountToMinorUnits("193.00", "en")).toBe(19300);
  });

  it("reads lakh-style grouping under the en profile", () => {
    expect(parseAmountToMinorUnits("1,234.56", "en")).toBe(123456);
  });

  it("reads a dotted thousands separator under the id-ID profile", () => {
    expect(parseAmountToMinorUnits("23.000", "id-ID")).toBe(2300000);
  });

  it("reads a commaed thousands separator under the id-ID profile", () => {
    expect(parseAmountToMinorUnits("16,500", "id-ID")).toBe(1650000);
  });

  it("drops a currency prefix", () => {
    expect(parseAmountToMinorUnits("Rp 23.000", "id-ID")).toBe(2300000);
    expect(parseAmountToMinorUnits("RM117.90", "en")).toBe(11790);
  });

  it("keeps a printed sign, because round-off is signed", () => {
    expect(parseAmountToMinorUnits("-0.43", "en")).toBe(-43);
    expect(parseAmountToMinorUnits("+0.43", "en")).toBe(43);
  });

  it("refuses to read a three-digit fraction under en rather than inventing a value", () => {
    // 23.000 is 23000 rupiah under id-ID. Under en it could be 23.0 or 23000, and a
    // gold value that depends on a guess is worse than no gold value.
    expect(parseAmountToMinorUnits("23.000", "id-ID")).toBe(2300000);
    expect(() => parseAmountToMinorUnits("23.000", "en")).toThrowError(/not an amount/);
  });

  it("reads a dotted thousands group as a whole amount under id-ID", () => {
    expect(parseAmountToMinorUnits("1.234", "id-ID")).toBe(123400);
  });

  it("rejects malformed grouping and stray spaces instead of coercing them", () => {
    for (const input of ["", "abc", "1.2.3", "12,34,56", "1 2 3"]) {
      expect(() => parseAmountToMinorUnits(input, "en")).toThrowError(/not an amount/);
    }
  });
});
