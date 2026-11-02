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
