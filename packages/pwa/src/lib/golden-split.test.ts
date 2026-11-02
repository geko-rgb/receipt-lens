import { describe, expect, it } from "vitest";
import type { Bill, BillCharge, Item, ItemUnit, ItemUnitAssignment, Participant, SplittableBill } from "./entities.js";
import { add, fromPaise } from "./exact-money.js";
import { computeExactShares } from "./splitting.js";
import { allocateSettlement } from "./settlement.js";

/**
 * Golden example — PROJECT(1).md §11, must reproduce exactly in CI.
 * ₹664.00; five participants; shared unit; confirmed-unassigned unit; zero-item P4.
 */
function goldenBill(): SplittableBill {
  const p = (id: string): Participant => ({
    id, billId: "b", name: id, paid: false, token: "t", tokenExpiresAt: "",
  });
  const item = (id: string, unitPrice: number, qty: number): Item => ({
    id, billId: "b", name: id, qty, quantitySource: "explicit", unitPrice,
    priceSource: "detected", lineTotal: unitPrice * qty, detectedLineTotal: unitPrice * qty,
    confidence: null, assumedQtyReviewed: false,
  });
  const charge = (
    id: string, type: BillCharge["type"], amount: number, extra: Partial<BillCharge> = {}
  ): BillCharge => ({
    id, billId: "b", type, label: id, amount, included: false, source: "detected", ...extra,
  });
  const units: ItemUnit[] = [
    { id: "A.u0", itemId: "A", unitIndex: 0, confirmedUnassigned: false },
    { id: "A.u1", itemId: "A", unitIndex: 1, confirmedUnassigned: false },
    { id: "B.u0", itemId: "B", unitIndex: 0, confirmedUnassigned: false },
    { id: "B.u1", itemId: "B", unitIndex: 1, confirmedUnassigned: false },
    { id: "B.u2", itemId: "B", unitIndex: 2, confirmedUnassigned: true },
    { id: "C.u0", itemId: "C", unitIndex: 0, confirmedUnassigned: false },
  ];
  const assignments: ItemUnitAssignment[] = [
    { itemUnitId: "A.u0", participantId: "P1" },
    { itemUnitId: "A.u0", participantId: "P2" },
    { itemUnitId: "A.u0", participantId: "P3" },
    { itemUnitId: "A.u1", participantId: "P2" },
    { itemUnitId: "B.u0", participantId: "P2" },
    { itemUnitId: "B.u1", participantId: "P3" },
    { itemUnitId: "C.u0", participantId: "P5" },
  ];
  const bill: Bill = {
    id: "b", title: "Golden", creatorId: "P1", payerId: "P1", createdAt: "2026-11-02",
    isLocked: true, taxIncluded: false, taxIncludedSource: "user_confirmed",
    grandTotal: 66400, grandTotalSource: "detected",
    adjustmentLines: [
      { id: "adj1", billId: "b", reason: "unassigned", amount: 2000, assignedToParticipantId: "P1" },
    ],
  };
  return {
    bill,
    participants: ["P1", "P2", "P3", "P4", "P5"].map(p),
    items: [item("A", 16025, 2), item("B", 2000, 3), item("C", 24000, 1)],
    itemUnits: units,
    assignments,
    charges: [
      charge("sc", "service_charge", 6205),
      charge("cgst", "tax", 1551),
      charge("sgst", "tax", 1551),
      charge("disc", "discount", 5000),
      charge("roundoff", "round_off", 43),
    ],
  };
}

describe("golden split table (CI-locked)", () => {
  it("reproduces the five exact shares in paise rationals", () => {
    const { shares, hasNegativeShare } = computeExactShares(goldenBill());
    expect(hasNegativeShare).toBe(false);
    expect(shares).toEqual([
      { participantId: "P1", exactAmount: { numeratorPaise: "24635", denominator: "3" } },
      { participantId: "P2", exactAmount: { numeratorPaise: "72710", denominator: "3" } },
      { participantId: "P3", exactAmount: { numeratorPaise: "24635", denominator: "3" } },
      { participantId: "P4", exactAmount: { numeratorPaise: "870", denominator: "1" } },
      { participantId: "P5", exactAmount: { numeratorPaise: "24870", denominator: "1" } },
    ]);
  });

  it("the exact shares sum algebraically to exactly 66400 paise", () => {
    const { shares } = computeExactShares(goldenBill());
    const total = shares.reduce((acc, s) => add(acc, s.exactAmount), fromPaise(0));
    expect(total).toEqual({ numeratorPaise: "66400", denominator: "1" });
  });

  it("the boundary allocation gives the spec's payment amounts", () => {
    const { shares } = computeExactShares(goldenBill());
    expect(allocateSettlement(shares, 66400)).toEqual([
      { participantId: "P1", settlementSharePaise: 8212 },
      { participantId: "P2", settlementSharePaise: 24237 },
      { participantId: "P3", settlementSharePaise: 8211 },
      { participantId: "P4", settlementSharePaise: 870 },
      { participantId: "P5", settlementSharePaise: 24870 },
    ]);
  });
});
