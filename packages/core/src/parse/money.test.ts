import { describe, expect, it } from "vitest";
import { inferProfile, readMoney, readRate, type NumberProfile } from "./money.js";

/**
 * DECISIONS/0010 Q2 and Q4, pinned as behaviour rather than prose. The lakh grammar, the refusal to
 * guess past two decimal digits, and the property that makes profile inference safe: two profiles never
 * read the same token to two different values, so a misvote can only omit.
 */

const PROFILES: readonly NumberProfile[] = ["id-ID", "en", "en-IN"];

function paise(token: string, profile: NumberProfile): number | null {
  return readMoney(token, profile).paise;
}

describe("the three number-format profiles (§5, DECISIONS/0010 Q2)", () => {
  it("reads Indian lakh grouping exactly as pinned", () => {
    expect(paise("1,23,456.78", "en-IN")).toBe(12345678);
    expect(paise("1,00,000", "en-IN")).toBe(10000000);
    expect(paise("12,34,567.00", "en-IN")).toBe(123456700);
    expect(paise("12,34,56,789", "en-IN")).toBe(12345678900);
  });

  it("rejects malformed grouping rather than re-reading it", () => {
    for (const token of ["1,23,4", "1,2,3", "1,234,56", "12,34,567,89"]) {
      expect(paise(token, "en-IN")).toBeNull();
    }
  });

  it("accepts western grouping under every en-family profile with the same value", () => {
    for (const token of ["1,234", "12,345", "1,234,567"]) {
      const western = paise(token, "en");
      expect(western).not.toBeNull();
      expect(paise(token, "en-IN")).toBe(western);
    }
  });

  it("refuses a fraction longer than two digits instead of rounding into paise", () => {
    expect(paise("1,23,456.789", "en-IN")).toBeNull();
    expect(paise("2.5625", "en-IN")).toBeNull();
    expect(paise("30.7400", "en")).toBeNull();
    expect(paise("2.50", "en-IN")).toBe(250);
    expect(paise("2.5", "en-IN")).toBe(250);
  });

  it("en-IN is a strict superset of en, token for token", () => {
    const dev = [
      "16,500", "8.000", "1,23,456.78", "12.5", "2.5625", ".50", "1,234,567", "1,00,000", "0.00",
      "224908", "12,34,56,789", "1,23,4", "30.74", "-5.59", "1.00", "95569390", "1,2,3",
    ];
    for (const token of dev) {
      const underEn = paise(token, "en");
      if (underEn === null) continue;
      expect(paise(token, "en-IN")).toBe(underEn);
    }
    expect(paise("1,23,456", "en")).toBeNull();
    expect(paise("1,23,456", "en-IN")).toBe(12345600);
  });

  it("id-ID groups on the dot, decimals on the comma, and prints comma-thousands", () => {
    expect(paise("12.500", "id-ID")).toBe(1250000);
    expect(paise("8.000", "id-ID")).toBe(800000);
    expect(paise("12,5", "id-ID")).toBe(1250);
    expect(paise("16,500", "id-ID")).toBe(1650000);
    expect(paise("1.234.567", "id-ID")).toBe(123456700);
    expect(paise("1,23,456", "id-ID")).toBeNull();
    expect(paise("86.00", "id-ID")).toBeNull();
    expect(paise("224908.00", "id-ID")).toBeNull();
  });

  it("refuses a comma decimal glued to comma grouping (12,500,5 is not an Indonesian amount)", () => {
    expect(paise("12,500,5", "id-ID")).toBeNull();
    expect(paise("12.500,5", "id-ID")).toBe(1250050);
  });
});

describe("currency tokens, signs and printed markers (§5, Q8)", () => {
  it("strips the profile's currency token, including one glued inside the word", () => {
    expect(paise("Rp 9,736", "id-ID")).toBe(973600);
    expect(paise("Rp20.446", "id-ID")).toBe(2044600);
    expect(paise("₹1,23,456.78", "en-IN")).toBe(12345678);
    expect(paise("Rs. 4,500.00", "en-IN")).toBe(450000);
    expect(paise("INR 90", "en-IN")).toBe(9000);
    expect(paise("$8.20", "en-IN")).toBe(820);
  });

  it("keeps a printed sign, which is what round-off needs and the two gold sign misses lacked", () => {
    expect(paise("-7,800", "id-ID")).toBe(-780000);
    expect(paise("-Rp 34,363", "id-ID")).toBe(-3436300);
    expect(paise("(500)", "en-IN")).toBe(-50000);
    expect(paise("+9.00", "en-IN")).toBe(900);
    expect(paise(":9,000", "id-ID")).toBe(900000);
  });

  it("marks an @-prefixed amount as a printed unit price without changing its value", () => {
    expect(readMoney("@28,000", "id-ID")).toMatchObject({ paise: 2800000, unitPriceMarker: true });
    expect(readMoney("@ 12.000", "id-ID")?.unitPriceMarker).toBe(true);
    expect(readMoney("24.000", "id-ID")?.unitPriceMarker).toBe(false);
  });

  it("flags a percent token so a rate is never counted as an amount", () => {
    expect(readMoney("15%", "id-ID").percent).toBe(true);
    expect(readMoney("100,000", "id-ID").percent).toBe(false);
    expect(readRate("6%", "en-IN")).toBe(600);
    expect(readRate("12.5%", "en-IN")).toBe(1250);
    expect(readRate("40.000%", "id-ID")).toBeNull();
    expect(readRate("9,736", "id-ID")).toBeNull();
  });

  it("refuses tokens that are not numbers at all", () => {
    for (const token of ["", "x1", "25/12/2018", "95569390-40118", "1,234.567.8", "-", "0.5500"]) {
      for (const profile of PROFILES) expect(paise(token, profile)).toBeNull();
    }
  });

  it("refuses a value that cannot be a safe integer of paise", () => {
    expect(paise("9007199254740991", "en-IN")).toBeNull();
    expect(paise("90071992547409.91", "en-IN")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("profile inference (DECISIONS/0010 Q4)", () => {
  it("selects id-ID only on evidence the en family cannot read", () => {
    expect(inferProfile(["16,500", "1,234", "100"])).toBe("en-IN");
    expect(inferProfile(["8.000", "23.000", "1.234.567"])).toBe("id-ID");
    expect(inferProfile(["2.50", "16.10", "86.00"])).toBe("en-IN");
  });

  it("defaults to en-IN, the app's profile, when the document says nothing", () => {
    expect(inferProfile([])).toBe("en-IN");
    expect(inferProfile(["Total", "100"])).toBe("en-IN");
  });

  it("never lets two profiles read one token to two different values", () => {
    const tokens = [
      "16,500", "1,234", "12,345", "1,234,567", "100", "8.000", "23.000", "1.234.567", "12,5",
      "12.5", "2.50", "0.00", ".50", "1,23,456.78", "1,00,000", "95569390", "2018", "118",
    ];
    for (const token of tokens) {
      const id = paise(token, "id-ID");
      const india = paise(token, "en-IN");
      if (id === null || india === null) continue;
      expect(india).toBe(id);
    }
  });
});
