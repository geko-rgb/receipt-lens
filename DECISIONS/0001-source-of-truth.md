# DECISIONS/0001 — Source of truth and G7

Date: 2026-11-02 · Owner decision.

G7 closed by `docs/business.md`; no external pre-spec business document exists;
`PROJECT(1).md` `assigned_to` references are historical annotations only.

`docs/business.md` is the business logic reference, derived from and subordinate to
the consolidated v0.4 spec: if it ever contradicts the spec or a locked ADR, the
spec wins and business.md gets patched — never the reverse. Do not edit
`PROJECT(1).md`.

Known inherited gap recorded by the owner: business.md §9 shows `pa={creator_upi}`
while §2 allows a non-creator payer. For v1, implement payer = creator and leave
`// TODO(spec): payer≠creator payee gap` at the UPI builder (ticket 15). Changing
this requires a spec-level owner decision.
