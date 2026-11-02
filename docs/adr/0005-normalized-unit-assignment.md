# ADR-005: Normalized unit assignment

Status: **locked** (seeded from `PROJECT(1).md` §14; exercised by tickets 12/14; model shape referenced by the split engine in ticket 02).

`ItemUnit { id, itemId, unitIndex, confirmedUnassigned }` and `ItemUnitAssignment { itemUnitId, participantId }` form the normalized assignment data. `(itemId, unitIndex)` and `(itemUnitId, participantId)` uniqueness/integrity are enforced, and `count(ItemUnit) = Item.qty` is checked transactionally.

Supersedes: the original business document's `Item.assigned_to` array. **Note:** that external source document is not part of this repo and could not be patched here at seeding time (gate G7 remains open for its owner); inside this repo, `GLOSSARY.md` and this ADR carry the supersession, and no code or doc may reintroduce `assigned_to`.
