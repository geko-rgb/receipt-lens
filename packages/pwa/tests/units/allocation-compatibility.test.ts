import { describe, expect, it } from "vitest";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult } from "@receipt-lens/core";

import type { BillDocument } from "../../src/lib/bill/document.js";
import { planQuantityAllocation, previewQuantityChange } from "../../src/lib/bill/units.js";
import {
  acknowledgeUnassignedUnit,
  addParticipant,
  allocateItemQuantity,
  assignUnit,
  beginFrom,
  finalizeItems,
  setItemQuantity,
  unassignUnit,
  type TransactionResult,
} from "../../src/lib/bill/transactions.js";
import { validateWorkingBill } from "../../src/lib/validate-bill.js";

/**
 * The five compatibility questions the owner asked before signing off on Phase 4, each as an assertion:
 *
 * 1. a one-unit line still gets the original checkbox interface (it is the default, not a mapping to a table),
 * 2. "Mark unassigned" still works on what quantity allocation left behind,
 * 3. an item whose units are shared is still managed per unit, because quantity allocation refuses it,
 * 4. typing counts and cancelling changes no assignment,
 * 5. saving the same allocation twice creates no duplicate.
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

function parseOf(qty: number, unitPrice: number): ParseResult {
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
  };
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected success, got a ${result.reject.code} rejection`);
  return result.document;
}

function rejected(result: TransactionResult): { code: string; refs: readonly string[] } {
  if (result.ok) throw new Error("expected a rejection, got a committed document");
  return result.reject;
}

function bill(qty: number, names: readonly string[] = ["p1", "p2"]): BillDocument {
  const parse = parseOf(qty, 10_000);
  const begun = beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Creator" });
  const finalized = ok(finalizeItems(begun, ["i1"]));
  return names.reduce((doc, name) => ok(addParticipant(doc, name)), finalized);
}

/** The exact expression `Units.svelte`'s `modeOf` uses, so the interface's default is pinned, not described. */
function defaultMode(doc: BillDocument, itemId: string): "unit" | "quantity" {
  const units = doc.working.itemUnits.filter((unit) => unit.itemId === itemId).length;
  return units > 1 ? "quantity" : "unit";
}

/** The lock checklist itself, not a second opinion about it (`validate-bill.ts` line 211). */
const blockersOf = (doc: BillDocument) =>
  validateWorkingBill(doc.working).blockers.locking.map((blocker) => blocker.code);

describe("1 — the owner's own rule: one unit is a checkbox, more than one is a table", () => {
  it("offers the checkbox panel for exactly one unit", () => {
    const doc = bill(1);
    expect(doc.working.itemUnits).toHaveLength(1);
    expect(defaultMode(doc, "i1")).toBe("unit");
    // The one unit is the whole interaction, and the shipped operations still work on it.
    const assigned = ok(assignUnit(doc, "unit:i1:0", "p1"));
    expect(assigned.working.assignments).toEqual([{ itemUnitId: "unit:i1:0", participantId: "p1" }]);
    expect(ok(unassignUnit(assigned, "unit:i1:0", "p1")).working.assignments).toHaveLength(0);
  });

  it("offers the quantity table from two units upward — 2, 6, 7 and 8 alike", () => {
    // The rule has one boundary and it is 1. Anything above it is a count, so a two-unit line is a table too:
    // six checkbox rows for six chapatis is the friction the feature exists to remove, and two is already two
    // rows per participant for something one number answers.
    for (const qty of [2, 6, 7, 8]) {
      const doc = bill(qty);
      expect(doc.working.itemUnits).toHaveLength(qty);
      expect(defaultMode(doc, "i1")).toBe("quantity");
    }
  });

  it("keeps the checkbox interface reachable for every one of those quantities", () => {
    // The default moved; nothing was taken away. The per-unit panel is still what the creator switches to, and
    // what a shared unit needs.
    for (const qty of [1, 2, 6, 7, 8]) {
      const doc = bill(qty);
      expect(doc.working.itemUnits).toHaveLength(qty);
      // Every unit is independently assignable through the shipped call, whatever the default panel is.
      const all = doc.working.itemUnits.reduce((current, unit) => ok(assignUnit(current, unit.id, "p1")), doc);
      expect(all.working.assignments).toHaveLength(qty);
      expect(holdersOf(all, "p1")).toHaveLength(qty);
    }
  });

  it("still accepts an allocation of one, so the table is reachable by choice on a one-unit line", () => {
    const doc = bill(1);
    const done = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 1 }]));
    expect(done.working.assignments).toEqual([{ itemUnitId: "unit:i1:0", participantId: "p1" }]);
  });

  it("allocates 2, 6, 7 and 8 units through the table with the same arithmetic", () => {
    for (const qty of [2, 6, 7, 8]) {
      const doc = bill(qty);
      const done = ok(
        allocateItemQuantity(doc, "i1", [
          { participantId: "p1", quantity: qty - 1 },
          { participantId: "p2", quantity: 1 },
        ]),
      );
      expect(done.working.assignments).toHaveLength(qty);
      expect(holdersOf(done, "p1")).toHaveLength(qty - 1);
      expect(holdersOf(done, "p2")).toEqual([`unit:i1:${qty - 1}`]);
    }
  });
});

describe("2 — 'Mark unassigned' works on what quantity allocation left behind", () => {
  it("leaves the remainder unassigned and unacknowledged, and blocks the lock until it is decided", () => {
    const doc = bill(4);
    const done = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 1 }]));

    const remainder = done.working.itemUnits.filter((unit) => unit.unitIndex > 0);
    expect(remainder.map((unit) => unit.id)).toEqual(["unit:i1:1", "unit:i1:2", "unit:i1:3"]);
    // Nothing is filled in on the creator's behalf: the three leftovers have no holder and no acknowledgment.
    expect(done.working.assignments).toHaveLength(1);
    expect(remainder.every((unit) => !unit.confirmedUnassigned)).toBe(true);
    expect(blockersOf(done)).toContain("units_unassigned");
  });

  it("acknowledges each leftover through the shipped operation, and only then clears the blocker", () => {
    const doc = bill(3);
    let current = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 1 }]));

    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:1"));
    expect(blockersOf(current)).toContain("units_unassigned");
    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:2"));
    expect(blockersOf(current)).not.toContain("units_unassigned");

    const acknowledged = current.working.itemUnits.filter((unit) => unit.confirmedUnassigned);
    expect(acknowledged.map((unit) => unit.id)).toEqual(["unit:i1:1", "unit:i1:2"]);
    // The allocated unit is neither acknowledged nor holding a stale flag.
    expect(current.working.itemUnits.find((unit) => unit.id === "unit:i1:0")!.confirmedUnassigned).toBe(false);
  });

  it("rescinds the acknowledgment when a later allocation claims that unit", () => {
    // §10 line 769: assigning is the act that rescinds an acknowledgement. Otherwise a unit would be both
    // "confirmed unassigned" and somebody's — a state the lock checklist could never resolve.
    const doc = bill(3);
    let current = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 1 }]));
    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:1"));
    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:2"));
    expect(blockersOf(current)).not.toContain("units_unassigned");

    const claimed = ok(allocateItemQuantity(current, "i1", [{ participantId: "p2", quantity: 3 }]));
    expect(claimed.working.itemUnits.every((unit) => !unit.confirmedUnassigned)).toBe(true);
    expect(holdersOf(claimed, "p2")).toEqual(["unit:i1:0", "unit:i1:1", "unit:i1:2"]);
  });

  it("acknowledging a leftover does not disturb the unit that was allocated", () => {
    const doc = bill(3);
    let current = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 2 }]));
    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:2"));
    expect(holdersOf(current, "p1")).toEqual(["unit:i1:0", "unit:i1:1"]);
    expect(current.working.itemUnits.find((unit) => unit.id === "unit:i1:2")!.confirmedUnassigned).toBe(true);
  });
});

describe("3 — a shared item is still managed through the original per-unit interface", () => {
  function shared(): BillDocument {
    // One unit, two holders: the division case the per-unit interface exists for.
    const doc = bill(3);
    const first = ok(assignUnit(doc, "unit:i1:0", "p1"));
    return ok(assignUnit(first, "unit:i1:0", "p2"));
  }

  it("refuses quantity allocation and names the per-unit mode, without being asked to flatten the share", () => {
    const doc = shared();
    const rejection = rejected(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 1 }]));
    expect(rejection.code).toBe("shared_units_present");
    // The refusal is not a treatment: nothing about the shared unit changed.
    expect(holdersOf(doc, "p1")).toEqual(["unit:i1:0"]);
    expect(holdersOf(doc, "p2")).toEqual(["unit:i1:0"]);
  });

  it("keeps the individual operations available on exactly those units", () => {
    const doc = bill(3, ["p1", "p2", "p3"]);
    const one = ok(assignUnit(doc, "unit:i1:0", "p1"));
    const two = ok(assignUnit(one, "unit:i1:0", "p2"));
    // Three holders on one unit: the billed division case. Only the per-unit interface can express it.
    const three = ok(assignUnit(two, "unit:i1:0", "p3"));
    expect(three.working.assignments).toHaveLength(3);
    expect(rejected(allocateItemQuantity(three, "i1", [{ participantId: "p1", quantity: 1 }])).code).toBe(
      "shared_units_present",
    );

    // Removing one holder is a per-unit call too, and it leaves the other two sharing the unit.
    const removed = ok(unassignUnit(three, "unit:i1:0", "p2"));
    expect(holdersOf(removed, "p2")).toEqual([]);
    expect(holdersOf(removed, "p1")).toEqual(["unit:i1:0"]);
    expect(holdersOf(removed, "p3")).toEqual(["unit:i1:0"]);
    // The two units nobody touched are what keeps the lock closed; the *shared* unit is never among them, because
    // a unit with holders is assigned by definition.
    const pending = validateWorkingBill(removed.working).blockers.locking.find((b) => b.code === "units_unassigned");
    expect(pending?.refs).toEqual(["unit:i1:1", "unit:i1:2"]);
  });

  it("never lets an acknowledgement sit on a unit that still has holders", () => {
    const doc = shared();
    // The one-unit-two-holders state is a *licit* state; acknowledging it as unassigned is not.
    expect(rejected(acknowledgeUnassignedUnit(doc, "unit:i1:0")).code).toBe("unit_assigned");
  });

  it("allocates the other items on the same bill while the shared one is untouched", () => {
    const doc = twoItemBill();
    const first = ok(assignUnit(doc, "unit:i1:0", "p1"));
    const second = ok(assignUnit(first, "unit:i1:0", "p2"));

    // The refusal is per item: the shared line is refused, the plain line on the same bill is not.
    expect(rejected(allocateItemQuantity(second, "i1", [{ participantId: "p1", quantity: 1 }])).code).toBe(
      "shared_units_present",
    );
    const allocated = ok(allocateItemQuantity(second, "i2", [{ participantId: "p1", quantity: 2 }]));
    expect(holdersOf(allocated, "p1")).toEqual(["unit:i1:0", "unit:i2:0", "unit:i2:1"]);
    expect(holdersOf(allocated, "p2")).toEqual(["unit:i1:0"]);
  });
});

describe("4 — typing counts and cancelling changes nothing", () => {
  it("planning is pure: the document it was handed is untouched", () => {
    const doc = ok(allocateItemQuantity(bill(4), "i1", [{ participantId: "p1", quantity: 2 }]));
    const before = JSON.stringify(doc);
    const outcome = planQuantityAllocation(doc.working, "i1", [
      { participantId: "p2", quantity: 1 },
      { participantId: "p1", quantity: 3 },
    ]);
    expect(outcome.ok).toBe(true);
    // The dialog's confirm button is the only writer; computing the preview on every keystroke writes nothing.
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("a refused plan changes nothing either", () => {
    const doc = ok(allocateItemQuantity(bill(4), "i1", [{ participantId: "p1", quantity: 2 }]));
    const before = JSON.stringify(doc);
    expect(planQuantityAllocation(doc.working, "i1", [{ participantId: "p1", quantity: 9 }]).ok).toBe(false);
    expect(planQuantityAllocation(doc.working, "i1", [{ participantId: "ghost", quantity: 1 }]).ok).toBe(false);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("changing the line's quantity only removes assignments when the change is committed", () => {
    const doc = ok(allocateItemQuantity(bill(4), "i1", [{ participantId: "p1", quantity: 4 }]));
    const before = JSON.stringify(doc);

    // 4 → 2 would remove units 2 and 3, both p1's. The preview is a prediction, not a write.
    const preview = previewQuantityChange(doc.working, "i1", 2);
    expect(preview.removedUnitIds).toEqual(["unit:i1:2", "unit:i1:3"]);
    expect(preview.removedAssignments).toHaveLength(2);
    expect(JSON.stringify(doc)).toBe(before);

    // Cancelling is exactly "the preview was shown and nothing else happened".
    expect(holdersOf(doc, "p1")).toHaveLength(4);

    // Committing it is a different call, and it does remove them — the two are never conflated.
    const shrunk = ok(setItemQuantity(doc, "i1", 2));
    expect(holdersOf(shrunk, "p1")).toEqual(["unit:i1:0", "unit:i1:1"]);
  });

  it("a quantity change that keeps every allocated unit leaves the assignments alone", () => {
    const doc = ok(allocateItemQuantity(bill(2), "i1", [{ participantId: "p1", quantity: 2 }]));
    const grown = ok(setItemQuantity(doc, "i1", 5));
    expect(holdersOf(grown, "p1")).toEqual(["unit:i1:0", "unit:i1:1"]);
    // The three new units are nobody's and unacknowledged, which is what the blocker is for.
    expect(blockersOf(grown)).toContain("units_unassigned");
  });
});

describe("5 — saving the same allocation repeatedly creates no duplicate", () => {
  it("applies the identical allocation twice to the identical state", () => {
    const doc = bill(5);
    const once = ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 3 },
        { participantId: "p2", quantity: 2 },
      ]),
    );
    const twice = ok(
      allocateItemQuantity(once, "i1", [
        { participantId: "p1", quantity: 3 },
        { participantId: "p2", quantity: 2 },
      ]),
    );

    // Same pairs, in the same order, and still exactly five assignments for five units.
    expect(twice.working.assignments).toEqual(once.working.assignments);
    expect(twice.working.assignments).toHaveLength(5);
    expect(new Set(twice.working.assignments.map((a) => `${a.itemUnitId}|${a.participantId}`)).size).toBe(5);
    // And the units themselves did not multiply.
    expect(twice.working.itemUnits).toHaveLength(5);
  });

  it("re-allocating differently replaces the old plan instead of adding to it", () => {
    const doc = bill(5);
    let current = ok(
      allocateItemQuantity(doc, "i1", [
        { participantId: "p1", quantity: 3 },
        { participantId: "p2", quantity: 2 },
      ]),
    );
    current = ok(
      allocateItemQuantity(current, "i1", [
        { participantId: "p2", quantity: 4 },
        { participantId: "p1", quantity: 1 },
      ]),
    );
    // Units are handed out in the declared order, so the plan that names p2 first gives p2 units 0–3 and p1 the
    // last one. Re-allocating replaces the previous plan; it never adds to it.
    expect(holdersOf(current, "p2")).toEqual(["unit:i1:0", "unit:i1:1", "unit:i1:2", "unit:i1:3"]);
    expect(holdersOf(current, "p1")).toEqual(["unit:i1:4"]);
    expect(current.working.assignments).toHaveLength(5);
    expect(new Set(current.working.assignments.map((a) => a.itemUnitId)).size).toBe(5);
  });

  it("a repeated allocation after an acknowledgement does not resurrect the acknowledgement", () => {
    const doc = bill(3);
    let current = ok(allocateItemQuantity(doc, "i1", [{ participantId: "p1", quantity: 1 }]));
    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:1"));
    current = ok(acknowledgeUnassignedUnit(current, "unit:i1:2"));
    const again = ok(allocateItemQuantity(current, "i1", [{ participantId: "p1", quantity: 1 }]));
    // The units that stay unallocated keep the creator's decision; the assigned one does not have a flag at all.
    expect(again.working.itemUnits.map((unit) => unit.confirmedUnassigned)).toEqual([false, true, true]);
    expect(again.working.assignments).toHaveLength(1);
  });
});

function holdersOf(doc: BillDocument, participantId: string): string[] {
  return doc.working.assignments
    .filter((assignment) => assignment.participantId === participantId)
    .map((assignment) => assignment.itemUnitId)
    .sort();
}

/** `i1` (one unit) and `i2` (two units), both finalized: one line to share, one line to allocate. */
function twoItemBill(): BillDocument {
  const parse: ParseResult = {
    ...parseOf(1, 10_000),
    items: [parsedItem("i1", { qty: 1 }), parsedItem("i2", { qty: 2, unitPrice: 5_000, lineTotal: 10_000 })],
    subtotal: 20_000,
    grandTotal: 20_000,
  };
  const begun = beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Creator" });
  const finalized = ok(finalizeItems(begun, ["i1", "i2"]));
  return ["p1", "p2"].reduce((doc, name) => ok(addParticipant(doc, name)), finalized);
}
