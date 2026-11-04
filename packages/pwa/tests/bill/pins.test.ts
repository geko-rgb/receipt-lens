import { describe, expect, it } from "vitest";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult, ParsedOtherCharge, ParsedTax, UnclassifiedRow } from "@receipt-lens/core";

import { visibleFindings, type BillDocument } from "../../src/lib/bill/document.js";
import type { DerivedBillState } from "../../src/lib/bill/totals.js";
import { formatPaise, formatPaiseOrNull, parsePaiseInput } from "../../src/lib/bill/paise-input.js";
import type { BillValidationResult } from "../../src/lib/bill/working-bill.js";
import {
  acknowledgeUnassignedUnit,
  addManualCharge,
  addManualItem,
  beginFrom,
  deleteCharge,
  deleteItem,
  finalizeAllResolvable,
  finalizeItems,
  isChargeAmountPaise,
  isCountableQuantity,
  isIntegerPaise,
  isUnitPricePaise,
  reviewAssumedQuantity,
  resolveChargeInclusion,
  runTransaction,
  setChargeAmount,
  setChargeSign,
  setChargeType,
  setGrandTotal,
  setItemName,
  setItemPrice,
  setItemQuantity,
  type Operation,
  type TransactionResult,
  type TransactionSteps,
} from "../../src/lib/bill/transactions.js";
import { validateWorkingBill } from "../../src/lib/validate-bill.js";

/**
 * DECISIONS/0020 T1–T13 and DECISIONS/0019 S3/S6/S7, as assertions.
 *
 * This is the bill-state seam the ticket's Verify line names: construct a bill, apply one operation,
 * assert the whole observable delta — provenance, printed facts, derived totals, findings, blockers,
 * cascade — or, for a failure, that nothing at all moved. Written before the implementation, deliberately:
 * every rule-carrying function in `src/lib/bill/` throws `not implemented`, so this file fails until the
 * rule exists.
 *
 * The fixtures are authored, not dataset-derived — this ticket is about the editor's state machine — and
 * core `validate()` runs for real over every parse here, so the extraction findings are the shipped
 * validator's own output rather than a hand-written approximation of it.
 */

const CREATED_AT = "2026-11-04T00:00:00.000Z";

function parsedItem(id: string, over: Partial<ParsedItem> = {}): ParsedItem {
  return {
    id,
    name: `Item ${id}`,
    qty: 1,
    quantitySource: "explicit",
    unitPrice: 10_000,
    priceSource: "detected",
    lineTotal: 10_000,
    confidence: null,
    sourceLineIds: [`line-${id}`],
    warnings: [],
    ...over,
  };
}

function ambiguousRow(id: string, over: Partial<UnclassifiedRow> = {}): UnclassifiedRow {
  return {
    id,
    text: "Srv Ch Rp 9.736",
    box: { x: 0, y: 10, width: 100, height: 12 },
    sourceLineIds: [`line-${id}`],
    reason: "ambiguous",
    warningCode: "ambiguous_row",
    ...over,
  };
}

/** Two resolved items and a ₹420.50 print — the state most of these pins reason about. */
function parseFixture(over: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [parsedItem("i1", { qty: 2, unitPrice: 32_050, lineTotal: 32_050 }), parsedItem("i2")],
    unclassifiedRows: [],
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: null,
    subtotalSource: "unresolved",
    grandTotal: 42_050,
    grandTotalSource: "detected",
    warnings: [],
    ...over,
  };
}

function taxFixture(over: Partial<ParsedTax> = {}): ParsedTax {
  return { label: "GST", amount: 1_551, rate: null, source: "detected", ...over };
}

function otherFixture(over: Partial<ParsedOtherCharge> = {}): ParsedOtherCharge {
  return { label: "Parcel", amount: 500, type: "other", sign: "unknown", source: "detected", ...over };
}

/** Revision 0, built the way `/bill` builds it. */
function begin(over: Partial<ParseResult> = {}): BillDocument {
  const parse = parseFixture(over);
  return beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Albus" });
}

/** A bill whose resolvable drafts are finalized, so the unit-level pins have units to talk about. */
function beginFinalized(over: Partial<ParseResult> = {}): BillDocument {
  return finalizeAllResolvable(begin(over)).document;
}

/** One item only, `qty` × `unitPrice`, finalized — for pins that count units. The print stays 42,050. */
function oneFinalizedItem(qty: number, unitPrice: number, detected: number | null = qty * unitPrice): BillDocument {
  return beginFinalized(parseFixture({ items: [parsedItem("i1", { qty, unitPrice, lineTotal: detected })] }));
}

/** Every path in the committed value that IndexedDB (ticket 14) or the share codec (ticket 16) could not carry. */
function nonJsonPaths(value: unknown, path = "$", found: string[] = []): string[] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return found;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) found.push(`${path} (non-finite number)`);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nonJsonPaths(entry, `${path}[${index}]`, found));
    return found;
  }
  if (typeof value !== "object") {
    found.push(`${path} (${typeof value})`);
    return found;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) found.push(`${path} (non-plain object)`);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) found.push(`${path}.${key} (undefined)`);
    else nonJsonPaths(entry, `${path}.${key}`, found);
  }
  return found;
}

const DERIVED_KEYS = Object.keys({
  calculatedItemsTotal: 0,
  calculatedSubtotal: 0,
  chargeEffectsTotal: 0,
  calculatedPayableTotal: 0,
  printedSubtotal: null,
  printedGrandTotal: null,
  reconciliationGap: null,
  shares: null,
  sharesUnavailableFor: null,
} satisfies DerivedBillState).sort();

function blankValidation(): BillValidationResult {
  return {
    findings: [],
    blockers: { unitCreation: [], assignment: [], finalization: [], locking: [] },
  };
}

/** The three steps, instrumented: each records that it ran, and none runs the real logic. */
function recordingSteps(log: string[]): TransactionSteps {
  return {
    recompute: (working) => {
      log.push("recompute");
      return {
        working,
        derived: {
          calculatedItemsTotal: 0,
          calculatedSubtotal: 0,
          chargeEffectsTotal: 0,
          calculatedPayableTotal: 0,
          printedSubtotal: null,
          printedGrandTotal: null,
          reconciliationGap: null,
          shares: [],
          sharesUnavailableFor: null,
        },
      };
    },
    validateParse: () => {
      log.push("validateParse");
      return null;
    },
    validateWorking: () => {
      log.push("validateWorking");
      return blankValidation();
    },
  };
}

const identity: Operation = (working) => working;

/**
 * Assignment is ticket 12's operation, so the pins that need an assigned unit write the array through
 * `runTransaction` directly. That exercises the runner and the invariants without inventing 12's API here.
 */
function assign(unitId: string, participantId: string): Operation {
  return (working) => ({
    ...working,
    assignments: [...working.assignments, { itemUnitId: unitId, participantId }],
  });
}

const lockingCodes = (document: BillDocument): string[] =>
  document.billValidation.blockers.locking.map((blocker) => blocker.code);

/**
 * Narrows a committed result. A rejection throws with its own code and refs, so a pin that expected a
 * commit fails with "bulk finalize rejected: not_finalizable [i2]" rather than a TypeError about `.effects`.
 */
function committed(result: TransactionResult, label = "transaction"): Extract<TransactionResult, { ok: true }> {
  if (!result.ok) throw new Error(`${label} rejected: ${result.reject.code} [${result.reject.refs.join(", ")}]`);
  return result;
}

describe("DECISIONS/0019 S3/S6/S7 — the committed document", () => {
  it("carries the working bill, the derived state and the bill validation as one value at revision 0", () => {
    const document = begin();
    expect(document.revision).toBe(0);
    expect(document.working.draftItems.map((draft) => draft.id)).toEqual(["i1", "i2"]);
    expect(Object.keys(document.derived).sort()).toEqual(DERIVED_KEYS);
    expect(document.working.parseValidation).not.toBeNull();
    // §10 line 800 clears `draft_items_unresolved` once every draft has a name, a resolved quantity and a
    // price — which this fixture does. Locking is still impossible, because the units those drafts will
    // materialize are unassigned; ticket 13's lock attempt finalizes the resolved drafts in bulk first.
    expect(lockingCodes(document)).not.toContain("draft_items_unresolved");
  });

  it("is JSON-safe end to end, which is what tickets 14 and 16 depend on", () => {
    const document = beginFinalized();
    expect(nonJsonPaths(document)).toEqual([]);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it("stays JSON-safe after edits, growth and an acknowledgement", () => {
    const grown = setItemQuantity(oneFinalizedItem(2, 10_000), "i1", 3);
    const acknowledged = acknowledgeUnassignedUnit(grown.document, "unit:i1:2");
    expect(acknowledged.ok).toBe(true);
    expect(nonJsonPaths(acknowledged.document)).toEqual([]);
    expect(JSON.parse(JSON.stringify(acknowledged.document))).toEqual(acknowledged.document);
  });

  it("is frozen, so a stray in-place write cannot corrupt the value that is also the persistence record", () => {
    const document = begin();
    const draft = document.working.draftItems[0]!;
    expect(() => {
      (draft as { unitPrice: number | null }).unitPrice = 1;
    }).toThrow(TypeError);
    expect(document.working.draftItems[0]!.unitPrice).toBe(32_050);
  });

  it("increments the revision exactly once per committed transaction, and never for a rejected one", () => {
    const edited = setItemPrice(begin(), "i2", 20_000);
    expect(edited.ok).toBe(true);
    expect(edited.document.revision).toBe(1);
    const rejected = setItemPrice(edited.document, "nope", 20_000);
    expect(rejected.ok).toBe(false);
    expect(rejected.document.revision).toBe(1);
  });
});

describe("DECISIONS/0020 T13 — 3C.1: the accepted parse becomes a bill", () => {
  it("maps each parsed item to a draft that keeps the parsed id and every provenance field", () => {
    const parse = parseFixture({
      items: [
        parsedItem("i1", { qty: null, quantitySource: "unresolved", unitPrice: null, priceSource: "unresolved", lineTotal: null }),
        parsedItem("i2", {
          qty: 1,
          quantitySource: "assumed",
          confidence: 0.62,
          warnings: [{ code: "qty_assumed", message: "no printed quantity" }],
        }),
      ],
    });
    const document = beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT });
    const [first, second] = document.working.draftItems;
    expect(first!.id).toBe("i1");
    expect(first!.parsedRef).toBe("i1");
    expect(first!.qty).toBeNull();
    expect(first!.quantitySource).toBe("unresolved");
    expect(first!.priceSource).toBe("unresolved");
    expect(first!.lineTotal).toBeNull();
    expect(first!.confidence).toBeNull();
    expect(second!.quantitySource).toBe("assumed");
    expect(second!.assumedQtyReviewed).toBe(false);
    expect(second!.manuallyAdded).toBe(false);
    expect(second!.confidence).toBe(0.62);
    expect(second!.warnings).toEqual([{ code: "qty_assumed", message: "no printed quantity" }]);
  });

  it("unifies the public charge shape, keeping round-off signed and inclusion unresolved where the question is coherent", () => {
    const parse = parseFixture({
      taxes: [taxFixture(), taxFixture({ label: "SGST", amount: 1_551 })],
      serviceCharge: 6_205,
      tip: 1_000,
      discount: 5_000,
      roundOff: 43,
      otherCharges: [otherFixture({ sign: "add" }), otherFixture({ label: "Unknown", amount: null })],
    });
    const document = beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT });
    const charges = document.working.draftCharges;
    expect(charges.map((charge) => charge.type)).toEqual([
      "tax",
      "tax",
      "service_charge",
      "tip",
      "discount",
      "round_off",
      "other",
      "other",
    ]);
    // DECISIONS/0011 V9's charge refs, so core's `chargeRefs` and the editor's rows name the same entity.
    expect(charges.map((charge) => charge.id)).toEqual(["t1", "t2", "service", "tip", "discount", "roundOff", "o1", "o2"]);
    expect(charges.find((charge) => charge.type === "round_off")!.amount).toBe(43);
    expect(charges.find((charge) => charge.type === "discount")!.amount).toBe(5_000);
    expect(charges.filter((charge) => charge.type === "other").map((charge) => charge.amount)).toEqual([500, null]);
    expect(charges.filter((charge) => charge.otherSign === "unknown").map((charge) => charge.label)).toEqual(["Unknown"]);
    // DECISIONS/0020 T6: the two types whose inclusion is not a coherent question arrive resolved; the rest
    // wait for the creator, because §10 line 752 forbids inferring it from anything but an explicit cue.
    expect(charges.map((charge) => [charge.type, charge.included])).toEqual([
      ["tax", null],
      ["tax", null],
      ["service_charge", null],
      ["tip", null],
      ["discount", false],
      ["round_off", false],
      ["other", null],
      ["other", null],
    ]);
    expect(charges.every((charge) => charge.source === "detected")).toBe(true);
    expect(charges.every((charge) => charge.manuallyAdded === false)).toBe(true);
  });

  it("skips scalar charge fields that were never printed, so nothing becomes a zero-amount charge", () => {
    const document = begin(parseFixture({ taxes: [taxFixture({ amount: null })], serviceCharge: null, tip: null, discount: null }));
    expect(document.working.draftCharges.map((charge) => charge.type)).toEqual(["tax"]);
    expect(document.working.draftCharges[0]!.amount).toBeNull();
  });

  it("starts with the creator as a participant and the payer, and keeps the printed facts where §10 puts them", () => {
    const document = begin(parseFixture({ subtotal: 40_000, subtotalSource: "detected" }));
    const { bill, participants } = document.working;
    expect(bill.creatorId).toBe(bill.payerId);
    expect(participants.map((participant) => participant.id)).toEqual([bill.creatorId]);
    expect(participants[0]!.name).toBe("Albus");
    expect(participants[0]!.paid).toBe(false);
    expect(bill.isLocked).toBe(false);
    expect(bill.taxIncluded).toBeNull();
    expect(bill.taxIncludedSource).toBe("unresolved");
    expect(bill.grandTotal).toBe(42_050);
    expect(bill.grandTotalSource).toBe("detected");
    expect(bill.adjustmentLines).toEqual([]);
    expect("subtotal" in bill).toBe(false);
    expect(document.working.parseResult!.subtotal).toBe(40_000);
  });

  it("carries the ambiguous rows and the parse evidence the reviewer still needs", () => {
    const rows = [ambiguousRow("u1")];
    const document = begin(parseFixture({ unclassifiedRows: rows }));
    expect(document.working.unclassifiedRows).toEqual(rows);
    expect(document.working.parseResult).not.toBeNull();
    expect(document.working.parseValidation!.findings.map((finding) => finding.code)).toContain("ambiguous_row");
  });
});

describe("DECISIONS/0020 T12 — persist → recompute → validate → blockers, or roll back", () => {
  it("runs the three steps in the §6 order, once each, after a successful persist", () => {
    const log: string[] = [];
    runTransaction(begin(), identity, recordingSteps(log));
    expect(log).toEqual(["recompute", "validateParse", "validateWorking"]);
  });

  it("runs none of them when the persist step rejects", () => {
    const log: string[] = [];
    const result = runTransaction(begin(), () => ({ code: "unknown_entity", refs: ["i9"], message: "not in the bill" }), recordingSteps(log));
    expect(result.ok).toBe(false);
    expect(log).toEqual([]);
  });

  for (const step of ["recompute", "validateParse", "validateWorking"] as const) {
    it(`returns the very same document object when ${step} throws, so no derived state from the mutation can exist`, () => {
      const document = begin();
      const failing = {
        ...recordingSteps([]),
        [step]: () => {
          throw new Error(`${step} blew up`);
        },
      };
      const result = runTransaction(document, identity, failing);
      expect(result.ok).toBe(false);
      expect(result.document).toBe(document);
    });
  }

  it("leaves the previous document's derived state and blockers byte-identical after a rollback", () => {
    const document = beginFinalized();
    const before = JSON.stringify({ derived: document.derived, blockers: document.billValidation.blockers });
    const result = runTransaction(document, identity, {
      ...recordingSteps([]),
      recompute: () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.document).toBe(document);
    expect(JSON.stringify({ derived: document.derived, blockers: document.billValidation.blockers })).toBe(before);
  });

  it("reports a recompute that violates an invariant as recompute_failed, not as an ordinary reject", () => {
    const result = runTransaction(begin(), identity, {
      ...recordingSteps([]),
      recompute: () => {
        throw new Error("count(units) != Item.qty");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reject.code).toBe("recompute_failed");
    expect(result.reject.refs).toContain("count(units) != Item.qty");
  });

  it("writes the fresh core result into the working bill it commits", () => {
    const committed = runTransaction(begin(), identity, recordingSteps([]));
    expect(committed.ok).toBe(true);
    expect(committed.document.working.parseValidation).toBeNull();
    expect(committed.document.working.parseResult).not.toBeNull();
  });

  it("commits a transaction whose validation is critical, because the gap is the product", () => {
    const document = beginFinalized();
    const edited = setItemPrice(document, "i1", 1);
    expect(edited.ok).toBe(true);
    expect(visibleFindings(edited.document).map((finding) => finding.code)).toContain("arithmetic_total");
    expect(edited.document.derived.reconciliationGap).toBe(42_050 - (1 * 2 + 10_000));
    expect(lockingCodes(edited.document)).not.toContain("arithmetic_total");
  });
});

describe("DECISIONS/0020 T1 — what a rejection is, and what is not", () => {
  it("rejects non-integer, non-finite and out-of-range paise as invalid_amount, naming the entity", () => {
    const document = begin();
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = setItemPrice(document, "i1", bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reject.code).toBe("invalid_amount");
      expect(result.reject.refs).toEqual(["i1"]);
    }
    expect(isIntegerPaise(0)).toBe(true);
    // A paise amount can legitimately be negative — `round_off` is signed (§11 rule 8) — so the sign rule
    // lives in the field predicates, not in "is this an exact paise amount at all".
    expect(isIntegerPaise(-1)).toBe(true);
    expect(isIntegerPaise(0.5)).toBe(false);
    expect(isIntegerPaise(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isIntegerPaise("100" as unknown as number)).toBe(false);
    expect(isIntegerPaise(null)).toBe(false);
    expect(isUnitPricePaise(-1)).toBe(false);
    expect(isUnitPricePaise(0)).toBe(true);
    expect(isChargeAmountPaise("round_off", -43)).toBe(true);
    expect(isChargeAmountPaise("tax", -43)).toBe(false);
  });

  it("rejects a quantity that is not a positive integer, including the fractional one v1 cannot represent", () => {
    const document = begin();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const result = setItemQuantity(document, "i1", bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reject.code).toBe("invalid_quantity");
    }
    expect(isCountableQuantity(1)).toBe(true);
    expect(isCountableQuantity(3)).toBe(true);
    expect(isCountableQuantity(0)).toBe(false);
    expect(isCountableQuantity(2.5)).toBe(false);
  });

  it("rejects an operation naming an entity the document does not have", () => {
    for (const result of [
      setItemName(begin(), "i404", "Nothing"),
      deleteItem(begin(), "i404"),
      finalizeItems(begin(), ["i404"]),
      deleteCharge(begin(), "c404"),
    ]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reject.code).toBe("unknown_entity");
    }
  });

  it("rejects every mutation of a locked bill — ticket 13 owns the unlock action, not this guard", () => {
    const locked = runTransaction(begin(), (working) => ({ ...working, bill: { ...working.bill, isLocked: true } }));
    expect(locked.ok).toBe(true);
    if (!locked.ok) throw new Error("unreachable");
    for (const result of [
      setItemPrice(locked.document, "i1", 9_999),
      deleteItem(locked.document, "i1"),
      addManualItem(locked.document, { name: "X", qty: 1, unitPrice: 100 }),
      finalizeAllResolvable(locked.document),
    ]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reject.code).toBe("bill_locked");
    }
  });

  it("clears a value rather than rejecting null, because blanking a field is how a user re-enters it", () => {
    const cleared = setItemPrice(begin(), "i1", null);
    expect(cleared.ok).toBe(true);
    const draft = cleared.document.working.draftItems.find((item) => item.id === "i1")!;
    expect(draft.unitPrice).toBeNull();
    expect(draft.priceSource).toBe("unresolved");
    expect(cleared.document.working.bill.grandTotal).toBe(42_050);
  });
});

describe("DECISIONS/0020 T3/T4/T5 — provenance, and what an edit may not touch", () => {
  it("marks an edited quantity and price user_confirmed, and nothing else", () => {
    const withQty = setItemQuantity(begin(), "i1", 3);
    expect(withQty.ok).toBe(true);
    const withPrice = setItemPrice(withQty.document, "i1", 4_500);
    expect(withPrice.ok).toBe(true);
    const draft = withPrice.document.working.draftItems.find((item) => item.id === "i1")!;
    expect(draft.qty).toBe(3);
    expect(draft.quantitySource).toBe("user_confirmed");
    expect(draft.unitPrice).toBe(4_500);
    expect(draft.priceSource).toBe("user_confirmed");
    expect(draft.name).toBe("Item i1");
    // §10 gives a name no provenance field, and a draft's `lineTotal` is the printed row total, not a product.
    expect(draft.lineTotal).toBe(32_050);
  });

  it("outranks the parser where the user typed a value, and leaves the parsed provenance where they did not", () => {
    let document = begin();
    document = setItemPrice(document, "i1", 4_500).document;
    document = setItemName(document, "i1", "Paneer Tikka").document;
    document = finalizeItems(document, ["i1"]).document;
    const item = document.working.items.find((entry) => entry.id === "i1")!;
    expect(item.priceSource).toBe("user_confirmed");
    expect(item.unitPrice).toBe(4_500);
    // §7: the untouched quantity keeps the parser's provenance, and only a user act promotes it.
    expect(item.quantitySource).toBe("explicit");
    expect(item.qty).toBe(2);
    expect(item.lineTotal).toBe(9_000);
    expect(item.name).toBe("Paneer Tikka");
  });

  it("keeps an unresolved value editable, because blocking the edit would make it unfixable", () => {
    const document = begin(
      parseFixture({
        items: [parsedItem("i1", { qty: null, quantitySource: "unresolved", unitPrice: null, priceSource: "unresolved", lineTotal: null })],
      }),
    );
    const before = validateWorkingBill(document.working);
    expect(before.blockers.finalization).toEqual(expect.arrayContaining(["qty_unresolved", "price_unresolved"]));
    const resolved = setItemQuantity(document, "i1", 2);
    expect(resolved.ok).toBe(true);
    const priced = setItemPrice(resolved.document, "i1", 5_000);
    expect(priced.ok).toBe(true);
    const after = validateWorkingBill(priced.document.working);
    expect(after.blockers.finalization).not.toContain("qty_unresolved");
    expect(after.blockers.finalization).not.toContain("price_unresolved");
    expect(after.blockers.unitCreation).not.toContain("qty_unresolved");
  });

  it("preserves the printed grand total and its source across a price edit, a delete and a finalize", () => {
    const document = beginFinalized();
    const edited = setItemPrice(document, "i1", 1);
    const deleted = deleteItem(edited.document, "i2");
    expect(deleted.ok).toBe(true);
    for (const result of [edited, deleted]) {
      expect(result.document.working.bill.grandTotal).toBe(42_050);
      expect(result.document.working.bill.grandTotalSource).toBe("detected");
      expect(result.document.derived.printedGrandTotal).toBe(42_050);
    }
  });

  it("moves the printed grand total only on an explicit correction, and then records it as user_confirmed", () => {
    const corrected = setGrandTotal(begin(), 41_000);
    expect(corrected.ok).toBe(true);
    expect(corrected.document.working.bill.grandTotal).toBe(41_000);
    expect(corrected.document.working.bill.grandTotalSource).toBe("user_confirmed");
    expect(corrected.document.derived.printedGrandTotal).toBe(41_000);
    expect(corrected.document.derived.reconciliationGap).toBe(41_000);
  });

  it("sets taxIncluded from the creator's choice only when the charges agree", () => {
    const document = begin(parseFixture({ taxes: [taxFixture(), taxFixture({ label: "SGST" })] }));
    const [gst, sgst] = document.working.draftCharges;
    const first = resolveChargeInclusion(document, gst!.id, true);
    expect(first.ok).toBe(true);
    expect(first.document.working.bill.taxIncluded).toBeNull();
    expect(first.document.working.draftCharges.find((charge) => charge.id === gst!.id)!.source).toBe("user_confirmed");

    const second = resolveChargeInclusion(first.document, sgst!.id, true);
    expect(second.document.working.bill.taxIncluded).toBe(true);
    expect(second.document.working.bill.taxIncludedSource).toBe("user_confirmed");

    const third = resolveChargeInclusion(second.document, sgst!.id, false);
    expect(third.document.working.bill.taxIncluded).toBeNull();
    expect(third.document.working.bill.taxIncludedSource).toBe("unresolved");
  });

  it("gives a manual item the provenance the user supplied and null for what they left blank", () => {
    const added = addManualItem(begin(), { name: "Extra Naan", qty: 2, unitPrice: null });
    expect(added.ok).toBe(true);
    const draft = added.document.working.draftItems.at(-1)!;
    expect(draft.manuallyAdded).toBe(true);
    expect(draft.parsedRef).toBeUndefined();
    expect(draft.quantitySource).toBe("user_confirmed");
    expect(draft.priceSource).toBe("unresolved");
    expect(draft.unitPrice).toBeNull();
    expect(draft.lineTotal).toBeNull();
    expect(validateWorkingBill(added.document.working).blockers.finalization).toContain("price_unresolved");
  });
});

describe("DECISIONS/0020 T7 — derived totals, the visible gap, and shares that are not computable yet", () => {
  it("excludes drafts, because an unresolved draft has no amount to sum", () => {
    const document = begin();
    expect(document.derived.calculatedItemsTotal).toBe(0);
    expect(document.derived.printedGrandTotal).toBe(42_050);
    expect(document.derived.reconciliationGap).toBe(42_050);

    const unresolved = begin(parseFixture({ items: [parsedItem("i1", { unitPrice: null, priceSource: "unresolved" })] }));
    expect(unresolved.derived.calculatedItemsTotal).toBe(0);
    expect(lockingCodes(unresolved)).toContain("draft_items_unresolved");
  });

  it("computes item and payable totals in integer paise over finalized entities", () => {
    const document = beginFinalized();
    expect(document.derived.calculatedItemsTotal).toBe(32_050 * 2 + 10_000);
    expect(document.derived.calculatedSubtotal).toBe(document.derived.calculatedItemsTotal);
    expect(document.derived.chargeEffectsTotal).toBe(0);
    expect(document.derived.calculatedPayableTotal).toBe(74_100);
    expect(document.derived.reconciliationGap).toBe(42_050 - 74_100);
  });

  it("subtracts discounts, skips included charges and excludes unknown-sign charges", () => {
    const document = beginFinalized(
      parseFixture({
        discount: 5_000,
        roundOff: 43,
        taxes: [taxFixture()],
        otherCharges: [otherFixture({ sign: "add" })],
      }),
    );
    // T6: the tax stays a draft until inclusion is chosen, so only the two definitional charges land.
    expect(document.working.charges.map((charge) => charge.type)).toEqual(["discount", "round_off"]);
    expect(document.derived.chargeEffectsTotal).toBe(-5_000 + 43);

    const tax = document.working.draftCharges.find((charge) => charge.type === "tax")!;
    const separate = resolveChargeInclusion(document, tax.id, false);
    const finalized = finalizeAllResolvable(separate.document);
    expect(finalized.document.working.charges.map((charge) => charge.type)).toEqual(["discount", "round_off", "tax"]);
    expect(finalized.document.derived.chargeEffectsTotal).toBe(-5_000 + 43 + 1_551);

    const included = resolveChargeInclusion(finalized.document, "t1", true);
    expect(included.ok).toBe(true);
    expect(included.document.derived.chargeEffectsTotal).toBe(-5_000 + 43);
    expect(included.document.working.charges.find((charge) => charge.id === "t1")!.source).toBe("user_confirmed");
  });

  it("never counts a charge whose sign is still unknown, and never finalizes it", () => {
    const document = beginFinalized(parseFixture({ otherCharges: [otherFixture({ sign: "unknown" })] }));
    expect(document.working.draftCharges.map((charge) => charge.type)).toEqual(["other"]);
    expect(document.derived.chargeEffectsTotal).toBe(0);
    const signed = setChargeSign(document, document.working.draftCharges[0]!.id, "subtract");
    const included = resolveChargeInclusion(signed.document, signed.document.working.draftCharges[0]!.id, false);
    const finalized = finalizeAllResolvable(included.document);
    expect(finalized.document.derived.chargeEffectsTotal).toBe(-500);
  });

  it("keeps the printed subtotal as the comparison input and never rewrites it from the item list", () => {
    const document = beginFinalized(parseFixture({ subtotal: 40_000, subtotalSource: "detected" }));
    expect(document.derived.printedSubtotal).toBe(40_000);
    expect(document.derived.calculatedItemsTotal).toBe(74_100);
    const over = visibleFindings(document).filter((finding) => finding.code === "arithmetic_item_sum");
    expect(over.length).toBe(1);
    expect(over[0]!.severity).toBe("critical");
    expect(over[0]!.scope).toBe("receipt");
  });

  it("never flags the item-sum arithmetic when no subtotal was printed, and reads an under-sum as missing rows", () => {
    const sumCodes = visibleFindings(beginFinalized(parseFixture({ subtotal: null }))).map((finding) => finding.code);
    expect(sumCodes).not.toContain("arithmetic_item_sum");

    const under = visibleFindings(beginFinalized(parseFixture({ subtotal: 100_000, grandTotal: 100_000 }))).map(
      (finding) => finding.code,
    );
    expect(under).toContain("items_may_be_missing");
    expect(under).not.toContain("arithmetic_item_sum");
  });

  it("flags a line total that disagrees with the printed one and leaves the printed value intact", () => {
    const document = beginFinalized(parseFixture({ items: [parsedItem("i1", { qty: 2, unitPrice: 16_025, lineTotal: 32_050 })] }));
    const item = document.working.items.find((entry) => entry.id === "i1")!;
    expect(item.detectedLineTotal).toBe(32_050);
    expect(item.lineTotal).toBe(32_050);
    const edited = setItemPrice(document, "i1", 15_000);
    const editedItem = edited.document.working.items.find((entry) => entry.id === "i1")!;
    expect(editedItem.lineTotal).toBe(30_000);
    expect(editedItem.detectedLineTotal).toBe(32_050);
    const mismatch = visibleFindings(edited.document).filter((finding) => finding.code === "line_total_mismatch");
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]!.itemRefs).toEqual(["i1"]);
    expect(mismatch[0]!.severity).toBe("minor");
  });

  it("reports shares as unavailable rather than throwing while a unit is neither assigned nor acknowledged", () => {
    const document = beginFinalized();
    expect(document.derived.shares).toBeNull();
    expect(document.derived.sharesUnavailableFor).toBe("units_unassigned");
    expect(lockingCodes(document)).toContain("units_unassigned");
  });

  it("computes exact shares once every unit is assigned or acknowledged, landing the acknowledged cost on the creator", () => {
    const document = oneFinalizedItem(2, 10_000);
    expect(document.working.itemUnits.map((unit) => unit.id)).toEqual(["unit:i1:0", "unit:i1:1"]);
    const acknowledged = acknowledgeUnassignedUnit(document, "unit:i1:0");
    expect(acknowledged.ok).toBe(true);
    const creatorId = acknowledged.document.working.bill.creatorId;
    expect(acknowledged.document.working.bill.adjustmentLines).toEqual([
      { id: "adj:unit:i1:0", billId: "b1", reason: "unassigned", amount: 10_000, assignedToParticipantId: creatorId },
    ]);

    const assigned = runTransaction(acknowledged.document, assign("unit:i1:1", creatorId));
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) throw new Error("unreachable");
    expect(assigned.document.derived.sharesUnavailableFor).toBeNull();
    expect(assigned.document.derived.shares).toEqual([
      { participantId: creatorId, exactAmount: { numeratorPaise: "20000", denominator: "1" } },
    ]);
    expect(lockingCodes(assigned.document)).not.toContain("units_unassigned");
  });

  it("asserts a negative share only when the shares are computable, so it never double-blocks", () => {
    const blocked = beginFinalized(parseFixture({ discount: 1_000_000 }));
    expect(lockingCodes(blocked)).toContain("units_unassigned");
    expect(lockingCodes(blocked)).not.toContain("negative_share_after_discount");

    const acknowledged = acknowledgeUnassignedUnit(oneFinalizedItem(1, 1), "unit:i1:0");
    const attempt = runTransaction(acknowledged.document, (working) => ({
      ...working,
      charges: [
        ...working.charges,
        { id: "discount", billId: "b1", type: "discount", label: "Discount", amount: 1_000_000, included: false, source: "detected" },
      ],
    }));
    if (!attempt.ok) throw new Error(`reject ${attempt.reject.code}: ${attempt.reject.refs.join(" | ")}`);
    const withDiscount = attempt;
    expect(withDiscount.document.derived.shares).not.toBeNull();
    expect(lockingCodes(withDiscount.document)).toContain("negative_share_after_discount");
    expect(visibleFindings(withDiscount.document).map((finding) => finding.code)).toContain("negative_share");
  });

  it("sums exact shares without rounding when a unit is shared, because that is ticket 02's money and this is its caller", () => {
    const document = oneFinalizedItem(1, 16_025);
    const creatorId = document.working.bill.creatorId;
    const withSecond = committed(
      runTransaction(document, (working) => ({
        ...working,
        participants: [...working.participants, { id: "p2", billId: "b1", name: "Second", paid: false, token: "", tokenExpiresAt: "" }],
      })),
      "second participant",
    );
    // §11 rule 3: ₹160.25 shared by two is 16025/2 paise each — a fractional paise, kept exactly.
    const shared = committed(
      runTransaction(withSecond.document, (working) => ({
        ...working,
        assignments: [
          { itemUnitId: "unit:i1:0", participantId: creatorId },
          { itemUnitId: "unit:i1:0", participantId: "p2" },
        ],
      })),
      "shared assignment",
    );
    expect(shared.document.derived.shares).toEqual([
      { participantId: creatorId, exactAmount: { numeratorPaise: "16025", denominator: "2" } },
      { participantId: "p2", exactAmount: { numeratorPaise: "16025", denominator: "2" } },
    ]);
    expect(nonJsonPaths(shared.document)).toEqual([]);
  });
});

describe("DECISIONS/0020 T6 — what finalization requires, and what it must not require", () => {
  it("refuses an unresolved price or quantity and names both entities", () => {
    const document = begin(
      parseFixture({
        items: [
          parsedItem("i1", { unitPrice: null, priceSource: "unresolved" }),
          parsedItem("i2", { qty: null, quantitySource: "unresolved" }),
        ],
      }),
    );
    const attempted = finalizeItems(document, ["i1", "i2"]);
    expect(attempted.ok).toBe(false);
    if (attempted.ok) throw new Error("unreachable");
    expect(attempted.reject.code).toBe("not_finalizable");
    expect(attempted.reject.refs).toEqual(["i1", "i2"]);
    const blockers = validateWorkingBill(document.working).blockers;
    expect(blockers.finalization).toEqual(expect.arrayContaining(["price_unresolved", "qty_unresolved"]));
    expect(blockers.unitCreation).toEqual(expect.arrayContaining(["item_not_finalized", "qty_unresolved"]));
    expect(document.working.itemUnits).toEqual([]);
  });

  it("refuses an empty name, accepts a zero price, and rejects a zero quantity", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1", { name: "   " }), parsedItem("i2", { unitPrice: 0, lineTotal: 0 })] }));
    expect(finalizeItems(document, ["i1"]).ok).toBe(false);
    const resolved = finalizeItems(document, ["i2"]);
    expect(resolved.ok).toBe(true);
    expect(resolved.document.working.items.find((item) => item.id === "i2")!.unitPrice).toBe(0);
    expect(validateWorkingBill(document.working).blockers.finalization).toContain("name_missing");
    const zeroQty = setItemQuantity(document, "i2", 0);
    expect(zeroQty.ok).toBe(false);
  });

  it("does not require an assumed quantity to be reviewed, but does require it before lock", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1", { quantitySource: "assumed" })] }));
    const finalized = finalizeItems(document, ["i1"]);
    expect(finalized.ok).toBe(true);
    expect(lockingCodes(finalized.document)).toContain("assumed_qty_unreviewed");
    const reviewed = reviewAssumedQuantity(finalized.document, "i1");
    expect(reviewed.ok).toBe(true);
    expect(reviewed.document.working.items.find((item) => item.id === "i1")!.assumedQtyReviewed).toBe(true);
    expect(lockingCodes(reviewed.document)).not.toContain("assumed_qty_unreviewed");
  });

  it("lets a review be recorded while the item is still a draft", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1", { quantitySource: "assumed" })] }));
    const reviewed = reviewAssumedQuantity(document, "i1");
    expect(reviewed.ok).toBe(true);
    expect(reviewed.document.working.draftItems.find((draft) => draft.id === "i1")!.assumedQtyReviewed).toBe(true);
    const finalized = finalizeItems(reviewed.document, ["i1"]);
    expect(lockingCodes(finalized.document)).not.toContain("assumed_qty_unreviewed");
  });

  it("refuses to finalize a draft carrying an unreviewed item-scoped critical", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1", { confidence: 0.2 })] }));
    expect(finalizeItems(document, ["i1"]).ok).toBe(false);
    const blockers = validateWorkingBill(document.working).blockers;
    expect(blockers.finalization).toContain("review_required");
    expect(visibleFindings(document).map((finding) => finding.code)).toContain("ocr_critical_field_confidence");
  });

  it("materializes exactly qty units on finalize, deterministically indexed, unassigned and unacknowledged", () => {
    const finalized = finalizeItems(begin(parseFixture({ items: [parsedItem("i1", { qty: 3, unitPrice: 10_000, lineTotal: 30_000 })] })), ["i1"]);
    expect(finalized.ok).toBe(true);
    const units = finalized.document.working.itemUnits;
    expect(units.map((unit) => unit.unitIndex)).toEqual([0, 1, 2]);
    expect(units.map((unit) => unit.id)).toEqual(["unit:i1:0", "unit:i1:1", "unit:i1:2"]);
    expect(units.every((unit) => unit.confirmedUnassigned === false)).toBe(true);
    expect(finalized.document.working.assignments).toEqual([]);
    expect(finalized.document.working.items[0]!.lineTotal).toBe(30_000);
  });

  it("keeps the entity id through finalization and refuses to finalize something already finalized", () => {
    const finalized = finalizeItems(begin(), ["i1"]);
    expect(finalized.ok).toBe(true);
    expect(finalized.document.working.draftItems.map((draft) => draft.id)).toEqual(["i2"]);
    expect(finalized.document.working.items.map((item) => item.id)).toEqual(["i1"]);
    expect(finalized.document.working.itemUnits.map((unit) => unit.itemId)).toEqual(["i1", "i1"]);
    const again = finalizeItems(finalized.document, ["i1"]);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.reject.code).toBe("unknown_entity");
  });

  it("finalizes charges only when amount, type, sign and inclusion are all resolved", () => {
    const document = begin(parseFixture({ taxes: [taxFixture()], otherCharges: [otherFixture({ sign: "unknown" })] }));
    const bulk = finalizeAllResolvable(document);
    expect(bulk.ok).toBe(true);
    expect(bulk.document.working.charges).toEqual([]);
    expect(bulk.document.working.draftCharges.map((charge) => charge.type)).toEqual(["tax", "other"]);
    const blockers = bulk.document.billValidation.blockers;
    expect(blockers.locking).toEqual(
      expect.arrayContaining([
        { code: "tax_inclusion_unresolved", refs: ["t1", "o1"] },
        { code: "draft_charges_unresolved", refs: ["o1"] },
      ]),
    );
    expect(blockers.finalization).toEqual(expect.arrayContaining(["charge_sign_unresolved", "charge_inclusion_unresolved"]));

    const signed = setChargeSign(bulk.document, "o1", "add");
    expect(signed.ok).toBe(true);
    expect(lockingCodes(signed.document)).not.toContain("draft_charges_unresolved");
    const taxResolved = resolveChargeInclusion(signed.document, "t1", false);
    expect(taxResolved.ok).toBe(true);
    if (!taxResolved.ok) throw new Error("unreachable");
    // Only `o1` still needs a choice; the items did finalize, so `units_unassigned` is legitimately present.
    expect(taxResolved.document.billValidation.blockers.locking.find((b) => b.code === "tax_inclusion_unresolved")).toEqual({
      code: "tax_inclusion_unresolved",
      refs: ["o1"],
    });
    const included = resolveChargeInclusion(taxResolved.document, "o1", false);
    expect(lockingCodes(included.document)).not.toContain("tax_inclusion_unresolved");
    const finalized = committed(finalizeAllResolvable(included.document), "bulk finalize");
    expect(finalized.document.working.charges.map((charge) => charge.type)).toEqual(["tax", "other"]);
    expect(finalized.document.working.draftCharges).toEqual([]);
  });

  it("does not let a receipt-level arithmetic critical block a per-item finalize", () => {
    const document = begin();
    // Nothing is finalized yet, so the bill says ₹0 against a ₹420.50 print: critical, and deliberately not
    // a finalization gate — §6 line 464 keeps findings and blockers apart, and gating here would make it
    // impossible to assemble a bill at all (DECISIONS/0020 T6).
    const critical = visibleFindings(document).filter((finding) => finding.code === "arithmetic_total");
    expect(critical.length).toBe(1);
    expect(critical[0]!.severity).toBe("critical");
    const finalized = finalizeAllResolvable(document);
    expect(finalized.ok).toBe(true);
    expect(finalized.document.working.items.length).toBe(2);
  });

  it("bulk-finalizes exactly the resolvable drafts, in one transaction, and leaves the rest as drafts", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1"), parsedItem("i2", { unitPrice: null, priceSource: "unresolved" })] }));
    const bulk = committed(finalizeAllResolvable(document), "bulk finalize");
    expect(bulk.effects.finalizedItemIds).toEqual(["i1"]);
    expect(bulk.document.working.items.map((item) => item.id)).toEqual(["i1"]);
    expect(bulk.document.working.draftItems.map((draft) => draft.id)).toEqual(["i2"]);
    expect(bulk.document.revision).toBe(1);
  });
});

describe("DECISIONS/0020 T9/T11 — deletes, cascades and quantity changes", () => {
  it("deletes a draft with no cascade, and a later bulk finalize cannot resurrect it", () => {
    const deleted = committed(deleteItem(begin(), "i2"), "draft delete");
    expect(deleted.effects.removedUnitIds).toEqual([]);
    expect(deleted.document.working.draftItems.map((draft) => draft.id)).toEqual(["i1"]);
    const bulk = committed(finalizeAllResolvable(deleted.document), "bulk finalize");
    expect(bulk.effects.finalizedItemIds).toEqual(["i1"]);
    expect(bulk.document.working.items.map((item) => item.id)).toEqual(["i1"]);
    expect(bulk.document.working.draftItems).toEqual([]);
  });

  it("cascades a finalized item, its units and its assignments in one transaction, reporting what went", () => {
    const document = oneFinalizedItem(2, 10_000);
    const creatorId = document.working.bill.creatorId;
    const withAssignment = committed(runTransaction(document, assign("unit:i1:1", creatorId)), "assignment");
    const deleted = committed(deleteItem(withAssignment.document, "i1"), "finalized delete");
    expect(deleted.effects.removedUnitIds).toEqual(["unit:i1:0", "unit:i1:1"]);
    expect(deleted.effects.removedAssignments).toEqual([{ itemUnitId: "unit:i1:1", participantId: creatorId }]);
    expect(deleted.document.working.itemUnits).toEqual([]);
    expect(deleted.document.working.assignments).toEqual([]);
    expect(deleted.document.derived.calculatedItemsTotal).toBe(0);
    expect(deleted.document.working.bill.grandTotal).toBe(42_050);
    expect(deleted.document.derived.printedGrandTotal).toBe(42_050);
  });

  it("drops the highest-index units and their assignments when a quantity shrinks", () => {
    const document = oneFinalizedItem(3, 10_000);
    const creatorId = document.working.bill.creatorId;
    const withAssignment = committed(runTransaction(document, assign("unit:i1:2", creatorId)), "assignment");
    const shrunk = committed(setItemQuantity(withAssignment.document, "i1", 2), "quantity shrink");
    expect(shrunk.effects.removedUnitIds).toEqual(["unit:i1:2"]);
    expect(shrunk.effects.removedAssignments).toEqual([{ itemUnitId: "unit:i1:2", participantId: creatorId }]);
    expect(shrunk.document.working.itemUnits.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    expect(shrunk.document.working.items[0]!.lineTotal).toBe(20_000);
    expect(shrunk.document.working.items[0]!.detectedLineTotal).toBe(30_000);
    expect(shrunk.document.working.assignments).toEqual([]);
  });

  it("appends unassigned units when a quantity grows, without renumbering the existing ones", () => {
    const document = oneFinalizedItem(1, 10_000);
    const grown = setItemQuantity(document, "i1", 3);
    expect(grown.ok).toBe(true);
    expect(grown.document.working.itemUnits.map((unit) => unit.id)).toEqual(["unit:i1:0", "unit:i1:1", "unit:i1:2"]);
    expect(grown.document.working.itemUnits.every((unit) => unit.confirmedUnassigned === false)).toBe(true);
    expect(grown.document.working.assignments).toEqual([]);
    expect(grown.document.derived.shares).toBeNull();
    expect(grown.document.working.items[0]!.lineTotal).toBe(30_000);
  });

  it("keeps the unit-count invariant with no orphan assignment or adjustment line after every operation", () => {
    const document = oneFinalizedItem(2, 10_000);
    const acknowledged = acknowledgeUnassignedUnit(document, "unit:i1:1");
    expect(acknowledged.ok).toBe(true);
    expect(acknowledged.document.working.bill.adjustmentLines.map((line) => line.id)).toEqual(["adj:unit:i1:1"]);

    const paths = [setItemQuantity(document, "i1", 1), setItemQuantity(acknowledged.document, "i1", 1), deleteItem(acknowledged.document, "i1")];
    for (const result of paths) {
      expect(result.ok).toBe(true);
      const { items, itemUnits, assignments, bill } = result.document.working;
      const unitIds = new Set(itemUnits.map((unit) => unit.id));
      expect(assignments.every((assignment) => unitIds.has(assignment.itemUnitId))).toBe(true);
      expect(bill.adjustmentLines.every((line) => unitIds.has(line.id.slice("adj:".length)))).toBe(true);
      for (const item of items) {
        expect(itemUnits.filter((unit) => unit.itemId === item.id).map((unit) => unit.unitIndex)).toEqual(
          Array.from({ length: item.qty }, (_, index) => index),
        );
      }
    }

    // The acknowledged unit was the highest index, so shrinking drops it and its line with it.
    expect(paths[1]!.document.working.bill.adjustmentLines).toEqual([]);
    expect(paths[2]!.document.working.bill.adjustmentLines).toEqual([]);
  });

  it("deletes a charge with no cascade, from either tier", () => {
    const document = begin(parseFixture({ taxes: [taxFixture()] }));
    const deleted = deleteCharge(document, "t1");
    expect(deleted.ok).toBe(true);
    expect(deleted.document.working.draftCharges).toEqual([]);
    expect(deleted.document.working.charges).toEqual([]);
    const finalized = finalizeAllResolvable(resolveChargeInclusion(document, "t1", false).document);
    const deletedFinal = deleteCharge(finalized.document, "t1");
    expect(deletedFinal.ok).toBe(true);
    expect(deletedFinal.document.working.charges).toEqual([]);
  });
});

describe("DECISIONS/0020 T8 — validateWorkingBill's findings and blockers", () => {
  const LOCKING = [
    "draft_items_unresolved",
    "draft_charges_unresolved",
    "tax_inclusion_unresolved",
    "units_unassigned",
    "assumed_qty_unreviewed",
    "grand_total_missing",
    "payer_missing",
    "unclassified_rows_unreviewed",
    "negative_share_after_discount",
  ] as const;

  it("returns §10's shape with no field added, and only the pinned vocabulary", () => {
    const result = validateWorkingBill(begin().working);
    expect(Object.keys(result).sort()).toEqual(["blockers", "findings"]);
    expect(Object.keys(result.blockers).sort()).toEqual(["assignment", "finalization", "locking", "unitCreation"]);
    const unitCreation = new Set(["item_not_finalized", "qty_unresolved", "qty_invalid"]);
    const assignment = new Set(["unit_missing", "participant_unknown", "assignment_duplicate"]);
    const finalization = new Set([
      "name_missing",
      "price_unresolved",
      "qty_unresolved",
      "qty_invalid",
      "review_required",
      "charge_amount_unresolved",
      "charge_type_unresolved",
      "charge_sign_unresolved",
      "charge_inclusion_unresolved",
    ]);
    expect(result.blockers.unitCreation.every((code) => unitCreation.has(code))).toBe(true);
    expect(result.blockers.assignment.every((code) => assignment.has(code))).toBe(true);
    expect(result.blockers.finalization.every((code) => finalization.has(code))).toBe(true);
    expect(result.blockers.locking.every((blocker) => LOCKING.includes(blocker.code))).toBe(true);
    // Core's finding, not this function's: blocking is expressed by a blocker, extraction by core.
    expect(result.findings.map((finding) => finding.code)).not.toContain("qty_assumed");
  });

  it("emits eight of §10's nine locking blockers from one bill, with refs", () => {
    const document = begin(
      parseFixture({
        items: [parsedItem("i1", { qty: null, quantitySource: "unresolved" }), parsedItem("i2", { quantitySource: "assumed" })],
        taxes: [taxFixture()],
        otherCharges: [otherFixture()],
        grandTotal: null,
        grandTotalSource: "unresolved",
        unclassifiedRows: [ambiguousRow("u1")],
      }),
    );
    const finalized = finalizeAllResolvable(document);
    const payerGone = runTransaction(finalized.document, (working) => ({ ...working, bill: { ...working.bill, payerId: "ghost" } }));
    expect(payerGone.ok).toBe(true);
    if (!payerGone.ok) throw new Error("unreachable");
    expect(lockingCodes(payerGone.document).sort()).toEqual(
      [
        "assumed_qty_unreviewed",
        "draft_charges_unresolved",
        "draft_items_unresolved",
        "grand_total_missing",
        "payer_missing",
        "tax_inclusion_unresolved",
        "unclassified_rows_unreviewed",
        "units_unassigned",
      ].sort(),
    );
    expect(payerGone.document.billValidation.blockers.locking.find((b) => b.code === "payer_missing")!.refs).toEqual(["ghost"]);
  });

  it("cannot assert a negative share at the same time as unassigned units, which is why the ninth needs its own state", () => {
    const codes = lockingCodes(beginFinalized(parseFixture({ discount: 1_000_000 })));
    expect(codes).toContain("units_unassigned");
    expect(codes).not.toContain("negative_share_after_discount");
    expect(codes).not.toContain("draft_items_unresolved");
  });

  it("claims an ambiguous row only while a live draft reads the same source line", () => {
    const claimed = begin(parseFixture({ unclassifiedRows: [ambiguousRow("u1", { sourceLineIds: ["line-i2"] })] }));
    expect(lockingCodes(claimed)).not.toContain("unclassified_rows_unreviewed");
    const unclaimed = committed(deleteItem(claimed, "i2"), "draft delete");
    expect(lockingCodes(unclaimed.document)).toContain("unclassified_rows_unreviewed");

    const orphan = begin(parseFixture({ unclassifiedRows: [ambiguousRow("u9")] }));
    expect(lockingCodes(orphan)).toContain("unclassified_rows_unreviewed");
    expect(
      orphan.billValidation.blockers.locking.find((blocker) => blocker.code === "unclassified_rows_unreviewed")!.refs,
    ).toEqual(["u9"]);
  });

  it("names the entities behind a blocker through refs rather than prose", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1", { unitPrice: null, priceSource: "unresolved" })] }));
    const blocker = validateWorkingBill(document.working).blockers.locking.find((b) => b.code === "draft_items_unresolved");
    expect(blocker!.refs).toEqual(["i1"]);
  });

  it("drops core's arithmetic once an edit made it stale, and keeps the extraction evidence", () => {
    const document = beginFinalized(parseFixture({ subtotal: 40_000, subtotalSource: "detected" }));
    expect(validate(document.working.parseResult!).findings.map((f) => f.code)).toContain("arithmetic_item_sum");

    const edited = setItemPrice(document, "i1", 10_000);
    const shown = visibleFindings(edited.document).map((finding) => finding.code);
    // 2 × 10,000 + 10,000 = 30,000 against a printed 40,000: under, so an incomplete list, not a contradiction.
    expect(shown).toContain("items_may_be_missing");
    expect(shown).not.toContain("arithmetic_item_sum");
    expect(edited.document.billValidation.findings.map((f) => f.code)).toContain("items_may_be_missing");
    expect(shown).toContain("confidence_unavailable");
  });

  it("keeps severity and blocking as separate systems", () => {
    const document = begin(parseFixture({ items: [parsedItem("i1", { quantitySource: "assumed" }), parsedItem("i2", { quantitySource: "assumed" })] }));
    const codes = visibleFindings(document).map((finding) => finding.code);
    // A minor extraction warning that blocks a specific action (§6 line 394).
    expect(codes).toContain("qty_assumed");
    expect(lockingCodes(document)).toContain("assumed_qty_unreviewed");
    // A receipt-level critical that blocks nothing at all (§6 line 464).
    expect(codes).toContain("arithmetic_total");
    expect(lockingCodes(document)).not.toContain("arithmetic_total");
    expect(document.working.parseValidation!.findings.find((f) => f.code === "qty_assumed")!.severity).toBe("minor");
  });
});

describe("business.md §5 — the text field is the only place a float could enter the money", () => {
  it("parses rupee text into exact integer paise without multiplying by 100", () => {
    expect(parsePaiseInput("4.50")).toBe(450);
    // The float trap this exists to avoid: `Math.round(100.10 * 100)` is 10009, not 10010.
    expect(parsePaiseInput("100.10")).toBe(10_010);
    expect(parsePaiseInput("0.43")).toBe(43);
    expect(parsePaiseInput("-0.43")).toBe(-43);
    expect(parsePaiseInput("7")).toBe(700);
    expect(parsePaiseInput("7.5")).toBe(750);
    expect(parsePaiseInput("1,234.56")).toBe(123_456);
    expect(parsePaiseInput(" 42050 ")).toBe(4_205_000);
  });

  it("leaves a blank field unresolved and hands an unparseable one to the seam's own rejection", () => {
    expect(parsePaiseInput("")).toBeNull();
    expect(parsePaiseInput("   ")).toBeNull();
    // Three decimals are not a paise amount, and neither is a word: both become NaN, which `setItemPrice`
    // rejects as `invalid_amount` rather than being silently rounded (DECISIONS/0020 T1).
    expect(parsePaiseInput("4.567")).toBeNaN();
    expect(parsePaiseInput("abc")).toBeNaN();
    expect(parsePaiseInput(".")).toBeNaN();
    expect(parsePaiseInput("4.")).toBe(400);
    const rejected = setItemPrice(begin(), "i1", parsePaiseInput("4.567") as number);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("unreachable");
    expect(rejected.reject.code).toBe("invalid_amount");
  });

  it("formats an exact paise amount as an exact rupee string, in en-IN grouping", () => {
    expect(formatPaise(450)).toBe("₹4.50");
    expect(formatPaise(42_050)).toBe("₹420.50");
    expect(formatPaise(-43)).toBe("-₹0.43");
    expect(formatPaise(12_345_678)).toBe("₹1,23,456.78");
    expect(formatPaiseOrNull(null)).toBe("unresolved");
    expect(() => formatPaise(4.5)).toThrow("integer paise");
  });
});

describe("DECISIONS/0020 T13 — hand-added lines follow the extracted ones' rules", () => {
  it("adds a hand-typed charge under the same gates as an extracted one", () => {
    const added = addManualCharge(begin(), { label: "Parcel", type: "other", amount: 500, otherSign: "add" });
    expect(added.ok).toBe(true);
    const draft = added.document.working.draftCharges.at(-1)!;
    expect(draft.manuallyAdded).toBe(true);
    expect(draft.source).toBe("user_confirmed");
    expect(draft.included).toBeNull();
    const bulk = finalizeAllResolvable(added.document);
    expect(bulk.document.working.charges.map((charge) => charge.label)).not.toContain("Parcel");
    expect(lockingCodes(bulk.document)).toContain("tax_inclusion_unresolved");

    const resolved = resolveChargeInclusion(bulk.document, draft.id, false);
    const finalized = finalizeAllResolvable(resolved.document);
    expect(finalized.document.working.charges.map((charge) => charge.label)).toContain("Parcel");
    expect(finalized.document.derived.chargeEffectsTotal).toBe(500);
  });

  it("resolves a charge's type and amount as user-confirmed edits, and only then lets it finalize", () => {
    const document = begin(parseFixture({ otherCharges: [otherFixture({ amount: null, sign: "unknown" })] }));
    const typed = setChargeType(document, "o1", "tip");
    expect(typed.ok).toBe(true);
    const amount = setChargeAmount(typed.document, "o1", 1_000);
    expect(amount.ok).toBe(true);
    expect(amount.document.working.draftCharges[0]!.source).toBe("user_confirmed");
    expect(amount.document.working.draftCharges[0]!.type).toBe("tip");
    expect(amount.document.working.draftCharges[0]!.otherSign).toBeNull();
    const blocked = finalizeAllResolvable(amount.document);
    expect(blocked.document.working.charges).toEqual([]);

    const included = resolveChargeInclusion(amount.document, "o1", false);
    const finalized = finalizeAllResolvable(included.document);
    expect(finalized.document.working.charges.map((charge) => charge.type)).toEqual(["tip"]);
    expect(finalized.document.derived.chargeEffectsTotal).toBe(1_000);
  });

  it("treats a manual item exactly like an extracted one once resolved: same gates, same finalize, same units", () => {
    const added = addManualItem(begin(), { name: "Extra Naan", qty: null, unitPrice: null });
    expect(added.ok).toBe(true);
    const manualId = added.document.working.draftItems.at(-1)!.id;
    expect(manualId).toBe("m1");
    expect(finalizeAllResolvable(added.document).document.working.items.map((item) => item.id)).not.toContain(manualId);

    const quantity = setItemQuantity(added.document, manualId, 2);
    const price = setItemPrice(quantity.document, manualId, 2_500);
    const finalized = finalizeAllResolvable(price.document);
    const item = finalized.document.working.items.find((entry) => entry.id === manualId)!;
    expect(item.lineTotal).toBe(5_000);
    expect(item.detectedLineTotal).toBeNull();
    expect(finalized.document.working.itemUnits.filter((unit) => unit.itemId === manualId).map((unit) => unit.unitIndex)).toEqual([0, 1]);
    expect(finalized.document.derived.calculatedItemsTotal).toBe(74_100 + 5_000);
    const second = addManualItem(finalized.document, { name: "Lassi", qty: 1, unitPrice: 1_000 });
    expect(second.document.working.draftItems.at(-1)!.id).toBe("m2");
  });
});
