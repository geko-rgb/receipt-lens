# 07: Conditional validation, findings, and the one-call extract

**What to build:** Extraction results are checked only where the receipt gives enough to check against, producing structured, addressed findings instead of a single confidence number — and a developer can reach all of it through one `extract()` call or through the staged calls, with the package publishable afterwards.

**Blocked by:** 06 (items, quantities and charges)

**Status:** in-review — implemented on `ticket/07-validation-findings-and-extract`, `pnpm -r test` 447 passing

**Effort:** ~40 h · **Roadmap:** workstream 1C (tasks 1C.1–1C.6) plus `extract()` wiring (S4) · **Week:** W6–7 · **Milestone:** M1
**Verify:** `pnpm -r test` green on the validation fixture suite; `extract()` integration test passes from the package entry point

- [x] The computed pre-tax base is compared with a reliable printed grand total only when the present operands semantically reconcile; a receipt with no printed subtotal is never falsely flagged — `validate/arithmetic.ts`, DECISIONS/0011 V1 rows 2/7/8, and **137 of 208 itemized dev receipts are in the no-subtotal state** (`validationPins.test.ts`, "operand presence")
- [x] Item-sum checks run as critical only with full line-total coverage, and otherwise emit a may-be-missing verdict rather than a contradiction — V1 rows 3–5 and V3's direction rule: over-sum critical 27, under-sum minor 17, partial coverage 1, exact 25
- [x] Printed round-off is honoured within the stated band and treated as a charge, while a mismatch beyond it stays critical — `ROUND_OFF_TOLERANCE_PAISE`/`ROUND_OFF_MAX_MAGNITUDE_PAISE`; V2, tested both ways in `arithmetic.test.ts`; dev prints a round-off on 1 comparable receipt and it fails the band
- [x] Two confidence floors apply — a critical floor and a warning floor, with critical never above warning — and null confidence is skipped throughout, emitting an unavailable-confidence finding when every value is null — V5/V6/V7, `RangeError` on a reversed pair; **all 250 dev receipts take `confidence_unavailable` because dev reference OCR supplies 0 scored words** (V0.1)
- [x] Any non-advisory critical caps the affected item's reported confidence — §6 line 408 in `validate/index.ts`; receipt-level caps all, item-level caps one, never raises, never imputes over `null`. Untestable on dev (0 scored items), so covered by `validate.test.ts` "what a critical caps, and what it does not"
- [x] Relaxed arithmetic mode keeps the checks running but marks their findings advisory, and says so in the result — V8; tested in both modes in `arithmetic.test.ts` and `validate.test.ts`, and the pin suite asserts relaxed mode marks **exactly** the `arithmetic_*` findings and nothing else
- [x] Findings carry stable codes addressed to the item, row or charge they concern; only canonical codes are emitted, with legacy spellings mapped at the boundary — `validate/findings.ts`, V9's positional charge refs, V10's boundary mapping; `validate.test.ts` covers legacy→canonical, pass-through of unknown codes, and address integrity
- [x] An itemless result is a critical zero-items finding, not a silent empty success — V11; 42 dev receipts land here, and the ticket-01 stub expectation in `api.test.ts` was replaced with the real behaviour
- [x] `extract()` composes OCR, parse and validate; `parse()` accepts normalized OCR only and is pure; `validate()` takes options; all four entry points are exported with stable exports, browser entry metadata and a quickstart README — `extract.ts`, `packages/core/README.md`, `npm pack --dry-run` clean at 85.2 kB / 317.8 kB unpacked, 83 files (session-measured — the command writes nothing to the repo); the integration test asserts `extract()` equals the staged call on the same input

## Evidence (2026-11-03)

**Pinned before the code, per the checkpoint gate:** `DECISIONS/0011-validation-conditions.md` — V0 the data
budget `validate()` actually has, V1 the 34-row conditional table, V3 the direction rule that stands in for
the uncomputable coverage test, V4 `included` vs `sign: "unknown"`, V5 floor enforcement, V6 name/price
attribution, V7 caps, V8 advisory, V9 charge addressing, V10 canonical codes, V11 `zero_items` and
`invalid_result_schema`, V12 `missing_optional_field` deliberately unemitted, V13 the 06 dispositions, V14
the two-code price split, V15 the outlier multiple, V16 the shipped validator's dev census. Four pins
(V3, V6, V14, V15) were approved by the owner at the checkpoint before any validator code was written.

**Shipped-validate() census over dev** (`validationPins.test.ts`, "emission census" — the real call, not a
restatement): 1,781 findings over 250 receipts, 106 critical, **86 receipts `uncertain`**. By code:
`ambiguous_row` 820, `confidence_unavailable` 250, `qty_assumed` 231, `price_not_resolved` 185,
`qty_unresolved` 141, `zero_items` 42, `arithmetic_total` 34, `arithmetic_item_sum` 27,
`unclassified_charge` 22, `items_may_be_missing` 18, `name_length_outlier` 6,
`ambiguous_price_separator` 2, `item_without_price` 2, `invalid_result_schema` 1.

**Carry-forwards answered.** 187 unresolved prices → 130 data-limited, 17 printed-but-not-extracted (06
defect, filed on its ticket), 38 unattributed, 2 no-line-total. The 2: `cord-v2/dev/78` prints `18 000`
split across two words (06 did not reassemble) and `sroie/dev/3` is a `CASHIER [NAME] TIME` footer that
became an item (05 false positive). Neither is a receipt that failed to print. `Srv Ch`/`SR 6` cannot be
surfaced at all — they never reach `ParseResult` (`charges.ts:108` drops unrecognised labels), which
violates §5 line 159 and is filed as **ticket 20**.

**Three corrections this ticket produced, all committed as assertions rather than prose:**
1. The brief's "3 gold-annotated → 3 exact, so 06 is wrong in zero known cases" is an artifact of the
   matcher: a conflicting `unitPrice` refuses its own pair. Name-only measurement gives **49** dev gold
   items annotating `unitPrice`; 44 unreachable, 3 exact, **2 actively wrong** — both from the
   `items.ts:132` rescue promoting a line total to a `detected` price under an **assumed** `qty 1`.
   **230 of 518 items carry that signature.** Filed on 06 (DECISIONS/0011 V13.1).
2. The 27 item-sum criticals are **not** DECISIONS/0010 Q5's predicted tax/aggregate mechanism. Five
   sampled at row level: charge rows (`PB 1 10%`, `P.Rest 10 %`, `SERV CHARGE 10%`, `SR 6%`) and tender
   rows (`BCA Card`, `DEBIT BCA`) classified as items, plus one correct item list whose subtotal is net of
   an untyped discount. Census: the excess equals the Σ of `%`-row items on 8 of 27, `%` items present on
   11, and 06's own `matchesTenderFamily` explains it on **1**. The subtotal parse is **not** the problem —
   where CORD annotates a subtotal, 06 reads it correctly on **21 of 21**. Filed on 05 and 06.
3. The census first published in the checkpoint (85 uncertain) was a pre-code restatement; the shipped
   validator produces 86, the extra receipt being the single `invalid_result_schema` — `sroie/dev/14`
   `i10` with `qty: 0` marked `explicit`, which §7 forbids. Filed on 06.

**Verified locally:** `pnpm install --frozen-lockfile` ✓ (lockfile unchanged — no dependency added)
`pnpm build` ✓ `pnpm typecheck` ✓ `pnpm -r test` **447 passing** (core 222, pwa 27, benchmarks 198) ✓
`pnpm verify:results` byte-identical ✓ `pnpm verify:fixtures` 715 files byte-identical ✓ `pnpm scan:pii`
idempotence clean, 51 advisories unchanged ✓ `node scripts/model-manifest.mjs --check` up to date ✓
fixture budget 12.0 MB / 50 MB ✓ `npm pack --dry-run` clean ✓. **Not done:** no `npm publish` (needs an
owner decision — the package declares no licence), no branch push, no PR.


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
