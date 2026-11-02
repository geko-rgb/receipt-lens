import { describe, expect, it } from "vitest";
import type { Bill, Item, ItemUnit, ItemUnitAssignment, Participant, SplittableBill } from "./entities.js";
import { computeExactShares } from "./splitting.js";

const p = (id: string): Participant => ({ id, billId: "b", name: id, paid: false, token: "t", tokenExpiresAt: "" });
const item = (id: string, unitPrice: number, qty: number): Item => ({
  id, billId: "b", name: id, qty, quantitySource: "explicit", unitPrice,
  priceSource: "detected", lineTotal: unitPrice * qty, detectedLineTotal: null,
  confidence: null, assumedQtyReviewed: false,
});
const unit = (itemId: string, i: number, confirmedUnassigned = false): ItemUnit => ({
  id: `${itemId}.u${i}`, itemId, unitIndex: i, confirmedUnassigned,
});
const asg = (itemUnitId: string, participantId: string): ItemUnitAssignment => ({ itemUnitId, participantId });
const bill = (adjustments: Bill["adjustmentLines"] = []): Bill => ({
  id: "b", title: "t", creatorId: "P1", payerId: "P1", createdAt: "", isLocked: false,
  taxIncluded: null, taxIncludedSource: "unresolved", grandTotal: null,
  grandTotalSource: "unresolved", adjustmentLines: adjustments,
});

const shareOf = (r: ReturnType<typeof computeExactShares>, id: string) =>
  r.shares.find((s) => s.participantId === id)!.exactAmount;

describe("exact share computation", () => {
  it("applicable non-included charges divide equally among ALL participants including zero-item ones", () => {
    const b: SplittableBill = {
      bill: bill(),
      participants: [p("P1"), p("P2")],
      items: [item("A", 1000, 1)],
      itemUnits: [unit("A", 0)],
      assignments: [asg("A.u0", "P1")],
      charges: [
        { id: "c1", billId: "b", type: "service_charge", label: "SC", amount: 500, included: false, source: "detected" },
      ],
    };
    const r = computeExactShares(b);
    expect(shareOf(r, "P1")).toEqual({ numeratorPaise: "1250", denominator: "1" });
    expect(shareOf(r, "P2")).toEqual({ numeratorPaise: "250", denominator: "1" });
    expect(r.hasNegativeShare).toBe(false);
  });

  it("charges marked included are display-only — never added or allocated", () => {
    const b: SplittableBill = {
      bill: bill(),
      participants: [p("P1"), p("P2")],
      items: [item("A", 1000, 1)],
      itemUnits: [unit("A", 0)],
      assignments: [asg("A.u0", "P1")],
      charges: [
        { id: "c1", billId: "b", type: "tax", label: "GST", amount: 400, included: true, source: "detected" },
      ],
    };
    const r = computeExactShares(b);
    expect(shareOf(r, "P1")).toEqual({ numeratorPaise: "1000", denominator: "1" });
    expect(shareOf(r, "P2")).toEqual({ numeratorPaise: "0", denominator: "1" });
  });

  it("other charges with unknown sign are excluded from arithmetic", () => {
    const b: SplittableBill = {
      bill: bill(),
      participants: [p("P1")],
      items: [],
      itemUnits: [],
      assignments: [],
      charges: [
        { id: "c1", billId: "b", type: "other", label: "?", amount: 700, included: false, otherSign: "unknown", source: "detected" },
      ],
    };
    expect(computeExactShares(b).shares[0]!.exactAmount).toEqual({ numeratorPaise: "0", denominator: "1" });
  });

  it("a unit shared by three divides exactly with no residual paise to anyone", () => {
    const b: SplittableBill = {
      bill: bill(),
      participants: [p("P1"), p("P2"), p("P3")],
      items: [item("A", 16025, 1)],
      itemUnits: [unit("A", 0)],
      assignments: [asg("A.u0", "P1"), asg("A.u0", "P2"), asg("A.u0", "P3")],
      charges: [],
    };
    const r = computeExactShares(b);
    expect(r.shares.every((s) => s.exactAmount.numeratorPaise === "16025" && s.exactAmount.denominator === "3")).toBe(true);
  });

  it("confirmed-unassigned cost reaches the creator only through the visible adjustment line", () => {
    const b: SplittableBill = {
      bill: bill([{ id: "a1", billId: "b", reason: "unassigned", amount: 2000, assignedToParticipantId: "P1" }]),
      participants: [p("P1"), p("P2")],
      items: [item("B", 2000, 1)],
      itemUnits: [unit("B", 0, true)],
      assignments: [],
      charges: [],
    };
    const r = computeExactShares(b);
    expect(shareOf(r, "P1")).toEqual({ numeratorPaise: "2000", denominator: "1" });
    expect(shareOf(r, "P2")).toEqual({ numeratorPaise: "0", denominator: "1" });
  });

  it("a discount that pushes a share negative is reported, never redistributed", () => {
    const b: SplittableBill = {
      bill: bill(),
      participants: [p("P1"), p("P2")],
      items: [item("A", 100, 1)],
      itemUnits: [unit("A", 0)],
      assignments: [asg("A.u0", "P1")],
      charges: [
        { id: "c1", billId: "b", type: "discount", label: "D", amount: 300, included: false, source: "detected" },
      ],
    };
    const r = computeExactShares(b);
    expect(r.hasNegativeShare).toBe(true);
    expect(shareOf(r, "P2")).toEqual({ numeratorPaise: "-150", denominator: "1" });
  });
});
