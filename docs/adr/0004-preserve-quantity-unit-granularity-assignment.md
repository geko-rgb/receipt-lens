# ADR-004: Preserve quantity and assign at unit granularity

Status: **locked** (seeded from `PROJECT(1).md` §14; exercised by ticket 12).

Preserve `Item.qty` as printed. Ownership is assigned per `ItemUnit`, not by duplicating receipt lines into separate item rows. Unresolved quantity blocks unit creation, assignment, and locking.
