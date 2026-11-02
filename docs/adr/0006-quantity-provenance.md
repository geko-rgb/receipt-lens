# ADR-006: Quantity provenance

Status: **locked** (seeded from `PROJECT(1).md` §14; exercised by tickets 06/11).

Distinguish `explicit`, `assumed`, `unresolved`, and `user_confirmed`. The parser emits only the first three; the PWA records `user_confirmed` for user-supplied or edited quantities.

Rule: assumed quantity is visibly tentative and requires review before lock; unresolved quantity blocks unit creation/assignment/finalization/lock as applicable.
