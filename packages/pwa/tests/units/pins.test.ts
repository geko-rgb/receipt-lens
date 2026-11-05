import { describe, expect, it } from "vitest";
import { validate } from "@receipt-lens/core";
import type { ParsedItem, ParseResult } from "@receipt-lens/core";

import { add, compare, fromPaise } from "../../src/lib/exact-money.js";
import type { BillDocument } from "../../src/lib/bill/document.js";
import { previewQuantityChange } from "../../src/lib/bill/units.js";
import {
  acknowledgeUnassignedUnit,
  addParticipant,
  assignUnit,
  beginFrom,
  finalizeAllResolvable,
  finalizeItems,
  resolveChargeInclusion,
  runTransaction,
  setItemQuantity,
  unassignUnit,
  type TransactionResult,
} from "../../src/lib/bill/transactions.js";

/**
 * DECISIONS/0021 A1–A15, as assertions.
 *
 * Written before the implementation, deliberately: `previewQuantityChange`, `assignUnit`, `unassignUnit`
 * and `addParticipant` throw `not implemented`, so this file is red until the rules exist. Everything it
 * touches is the bill-state seam — a document in, a document or a rejection out — never a component.
 */

const CREATED_AT = "2026-11-05T00:00:00.000Z";
const CREATOR = "b1:creator";

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

function begin(qty = 2, unitPrice = 16_025, over: Partial<ParseResult> = {}): BillDocument {
  const parse = parseOf(qty, unitPrice, over);
  return beginFrom(parse, validate(parse), { billId: "b1", createdAt: CREATED_AT, creatorName: "Creator" });
}

/** One finalized line: the state every unit-level pin reasons about. */
function finalized(qty = 2, unitPrice = 16_025, over: Partial<ParseResult> = {}): BillDocument {
  return ok(finalizeItems(begin(qty, unitPrice, over), ["i1"]));
}

function ok(result: TransactionResult): BillDocument {
  if (!result.ok) throw new Error(`expected success, got a ${result.reject.code} rejection`);
  return result.document;
}

function rejected(result: TransactionResult): { readonly code: string; readonly refs: string[] } {
  if (result.ok) throw new Error("expected a rejection, got a committed document");
  return result.reject;
}

function adding(doc: BillDocument, ...names: string[]): BillDocument {
  return names.reduce((current, name) => ok(addParticipant(current, name)), doc);
}

function assigning(doc: BillDocument, unitId: string, ...participantIds: string[]): BillDocument {
  return participantIds.reduce((current, participantId) => ok(assignUnit(current, unitId, participantId)), doc);
}

function unitOf(doc: BillDocument, unitIndex: number) {
  const unit = doc.working.itemUnits.find((entry) => entry.itemId === "i1" && entry.unitIndex === unitIndex);
  if (!unit) throw new Error(`no unit ${unitIndex} on i1`);
  return unit;
}

function shareOf(doc: BillDocument, participantId: string) {
  return doc.derived.shares?.find((entry) => entry.participantId === participantId);
}

function blockerOf(doc: BillDocument, code: string) {
  return doc.billValidation.blockers.locking.find((entry) => entry.code === code);
}

const snapshot = (doc: BillDocument): string => JSON.stringify(doc);

describe("ticket 12 — unit materialization (DECISIONS/0021 A1)", () => {
  it("materializes exactly Item.qty units at finalization, and none on the draft", () => {
    const draft = begin(3, 10_000);
    expect(draft.working.itemUnits).toEqual([]);

    const done = ok(finalizeItems(draft, ["i1"]));
    expect(done.working.itemUnits.map((unit) => unit.id)).toEqual([
      "unit:i1:0",
      "unit:i1:1",
      "unit:i1:2",
    ]);
    expect(done.working.itemUnits.map((unit) => unit.unitIndex)).toEqual([0, 1, 2]);
    expect(done.working.itemUnits.every((unit) => unit.confirmedUnassigned === false)).toBe(true);
  });

  it("keeps count(units) = Item.qty and contiguous unitIndex after a quantity increase", () => {
    const grown = ok(setItemQuantity(finalized(2), "i1", 3));

    expect(grown.working.items[0]!.qty).toBe(3);
    expect(grown.working.itemUnits.map((unit) => unit.unitIndex)).toEqual([0, 1, 2]);
    const appended = unitOf(grown, 2);
    expect(appended.confirmedUnassigned).toBe(false);
    expect(blockerOf(grown, "units_unassigned")?.refs).toContain(appended.id);
  });

  it("leaves existing acknowledgements standing when a quantity grows", () => {
    const acknowledged = ok(acknowledgeUnassignedUnit(finalized(2), unitOf(finalized(2), 0).id));
    const grown = ok(setItemQuantity(acknowledged, "i1", 3));

    expect(unitOf(grown, 0).confirmedUnassigned).toBe(true);
    expect(unitOf(grown, 1).confirmedUnassigned).toBe(false);
    expect(unitOf(grown, 2).confirmedUnassigned).toBe(false);
    // Only the two units the growth created are pending; the creator's earlier statement stands.
    expect(blockerOf(grown, "units_unassigned")?.refs).toEqual(["unit:i1:1", "unit:i1:2"]);
  });

  it("removes the highest-index units on shrink, even when a lower unit is free", () => {
    const doc = adding(finalized(3), "P1", "P2");
    const acknowledged = ok(acknowledgeUnassignedUnit(doc, unitOf(doc, 0).id));
    const assigned = ok(assignUnit(ok(assignUnit(acknowledged, unitOf(doc, 1).id, "p1")), unitOf(doc, 2).id, "p2"));

    const shrunk = setItemQuantity(assigned, "i1", 2);
    const after = ok(shrunk);
    if (!shrunk.ok) throw new Error("unreachable");

    expect(after.working.itemUnits.map((unit) => unit.id)).toEqual(["unit:i1:0", "unit:i1:1"]);
    expect(after.working.assignments).toEqual([{ itemUnitId: "unit:i1:1", participantId: "p1" }]);
    expect(shrunk.effects.removedUnitIds).toEqual(["unit:i1:2"]);
    expect(shrunk.effects.removedAssignments).toEqual([{ itemUnitId: "unit:i1:2", participantId: "p2" }]);
    expect(unitOf(after, 0).confirmedUnassigned).toBe(true);
  });
});

describe("ticket 12 — assignment (DECISIONS/0021 A2–A5)", () => {
  it("assigns a unit to a participant in one transaction", () => {
    const doc = adding(finalized(1), "P1");
    const before = doc.revision;
    const assigned = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));

    expect(assigned.working.assignments).toEqual([{ itemUnitId: "unit:i1:0", participantId: "p1" }]);
    expect(assigned.revision).toBe(before + 1);
    expect(shareOf(assigned, "p1")!.exactAmount).toEqual({ numeratorPaise: "16025", denominator: "1" });
    expect(blockerOf(assigned, "units_unassigned")).toBeUndefined();
  });

  it("rejects a duplicate (itemUnitId, participantId) pair and preserves the document", () => {
    const doc = adding(finalized(1), "P1");
    const first = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));
    const second = assignUnit(first, unitOf(first, 0).id, "p1");

    expect(rejected(second).code).toBe("assignment_duplicate");
    expect(second.document).toBe(first);
  });

  it("rejects an assignment naming an unknown participant", () => {
    const doc = finalized(1);
    const result = assignUnit(doc, unitOf(doc, 0).id, "p404");

    expect(rejected(result).code).toBe("unknown_entity");
    expect(rejected(result).refs).toEqual(["p404"]);
    expect(result.document).toBe(doc);
  });

  it("rejects an assignment naming a unit that does not exist", () => {
    const doc = finalized(1);
    const result = assignUnit(doc, "unit:i1:99", CREATOR);

    expect(rejected(result).code).toBe("unknown_entity");
    expect(result.document).toBe(doc);
  });

  it("rejects every assignment on a locked bill through the existing seam, adding no lock path", () => {
    // Ticket 11's own pins set `isLocked` through `runTransaction` (tests/bill/pins.test.ts:500), so the
    // guard is reachable without a `lockBill` operation ticket 13 would have to remove (0021 A3).
    const locked = ok(runTransaction(finalized(1), (working) => ({ ...working, bill: { ...working.bill, isLocked: true } })));
    const result = assignUnit(locked, unitOf(locked, 0).id, CREATOR);

    expect(rejected(result).code).toBe("bill_locked");
    expect(result.document).toBe(locked);
  });

  it("clears confirmedUnassigned in the same transaction that assigns the unit", () => {
    const doc = adding(finalized(1), "P1");
    const acknowledged = ok(acknowledgeUnassignedUnit(doc, unitOf(doc, 0).id));
    expect(acknowledged.working.bill.adjustmentLines.map((line) => line.id)).toEqual(["adj:unit:i1:0"]);

    const assigned = ok(assignUnit(acknowledged, unitOf(acknowledged, 0).id, "p1"));

    expect(unitOf(assigned, 0).confirmedUnassigned).toBe(false);
    expect(assigned.working.bill.adjustmentLines).toEqual([]);
    expect(assigned.revision).toBe(acknowledged.revision + 1);
  });

  it("refuses to acknowledge a unit that still has assignments", () => {
    const doc = adding(finalized(1), "P1");
    const assigned = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));
    const result = acknowledgeUnassignedUnit(assigned, unitOf(assigned, 0).id);

    expect(rejected(result).code).toBe("unit_assigned");
    expect(result.document).toBe(assigned);
  });

  it("unassigning the last participant returns the unit to pending, not acknowledged", () => {
    const doc = adding(finalized(2), "P1");
    const assigned = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));
    const unassigned = ok(unassignUnit(assigned, unitOf(assigned, 0).id, "p1"));

    expect(unassigned.working.assignments).toEqual([]);
    expect(unitOf(unassigned, 0).confirmedUnassigned).toBe(false);
    expect(blockerOf(unassigned, "units_unassigned")?.refs).toContain("unit:i1:0");
    expect(unassigned.working.bill.adjustmentLines).toEqual([]);
    expect(unassigned.derived.shares).toBeNull();
  });

  it("rejects unassigning a pair that is not present", () => {
    const doc = adding(finalized(1), "P1");
    const assigned = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));
    const removed = ok(unassignUnit(assigned, unitOf(assigned, 0).id, "p1"));
    const result = unassignUnit(removed, unitOf(removed, 0).id, "p1");

    expect(rejected(result).code).toBe("unknown_entity");
    expect(result.document).toBe(removed);
  });

  it("does not move the item price, the printed row total or the grand total", () => {
    const doc = adding(finalized(2), "P1");
    const assigned = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));
    const item = assigned.working.items[0]!;

    expect(item.unitPrice).toBe(16_025);
    expect(item.lineTotal).toBe(32_050);
    expect(item.detectedLineTotal).toBe(32_050);
    expect(assigned.working.bill.grandTotal).toBe(32_050);
  });
});

describe("ticket 12 — exact division of a shared unit (DECISIONS/0021 A9)", () => {
  it("divides a shared unit's integer-paise price exactly, with no rounding", () => {
    const doc = adding(finalized(1, 16_025), "P1", "P2", "P3");
    const assigned = assigning(doc, unitOf(doc, 0).id, "p1", "p2", "p3");

    for (const participantId of ["p1", "p2", "p3"]) {
      expect(shareOf(assigned, participantId)!.exactAmount).toEqual({
        numeratorPaise: "16025",
        denominator: "3",
      });
    }
  });

  it("sums the shared unit's exact shares back to its price", () => {
    const doc = adding(finalized(1, 16_025), "P1", "P2", "P3");
    const assigned = assigning(doc, unitOf(doc, 0).id, "p1", "p2", "p3");

    const total = ["p1", "p2", "p3"]
      .map((participantId) => shareOf(assigned, participantId)!.exactAmount)
      .reduce((sum, amount) => add(sum, amount), fromPaise(0));
    expect(compare(total, fromPaise(16_025))).toBe(0);
  });
});

describe("ticket 12 — quantity decrease, in three states (DECISIONS/0021 A7/A8)", () => {
  function twoAssigned(): BillDocument {
    const doc = adding(finalized(2), "P1", "P2");
    return assigning(doc, unitOf(doc, 1).id, "p2");
  }

  it("state 1: the preview names the removals and commits nothing", () => {
    const doc = twoAssigned();
    const before = snapshot(doc);
    const revision = doc.revision;

    const preview = previewQuantityChange(doc.working, "i1", 1);

    expect(preview.removedUnitIds).toEqual(["unit:i1:1"]);
    expect(preview.removedAssignments).toEqual([{ itemUnitId: "unit:i1:1", participantId: "p2" }]);
    expect(preview.removedAcknowledgedUnitIds).toEqual([]);
    expect(snapshot(doc)).toBe(before);
    expect(doc.revision).toBe(revision);
  });

  it("state 2: a cancelled warning is a no-op — same document, revision and units", () => {
    const doc = twoAssigned();
    const before = doc;
    const revision = doc.revision;

    // Cancelling means the transaction is never issued; the preview is the only thing that ran.
    previewQuantityChange(before.working, "i1", 1);

    expect(doc).toBe(before);
    expect(doc.revision).toBe(revision);
    expect(doc.working.items[0]!.qty).toBe(2);
    expect(doc.working.itemUnits).toHaveLength(2);
    expect(doc.working.assignments).toHaveLength(1);
  });

  it("state 3: confirming applies the previewed cascade in exactly one transaction", () => {
    const doc = twoAssigned();
    const revision = doc.revision;
    const preview = previewQuantityChange(doc.working, "i1", 1);

    const result = setItemQuantity(doc, "i1", 1);
    const after = ok(result);
    if (!result.ok) throw new Error("unreachable");

    expect(after.revision).toBe(revision + 1);
    expect(result.effects.removedUnitIds).toEqual(preview.removedUnitIds);
    expect(result.effects.removedAssignments).toEqual(preview.removedAssignments);
    expect(after.working.items[0]!.qty).toBe(1);
    expect(after.working.itemUnits.map((unit) => unit.id)).toEqual(["unit:i1:0"]);
    expect(after.working.assignments).toEqual([]);
  });

  it("rejects a decrease to 0 as invalid_quantity and keeps the line and its units", () => {
    const doc = twoAssigned();
    const result = setItemQuantity(doc, "i1", 0);

    expect(rejected(result).code).toBe("invalid_quantity");
    expect(result.document).toBe(doc);
    expect(doc.working.items[0]!.qty).toBe(2);
    expect(doc.working.itemUnits).toHaveLength(2);
    expect(doc.working.assignments).toHaveLength(1);
  });
});

describe("ticket 12 — lock interaction (DECISIONS/0021 A11/A12)", () => {
  it("blocks lock while a unit is neither assigned nor acknowledged", () => {
    const doc = adding(finalized(2), "P1");
    const half = ok(assignUnit(doc, unitOf(doc, 0).id, "p1"));

    expect(blockerOf(half, "units_unassigned")?.refs).toEqual(["unit:i1:1"]);
    expect(half.derived.shares).toBeNull();

    const settled = ok(acknowledgeUnassignedUnit(half, unitOf(half, 1).id));
    expect(blockerOf(settled, "units_unassigned")).toBeUndefined();
    expect(settled.derived.shares).not.toBeNull();
  });

  it("does not gate assignment on an unresolved draft elsewhere on the bill", () => {
    const doc = begin(1, 10_000, {
      items: [parsedItem("i1", { qty: 1, unitPrice: 10_000, lineTotal: 10_000 }), parsedItem("i2")],
      subtotal: 20_000,
      grandTotal: 20_000,
    });
    const partial = ok(finalizeItems(doc, ["i1"]));

    const assigned = ok(assignUnit(partial, unitOf(partial, 0).id, CREATOR));

    expect(assigned.billValidation.blockers.assignment).toEqual([]);
    expect(assigned.billValidation.blockers.unitCreation).toContain("item_not_finalized");
    expect(assigned.working.draftItems.map((draft) => draft.id)).toEqual(["i2"]);
  });
});

describe("ticket 12 — participants (DECISIONS/0021 A10)", () => {
  it("adds participants with deterministic ids and leaves units and assignments untouched", () => {
    const doc = finalized(2);
    const unitsBefore = doc.working.itemUnits;
    const assignmentsBefore = doc.working.assignments;

    const withP1 = ok(addParticipant(doc, "P1"));
    const both = ok(addParticipant(withP1, "P2"));

    expect(both.working.participants.map((participant) => participant.id)).toEqual([CREATOR, "p1", "p2"]);
    expect(both.working.itemUnits).toEqual(unitsBefore);
    expect(both.working.assignments).toEqual(assignmentsBefore);
    expect(withP1.revision).toBe(doc.revision + 1);
  });

  it("allows two participants to share a name", () => {
    const doc = adding(finalized(1), "Alex", "Alex");
    const alexes = doc.working.participants.filter((participant) => participant.name === "Alex");

    expect(alexes).toHaveLength(2);
    expect(new Set(alexes.map((participant) => participant.id)).size).toBe(2);
  });

  it("rejects a blank participant name and adds nothing", () => {
    const doc = finalized(1);
    const result = addParticipant(doc, "   ");

    expect(rejected(result).code).toBe("invalid_name");
    expect(result.document).toBe(doc);
    expect(doc.working.participants).toHaveLength(1);
  });

  it("adding a participant does not re-open acknowledged units", () => {
    const doc = finalized(2);
    const acknowledged = ok(acknowledgeUnassignedUnit(doc, unitOf(doc, 0).id));
    const grown = ok(addParticipant(acknowledged, "P1"));

    expect(unitOf(grown, 0).confirmedUnassigned).toBe(true);
    expect(grown.working.bill.adjustmentLines.map((line) => line.id)).toEqual(["adj:unit:i1:0"]);
  });

  it("gives a zero-item participant an equal share of applicable charges", () => {
    const charged = ok(resolveChargeInclusion(finalized(1, 10_000, { serviceCharge: 1_000, grandTotal: 11_000 }), "service", false));
    const billed = ok(finalizeAllResolvable(charged));
    const withCreator = assigning(billed, unitOf(billed, 0).id, CREATOR);
    const doc = adding(withCreator, "P1");

    expect(shareOf(doc, "p1")!.exactAmount).toEqual({ numeratorPaise: "500", denominator: "1" });
    expect(shareOf(doc, CREATOR)!.exactAmount).toEqual({ numeratorPaise: "10500", denominator: "1" });
  });
});
