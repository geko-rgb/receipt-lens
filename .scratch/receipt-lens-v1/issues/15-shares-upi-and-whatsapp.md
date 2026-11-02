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
