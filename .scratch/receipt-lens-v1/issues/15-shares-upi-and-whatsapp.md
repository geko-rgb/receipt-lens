# 15: Pay someone — exact share, UPI link, WhatsApp

**What to build:** Each participant sees their exact share, stated as a fraction when it repeats, and a separate whole-paise payment amount they can pay in one tap; a participant who owes nothing gets no payment link; and the creator can send a participant their share through WhatsApp as a deliberate action.

**Blocked by:** 13 (lock checklist and lifecycle)

**Status:** ready-for-agent

**Effort:** ~38 h · **Roadmap:** workstream 3F (tasks 3F.1–3F.6) · **Week:** W19 · **Milestone:** M3
**Verify:** UPI invariant matrix green — encoding, charset, length, decimals, zero-share, self-payment — across the declared app shapes; G5 verification note committed

- [ ] Where exact and payable amounts differ, both are shown and distinctly labelled; where they are equal, the duplication is suppressed
- [ ] A participant with a zero exact share sees a nothing-to-pay state and no payment link is generated
- [ ] The deep link prefills payee, two-decimal amount and note, with the amount always formatted to two decimals and every parameter URL-encoded
- [ ] Parameter length limits are enforced as specified, with over-long notes truncated rather than dropped, and an optional transaction reference produced deterministically within its length and charset
- [ ] Limits are verified against the primary scheme specification before the constants are locked, and the verification is recorded
- [ ] The payer and creator never receive a self-payment link
- [ ] Payment confirmation is a manual action only, and no copy anywhere claims a transfer settled or was verified
- [ ] The WhatsApp share is click-to-chat carrying the participant's exact share, settlement amount and bill link, and is described as an external deliberate action

## Forwarded to ticket 15 (from ticket 14's `DECISIONS/0023` P12, 2026-11-05)

Two things ticket 14 found, dispositioned as 15's rather than 14's — 14 changed neither:

- **A refused removal leaves its modal backdrop up, swallowing every pointer event on the page.** Accepted
  as-is by the owner's ruling in ticket 13 (`.scratch/receipt-lens-v1/issues/13-lock-checklist-and-lifecycle.md:35-38`):
  `confirmRemoval` clears `removing` only on `ok`, so the user reads why it failed, then dismisses. Ticket 14
  does not exercise a refused removal in e2e, so the workaround is not inherited here — but it lands on 15,
  which owns the `paid` toggle that can produce a `participant_paid` refusal on screen. **Any 15 spec that
  asserts a rejected removal must click `remove-cancel` before touching anything else**, or the failure looks
  like a hanging locator rather than a dialog doing what it was ruled to do.
- **Ledger rows for abandoned imports.** `DECISIONS/0023` P7 saves revision 0 for every accepted capture, so
  a capture the creator never edits still leaves a past-bills row. Not a data-loss or privacy problem — the
  row is labelled with its draft count and deletable — but 15 is the next ticket to present the ledger (the
  settlement view, the paid toggle), so it is the right place to notice if the list is filling up. Owner's
  framing at the checkpoint 1 gate: *"Consider auto-pruning bills with zero items and no edits after N days,
  or a soft-delete flag, if the ledger accumulates abandoned imports. Not required for 14."* Decide it with a
  number attached, or leave it and say so; either is a ruling, silence is not.

