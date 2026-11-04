import { computeExactShares, signedChargePaise } from "../splitting.js";
import type { ParticipantShare } from "../splitting.js";
import type { AdjustmentLine, ItemUnit, WorkingBill } from "./working-bill.js";
import { findQuantityUnitViolations } from "./units.js";

/**
 * Derived selectors (§10 line 743): computed values, never the printed facts they are compared against.
 * They live beside the working bill inside one committed document — DECISIONS/0019 S3 — and nothing here is
 * persisted: a reload recomputes them through the same code path an edit uses.
 */
export interface DerivedBillState {
  /** Σ finalized `Item.lineTotal`, integer paise. Drafts are excluded: an unresolved draft has no amount (§10 line 764). */
  readonly calculatedItemsTotal: number;
  /** v1's item-list sum. Distinct from `printedSubtotal` by design (0019 S3): §6's formula starts at the printed value. */
  readonly calculatedSubtotal: number;
  /** Σ signed effect of non-included, classifiable charges; `discount` subtracts, `round_off` is already signed. */
  readonly chargeEffectsTotal: number;
  /** `calculatedSubtotal + chargeEffectsTotal` — what the bill says is payable. */
  readonly calculatedPayableTotal: number;
  /** `parseResult.subtotal`, the imported receipt fact. Never rewritten by an edit (0020 T5). */
  readonly printedSubtotal: number | null;
  /** `bill.grandTotal`. Only an explicit `setGrandTotal` moves it (0020 T5). */
  readonly printedGrandTotal: number | null;
  /** `printedGrandTotal − calculatedPayableTotal`, or null when the print is unknown. The gap the editor exists to keep visible. */
  readonly reconciliationGap: number | null;
  /** Exact shares, or null when a unit is neither assigned nor acknowledged (DECISIONS/0020 T7). */
  readonly shares: ParticipantShare[] | null;
  /** Why `shares` is null, as a code. `computeExactShares` throws on that state, and a throw here would be the editor refusing an edit. */
  readonly sharesUnavailableFor: ShareBlockerCode | null;
}

/** The one precondition failure v1 can actually reach: unacknowledged units are the ordinary mid-edit state of a real bill. */
export type ShareBlockerCode = "units_unassigned";

/** §6 line 458's round-off band, consumed from DECISIONS/0011 V5's posture: pinned defaults, not calibrated here. */
export const ROUND_OFF_TOLERANCE_PAISE = 2;
export const ROUND_OFF_MAX_PAISE = 100;

/** What step 2 hands the runner: the state it validated, and the numbers the UI shows. */
export interface RecomputeResult {
  readonly working: WorkingBill;
  readonly derived: DerivedBillState;
}

/** A unit no participant holds and the creator has not acknowledged: §11 rule 4's unassigned unit. */
export function unacknowledgedUnits(
  units: ItemUnit[],
  assignments: { itemUnitId: string }[],
): ItemUnit[] {
  const assigned = new Set(assignments.map((assignment) => assignment.itemUnitId));
  return units.filter((unit) => !assigned.has(unit.id) && !unit.confirmedUnassigned);
}

/** The same set from the other side: acknowledged, so its cost belongs to the creator. */
function acknowledgedUnits(units: ItemUnit[], assignments: { itemUnitId: string }[]): ItemUnit[] {
  const assigned = new Set(assignments.map((assignment) => assignment.itemUnitId));
  return units.filter((unit) => !assigned.has(unit.id) && unit.confirmedUnassigned);
}

/**
 * §10 line 769 / §11 rule 4: an acknowledged unassigned unit's cost lands on the creator as a visible
 * `AdjustmentLine`. The lines are *regenerated* from the acknowledged units rather than appended by each
 * operation, because that is what makes §10 line 790's cascade and DECISIONS/0020 T11's quantity shrink
 * correct without every operation remembering to do the arithmetic: a line cannot outlive the unit it names.
 * The deterministic `adj:unit:<unitId>` id is the linkage §10's `AdjustmentLine` shape has no field for.
 */
export function regenerateAdjustmentLines(working: WorkingBill): AdjustmentLine[] {
  const priceOf = new Map(working.items.map((item) => [item.id, item.unitPrice]));
  return acknowledgedUnits(working.itemUnits, working.assignments).map((unit) => ({
    id: `adj:${unit.id}`,
    billId: working.bill.id,
    reason: "unassigned" as const,
    amount: priceOf.get(unit.itemId) ?? 0,
    assignedToParticipantId: working.bill.creatorId,
  }));
}

/** Step 2 of §6 line 400. Throws on a broken invariant, which the runner reports as `recompute_failed`. */
export function recompute(input: WorkingBill): RecomputeResult {
  const violations = findQuantityUnitViolations(input.items, input.itemUnits);
  if (violations.length > 0) {
    throw new Error(`count(units where itemId = X) != Item.qty for ${violations.join(", ")}`);
  }
  const unitIds = new Set(input.itemUnits.map((unit) => unit.id));
  const orphans = input.assignments.filter((assignment) => !unitIds.has(assignment.itemUnitId));
  if (orphans.length > 0) {
    throw new Error(`assignment to a deleted unit: ${orphans.map((orphan) => orphan.itemUnitId).join(", ")}`);
  }

  const working: WorkingBill = {
    ...input,
    bill: { ...input.bill, adjustmentLines: regenerateAdjustmentLines(input) },
  };
  return { working, derived: recomputeDerived(working) };
}

/**
 * The totals, the printed facts to reconcile against, and — only when its precondition holds — the exact
 * participant shares. DECISIONS/0020 T7: `computeExactShares` throws on an unacknowledged unit, and that
 * state is an ordinary mid-edit bill, so it is checked before the call instead of surfacing as a failed
 * transaction.
 */
export function recomputeDerived(working: WorkingBill): DerivedBillState {
  const calculatedItemsTotal = working.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const calculatedSubtotal = calculatedItemsTotal;

  let chargeEffectsTotal = 0;
  for (const charge of working.charges) {
    // §6 line 456: an included charge is already inside the prices, and §6 line 461 excludes an unknown sign.
    if (charge.included) continue;
    if (charge.type === "other" && charge.otherSign === "unknown") continue;
    chargeEffectsTotal += signedChargePaise(charge);
  }

  const calculatedPayableTotal = calculatedSubtotal + chargeEffectsTotal;
  const printedSubtotal = working.parseResult?.subtotal ?? null;
  const printedGrandTotal = working.bill.grandTotal;
  const reconciliationGap = printedGrandTotal === null ? null : printedGrandTotal - calculatedPayableTotal;

  const pending = unacknowledgedUnits(working.itemUnits, working.assignments);
  if (pending.length > 0) {
    return {
      calculatedItemsTotal,
      calculatedSubtotal,
      chargeEffectsTotal,
      calculatedPayableTotal,
      printedSubtotal,
      printedGrandTotal,
      reconciliationGap,
      shares: null,
      sharesUnavailableFor: "units_unassigned",
    };
  }

  const { shares } = computeExactShares({
    bill: working.bill,
    participants: working.participants,
    items: working.items,
    itemUnits: working.itemUnits,
    assignments: working.assignments,
    charges: working.charges,
  });

  return {
    calculatedItemsTotal,
    calculatedSubtotal,
    chargeEffectsTotal,
    calculatedPayableTotal,
    printedSubtotal,
    printedGrandTotal,
    reconciliationGap,
    shares,
    sharesUnavailableFor: null,
  };
}
