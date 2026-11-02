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
