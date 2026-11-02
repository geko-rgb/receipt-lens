# ADR-005: Normalized unit assignment

Status: **locked** (seeded from `PROJECT(1).md` §14; exercised by tickets 12/14; model shape referenced by the split engine in ticket 02).

`ItemUnit { id, itemId, unitIndex, confirmedUnassigned }` and `ItemUnitAssignment { itemUnitId, participantId }` form the normalized assignment data. `(itemId, unitIndex)` and `(itemUnitId, participantId)` uniqueness/integrity are enforced, and `count(ItemUnit) = Item.qty` is checked transactionally.

Supersedes: the original business document's `Item.assigned_to` array — closed by `docs/business.md` (see `DECISIONS/0001-source-of-truth.md`, gate G7): the business reference now documents the normalized model, and `PROJECT(1).md` mentions of `assigned_to` are historical supersession annotations only. No code or doc may reintroduce `assigned_to`.
