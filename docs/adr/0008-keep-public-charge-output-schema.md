# ADR-008: Keep the selected public charge output schema

Status: **locked** (DQ-03 = B; seeded from `PROJECT(1).md` §14; the shape is defined by ticket 02 and populated by ticket 06).

Keep the public `ParseResult` fields `taxes[]`, `serviceCharge`, `tip`, and `discount` separate — the owner's chosen public shape. Add explicit `roundOff` (signed integer paise) and `otherCharges[]` so Indian round-off/unclassified charges are representable without replacing it.

Internal model: the PWA maps public parsed fields into one `BillCharge[]` with a `type` discriminator (`tax`, `service_charge`, `tip`, `discount`, `round_off`, `other`). This internal unification is not a public API shape change.

Draft rule: unresolved null amounts exist only in draft/import entities; finalized `BillCharge.amount` is a resolved integer-paise value.
