# 11: Edit the bill without losing the print

**What to build:** The creator resolves drafts into a real bill, adds, edits and deletes items and charges, and never sees a number that disagrees with the data just written — while the printed grand total stays visible as printed even as items change, so the gap between what the receipt said and what the bill says cannot be quietly overwritten.

**Blocked by:** 10 (capture, review and reprocess)

**Status:** ready-for-agent

**Effort:** ~54 h · **Roadmap:** workstream 3C (tasks 3C.1–3C.6) · **Week:** W14–17 · **Milestone:** M3
**Verify:** bill-state seam suite green (`pnpm -r test`), including the full-state-delta and rollback assertions

- [ ] Draft items and charges may hold unresolved values, while resolved items and charges hold integer paise and no nulls; finalization requires resolved fields and is blocked otherwise
- [ ] Every add, edit and delete runs as one transaction in a fixed order — persist, recompute derived totals, validate, update findings — and rolls back entirely on failure
- [ ] A manual edit permanently marks that value user-confirmed, survives later parsing, and outranks parser-supplied values
- [ ] The printed or confirmed grand total is preserved across item edits and deletions, with the difference against the computed total shown rather than reconciled away
- [ ] Each charge's inclusion-in-price status is set only from an explicit receipt cue, and an ambiguous one stays unresolved until the creator resolves it
- [ ] Items and charges added by hand follow exactly the same editing and validation rules as extracted ones, so a partial receipt can still become a complete bill
- [ ] Behaviour is exercised through the bill-state seam: construct a bill, apply an operation, assert the full observable delta including rollback
