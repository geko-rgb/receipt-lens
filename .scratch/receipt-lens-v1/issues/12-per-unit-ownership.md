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
