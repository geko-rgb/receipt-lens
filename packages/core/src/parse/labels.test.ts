import { describe, expect, it } from "vitest";
import { chooseCategory, hasInclusionCue, matchLabels, overlappingEqualLengthPairs } from "./labels.js";

/**
 * DECISIONS/0010 Q3: longest label first, leftmost on a genuine tie, a matched span consumed once. 05
 * used the dictionary as a boolean; typing charges needs to know *which* label matched, so the tie-breaks
 * §5 left as prose are pinned here.
 */

const categoriesOf = (text: string) => matchLabels(text).map((match) => `${match.label}:${match.category}`);

describe("longest-first matching (§5 line 379)", () => {
  it("never reads SUBTOTAL as TOTAL", () => {
    expect(categoriesOf("SUBTOTAL 108.00")).toEqual(["subtotal:subtotal"]);
    expect(categoriesOf("SUB-TOTAL 108.00")).toEqual(["sub total:subtotal"]);
    expect(categoriesOf("TOTAL 118.00")).toEqual(["total:grandTotal"]);
  });

  it("never lets a two-word tax label fragment into a phantom item", () => {
    expect(categoriesOf("SERVICE CHARGE 5.90")).toEqual(["service charge:service"]);
    expect(categoriesOf("ROUND OFF 0.20")).toEqual(["round off:roundOff"]);
    expect(categoriesOf("GRAND TOTAL 118.00")).toEqual(["grand total:grandTotal"]);
    // The longer label wins and its span is consumed, so no leftover word is available to match again.
    expect(categoriesOf("SVC CHG 6.00")).toEqual(["svc chg:service"]);
  });

  it("keeps every distinct label a row carries, in document order", () => {
    expect(categoriesOf("CGST 2.50 SGST 2.50")).toEqual(["cgst:tax", "sgst:tax"]);
    expect(categoriesOf("TOTAL ITEMS 2 TAX 0.85")).toEqual(["total:grandTotal", "tax:tax"]);
  });

  it("matches words, not letter runs inside a name", () => {
    expect(matchLabels("MULTIPURPOSE BAG")).toEqual([]);
    expect(matchLabels("SCALLOP POTATO")).toEqual([]);
    expect(categoriesOf("ROUND TABLE")).toEqual(["round:roundOff"]);
  });
});

describe("the tie-breaks (§5's own cases and the two it never mentions)", () => {
  it("resolves a same-index conflict by length, which is §5's rule", () => {
    // `total` is also a prefix of `grand total`; at the same index the longer entry is the only match.
    expect(categoriesOf("GRAND TOTAL 1.00")).toEqual(["grand total:grandTotal"]);
  });

  it("has no equal-length overlap for the tie-break to resolve, proved against the matcher", () => {
    // `cess`/`sgst` and `vat`/`tax` do share letters, so this is not a claim about the data: whole-word
    // matching means a matched span always ends on a space, and an overlapping equal-length match would
    // need a letter in that same position. The witness strings are built and matched to check it.
    expect(overlappingEqualLengthPairs()).toEqual([]);
  });

  it("prefers the tax over the aggregate it is named with, unless the text is an inclusion cue", () => {
    for (const row of ["TOTAL GST : 0.00", "TAX TOTAL: 0.85", "TOTAL TAX : 0.28", "TOTAL TAX 5.00"]) {
      expect(chooseCategory(matchLabels(row), hasInclusionCue(row))).toBe("tax");
    }
    for (const row of ["TOTAL SALES (EXCLUDING GST) : 80.91", "TOTAL INCL. OF GST 15.90", "TAKEOUT TOTAL (INCL GST) 26.60"]) {
      expect(chooseCategory(matchLabels(row), hasInclusionCue(row))).toBe("grandTotal");
    }
  });

  it("reports the CORD-bucket labels as the same charge families", () => {
    expect(categoriesOf("PAJAK 10% 18.182")).toEqual(["pajak:tax"]);
    expect(categoriesOf("JUMLAH 45.000")).toEqual(["jumlah:subtotal"]);
    expect(categoriesOf("DISKON 5.000")).toEqual(["diskon:discount"]);
    expect(categoriesOf("SERVIS 2.000")).toEqual(["servis:service"]);
  });
});
