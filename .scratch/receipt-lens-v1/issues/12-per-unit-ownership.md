# 12: Per-unit ownership

**What to build:** Each item is materialized into one unit per quantity, and those units are assigned to people — one unit per person for a shared dish, several units to one person for a solo dish, some units explicitly left unowned — so that a quantity of three shared two ways and one unassigned is expressible without inventing a fraction of a dish.

**Blocked by:** 11 (bill editor transactions)

**Status:** ready-for-agent

**Effort:** ~20 h · **Roadmap:** unit materialization inside workstream 3C (ADR-005, parts of 3C.3–3C.4) · **Week:** W15–17 · **Milestone:** M3
**Verify:** bill-state seam suite green for units and assignments, including quantity-decrease warnings and rollback

- [ ] Finalizing an item materializes exactly its quantity in units, and the count is enforced transactionally on every quantity change
- [ ] Assignment is stored as item-unit-to-participant pairs with uniqueness enforced, duplicates rejected, and no assignment surviving for a removed unit
- [ ] A unit assigned to several people divides its integer-paise price exactly across them, with no rounding introduced
- [ ] A unit can be explicitly confirmed-unassigned, distinct from simply lacking an assignment
- [ ] A quantity decrease warns about the assignments it will remove and applies the removal in the same transaction
- [ ] An acknowledged unassigned unit contributes its full cost to the creator's share as an explicit adjustment line at lock time, never as a rounding bucket
- [ ] Behaviour is exercised through the bill-state seam, including the rollback and warning paths

## Comments

**2026-11-05 — forward note from ticket 11 (owner ruling on fractional quantities).**

A fractional/weight quantity has **no unit representation** in §11's model, and that constrains what this
ticket can assign. `DECISIONS/0020` T6: `setItemQuantity` rejects anything that is not a positive integer as
`invalid_quantity`, because `ItemUnit` is `unitIndex 0..qty−1` — there is no half-unit to hand to a person.
The owner ruled this a documented v1 product limit, now in `PROJECT(1).md` §19 and `docs/business.md` §16:
users enter weight-based items as whole units at full price. If 12 wants a different answer (per-gram
pricing, fractional shares of one unit), that is a spec change and needs its own record — not an editor
constant, and not a unit whose `unitIndex` is 0.5.

What 12 inherits from 11 in practice: `working.itemUnits` / `working.assignments` are already maintained
transactionally (`totals.ts` enforces `count(units) = qty` and drops orphaned assignments in recompute, so a
violation surfaces as `recompute_failed` and rolls the edit back); `assignments` is the only field 12 has to
write; `blockers.assignment` already emits `unit_missing`, `participant_unknown` and `assignment_duplicate`;
and `acknowledgeUnassignedUnit` in `transactions.ts` refuses a unit that already has assignments
(`unit_assigned`), which is what makes §10 line 769's "assigning clears `confirmedUnassigned` in the same
transaction" a real rule instead of a hope. `adjustmentLines` are regenerated from acknowledged units on
every recompute, so 12 must not maintain them by hand.
