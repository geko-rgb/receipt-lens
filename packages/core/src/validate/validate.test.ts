import { describe, expect, it } from "vitest";
import type { ParsedItem, ParseResult, ParseValidationResult, ParseWarning, ValidateOptions } from "../types.js";
import { validate } from "./index.js";

/**
 * `validate()` as the public boundary: the behaviours §4 and §6 state about the whole result, tested
 * against authored `ParseResult`s. The conditional arithmetic graph is `arithmetic.test.ts`, the floors
 * are `confidence.test.ts`; this file is about emission, addressing, caps and the options contract.
 */

const STRICT: ValidateOptions = {
  criticalOcrConfidenceFloor: 0.5,
  warningOcrConfidenceFloor: 0.7,
  strictArithmetic: true,
};
const RELAXED: ValidateOptions = { ...STRICT, strictArithmetic: false };

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

const codes = (r: ParseValidationResult) => r.findings.map((f) => f.code);
const find = (r: ParseValidationResult, code: string) => r.findings.filter((f) => f.code === code);

describe("§4 line 322 — an itemless result is critical, not a silent success", () => {
  it("an empty ParseResult yields zero_items and nothing else pretending to be clean", () => {
    const out = validate(result(), STRICT);
    expect(codes(out)).toEqual(["zero_items", "confidence_unavailable"]);
    expect(find(out, "zero_items")[0]).toMatchObject({ severity: "critical", scope: "receipt" });
    expect(out.uncertain).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("one item is enough to clear it", () => {
    expect(codes(validate(result({ items: [item("i1")] }), STRICT)).includes("zero_items")).toBe(false);
  });
});

describe("§4 line 325 — null confidence is skipped and reported, never imputed", () => {
  it("all-null scores emit confidence_unavailable once and no comparison findings", () => {
    const out = validate(
      result({ items: [item("i1", { confidence: null }), item("i2", { confidence: null })] }),
      STRICT
    );
    expect(find(out, "confidence_unavailable")).toHaveLength(1);
    expect(out.findings.some((f) => /confidence/.test(f.code) && f.code !== "confidence_unavailable")).toBe(false);
    expect(out.items.map((i) => i.confidence)).toEqual([null, null]);
  });

  it("no receipt-wide finding is critical, so the diagnostic is never the sole rejection", () => {
    const out = validate(result({ items: [item("i1", { confidence: 0.05 })] }), STRICT);
    const diagnostic = find(out, "ocr_confidence_low")[0];
    expect(diagnostic?.severity).toBe("minor");
    expect(diagnostic?.scope).toBe("receipt");
  });
});

describe("the two floors are enforced, not repaired", () => {
  it("a reversed pair is rejected outright", () => {
    expect(() => validate(result(), { ...STRICT, criticalOcrConfidenceFloor: 0.9, warningOcrConfidenceFloor: 0.6 })).toThrow(
      RangeError
    );
  });

  it("equal floors are legal", () => {
    expect(() => validate(result(), { ...STRICT, criticalOcrConfidenceFloor: 0.7 })).not.toThrow();
  });

  it("out-of-range and non-numeric floors are rejected", () => {
    for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validate(result(), { ...STRICT, warningOcrConfidenceFloor: bad })).toThrow(RangeError);
    }
  });

  it("the operational error codes are not borrowed for caller misuse", () => {
    try {
      validate(result(), { ...STRICT, criticalOcrConfidenceFloor: 0.8 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).name).toBe("RangeError");
    }
  });

  it("options default to §6's pinned values when omitted", () => {
    // 0.65 is between 0.50 and 0.70, so the defaults are what makes this a warning rather than a critical.
    const out = validate(result({ items: [item("i1", { confidence: 0.65 })] }));
    expect(find(out, "name_confidence_low")).toHaveLength(1);
    expect(find(out, "ocr_critical_field_confidence")).toHaveLength(0);
    expect(out.uncertain).toBe(false);
  });
});

describe("§4 line 323 / §6 line 462 — relaxed arithmetic mode, tested against strict", () => {
  const contradictory = () =>
    result({
      subtotal: 1500,
      grandTotal: 1000,
      items: [item("i1"), item("i2", { lineTotal: 2000 })],
    });

  it("strict mode: arithmetic contradictions set uncertain and cap every item", () => {
    const out = validate(contradictory(), STRICT);
    expect(out.uncertain).toBe(true);
    expect(out.items.map((i) => i.confidence)).toEqual([0.5, 0.5]);
    expect(out.findings.every((f) => f.advisory === undefined)).toBe(true);
  });

  it("relaxed mode: the same findings are raised, marked advisory, and neither set uncertain nor cap", () => {
    const out = validate(contradictory(), RELAXED);
    expect(codes(out)).toEqual(codes(validate(contradictory(), STRICT)));
    expect(find(out, "arithmetic_item_sum")[0]?.advisory).toBe(true);
    expect(find(out, "arithmetic_total")[0]?.advisory).toBe(true);
    expect(out.uncertain).toBe(false);
    expect(out.items.map((i) => i.confidence)).toEqual([0.9, 0.9]);
  });

  it("relaxed mode does not downgrade a non-arithmetic critical", () => {
    const out = validate(result({ items: [item("i1", { unitPrice: null, lineTotal: null })] }), RELAXED);
    const critical = find(out, "item_without_price")[0]!;
    expect(critical.severity).toBe("critical");
    expect(critical).not.toHaveProperty("advisory");
    expect(out.uncertain).toBe(true);
  });
});

describe("§6 line 408 — what a critical caps, and what it does not", () => {
  it("an item-level critical caps only its own item", () => {
    const out = validate(
      result({ items: [item("i1", { unitPrice: null, lineTotal: null }), item("i2")] }),
      STRICT
    );
    expect(out.items.map((i) => i.confidence)).toEqual([0.5, 0.9]);
  });

  it("a receipt-level critical caps every item", () => {
    const out = validate(result({ subtotal: 100, items: [item("i1"), item("i2", { lineTotal: 500 })] }), STRICT);
    expect(find(out, "arithmetic_item_sum")).toHaveLength(1);
    expect(out.items.map((i) => i.confidence)).toEqual([0.5, 0.5]);
  });

  it("a cap never raises a score that is already lower", () => {
    const out = validate(result({ items: [item("i1", { confidence: 0.4, unitPrice: null, lineTotal: null })] }), STRICT);
    expect(out.items[0]!.confidence).toBe(0.4);
  });

  it("a null confidence is never capped into a number", () => {
    const out = validate(result({ items: [item("i1", { confidence: null, unitPrice: null, lineTotal: null })] }), STRICT);
    expect(out.items[0]!.confidence).toBeNull();
  });

  it("a row-scope or charge-scope finding caps nothing", () => {
    const out = validate(
      result({
        items: [item("i1")],
        unclassifiedRows: [
          { id: "u1", text: "MAYBE A SIDE", box: { x: 0, y: 0, width: 4, height: 4 }, sourceLineIds: ["l9"], reason: "ambiguous", warningCode: "ambiguous_row" },
        ],
        warnings: [{ code: "unclassified_charge", message: "row not typed", sourceLineIds: ["l8"] }],
      }),
      STRICT
    );
    expect(out.items[0]!.confidence).toBe(0.9);
    expect(find(out, "ambiguous_row")[0]?.rowRefs).toEqual(["u1"]);
    expect(find(out, "unclassified_charge")[0]?.scope).toBe("charge");
  });
});

describe("§4 line 319 — the input is not mutated and nothing is shared into the output", () => {
  it("validate() leaves the ParseResult exactly as it was given", () => {
    const parsed = result({
      subtotal: 1500,
      items: [item("i1"), item("i2", { lineTotal: 2000, confidence: null })],
    });
    const before = JSON.stringify(parsed);
    validate(parsed, STRICT);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(parsed.items[0]!.confidence).toBe(0.9);
  });

  it("validated items are copies, so mutating one cannot reach the parser's result", () => {
    const parsed = result({ items: [item("i1")] });
    const out = validate(parsed, STRICT);
    out.items[0]!.sourceLineIds.push("injected");
    expect(parsed.items[0]!.sourceLineIds).toEqual(["li1"]);
  });

  it("no nested object of a validated warning aliases the input, boxes included", () => {
    const warning: ParseWarning = {
      code: "unclassified_charge",
      message: "row not typed",
      sourceLineIds: ["l5"],
      sourceBox: { x: 1, y: 2, width: 3, height: 4 },
    };
    const parsed = result({ items: [item("i1", { warnings: [warning] })], warnings: [warning] });
    const out = validate(parsed, STRICT);
    const copied = out.items[0]!.warnings[0]!;
    expect(copied).not.toBe(warning);
    expect(copied.sourceBox).not.toBe(warning.sourceBox);
    expect(copied.sourceLineIds).not.toBe(warning.sourceLineIds);
    copied.sourceBox!.x = 99;
    copied.sourceLineIds!.push("injected");
    expect(parsed.items[0]!.warnings[0]!.sourceBox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(parsed.items[0]!.warnings[0]!.sourceLineIds).toEqual(["l5"]);
  });
});

describe("§4 line 329 — legacy spellings are mapped at the boundary", () => {
  const legacy = (code: string): ParseWarning =>
    ({ code, message: `legacy warning ${code}`, itemRef: "i1" }) as unknown as ParseWarning;

  it("low_name_confidence arrives and name_confidence_low leaves", () => {
    const parsed = result({ items: [item("i1", { confidence: 0.65 })], warnings: [legacy("low_name_confidence")] });
    const out = validate(parsed, STRICT);
    expect(codes(out)).toContain("name_confidence_low");
    expect(codes(out).some((c) => c.startsWith("low_"))).toBe(false);
  });

  it("the canonical items carry canonical warnings too", () => {
    const withLegacyItemWarning = item("i1", { confidence: 0.65, warnings: [legacy("low_price_confidence")] });
    const out = validate(result({ items: [withLegacyItemWarning] }), STRICT);
    expect(out.items[0]!.warnings.map((w) => w.code)).toEqual(["price_confidence_low"]);
    expect(out.items[0]!.warnings[0]).not.toBe(withLegacyItemWarning.warnings[0]);
  });

  it("an unknown code is passed through rather than swallowed", () => {
    const out = validate(result({ items: [item("i1")], warnings: [legacy("items_may_be_missing_v2")] }), STRICT);
    expect(codes(out)).toContain("items_may_be_missing_v2");
  });
});

describe("findings address the thing that caused them", () => {
  it("an item's own findings name only that item", () => {
    const out = validate(
      result({
        items: [
          item("i1", { quantitySource: "assumed", qty: 1, warnings: [{ code: "qty_assumed", message: "1 assumed", itemRef: "i1" }] }),
          item("i2", { unitPrice: null, priceSource: "unresolved" }),
        ],
        warnings: [{ code: "qty_assumed", message: "1 assumed", itemRef: "i1", sourceLineIds: ["l1"] }],
      }),
      STRICT
    );
    expect(find(out, "qty_assumed")[0]?.itemRefs).toEqual(["i1"]);
    expect(find(out, "price_not_resolved")[0]?.itemRefs).toEqual(["i2"]);
    expect(find(out, "price_not_resolved")[0]?.scope).toBe("item");
  });

  it("a row-shaped warning is joined to the preserved row's id", () => {
    const out = validate(
      result({
        items: [item("i1")],
        unclassifiedRows: [
          { id: "u1", text: "TWO PRICES HERE", box: { x: 0, y: 0, width: 4, height: 4 }, sourceLineIds: ["l7"], reason: "ambiguous", warningCode: "ambiguous_row" },
        ],
        warnings: [
          { code: "ambiguous_price_separator", message: "row l7 has 2 candidates", sourceLineIds: ["l7"] },
        ],
      }),
      STRICT
    );
    expect(find(out, "ambiguous_price_separator")[0]?.rowRefs).toEqual(["u1"]);
  });

  it("a receipt-scope finding carries no address at all", () => {
    const out = validate(result({ subtotal: 100, items: [item("i1", { lineTotal: 500 })] }), STRICT);
    expect(find(out, "arithmetic_item_sum")[0]).not.toHaveProperty("itemRefs");
  });
});

describe("§6 line 419 — schema violations are findings", () => {
  it("a non-integer amount on an item is critical and addressed", () => {
    const out = validate(result({ items: [item("i1", { lineTotal: 1000.5 })] }), STRICT);
    const f = find(out, "invalid_result_schema")[0];
    expect(f?.scope).toBe("item");
    expect(f?.itemRefs).toEqual(["i1"]);
  });

  it("a negative magnitude where §4 declares a positive one is caught", () => {
    const out = validate(result({ items: [item("i1")], discount: -100 }), STRICT);
    expect(find(out, "invalid_result_schema")[0]?.chargeRefs).toEqual(["discount"]);
  });

  it("a quantity of zero or NaN is caught, per §7's reject rule", () => {
    for (const qty of [0, -2, Number.NaN]) {
      expect(codes(validate(result({ items: [item("i1", { qty })] }), STRICT))).toContain("invalid_result_schema");
    }
  });

  it("a round-off may be negative — its sign is the printed one", () => {
    const out = validate(result({ items: [item("i1")], roundOff: -50 }), STRICT);
    expect(find(out, "invalid_result_schema")).toHaveLength(0);
  });

  it("a dangling itemRef makes an unaddressable finding impossible to hide", () => {
    const out = validate(
      result({ items: [item("i1")], warnings: [{ code: "qty_assumed", message: "ghost", itemRef: "i999" }] }),
      STRICT
    );
    expect(codes(out)).toContain("invalid_result_schema");
  });
});

describe("§6 line 433 — the name-length outlier", () => {
  it("below 5 items the rule is not evaluated at all", () => {
    const few = [item("i1", { name: "a".repeat(200) }), item("i2"), item("i3"), item("i4")];
    expect(codes(validate(result({ items: few }), STRICT))).not.toContain("name_length_outlier");
  });

  it("at exactly 5 items one outlier cannot reach 2 sigma — the statistic caps itself at 1.79", () => {
    // With n items and a single outlier the largest attainable z is (n−1)/√n, which is 1.789 at n = 5.
    // k = 2 is therefore unreachable until n = 6, and this records that the rule's floor is not the
    // ≥5 gate the spec names but the multiple pinned in DECISIONS/0011 V15.
    const items = [item("i1"), item("i2"), item("i3"), item("i4"), item("i5", { name: "n".repeat(400) })];
    expect(codes(validate(result({ items }), STRICT))).not.toContain("name_length_outlier");
  });

  it("at 6 items a two-sigma outlier is flagged and its neighbours are not", () => {
    const items = [item("i1"), item("i2"), item("i3"), item("i4"), item("i5"), item("i6", { name: "n".repeat(300) })];
    const flagged = find(validate(result({ items }), STRICT), "name_length_outlier");
    expect(flagged.map((f) => f.itemRefs)).toEqual([["i6"]]);
    expect(flagged[0]?.severity).toBe("minor");
  });

  it("a uniform receipt flags nothing", () => {
    const items = ["i1", "i2", "i3", "i4", "i5"].map((id) => item(id, { name: "same length" }));
    expect(codes(validate(result({ items }), STRICT))).not.toContain("name_length_outlier");
  });
});

describe("emission is deterministic and reports only extraction", () => {
  it("the same ParseResult produces byte-identical findings twice", () => {
    const parsed = result({ subtotal: 1500, grandTotal: 1200, items: [item("i1"), item("i2", { lineTotal: 2000 })] });
    expect(JSON.stringify(validate(parsed, STRICT))).toBe(JSON.stringify(validate(parsed, STRICT)));
  });

  it("nothing about participants, drafts, units or lock state is reachable from here", () => {
    // §6 lines 398–401: LockBlocker is PWA-owned. The check is on the shape, not on the prose — a finding
    // may say what a state blocks without carrying a blocker field the PWA would then have to ignore.
    const out = validate(result({ items: [item("i1", { qty: null, quantitySource: "unresolved" })] }), STRICT);
    expect(Object.keys(out).sort()).toEqual(["findings", "items", "uncertain"]);
    const allowed = new Set(["severity", "code", "scope", "message", "itemRefs", "rowRefs", "chargeRefs", "advisory"]);
    const keys = new Set(out.findings.flatMap((f) => Object.keys(f)));
    for (const key of keys) expect(allowed.has(key)).toBe(true);
    expect([...keys].some((k) => /lock|blocker|participant|draft|payer|assign/i.test(k))).toBe(false);
    expect(find(out, "qty_unresolved")[0]?.severity).toBe("minor");
  });

  it("an unclassified charge with unknown sign blocks the total check without inventing a number", () => {
    const out = validate(
      result({
        subtotal: 1000,
        grandTotal: 1500,
        items: [item("i1")],
        otherCharges: [{ label: "SRV", amount: null, type: "other", sign: "unknown", source: "detected" }],
        warnings: [{ code: "unclassified_charge", message: "carries 2 amounts", sourceLineIds: ["l5"] }],
      }),
      STRICT
    );
    expect(codes(out)).not.toContain("arithmetic_total");
    expect(find(out, "unclassified_charge")).toHaveLength(1);
    expect(out.uncertain).toBe(false);
  });
});
