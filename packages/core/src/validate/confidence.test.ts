import { describe, expect, it } from "vitest";
import type { ParsedItem, ParseResult } from "../types.js";
import { validateConfidence } from "./confidence.js";

const FLOORS = { critical: 0.5, warning: 0.7 };

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

function result(items: ParsedItem[]): ParseResult {
  return {
    items,
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
  };
}

/**
 * Item-scoped findings only: a single low score also drags the receipt-wide mean below the warning floor,
 * which is correct behaviour and is asserted separately in the diagnostic block below.
 */
const shape = (items: ParsedItem[]) =>
  validateConfidence(result(items), FLOORS)
    .filter((f) => f.scope === "item")
    .map((f) => [f.code, f.severity, f.scope, ...(f.itemRefs ?? [])]);

describe("null is skipped, never imputed", () => {
  it("every score null: one unavailable diagnostic and no comparison at all", () => {
    const findings = validateConfidence(result([item("i1", { confidence: null }), item("i2", { confidence: null })]), FLOORS);
    expect(findings).toEqual([
      {
        severity: "minor",
        code: "confidence_unavailable",
        scope: "receipt",
        message: "No meaningful confidence scores were supplied, so every confidence comparison is skipped",
      },
    ]);
  });

  it("zero items is zero supplied scores, so the receipt is reported, not read as clean", () => {
    expect(validateConfidence(result([]), FLOORS).map((f) => f.code)).toEqual(["confidence_unavailable"]);
  });

  it("a null-scored item is skipped while its scored neighbour is still checked", () => {
    const findings = validateConfidence(result([item("i1", { confidence: null }), item("i2", { confidence: 0.2 })]), FLOORS);
    expect(findings.map((f) => f.code)).toContain("ocr_critical_field_confidence");
    expect(findings.some((f) => f.itemRefs?.includes("i1"))).toBe(false);
    expect(findings.some((f) => f.code === "confidence_unavailable")).toBe(false);
  });
});

describe("the two floors", () => {
  it("below the critical floor is one critical finding addressed to that item", () => {
    expect(shape([item("i1", { confidence: 0.49 })])).toEqual([
      ["ocr_critical_field_confidence", "critical", "item", "i1"],
    ]);
  });

  it("a score exactly at the critical floor is not below it", () => {
    expect(shape([item("i1", { confidence: 0.5 })])).toEqual([
      ["name_confidence_low", "minor", "item", "i1"],
      ["price_confidence_low", "minor", "item", "i1"],
    ]);
  });

  it("a score exactly at the warning floor is clean", () => {
    expect(shape([item("i1", { confidence: 0.7 })])).toEqual([]);
  });

  it("between the floors is a review signal on the item only, never a receipt-level finding", () => {
    const findings = validateConfidence(result([item("i1", { confidence: 0.55 }), item("i2", { confidence: 0.95 })]), FLOORS);
    expect(findings.filter((f) => f.scope === "item").map((f) => f.itemRefs?.[0])).toEqual(["i1", "i1"]);
    expect(findings.some((f) => f.severity === "critical")).toBe(false);
  });

  it("the critical case subsumes the warning codes — one cause, one severity", () => {
    expect(
      validateConfidence(result([item("i1", { confidence: 0.1 })]), FLOORS)
        .filter((f) => f.scope === "item")
        .map((f) => f.code)
    ).toEqual(["ocr_critical_field_confidence"]);
  });
});

describe("V6 — the contributing field set rather than a guess about which field was low", () => {
  it("a detected price contributes, so both field codes are raised", () => {
    expect(shape([item("i1", { confidence: 0.6, priceSource: "detected" })])).toEqual([
      ["name_confidence_low", "minor", "item", "i1"],
      ["price_confidence_low", "minor", "item", "i1"],
    ]);
  });

  it("an unresolved price contributes nothing, so only the name code is raised", () => {
    expect(
      shape([item("i1", { confidence: 0.6, priceSource: "unresolved", unitPrice: null, lineTotal: null })])
    ).toEqual([["name_confidence_low", "minor", "item", "i1"]]);
  });

  it("the rule is per item: two items below the warning floor with different price states differ in output", () => {
    const codes = shape([item("i1", { confidence: 0.6 }), item("i2", { confidence: 0.6, priceSource: "unresolved", unitPrice: null })]);
    expect(codes.map((c) => c[0])).toEqual([
      "name_confidence_low",
      "price_confidence_low",
      "name_confidence_low",
    ]);
  });
});

describe("the receipt-wide diagnostic", () => {
  it("a low mean is minor and receipt-scoped, and it is not the only signal a receipt gets", () => {
    const findings = validateConfidence(result([item("i1", { confidence: 0.6 }), item("i2", { confidence: 0.65 })]), FLOORS);
    const receipt = findings.filter((f) => f.scope === "receipt");
    expect(receipt.map((f) => [f.code, f.severity])).toEqual([["ocr_confidence_low", "minor"]]);
    expect(findings.filter((f) => f.scope === "item").length).toBeGreaterThan(0);
  });

  it("one low item among strong items does not drag the receipt diagnostic down", () => {
    const items = [item("i1", { confidence: 0.55 }), item("i2", { confidence: 0.95 }), item("i3", { confidence: 0.95 })];
    expect(validateConfidence(result(items), FLOORS).some((f) => f.code === "ocr_confidence_low")).toBe(false);
  });

  it("a critically low item still produces the receipt diagnostic when the mean is low", () => {
    const findings = validateConfidence(result([item("i1", { confidence: 0.1 }), item("i2", { confidence: 0.2 })]), FLOORS);
    expect(findings.map((f) => f.code).filter((c) => c === "ocr_confidence_low")).toHaveLength(1);
    expect(findings.filter((f) => f.severity === "critical")).toHaveLength(2);
  });
});

describe("floors are consumed as given", () => {
  it("moving the floors moves the findings without the code knowing about 0.50/0.70", () => {
    const strict = validateConfidence(result([item("i1", { confidence: 0.65 })]), { critical: 0.7, warning: 0.8 });
    expect(strict.filter((f) => f.scope === "item").map((f) => [f.code, f.severity])).toEqual([
      ["ocr_critical_field_confidence", "critical"],
    ]);
  });

  it("equal floors collapse the warning band: a score at the floor is neither critical nor minor", () => {
    expect(validateConfidence(result([item("i1", { confidence: 0.65 })]), { critical: 0.6, warning: 0.6 })).toEqual([]);
  });
});
