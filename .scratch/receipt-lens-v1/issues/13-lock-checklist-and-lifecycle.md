# 13: The lock checklist and bill lifecycle

**What to build:** Locking becomes a checklist the creator can read and clear, computed from the bill as it currently stands rather than from what the parser once thought — drafts unresolved, units unassigned, assumed quantities unreviewed, total or payer missing, unclassified rows unreviewed, negative share after discount — and unlock is available but honest about invalidating links already sent.

**Blocked by:** 12 (per-unit ownership), 02 (exact money and the golden split)

**Status:** ready-for-agent

**Effort:** ~22 h · **Roadmap:** workstream 3C (tasks 3C.7–3C.8) · **Week:** W16–17 · **Milestone:** M3
**Verify:** blocker matrix test — every blocker code is produced by its condition and cleared by its fix, in CI

- [ ] Blockers are structured codes computed from complete current state, never from stale parse arithmetic and never by parsing display text
- [ ] Every listed blocker has a test proving the condition produces it and the corresponding fix clears it
- [ ] Locking is possible only with an empty blocker list, and the locked bill's totals and shares are computed once against resolved data
- [ ] The lifecycle moves draft, review-required, ready-to-lock, locked and settled, with the UI state derived from blockers rather than tracked separately
- [ ] Payer defaults to the creator, both are participants, and a non-participant payer is rejected
- [ ] Unlocking requires an explicit confirmation, regenerates share links, and marks previously issued links as stale snapshots rather than leaving them silently contradicting the bill
- [ ] Contradicts nothing in the split-engine decisions: unlock never mutates a locked bill in place without regenerating its shares

## Notes from the e2e run (2026-11-05)

- **Roster is unreachable while a bill is in `draft` — forwarded to ticket 14 by owner ruling.** `Bill.svelte`
  renders `<Units>` inside the `{:else}` of `{#if working.items.length === 0}`, so the participants section — the
  roster, the payer select, the per-unit assignment checkboxes and the acknowledge button — does not exist in the
  DOM until the first item is finalized. A creator who wants to add people before touching the lines has no
  control to add them with, and the only way in is Finalize all resolved.
  `playwright/lock-lifecycle.spec.ts` asserts the constraint (`participant-name` absent in draft) rather than
  fighting it. Not a bug: a UX decision, handed to ticket 14 because persistence may require it.
- **A refused assignment left the checkbox visually checked (fixed in ticket 13 by owner ruling).**
  `Units.svelte`'s `toggle` published `assignUnit`/`unassignUnit` and ignored the result, while `checked` is bound
  one-way — so after a `bill_locked` refusal the box stayed ticked with no assignment in the document, against the
  component's own §6-line-400 header rule. `onPaid` and `onPayer` already rolled back; `toggle` now does the same.
  Found by the lock e2e's `expect(box).not.toBeChecked()`; ticket 12 never exercised a `bill_locked` rejection
  because that state did not exist until ticket 13.
- **A refused removal keeps its modal backdrop up — accepted as-is by owner ruling, not a bug.**
  `confirmRemoval` clears `removing` only on `ok`, so the dialog stays open while the user reads why the removal
  failed, and its backdrop then swallows every pointer event on the page. Correct UX: read the error, dismiss to
  continue. Tests must click `remove-cancel` after asserting the rejection before touching anything else.
