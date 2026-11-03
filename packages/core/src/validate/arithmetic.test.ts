import { describe, expect, it } from "vitest";
import type { ParsedItem, ParseResult, ParseWarning, ParsedTax, ParsedOtherCharge } from "../types.js";
import { computedBase, validateArithmetic } from "./arithmetic.js";

/**
 * The conditional table in DECISIONS/0011 V1, tested row by row against authored `ParseResult`s.
 * Authored rather than fixture-derived because dev carries no confidence scores at all (V0.1) and its
 * receipts cannot be asked to be in two operand states at once.
 */

function item(id: string, over: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id,
    name: `item ${id}`,
    qty: 1,
    quantitySource: "explicit",
    unitPrice: 1000,
    priceSource: "detected",
    lineTotal: 1000,
    confidence: 0.9,
    sourceLineIds: [`l${id}`],
    warnings: [],
    ...over,
  };
}

function tax(label: string, over: Partial<ParsedTax> = {}): ParsedTax {
  return { label, amount: 500, source: "detected", ...over };
}

function other(over: Partial<ParsedOtherCharge> = {}): ParsedOtherCharge {
  return { label: "misc", amount: 200, type: "other", sign: "add", source: "detected" as const, ...over };
}

function result(over: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [],
    unclassifiedRows: [],
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: null,
    subtotalSource: "unresolved",
    grandTotal: null,
    grandTotalSource: "unresolved",
    warnings: [],
    ...over,
  };
}

const codes = (parsed: ParseResult, strict = true) => validateArithmetic(parsed, strict).map((f) => f.code);

describe("V1 rows 2–6 — the item-sum branch is conditional on a printed subtotal", () => {
  it("row 2: no printed subtotal means no comparison, so nothing is emitted even with full coverage", () => {
    // 137 of 208 itemized dev receipts are in this state. "Never falsely flagged" is the ticket's box.
    const parsed = result({ subtotal: null, items: [item("i1"), item("i2", { lineTotal: 99999 })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 2: a missing subtotal does not become items_may_be_missing either", () => {
    const parsed = result({ subtotal: null, grandTotal: 3000, items: [item("i1"), item("i2", { lineTotal: null })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 3: incomplete coverage is a may-be-missing verdict, never a contradiction", () => {
    const parsed = result({
      subtotal: 2000,
      items: [item("i1"), item("i2", { lineTotal: null, unitPrice: null, priceSource: "unresolved" })],
    });
    const findings = validateArithmetic(parsed, true);
    expect(findings.map((f) => [f.code, f.severity])).toEqual([["items_may_be_missing", "minor"]]);
    expect(findings[0]!.itemRefs).toEqual(["i2"]);
    expect(codes(parsed).includes("arithmetic_item_sum")).toBe(false);
  });

  it("row 4: sum over the subtotal is a critical contradiction — missing rows cannot explain it", () => {
    const parsed = result({ subtotal: 1500, items: [item("i1"), item("i2", { lineTotal: 2000 })] });
    const findings = validateArithmetic(parsed, true);
    expect(findings.map((f) => [f.code, f.severity, f.scope])).toEqual([["arithmetic_item_sum", "critical", "receipt"]]);
    expect(findings[0]!.message).toContain("(+1500)");
  });

  it("row 5: sum under the subtotal is extraction incompleteness, not a contradiction", () => {
    const parsed = result({ subtotal: 5000, items: [item("i1"), item("i2", { lineTotal: 2000 })] });
    expect(validateArithmetic(parsed, true).map((f) => [f.code, f.severity])).toEqual([
      ["items_may_be_missing", "minor"],
    ]);
  });

  it("row 6: an exact reconciliation emits nothing", () => {
    const parsed = result({ subtotal: 3000, items: [item("i1"), item("i2", { lineTotal: 2000 })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 1: an itemless result is the zero_items finding's business, not arithmetic's", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1000, items: [] });
    expect(codes(parsed)).toEqual([]);
  });
});

describe("V1 rows 7–13 — the total branch needs the subtotal and every charge's semantics", () => {
  it("row 7: no printed grand total leaves nothing to reconcile against", () => {
    const parsed = result({ subtotal: 1000, grandTotal: null, taxes: [tax("gst", { amount: 999 })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 8: a missing subtotal blocks arithmetic_total rather than substituting the item sum", () => {
    const parsed = result({ subtotal: null, grandTotal: 5000, items: [item("i1", { lineTotal: 4000 })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 9: a tax with no resolved amount blocks the check — it is not a zero", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1500, taxes: [tax("gst", { amount: null })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 9: an other charge with unknown sign blocks the check", () => {
    const parsed = result({
      subtotal: 1000,
      grandTotal: 1500,
      otherCharges: [other({ amount: 500, sign: "unknown" })],
    });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 9: an other charge with no amount blocks the check", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1500, otherCharges: [other({ amount: null })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 13: subtotal + charges reconciling exactly emits nothing", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1500, taxes: [tax("gst")] });
    expect(codes(parsed)).toEqual([]);
  });

  it("row 12: no printed round-off and a material mismatch is critical", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 2500, taxes: [tax("gst", { amount: 100 })] });
    const findings = validateArithmetic(parsed, true);
    expect(findings.map((f) => [f.code, f.severity, f.scope])).toEqual([["arithmetic_total", "critical", "receipt"]]);
    expect(findings[0]!.chargeRefs).toContain("subtotal");
    expect(findings[0]!.chargeRefs).toContain("grandTotal");
    expect(findings[0]!.chargeRefs).toContain("t1");
  });

  it("one paise off is material: the band belongs to a printed round-off, not to the total", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1501, taxes: [tax("gst")] });
    expect(codes(parsed)).toEqual(["arithmetic_total"]);
  });
});

describe("V4 — included and unknown-sign are different exclusions and must not be merged", () => {
  it("a tax marked included is not added, and the check still runs on the remaining operands", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1000, taxes: [tax("gst", { included: true })] });
    expect(computedBase(parsed)).toBe(1000);
    expect(codes(parsed)).toEqual([]);
  });

  it("an included charge is display-only: adding it would double-count what is already inside the prices", () => {
    expect(computedBase(result({ subtotal: 1000, taxes: [tax("gst")] }))).toBe(1500);
    expect(computedBase(result({ subtotal: 1000, taxes: [tax("gst", { included: true })] }))).toBe(1000);
  });

  it("discount subtracts, service charge and tip add, and roundOff is not in the base", () => {
    const parsed = result({ subtotal: 1000, taxes: [tax("gst", { amount: 100 })], serviceCharge: 50, tip: 25, discount: 75, roundOff: 5 });
    expect(computedBase(parsed)).toBe(1100);
  });

  it("an other charge with sign subtract subtracts", () => {
    const parsed = result({ subtotal: 1000, otherCharges: [other({ amount: 200, sign: "subtract" })] });
    expect(computedBase(parsed)).toBe(800);
  });
});

describe("V2 — the printed round-off band", () => {
  it("row 10: a round-off within 2 paise of expected and at most 100 paise passes as information", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1098, taxes: [tax("gst", { amount: 100 })], roundOff: -2 });
    const findings = validateArithmetic(parsed, true);
    expect(findings.map((f) => [f.code, f.severity])).toEqual([["round_off_adjusted", "minor"]]);
    expect(findings[0]!.chargeRefs).toContain("roundOff");
    expect(codes(parsed).includes("arithmetic_total")).toBe(false);
  });

  it("a round-off 5 paise off the expected value is a critical contradiction, not a tolerance", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1100, taxes: [tax("gst", { amount: 100 })], roundOff: 5 });
    expect(codes(parsed)).toEqual(["arithmetic_total"]);
  });

  it("a round-off of exactly the magnitude cap is inside the band", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1200, taxes: [tax("gst", { amount: 100 })], roundOff: 100 });
    expect(codes(parsed)).toEqual(["round_off_adjusted"]);
  });

  it("a round-off beyond ₹1.00 in magnitude is critical however well it matches", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1300, taxes: [tax("gst", { amount: 100 })], roundOff: 200 });
    expect(codes(parsed)).toEqual(["arithmetic_total"]);
  });

  it("row 11: a printed round-off of zero that reconciles nothing is still checked", () => {
    const parsed = result({ subtotal: 1000, grandTotal: 1000, roundOff: 0 });
    expect(codes(parsed)).toEqual(["round_off_adjusted"]);
  });
});

describe("V8 — advisory semantics", () => {
  const contradictory = () =>
    result({ subtotal: 1500, grandTotal: 1000, items: [item("i1"), item("i2", { lineTotal: 2000 })] });

  it("strict mode: findings carry no advisory flag at all", () => {
    expect(validateArithmetic(contradictory(), true).every((f) => f.advisory === undefined)).toBe(true);
  });

  it("relaxed mode: the checks still run and every arithmetic finding says so", () => {
    const findings = validateArithmetic(contradictory(), false);
    expect(findings.map((f) => f.code)).toEqual(["arithmetic_item_sum", "arithmetic_total"]);
    expect(findings.every((f) => f.advisory === true)).toBe(true);
  });

  it("relaxed mode does not change severity — it changes provenance", () => {
    const strict = validateArithmetic(contradictory(), true);
    const relaxed = validateArithmetic(contradictory(), false);
    expect(relaxed.map((f) => f.severity)).toEqual(strict.map((f) => f.severity));
  });

  it("a may-be-missing verdict is advisory too when relaxed: it was produced by an arithmetic branch", () => {
    const parsed = result({ subtotal: 900, items: [item("i1", { lineTotal: null, unitPrice: null, priceSource: "unresolved" })] });
    expect(validateArithmetic(parsed, false).every((f) => f.advisory === true)).toBe(true);
  });
});

describe("exactness and scale", () => {
  it("a base that cannot be a safe integer is not compared at all", () => {
    const parsed = result({ subtotal: Number.MAX_SAFE_INTEGER, grandTotal: 1000, taxes: [tax("gst", { amount: 5 })] });
    expect(computedBase(parsed)).toBeNull();
    expect(codes(parsed)).toEqual([]);
  });

  it("lakhs of paise add exactly — no binary float touches this comparison", () => {
    const parsed = result({ subtotal: 12345678901, grandTotal: 12345678901, items: [item("i1", { lineTotal: 12345678901 })] });
    expect(codes(parsed)).toEqual([]);
  });

  it("validate() does not mutate the ParseResult it is given", () => {
    const parsed = result({ subtotal: 1500, items: [item("i1"), item("i2", { lineTotal: 2000 })] });
    const before = JSON.stringify(parsed);
    validateArithmetic(parsed, true);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("a warning array is not fabricated into the returned result", () => {
    const warnings: ParseWarning[] = [];
    const parsed = result({ subtotal: 1000, grandTotal: 1000, warnings });
    expect(validateArithmetic(parsed, true)).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
