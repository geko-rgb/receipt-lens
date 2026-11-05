import type { Item, ItemUnit, ItemUnitAssignment, WorkingBill } from "./working-bill.js";

/**
 * `ItemUnit` materialization and quantity maintenance — §10 line 767 and §11 rule 2:
 * `count(ItemUnit where itemId = X) = Item.qty` after *every* transaction, with `unitIndex 0..qty−1` and no
 * gap. DECISIONS/0020 T11.
 */

export function unitId(itemId: string, unitIndex: number): string {
  return `unit:${itemId}:${unitIndex}`;
}

/**
 * One unit per quantity, with ids derived from `(itemId, index)` rather than a clock or key order
 * (DECISIONS/0011's determinism rule), so re-running an operation on the same input yields byte-identical
 * state. New units start unassigned *and* unacknowledged (§10 line 785), because an acknowledgement is the
 * creator's act, not a default.
 */
export function materializeUnits(itemId: string, qty: number): ItemUnit[] {
  return Array.from({ length: qty }, (_, index) => ({
    id: unitId(itemId, index),
    itemId,
    unitIndex: index,
    confirmedUnassigned: false,
  }));
}

/**
 * Bring an item's units to exactly `qty`. Growing appends the next indices; shrinking removes the
 * highest-index ones and reports them, because their assignments — and any `AdjustmentLine` derived from
 * them — have to go in the same transaction (§10 line 790, `docs/pwa-design.md` §1.2).
 */
export function syncUnitsToQuantity(
  item: Item,
  existing: ItemUnit[],
): { units: ItemUnit[]; removedUnitIds: string[] } {
  const mine = existing
    .filter((unit) => unit.itemId === item.id)
    .slice()
    .sort((a, b) => a.unitIndex - b.unitIndex);

  if (mine.length === item.qty) return { units: existing, removedUnitIds: [] };

  if (mine.length < item.qty) {
    const appended = Array.from({ length: item.qty - mine.length }, (_, offset) => {
      const unitIndex = mine.length + offset;
      return { id: unitId(item.id, unitIndex), itemId: item.id, unitIndex, confirmedUnassigned: false };
    });
    return { units: [...existing, ...appended], removedUnitIds: [] };
  }

  const kept = new Set(mine.slice(0, item.qty).map((unit) => unit.id));
  const removedUnitIds = mine.slice(item.qty).map((unit) => unit.id);
  return {
    units: existing.filter((unit) => unit.itemId !== item.id || kept.has(unit.id)),
    removedUnitIds,
  };
}

/**
 * The invariant recompute checks rather than assumes. A violation is `recompute_failed` and the document is
 * unchanged (DECISIONS/0020 T1): silently re-syncing here would repair state an operation corrupted and
 * hide the operation that did it.
 */
export function findQuantityUnitViolations(items: Item[], units: ItemUnit[]): string[] {
  const offenders = new Set<string>();
  for (const item of items) {
    if (units.filter((unit) => unit.itemId === item.id).length !== item.qty) offenders.add(item.id);
  }
  // An orphan unit — one whose item is gone — is the other half of the same broken invariant.
  const itemIds = new Set(items.map((item) => item.id));
  for (const unit of units) {
    if (!itemIds.has(unit.itemId)) offenders.add(unit.itemId);
  }
  return [...offenders];
}

/**
 * What a quantity decrease would remove, computed over the committed state without writing anything
 * (DECISIONS/0021 A7). The UI shows this in a blocking confirmation; `setUnitsToQuantity`'s `effects` are
 * what actually happened. The two are never conflated: a preview is a prediction.
 */
export interface QuantityChangePreview {
  readonly itemId: string;
  readonly fromQty: number;
  readonly toQty: number;
  readonly removedUnitIds: string[];
  readonly removedAssignments: ItemUnitAssignment[];
  readonly removedAcknowledgedUnitIds: string[];
}

/**
 * The shrink is `syncUnitsToQuantity`'s, not a second implementation of it: the preview must predict exactly
 * what the transaction will do, or the warning is describing a different removal than the one that happens.
 * A draft has no units, so it previews as an empty removal (0021 A7).
 */
export function previewQuantityChange(
  working: WorkingBill,
  itemId: string,
  newQty: number,
): QuantityChangePreview {
  const item = working.items.find((entry) => entry.id === itemId);
  const mine = working.itemUnits.filter((unit) => unit.itemId === itemId);
  if (!item) {
    return {
      itemId,
      fromQty: mine.length,
      toQty: newQty,
      removedUnitIds: [],
      removedAssignments: [],
      removedAcknowledgedUnitIds: [],
    };
  }

  const { removedUnitIds } = syncUnitsToQuantity({ ...item, qty: newQty }, working.itemUnits);
  const removed = new Set(removedUnitIds);
  return {
    itemId,
    fromQty: item.qty,
    toQty: newQty,
    removedUnitIds,
    removedAssignments: working.assignments.filter((assignment) => removed.has(assignment.itemUnitId)),
    removedAcknowledgedUnitIds: mine
      .filter((unit) => removed.has(unit.id) && unit.confirmedUnassigned)
      .map((unit) => unit.id),
  };
}

/** The pure half of assignment: `transactions.ts` maps a reason to a `TransactionRejectCode` (0021 A3). */
export type AssignmentFailure =
  | "unit_missing"
  | "participant_unknown"
  | "assignment_duplicate"
  | "assignment_missing";

export type AssignmentOutcome =
  | { readonly ok: true; readonly working: WorkingBill }
  | { readonly ok: false; readonly reason: AssignmentFailure };

/**
 * Set membership, one pair per call (DECISIONS/0021 A2). Assigning is the act that rescinds an
 * acknowledgement (§10 line 769), so the flag is cleared in the same returned state — there is no
 * intermediate value in which a unit is both acknowledged and held.
 */
export function assignPair(
  working: WorkingBill,
  unitId: string,
  participantId: string,
): AssignmentOutcome {
  if (!working.itemUnits.some((unit) => unit.id === unitId)) {
    return { ok: false, reason: "unit_missing" };
  }
  if (!working.participants.some((participant) => participant.id === participantId)) {
    return { ok: false, reason: "participant_unknown" };
  }
  if (
    working.assignments.some(
      (assignment) => assignment.itemUnitId === unitId && assignment.participantId === participantId,
    )
  ) {
    return { ok: false, reason: "assignment_duplicate" };
  }

  return {
    ok: true,
    working: {
      ...working,
      itemUnits: working.itemUnits.map((unit) =>
        unit.id === unitId ? { ...unit, confirmedUnassigned: false } : unit,
      ),
      assignments: [...working.assignments, { itemUnitId: unitId, participantId }],
    },
  };
}

/**
 * Removing the last pair leaves the unit pending, not acknowledged (DECISIONS/0021 A4): an un-tick is a
 * statement about who holds the unit, never a statement that the creator will pay for it.
 */
export function unassignPair(
  working: WorkingBill,
  unitId: string,
  participantId: string,
): AssignmentOutcome {
  if (!working.itemUnits.some((unit) => unit.id === unitId)) {
    return { ok: false, reason: "unit_missing" };
  }
  if (!working.participants.some((participant) => participant.id === participantId)) {
    return { ok: false, reason: "participant_unknown" };
  }
  const present = working.assignments.some(
    (assignment) => assignment.itemUnitId === unitId && assignment.participantId === participantId,
  );
  if (!present) return { ok: false, reason: "assignment_missing" };

  return {
    ok: true,
    working: {
      ...working,
      assignments: working.assignments.filter(
        (assignment) => !(assignment.itemUnitId === unitId && assignment.participantId === participantId),
      ),
    },
  };
}
