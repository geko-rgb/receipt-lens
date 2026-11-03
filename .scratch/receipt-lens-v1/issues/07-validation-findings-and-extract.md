# 07: Conditional validation, findings, and the one-call extract

**What to build:** Extraction results are checked only where the receipt gives enough to check against, producing structured, addressed findings instead of a single confidence number — and a developer can reach all of it through one `extract()` call or through the staged calls, with the package publishable afterwards.

**Blocked by:** 06 (items, quantities and charges)

**Status:** ready-for-agent

**Effort:** ~40 h · **Roadmap:** workstream 1C (tasks 1C.1–1C.6) plus `extract()` wiring (S4) · **Week:** W6–7 · **Milestone:** M1
**Verify:** `pnpm -r test` green on the validation fixture suite; `extract()` integration test passes from the package entry point

- [ ] The computed pre-tax base is compared with a reliable printed grand total only when the present operands semantically reconcile; a receipt with no printed subtotal is never falsely flagged
- [ ] Item-sum checks run as critical only with full line-total coverage, and otherwise emit a may-be-missing verdict rather than a contradiction
- [ ] Printed round-off is honoured within the stated band and treated as a charge, while a mismatch beyond it stays critical
- [ ] Two confidence floors apply — a critical floor and a warning floor, with critical never above warning — and null confidence is skipped throughout, emitting an unavailable-confidence finding when every value is null
- [ ] Any non-advisory critical caps the affected item's reported confidence
- [ ] Relaxed arithmetic mode keeps the checks running but marks their findings advisory, and says so in the result
- [ ] Findings carry stable codes addressed to the item, row or charge they concern; only canonical codes are emitted, with legacy spellings mapped at the boundary
- [ ] An itemless result is a critical zero-items finding, not a silent empty success
- [ ] `extract()` composes OCR, parse and validate; `parse()` accepts normalized OCR only and is pure; `validate()` takes options; all four entry points are exported with stable exports, browser entry metadata and a quickstart README

## Inherited from ticket 06 (2026-11-03)

**187 items with `priceSource: "unresolved"` (of 504 classified item rows) and 2 with no line total on
dev. Emit findings; do not suppress.** 06 left every unestablished amount `null` rather than guessing, so
`price_not_resolved` and `item_without_price` now have real triggers.

07's report must **distinguish data-limited items** (the receipt prints a line total only — no unit price
exists to extract) **from parser-failed items** (a unit price was printed and 06 did not extract it).
The two need different findings: the first is a `missing_optional_field` / data-shape fact, the second is a
06 defect. **If the latter exists, 07 should surface a regression note for 06, not work around it.**
The checkable case for "printed but not extracted" is CORD's `@` marker (a printed unit price): of the
paired CORD items whose gold annotates `unitPrice` — 3 of them — **all 3 agree exactly**, and 0 of the 135
dev pairs has a `lineTotal` that contradicts gold. So 06's extracted prices are currently wrong in zero
known cases; if 07's findings say otherwise, that is a 06 regression to report, not to paper over.

Two more 06 facts 07 must not re-derive by accident: `included` is **never** set by the parser (business.md
§6.6 makes it an explicit-cue decision), so every parsed tax is additive and any `round_off_adjusted`
match will be computed against additive taxes. And `serviceCharge`/`tip`/`discount`/`roundOff` are **sums**
across rows, because the DQ-03 public shape carries one field each — reconciling them against a printed
subtotal assumes that summing, so a mismatch there may be 06's aggregation rather than an OCR error.
