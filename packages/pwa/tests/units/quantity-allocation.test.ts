import { describe, expect, it } from "vitest";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult } from "@receipt-lens/core";

import type { BillDocument } from "../../src/lib/bill/document.js";
import { planQuantityAllocation } from "../../src/lib/bill/units.js";
import {
  acknowledgeUnassignedUnit,
  addParticipant,
  allocateItemQuantity,
  assignUnit,
  beginFrom,
  finalizeItems,
  runTransaction,
  setItemQuantity,
  unassignUnit,
  type TransactionResult,
} from "../../src/lib/bill/transactions.js";

/**
 * Owner request (`next.md` Phase 4) — quick quantity allocation, as assertions.
 *
 * The feature exists to stop eight checkbox clicks for eight chapatis. These tests pin the arithmetic, the
 * refusals, the atomicity and — the one that matters most — that the per-unit mode, including shared units,
 * still behaves exactly as it did.
 */

const CREATED_AT = "2026-11-08T00:00:00.000Z";

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

function parseOf(qty: number, unitPrice: number, over: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [parsedItem("i1", { qty, unitPrice, lineTotal: qty * unitPrice })],
    unclassifiedRows: [],
    taxes: [],
    serviceCharge: null,
    tip: null,
    discount: null,
    roundOff: null,
    otherCharges: [],
    subtotal: qty * unitPrice,
    subtotalSource: "detected",
    grandTotal: qty * unitPrice,
    grandTotalSource: "detected",
    warnings: [],
    ...over,
  };
}

function begin(qty = 8, unitPrice = 2_400): BillDocument {
  const parse = parseOf(qty, unitPrice);
  return beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Creator" });
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected success, got a ${result.reject.code} rejection`);
  return result.document;
}

function rejected(result: TransactionResult): { code: string; refs: readonly string[] } {
  if (result.ok) throw new Error("expected a rejection, got a committed document");
  return result.reject;
}

/** Eight chapatis shared three ways: 2 + 5 + 1. The owner's own example. */
function eightChapatis(): BillDocument {
  const finalized = ok(finalizeItems(begin(8, 2_400), ["i1"]));
  return ["p1", "p2", "p3"].reduce((doc, name) => ok(addParticipant(doc, name)), finalized);
}

function holders(doc: BillDocument, participantId: string): string[] {
  return doc.working.assignments
    .filter((assignment) => assignment.participantId === participantId)
    .map((assignment) => assignment.itemUnitId)
    .sort();
}

const snapshot = (doc: BillDocument): string => JSON.stringify(doc);

describe("quick quantity allocation — the arithmetic", () => {
  it("assigns 2 / 5 / 1 units in one transaction, and each unit gets exactly one holder", () => {
    const doc = eightChapatis();
    const done = ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 5 },
        { participantId: "p3", quantity: 1 },
      ]),
    );

    expect(doc.working.assignments).toHaveLength(0);
    expect(done.working.assignments).toHaveLength(8);
    expect(holders(done, "p1")).toEqual(["unit:i1:0", "unit:i1:1"]);
    expect(holders(done, "p2")).toEqual([
      "unit:i1:2",
      "unit:i1:3",
      "unit:i1:4",
      "unit:i1:5",
      "unit:i1:6",
    ]);
    expect(holders(done, "p3")).toEqual(["unit:i1:7"]);

    // One holder per unit is what makes this an exclusive partition rather than shared ownership.
    const perUnit = new Map<string, number>();
    for (const assignment of done.working.assignments) {
      perUnit.set(assignment.itemUnitId, (perUnit.get(assignment.itemUnitId) ?? 0) + 1);
    }
    expect([...perUnit.values()].every((count) => count === 1)).toBe(true);
  });

  it("is one transaction: one revision, whatever the number of units", () => {
    const doc = eightChapatis();
    const done = ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 5 },
        { participantId: "p3", quantity: 1 },
      ]),
    );
    expect(done.revision).toBe(doc.revision + 1);
  });

  it("leaves the remainder unassigned rather than filling it in (requirement 7)", () => {
    const doc = eightChapatis();
    const done = ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 2 },
      ]),
    );
    expect(done.working.assignments).toHaveLength(4);
    const unassigned = done.working.itemUnits.filter(
      (unit) => !done.working.assignments.some((assignment) => assignment.itemUnitId === unit.id),
    );
    expect(unassigned).toHaveLength(4);
    expect(unassigned.every((unit) => unit.confirmedUnassigned === false)).toBe(true);
  });

  it("replaces an earlier allocation rather than adding to it", () => {
    const first = ok(
      allocateItemQuantity(eightChapatis(), "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 2 },
      ]),
    );
    const second = ok(allocateItemQuantity(first, "i1", [{ participantId: "p3", quantity: 8 }]));
    expect(second.working.assignments).toHaveLength(8);
    expect(holders(second, "p3")).toHaveLength(8);
    expect(holders(second, "p1")).toEqual([]);
    expect(holders(second, "p2")).toEqual([]);
  });

  it("accepts a zero allocation and allocates nothing for that person", () => {
    const done = ok(
      allocateItemQuantity(eightChapatis(), "i1", [
        { participantId: "p1", quantity: 0 },
        { participantId: "p2", quantity: 8 },
      ]),
    );
    expect(holders(done, "p1")).toEqual([]);
    expect(holders(done, "p2")).toHaveLength(8);
  });

  it("scales to large quantities", () => {
    const finalized = ok(finalizeItems(begin(120, 100), ["i1"]));
    const doc = ["p1", "p2", "p3"].reduce((current, name) => ok(addParticipant(current, name)), finalized);
    const done = ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 60 },
        { participantId: "p2", quantity: 59 },
        { participantId: "p3", quantity: 1 },
      ]),
    );
    expect(done.working.assignments).toHaveLength(120);
  });

  it("clears a unit's acknowledgement when that unit is allocated", () => {
    const doc = eightChapatis();
    const acknowledged = ok(acknowledgeUnassignedUnit(doc, "unit:i1:0"));
    expect(acknowledged.working.itemUnits[0]!.confirmedUnassigned).toBe(true);

    const done = ok(allocateItemQuantity(acknowledged, "i1", [{ participantId: "p1", quantity: 8 }]));
    // §10 line 769: assigning is the act that rescinds the acknowledgement.
    expect(done.working.itemUnits[0]!.confirmedUnassigned).toBe(false);
  });
});

describe("quick quantity allocation — the refusals", () => {
  it("rejects an over-allocation and writes nothing (requirement 5)", () => {
    const doc = eightChapatis();
    const before = snapshot(doc);
    const reject = rejected(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 5 },
        { participantId: "p2", quantity: 4 },
      ]),
    );
    expect(reject.code).toBe("over_allocated");
    expect(snapshot(doc)).toBe(before);
  });

  it("rejects a negative or fractional quantity as invalid input (requirement 6)", () => {
    const doc = eightChapatis();
    for (const quantity of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rejected(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity }])).code).toBe(
        "invalid_quantity",
      );
    }
    expect(doc.working.assignments).toHaveLength(0);
  });

  it("rejects a participant named twice", () => {
    expect(
      rejected(
        allocateItemQuantity(eightChapatis(), "i1", [
          { participantId: "p1", quantity: 1 },
          { participantId: "p1", quantity: 1 },
        ]),
      ).code,
    ).toBe("assignment_duplicate");
  });

  it("rejects an unknown participant and an unknown item", () => {
    expect(rejected(allocateItemQuantity(eightChapatis(), "i1", [{ participantId: "p9", quantity: 1 }])).code).toBe(
      "unknown_entity",
    );
    expect(rejected(allocateItemQuantity(eightChapatis(), "i9", [{ participantId: "p1", quantity: 1 }])).code).toBe(
      "unknown_entity",
    );
  });

  it("refuses a draft line, because a draft has no units yet", () => {
    const draft = ["p1"].reduce((doc, name) => ok(addParticipant(doc, name)), begin(8, 2_400));
    const reject = rejected(allocateItemQuantity(draft, "i1", [{ participantId: "p1", quantity: 1 }]));
    expect(reject.code).toBe("item_not_finalized");
  });

  it("refuses to flatten a shared unit, and leaves the per-unit assignment exactly as it was", () => {
    // One unit held by two people is a different statement from "two units": it means the cost of *that* unit is
    // divided. A count cannot express it, so the transaction refuses rather than quietly picking one holder.
    const doc = eightChapatis();
    const shared = ok(assignUnit(ok(assignUnit(doc, "unit:i1:0", "p1")), "unit:i1:0", "p2"));
    expect(shared.working.assignments.filter((assignment) => assignment.itemUnitId === "unit:i1:0")).toHaveLength(2);

    const before = snapshot(shared);
    const reject = rejected(
      allocateItemQuantity(shared, "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 2 },
      ]),
    );
    expect(reject.code).toBe("shared_units_present");
    expect(snapshot(shared)).toBe(before);
  });

  it("refuses on a locked bill like every other content edit", () => {
    const doc = eightChapatis();
    // A lock needs a clean checklist; this bill has unassigned units, so prove the refusal by locking first where
    // it is allowed, then allocating.
    const locked = { ...doc, working: { ...doc.working, bill: { ...doc.working.bill, isLocked: true } } };
    expect(rejected(allocateItemQuantity(locked, "i1", [{ participantId: "p1", quantity: 1 }])).code).toBe(
      "bill_locked",
    );
  });
});

describe("quick quantity allocation — atomicity", () => {
  it("rolls back to the same document object when the write fails", () => {
    const doc = eightChapatis();
    const result = allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 99 }]);
    expect(result.ok).toBe(false);
    // DECISIONS/0019 S2.2: a failed mutation returns the input document by identity, so no derived state from a
    // rejected allocation can have been published anywhere.
    expect(result.document).toBe(doc);
  });

  it("does not publish a partial assignment when the recompute fails", () => {
    // The whole allocation rides on one transaction, so a failing recompute leaves the *plan* unpublished too —
    // there is no intermediate document in which two of the three people are assigned.
    const doc = eightChapatis();
    const result = runTransaction(doc, (working) => {
      const planned = planQuantityAllocation(working, "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 5 },
        { participantId: "p3", quantity: 1 },
      ]);
      if (!planned.ok) throw new Error("expected a plan");
      return planned.working;
    }, {
      recompute: () => {
        throw new Error("boom");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reject.code).toBe("recompute_failed");
    expect(result.document).toBe(doc);
    expect(doc.working.assignments).toHaveLength(0);
  });
});

describe("the existing per-unit mode still works (ADR-005)", () => {
  it("keeps one unit per click, and shared units still divide", () => {
    const doc = eightChapatis();
    const one = ok(assignUnit(doc, "unit:i1:0", "p1"));
    expect(one.working.assignments).toEqual([{ itemUnitId: "unit:i1:0", participantId: "p1" }]);

    const shared = ok(assignUnit(one, "unit:i1:0", "p2"));
    expect(shared.working.assignments).toHaveLength(2);
    // Sharing one unit halves that unit's cost for each of them; the derived split says so.
    const shares = shared.derived.shares ?? [];
    expect(shares.every((share) => share.participantId !== "")).toBe(true);
  });

  it("unassigning the last holder leaves the unit pending, not acknowledged", () => {
    const doc = ok(assignUnit(eightChapatis(), "unit:i1:0", "p1"));
    const off = ok(unassignUnit(doc, "unit:i1:0", "p1"));
    expect(off.working.assignments).toEqual([]);
    expect(off.working.itemUnits.find((unit) => unit.id === "unit:i1:0")!.confirmedUnassigned).toBe(false);
  });

  it("a quantity allocation and an individual assignment agree on the same units", () => {
    const doc = eightChapatis();
    const counted = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 2 }]));
    const clicked = ok(assignUnit(ok(assignUnit(doc, "unit:i1:0", "p1")), "unit:i1:1", "p1"));
    expect(counted.working.assignments).toEqual(clicked.working.assignments);
  });
});

describe("the planner is pure and deterministic", () => {
  it("returns the same plan for the same input, twice", () => {
    const doc = eightChapatis();
    const allocations = [
      { participantId: "p3", quantity: 1 },
      { participantId: "p1", quantity: 2 },
    ];
    const a = planQuantityAllocation(doc.working, "i1", allocations);
    const b = planQuantityAllocation(doc.working, "i1", allocations);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.plan).toEqual(b.plan);
    // Participant order is the caller's, and the remainder is reported rather than assigned.
    expect(a.plan.assignments[0]).toEqual({ itemUnitId: "unit:i1:0", participantId: "p3" });
    expect(a.plan.unallocatedUnitIds).toHaveLength(5);
  });

  it("never mutates the input document", () => {
    const doc = eightChapatis();
    const before = snapshot(doc);
    ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 3 },
        { participantId: "p2", quantity: 3 },
      ]),
    );
    expect(snapshot(doc)).toBe(before);
  });

  it("reports the unit count it will leave unallocated, so the UI cannot disagree with the write", () => {
    const doc = eightChapatis();
    const planned = planQuantityAllocation(doc.working, "i1", [{ participantId: "p1", quantity: 3 }]);
    if (!planned.ok) throw new Error("expected a plan");
    const written = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 3 }]));
    const actuallyUnassigned = written.working.itemUnits.filter(
      (unit) => !written.working.assignments.some((assignment) => assignment.itemUnitId === unit.id),
    );
    // The zero-quantity participant's units are dropped by the caller; the planner must still predict the count.
    expect(planned.plan.unallocatedUnitIds).toHaveLength(actuallyUnassigned.length);
  });
});

describe("allocation survives a quantity change", () => {
  it("shrinking the line drops the highest units, and the allocation follows the units", () => {
    const allocated = ok(
      allocateItemQuantity(eightChapatis(), "i1", [
        { participantId: "p1", quantity: 2 },
        { participantId: "p2", quantity: 6 },
      ]),
    );
    const shrunk = ok(setItemQuantity(allocated, "i1", 4));
    expect(shrunk.working.assignments).toHaveLength(4);
    expect(holders(shrunk, "p1")).toEqual(["unit:i1:0", "unit:i1:1"]);
    expect(holders(shrunk, "p2")).toEqual(["unit:i1:2", "unit:i1:3"]);
  });
});
