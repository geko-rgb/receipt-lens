# 11: Edit the bill without losing the print

**What to build:** The creator resolves drafts into a real bill, adds, edits and deletes items and charges, and never sees a number that disagrees with the data just written — while the printed grand total stays visible as printed even as items change, so the gap between what the receipt said and what the bill says cannot be quietly overwritten.

**Blocked by:** 10 (capture, review and reprocess)

**Status:** in-review — implemented on `ticket/11-bill-editor-transactions` (tip `8cf3a8f`), `pnpm -r test`
573 passing, Playwright 23/23, typecheck 0 errors, `scan:egress` 0 violations. DECISIONS/0019 and DECISIONS/0020
were written and **reported** at Checkpoint 1 before any code, and the failing pins suite was **reported** at
Checkpoint 2 before implementation, as the ticket required — both reports were sent into an unattended
(auto-mode) session, so **no owner approval was received**; work continued on the reported decision rather
than an approved one. Nothing pushed, no PR. If the state-management choice is wrong, say so: it is the one
part of this ticket that would be expensive to change after tickets 12–16 build on it.

**Effort:** ~54 h · **Roadmap:** workstream 3C (tasks 3C.1–3C.6) · **Week:** W14–17 · **Milestone:** M3
**Verify:** bill-state seam suite green (`pnpm -r test`), including the full-state-delta and rollback assertions

- [x] Draft items and charges may hold unresolved values, while resolved items and charges hold integer paise and no nulls; finalization requires resolved fields and is blocked otherwise
- [x] Every add, edit and delete runs as one transaction in a fixed order — persist, recompute derived totals, validate, update findings — and rolls back entirely on failure
- [x] A manual edit permanently marks that value user-confirmed, survives later parsing, and outranks parser-supplied values
- [x] The printed or confirmed grand total is preserved across item edits and deletions, with the difference against the computed total shown rather than reconciled away
- [x] Each charge's inclusion-in-price status is set only from an explicit receipt cue, and an ambiguous one stays unresolved until the creator resolves it
- [x] Items and charges added by hand follow exactly the same editing and validation rules as extracted ones, so a partial receipt can still become a complete bill
- [x] Behaviour is exercised through the bill-state seam: construct a bill, apply an operation, assert the full observable delta including rollback

## Comments

**2026-11-05 — implementation.** Two records precede the code, per the ticket's own order of work:
`DECISIONS/0019-bill-state-management.md` (the store: one immutable `BillDocument` — working bill, derived
state, both validation results — behind a single `$state.raw` root, committed atomically, JSON-safe,
recomputed on load) and `DECISIONS/0020-editor-transactions.md` (what counts as a failure, what an edit may
not touch, the finalization gates, and `validateWorkingBill`'s exact return vocabulary).

- **The seam.** `packages/pwa/src/lib/bill/` (`working-bill`, `document`, `mapping`, `totals`, `units`,
  `finalize`, `transactions`) and `src/lib/validate-bill.ts` — §6 line 399's named path — are
  framework-free. `packages/pwa/tests/bill/pins.test.ts` (71 tests) drives them directly: it injects the
  recompute/validate steps to prove §6 line 400's *order*, and asserts a rolled-back transaction returns the
  previous document by identity, so no derived state from the failed mutation exists anywhere to display.
  `Bill.svelte` holds no rule; `bill-document.svelte.ts` is the ~70-line reactive slot.
- **Print survives edits.** `Bill.grandTotal`/`grandTotalSource` change only under `setGrandTotal`;
  `Item.detectedLineTotal` is set once at finalize and never recomputed, while `lineTotal` is the live
  `qty × unitPrice`; a disagreement raises the coded finding `line_total_mismatch` and the gap
  `reconciliationGap` stays on screen. Deleting an item that closes the gap is asserted in the e2e walk —
  the deletion succeeds and the print is still ₹100.00.
- **Blockers, not prose.** The nine §10 locking codes are emitted from working state with refs; core's
  arithmetic findings are superseded once the bill recomputes them (family, not code — an edited bill can
  answer a *different* member of the family, and core's answer is stale either way). `blockers.unitCreation`,
  `.assignment` and `.finalization` carry the closed vocabularies pinned in 0020 T8.
- **Two things this ticket closes that were open in `HANDOFF.md`:** an `otherSign: "unknown"` charge maps to
  §10's existing `draft_charges_unresolved` (no new §13 code invented), and the
  `splitting.ts:38` "neither assigned nor acknowledged" throw is now a guarded precondition — shares report
  `sharesUnavailableFor: "units_unassigned"` instead of failing an ordinary edit.
- **Corrections to the kickoff, reported before continuing:** pin tests live at
  `packages/pwa/tests/bill/` (the repo convention, included by `tsconfig.test.json`), not `src/tests/`;
  baseline was 502 unit tests (core 222, pwa 66, benchmarks 214) and 21 Playwright tests with 2 tagged
  `@offline`; §6 line 399's file path for `validateWorkingBill` is `src/lib/validate-bill.ts`, so it is not
  under `lib/bill/`.
- **Two claims that changed with the product, in their own explained commit.** `Bill.svelte` is no longer
  ticket 10's placeholder, so `capture.spec.ts`'s handoff assertion now reads the working bill it built;
  and core now sits in the entry chunk because a bill edit calls `validate()` synchronously — exactly the
  consequence `DECISIONS/0017` D4 recorded — so `smoke.spec.ts`'s string proxy became a chunk-graph
  assertion: the ONNX runtime stays a dynamic entry, outside the entry's static closure.
- **Not done, on purpose:** no IndexedDB (ticket 14), no assignment (12), no lock action or unlock (13), no
  participant UI. Fractional quantities (`1.5 kg`) are rejected because §11's unit model cannot represent
  them — filed as an owner question in DECISIONS/0020 rather than decided by an editor constant.
- **Evidence still owed by an earlier ticket:** `DECISIONS/0017` D9.1's footprint remeasurement is now
  unambiguously due — the PWA entry chunk is 144.44 kB raw / 48.12 kB gzip with core in the graph, against
  ticket 10a's 34.278 kB shell, and the published 21.30 MB pair is still the harness's.
