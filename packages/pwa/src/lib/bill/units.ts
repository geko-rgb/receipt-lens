import type { Item, ItemUnit } from "./working-bill.js";

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
