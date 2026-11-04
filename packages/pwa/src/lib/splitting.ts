import type { BillCharge, ExactMoney, SplittableBill } from "./entities.js";
import { add, compare, divInt, fromPaise } from "./exact-money.js";

export interface ParticipantShare {
  participantId: string;
  exactAmount: ExactMoney;
}

export interface SplitResult {
  shares: ParticipantShare[];
  hasNegativeShare: boolean;
}

/**
 * Signed effect on the payable total; discounts subtract, round_off is already signed.
 * Exported because ticket 11's derived totals must not restate §11 rule 8 a second time.
 */
export function signedChargePaise(charge: BillCharge): number {
  switch (charge.type) {
    case "discount":
      return -charge.amount;
    case "other":
      return charge.otherSign === "subtract" ? -charge.amount : charge.amount;
    default:
      return charge.amount;
  }
}

export function computeExactShares(state: SplittableBill): SplitResult {
  const zero = fromPaise(0);
  const totals = new Map<string, ExactMoney>(state.participants.map((pt) => [pt.id, zero]));

  const itemById = new Map(state.items.map((it) => [it.id, it]));
  for (const unit of state.itemUnits) {
    const assignees = [
      ...new Set(
        state.assignments.filter((a) => a.itemUnitId === unit.id).map((a) => a.participantId)
      ),
    ];
    if (assignees.length === 0) {
      if (!unit.confirmedUnassigned) {
        // TODO(ticket 13): produce `units_unassigned` instead of throwing
        throw new Error(`unit ${unit.id} is neither assigned nor acknowledged`);
      }
      continue;
    }
    const price = fromPaise(itemById.get(unit.itemId)!.unitPrice);
    const perAssignee = divInt(price, assignees.length);
    for (const participantId of assignees) {
      totals.set(participantId, add(totals.get(participantId)!, perAssignee));
    }
  }

  if (state.participants.length > 0) {
    const applicable = state.charges.filter(
      (c) => !c.included && !(c.type === "other" && c.otherSign === "unknown")
    );
    for (const charge of applicable) {
      const perParticipant = divInt(fromPaise(signedChargePaise(charge)), state.participants.length);
      for (const participant of state.participants) {
        totals.set(
          participant.id,
          add(totals.get(participant.id)!, perParticipant)
        );
      }
    }
  }

  for (const adjustment of state.bill.adjustmentLines) {
    const current = totals.get(adjustment.assignedToParticipantId);
    if (current) {
      totals.set(
        adjustment.assignedToParticipantId,
        add(current, fromPaise(adjustment.amount))
      );
    }
  }

  const shares = state.participants.map((pt) => ({
    participantId: pt.id,
    exactAmount: totals.get(pt.id)!,
  }));
  return {
    shares,
    hasNegativeShare: shares.some((s) => compare(s.exactAmount, zero) < 0),
  };
}
