import { describe, expect, it } from "vitest";
import type { Bill, BillCharge, Item, ItemUnit, ItemUnitAssignment, Participant, SplittableBill } from "./entities.js";
import { add, fromPaise } from "./exact-money.js";
import { computeExactShares } from "./splitting.js";
import { allocateSettlement } from "./settlement.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomBill(rand: () => number) {
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const participantIds = Array.from({ length: int(1, 6) }, (_, i) => `P${i + 1}`);
  const participants: Participant[] = participantIds.map((id) => ({
    id, billId: "b", name: id, paid: false, token: "t", tokenExpiresAt: "",
  }));
  const items: Item[] = [];
  const itemUnits: ItemUnit[] = [];
  const assignments: ItemUnitAssignment[] = [];
  let expectedTotalPaise = 0;

  for (let i = 0; i < int(0, 4); i++) {
    const itemId = `I${i}`;
    const unitPrice = int(50, 50000);
    const qty = int(1, 3);
    items.push({
      id: itemId, billId: "b", name: itemId, qty, quantitySource: "explicit", unitPrice,
      priceSource: "detected", lineTotal: unitPrice * qty, detectedLineTotal: null,
      confidence: null, assumedQtyReviewed: false,
    });
    for (let u = 0; u < qty; u++) {
      expectedTotalPaise += unitPrice;
      const unitId = `${itemId}.u${u}`;
      const shared = rand() < 0.4;
      const assignees = shared
        ? participantIds.filter(() => rand() < 0.5)
        : [pick(participantIds)];
      if (assignees.length === 0) {
        itemUnits.push({ id: unitId, itemId, unitIndex: u, confirmedUnassigned: true });
      } else {
        itemUnits.push({ id: unitId, itemId, unitIndex: u, confirmedUnassigned: false });
        for (const pid of assignees) assignments.push({ itemUnitId: unitId, participantId: pid });
      }
    }
  }

  const charges: BillCharge[] = [];
  const type = (): BillCharge["type"] => pick(["tax", "service_charge", "tip", "discount", "round_off"] as const);
  for (let c = 0; c < int(0, 5); c++) {
    const t = type();
    const amount = t === "round_off" ? int(-100, 100) : int(10, 10000);
    expectedTotalPaise += t === "discount" ? -Math.abs(amount) : amount;
    charges.push({
      id: `C${c}`, billId: "b", type: t, label: t, amount,
      included: false, source: "detected",
    });
  }

  const adjustments = itemUnits
    .filter((u) => u.confirmedUnassigned)
    .map((u, idx) => ({
      id: `A${idx}`,
      billId: "b",
      reason: "unassigned" as const,
      amount: items.find((it) => it.id === u.itemId)!.unitPrice,
      assignedToParticipantId: participantIds[0],
    }));

  const bill: Bill = {
    id: "b", title: "random", creatorId: participantIds[0], payerId: participantIds[0],
    createdAt: "", isLocked: true, taxIncluded: false, taxIncludedSource: "user_confirmed",
    grandTotal: expectedTotalPaise, grandTotalSource: "user_confirmed",
    adjustmentLines: adjustments,
  };
  const state: SplittableBill = { bill, participants, items, itemUnits, assignments, charges };
  return { state, expectedTotalPaise };
}

describe("sum-invariance on randomized bills (property tests)", () => {
  it("exact shares always sum to the confirmed payable total", () => {
    const rand = lcg(20261102);
    for (let trial = 0; trial < 200; trial++) {
      const { state, expectedTotalPaise } = randomBill(rand);
      const { shares, hasNegativeShare } = computeExactShares(state);
      const sum = shares.reduce((acc, s) => add(acc, s.exactAmount), fromPaise(0));
      expect(sum, `trial ${trial}`).toEqual({
        numeratorPaise: String(expectedTotalPaise),
        denominator: "1",
      });
      if (!hasNegativeShare) {
        const paid = allocateSettlement(shares, expectedTotalPaise);
        expect(paid.reduce((t, x) => t + x.settlementSharePaise, 0), `settlement ${trial}`).toBe(
          expectedTotalPaise
        );
      }
    }
  });
});
