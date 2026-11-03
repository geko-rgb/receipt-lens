# DECISIONS/0011 — Validation conditions, floors and finding addresses (the Tier-3 pins for ticket 07)

Date: 2026-11-03 · Ticket 07. Slot 0009 is the still-open skills-tracking record (`HANDOFF.md`), so the
number continues 0010's deliberate skip; nothing here belongs to that question.

`PROJECT(1).md` §6 gives a table of codes, one formula and the sentence *"Validation is conditional
(check only present, semantically compatible operands) and scoped"*. It does not give the dependency
graph, and the graph is the ticket: 14 of §6's 20 codes have a precondition that another check's
outcome supplies, and three of them (`arithmetic_item_sum`, `items_may_be_missing`,
`arithmetic_total`) can each be the *wrong* answer for a state the others are right about. Writing
`validate()` without pinning that first produces a validator that is confidently wrong on most of the
corpus — which is what the numbers below are for.

Split discipline holds: measured against `benchmarks/fixtures/dev/` only (250 receipts: CORD `valid`
100 + SROIE `train` 150, 10,424 OCR words, 5,199 clustered rows, 518 parsed items). Nothing read
`eval/` (DECISIONS/0004). Every number in this record is re-derived by the committed
`benchmarks/src/parser/validationPins.test.ts`, in the same role
`benchmarks/src/parser/quantityMoneyPins.test.ts` plays for DECISIONS/0010 — if the parser or these
pins move, that test moves and this record is wrong on its face.

---

## V0 — What `validate()` is actually given

`validate(parseResult: ParseResult, options?: ValidateOptions): ParseValidationResult` (§6 line 398)
sees **only** the `ParseResult`. That is not a stylistic constraint; it is a hard data budget, and
three §6 rules turn out not to be computable inside it:

1. **Word-level scores do not exist here.** §6 line 406 scopes item findings to *"meaningful scores for
   words contributing to the item's name or price"*. The only score in the shape is
   `ParsedItem.confidence`, which 06 computes as the mean over **every** word on the item's rows
   (`parse/items.ts:152` `confidenceOf`) — name, price, quantity, all of it. So name-vs-price
   attribution is not recoverable. See V6.
2. **Charges have no `id`.** §4's `ParsedTax` and `ParsedOtherCharge` carry `label`/`amount`/`sign`,
   and `serviceCharge`/`tip`/`discount`/`roundOff`/`subtotal`/`grandTotal` are bare numbers. §6 line 394
   requires findings be scoped to *"the words/items/rows/charges that caused them"*, so an addressing
   convention has to be invented inside the finding payload. See V9.
3. **A labelled row with no readable amount is not in the shape at all.** 06 skips it
   (`parse/charges.ts:115`, `if (amounts.length === 0) continue;`) and §5 preserves nothing about it,
   so §6's `missing_optional_field` example — *"printed TOTAL label with unreadable amount"* — has no
   trigger. See V12.

**Receipt-wide confidence is also approximated, not computed.** §6 line 407 defines it as *"a
word-count-weighted mean of non-null word scores"*. `ParseResult` carries no word counts. The only
faithful-within-contract reading is a mean over the item confidences that do exist; that is unweighted
by word count and is a documented deviation, not a re-derivation of the spec. It is tolerable only
because the same sentence makes the diagnostic *"never the sole reason to reject a receipt"*.

### V0.1 — The dev corpus cannot exercise the floors at all

Committed measurement (`validationPins.test.ts`, *"dev reference OCR supplies no confidence"*):

| population | count |
|---|---|
| dev OCR words | 10,424 |
| dev words with a non-null confidence | **0** |
| dev provider lines | 5,604 |
| dev lines with a non-null confidence | **0** |
| parsed items | 518 |
| items with a non-null confidence | **0** |

The dev fixtures are dataset *reference OCR* (DECISIONS/0003), and neither CORD's nor SROIE's annotation
carries a recognition score. So on the whole dev corpus every confidence comparison is skipped and
every receipt takes the `confidence_unavailable` path: **the floors have zero dev coverage.** They are
exercised by authored fixtures and, at M1 exit, by real provider output — which is exactly what §17
means by *"pin the two OCR confidence thresholds at M1 exit"*, and why 07 **consumes** 0.50/0.70 rather
than calibrating them (V5). Ticket 04's real-receipt run is the only non-null source in the repo
(HANDOFF: 29 lines / 75 words, mean 0.849, range 0.414–0.996); that is a harness output, not a dev
fixture, and no pin here depends on it.

Consequence to keep honest: **no confidence number in this ticket's report is a dev measurement**, and
09b must not read dev as evidence about the floors.

---

## V1 — The conditional table

The artifact this ticket exists to produce. *"state of the operands → what is emitted → what is
deliberately not emitted → why"*, with the dev population of each row from
`validationPins.test.ts`. Reading a row's "not emitted" column is the review task: an emission not
listed here is a bug, and a non-emission not justified here is a missed check.

Item-sum branch (needs `subtotal` and full line-total coverage). Dev: 208 of 250 receipts produce ≥1
item; 206 have full coverage; `subtotal` prints on 82; `subtotal` + `grandTotal` on 73.

| # | Input state | Emitted | Not emitted | Why | Dev |
|---|---|---|---|---|---|
| 1 | `items.length === 0` | `zero_items` critical, receipt | every arithmetic check | §4 line 322: an itemless result is not a silent success; with no items there are no operands either | 42 |
| 2 | `subtotal === null`, all items have `lineTotal` | — | `arithmetic_item_sum`, `items_may_be_missing` | **can't compare against nothing** (§6 line 394). Absent subtotal is the normal case, not a defect | **137** |
| 3 | `subtotal` present, ≥1 item `lineTotal === null` | `items_may_be_missing` minor, receipt | `arithmetic_item_sum` critical | §6 line 459: incomplete coverage means the sum is not the whole list, so a difference is not a contradiction | 1 |
| 4 | `subtotal` present, full coverage, Σ line totals **>** subtotal | `arithmetic_item_sum` critical, receipt | `items_may_be_missing` | the list is too big or an amount is wrong — per-item edits *can* resolve it, which is §6 line 459's own test for a contradiction | 27 |
| 5 | same, Σ **<** subtotal | `items_may_be_missing` minor, receipt | `arithmetic_item_sum` critical | the parsimonious explanation is rows missing from the parse, and a missing row is not something a per-item edit fixes. See V3 | 17 |
| 6 | same, Σ **===** subtotal | — | everything above | reconciles | 25 |

Total branch (needs `grandTotal`, `subtotal`, and every additive operand's semantics known).

| # | Input state | Emitted | Not emitted | Why | Dev |
|---|---|---|---|---|---|
| 7 | `grandTotal === null` | — | `arithmetic_total`, `round_off_adjusted` | no second operand to reconcile against | 37 receipts have no grand total |
| 8 | `subtotal === null`, `grandTotal` present | — | `arithmetic_total` | §6's formula *starts* at `subtotal`; substituting Σ item totals would be computing the thing being checked | — |
| 9 | any `taxes[].amount === null`, or any `otherCharges[]` with `amount === null` / `sign === "unknown"` | `unclassified_charge` (already 06's warning, re-emitted), charge scope | `arithmetic_total` | *"all required operands **and their semantics** are known"* (§6 line 457). An unclassified charge is not a zero | 14 |
| 10 | `roundOff` printed, `roundOff` matches `expected` within 2 paise and \|roundOff\| ≤ 100 paise | `round_off_adjusted` minor | `arithmetic_total` | §6 line 458: the band is an exception that *passes*, reported as information | 0 |
| 11 | `roundOff` printed, outside the band | `arithmetic_total` critical | `round_off_adjusted` | §6 line 458: *"a larger/mismatched adjustment is a critical contradiction, not a blanket tolerance"* | 1 |
| 12 | no `roundOff`, `expected !== 0` | `arithmetic_total` critical | `round_off_adjusted` | §6 line 457 | 33 |
| 13 | no `roundOff`, `expected === 0` | — | — | reconciles | 35 |

Item branch (per item, independent of the two above).

| # | Input state | Emitted | Not emitted | Why | Dev |
|---|---|---|---|---|---|
| 14 | `unitPrice === null` **and** `lineTotal === null` | `item_without_price` critical, item; caps that item | `price_not_resolved` | the item has no money at all — nothing to split. V14's split of the two codes | 2 items |
| 15 | `unitPrice === null`, `lineTotal !== null` | `price_not_resolved` minor, item | `item_without_price` | the row printed a total; the unresolved field is the unit price, and §7 forbids the parser deriving it. Review/correction, not a broken item | 185 items |
| 16 | `qty === null` or `quantitySource === "unresolved"` | `qty_unresolved` minor, item | — | §7 row 3. 141 of the 187 unresolved-price items are also here — one cause, two codes, both correct | 141 |
| 17 | `quantitySource === "assumed"` | `qty_assumed` minor, item | — | §7 row 2; 06 emitted it, `validate()` re-emits | — |
| 18 | ≥5 items, name length > mean + 2·population SD | `name_length_outlier` minor, item | below 5 items | §6 line 433 makes the ≥5 gate explicit. k is 07's to pin: V15 | 6 items |
| 19 | `unclassifiedRows[]` entry | `ambiguous_row` minor, row, with `rowRefs` | — | §5 line 155: preserved, never force-fitted. **820 rows across 172 of 250 receipts** | 820 rows |
| 20 | row with ≥2 price-column candidates | `ambiguous_price_separator` minor, row | an item | §6 line 460: *"does not produce a finalized item"* | — |
| 21 | `otherCharges[]` with `sign === "unknown"` | `unclassified_charge` minor, charge | counted in arithmetic | §6 line 461, re-quoted verbatim in V4 | 14 receipts |
| 22 | any charge with `included: true` | — | counted in arithmetic | §6 line 456, re-quoted verbatim in V4. **06 never sets it**, so dev exercises the additive branch only | all 0 |

Confidence branch (see V5–V7).

| # | Input state | Emitted | Not emitted | Why | Dev |
|---|---|---|---|---|---|
| 23 | every item `confidence === null` | `confidence_unavailable` minor, receipt, once | every confidence comparison | §4 line 325: *"never invents, imputes, or defaults confidence"* | **250 / 250** |
| 24 | some item scores non-null | comparisons on those items only | a finding for the null ones | null is skipped, not zero | 0 items |
| 25 | item score < critical floor | `ocr_critical_field_confidence` critical, item | the warning-floor codes | one cause, one severity: critical subsumes warning | 0 |
| 26 | critical floor ≤ item score < warning floor | V6's contributing-field minors | `ocr_critical_field_confidence` | between the floors is a review signal, not a rejection | 0 |
| 27 | item score ≥ warning floor | — | — | clean | 0 |

| # | Input state | Emitted | Not emitted | Why | Dev |
|---|---|---|---|---|---|
| 28 | non-advisory critical, any scope | `uncertain: true` | — | `ParseValidationResult.uncertain`'s definition (§4 line 291) | **86 receipts** |
| 29 | only advisory criticals | `uncertain: false` | caps | §4 line 323 | — |
| 30 | non-advisory critical touching an item | `min(confidence, 0.5)` on that item | any change to `null` | §6 line 408. A cap never raises and never imputes | 0 (all null) |
| 31 | `strictArithmetic: false` | arithmetic findings with `advisory: true` | `uncertain`, caps | V8 | — |
| 32 | legacy `low_name_confidence` / `low_price_confidence` in input | canonical spelling | the legacy spelling | §4 line 329 | — |
| 33 | printed label row whose amount was unreadable | — | `missing_optional_field` | **no trigger exists in `ParseResult`** (V12) | 568 rows invisible |
| 34 | row carrying an out-of-dictionary charge label (`Srv Ch`) | — | `unclassified_charge` | 06 drops the row before a charge exists (V13) | measured, see V13 |

Row 2 is the one the ticket calls out by name: *"a receipt with no printed subtotal is never falsely
flagged"* — 137 of 208 itemized dev receipts (66%) are in exactly that state, and a straight-line
validator would have emitted `items_may_be_missing` on all of them.

---

## V3 — Coverage plausibility, decided by direction rather than by magnitude

§6 line 459 gates `arithmetic_item_sum` on *"every relevant parsed item has a line total **and** the
row count/coverage is plausible"*. The first half is computable from `ParseResult`; **the second half
is not** — `validate()` has no idea how many item rows the receipt actually printed, so there is no
coverage ratio to compute. Inventing one (e.g. "≥3 items", "sum within 20%") is a threshold with no
evidence behind it.

What *is* in the data is the **sign of the discrepancy**:

- Σ line totals **<** printed subtotal → an incomplete item list looks exactly like this, and §6 line
  459 says so in terms (*"absent rows suggest extraction incompleteness, not a contradiction that
  per-item edits can automatically resolve"*). → `items_may_be_missing` minor.
- Σ line totals **>** printed subtotal → **missing rows cannot explain it.** Over-inclusion can: a
  phantom item, a wrong amount, or a subtotal read off the wrong row. Those are per-item edits. →
  `arithmetic_item_sum` critical.

So direction is the computable proxy for plausibility, and it is §6's own reasoning rather than a new
threshold. Dev: 25 equal / 27 over / 17 under of the 69 comparable receipts.

### V3.1 — Sampled: the 27 are a classification leak, not Q5's predicted cost

DECISIONS/0010 Q5 forecast that *"any row whose aggregate text 06 cannot read as an inclusion cue will
type as a tax and be reviewed as a charge mismatch — `validate()`'s arithmetic in ticket 07 is what
surfaces it."* That sentence was quoted here as the explanation for the 27 `arithmetic_item_sum`
criticals. **Five receipts sampled at row level say the mechanism is not Q5's**, so the exposure is
real but the prediction is not what produced it. Q5 governs rows 06 already treats as charges
(`noise_header`); every sampled case fails **one stage earlier** — 05 classified the row `item`, so
`readCharges` never saw it and no precedence rule ever ran.

| receipt | excess | printed cause | Q5? |
|---|---|---|---|
| `cord-v2/dev/11` | 810,000 | row 5 `PB 1 10% 8.100` → item `i5`. The 4 real items sum to exactly the printed subtotal | **no** |
| `cord-v2/dev/48` | 559,200 | `P.Rest 10 %` → item (same class as dev/11) | **no** |
| `sroie/dev/37` | 823 | `SERV CHARGE 10%` (496) + `SR 6% 54.56` (327) → items; the two sum exactly | **no** |
| `cord-v2/dev/22` | 33,600,000 | `PB1 28,000` (2,800,000, tax) + `BCA Card 308,000` (30,800,000, tender) → items | **no** |
| `cord-v2/dev/84` | 5,200,000 | `DEBIT BCA 52,000` → item, exactly the excess. The twice-listed `HAZELNUT CHOCO MT (R)` is a genuine double print, not a bug | **no** |
| `cord-v2/dev/8` | 780,000 | no leak at all: the item sum is right and the printed subtotal is **net** of `DISC ITEM -40.000%` / `AMOUNT -7,800`, which 06 left in `unclassifiedRows` | **no** |

Three mechanisms: **percent-charge rows** (`PB`, `P.Rest`, `PB1`, `SERV CHARGE`, `SR 6%`) becoming items,
**tender rows** (`BCA Card`, `DEBIT BCA`) becoming items, and **an untyped discount** making a correct
item list exceed a net subtotal. All three are the same species as V13's dictionary gap — §5 line 385's
safeguard (*"Charge labels are matched before numeric rows are classified as products"*) cannot fire on
labels §5's dictionary does not contain.

Census over all 27, using only shipped predicates (`validationPins.test.ts`, *"the item-sum criticals
are over-inclusive item lists"*):

| test | count |
|---|---|
| excess **equals exactly** the sum of items whose printed row carries a `%` token | **8 of 27** |
| a `%`-row item present, but the excess is not fully attributed | 11 (the 8 above + 3) |
| excess equals exactly the sum of items 06's own `matchesTenderFamily` calls a tender | **1 of 27** |
| parsed `subtotal` disagrees with gold `subtotal` | **0 of 21** |
| no `%` item and no attributed tender | 16 |

The last two rows are the ones that make the finding trustworthy rather than an artifact: **where CORD
annotates a subtotal, 06 reads it correctly on all 21 checkable receipts** — so the comparison is not
broken, the item list genuinely over-counts, and `arithmetic_item_sum` is naming a real defect. And the
tender count of **1** is itself a finding: `DEBIT BCA` and `BCA Card` are *not* in 0010 Q7's tender
family, so the family that removed 441 cash rows does not cover card/deferred payment labels.

The 16 unattributed remain unattributed: no shipped predicate explains them, and inventing a rule to
explain them would be tuning the validator to make a number look better. 07 emits the criticals, files
the regression note, and sets no tolerance.


## V4 — `included` and `sign: "unknown"`, re-quoted verbatim

Two exclusion rules from §6 that the formula's shape hides, restated because getting them wrong changes
money:

> Charges marked `included: true` are already inside the relevant item/subtotal prices and are never
> added again. They also are not split as separate charge amounts. (§6 line 456)

> An `other` charge with `sign: "unknown"` is excluded from arithmetic and emits `unclassified_charge`;
> it must be classified or explicitly excluded before lock if it can affect reconciliation. (§6 line 461)

In `computedBase` the two behave differently and must not be merged: an `included` charge is
**silently not added** (it is already inside the base — the arithmetic is still valid, so no check is
blocked), while an `unknown`-sign charge **blocks the check** (the base is incomplete, and comparing an
incomplete base against a printed total manufactures a contradiction). Dev exercises only the additive
branch, because business.md §6.6 makes `included` an explicit-cue decision and 06 deliberately leaves
the field `undefined` on every charge it emits (DECISIONS/0010, "does not decide"). **07 does not set
`included` either**: 0010 names that as a documented behaviour to be decided elsewhere, and inferring
it because a total happens to match would hide a wrong guess inside a sum.

## V5 — The floors: defaults, and the ordering check

`criticalOcrConfidenceFloor = 0.50`, `warningOcrConfidenceFloor = 0.70`, required
`critical <= warning` (§6 line 405). DECISIONS/0006 line 130 hands both to ticket 07 explicitly and
§17 keeps the calibration at M1 exit, so 07's authority is:

- **Pin the defaults** `validate()` uses when `options` is omitted (the §6 line 398 signature is
  `options?`, so the parameter is optional and the defaults are load-bearing): 0.50, 0.70,
  `strictArithmetic: true`. These are the values §4's own example passes.
- **Consume, never re-decide.** No dev measurement in this ticket argues for a different number,
  because V0.1 shows dev has no scores to argue with.
- **Reject a reversed pair by throwing, not by swapping.** A caller that passes `critical: 0.9,
  warning: 0.6` has a bug; silently sorting the two would hide it and would change which findings the
  caller gets. `RangeError`, following `ocr/provider.ts:25`'s precedent (*"Misuse ... is a programming
  error, not an operational one, so it throws a plain `TypeError` rather than borrowing an operational
  code"*) — a reversed floor is not `IMAGE_UNREADABLE` and must not consume §4's operational code list.
  Non-finite or out-of-`[0,1]` floors are rejected the same way.
- The cap value 0.5 (§6 line 408) is the spec's literal constant, **not** the critical floor: it stays
  0.5 if a future M1 exit moves the floor.

## V6 — What "item-scoped" can mean when the shape carries one number

V0.1 leaves the floors unexercised on dev, but the rule still has to be right, and §6 line 406's
name/price split is not recoverable from `ParsedItem.confidence` (V0 item 1). Options considered:

| option | cost |
|---|---|
| guess one code | attributes a blended score to a field with no evidence for which one |
| always emit both codes | claims a price is unreliable on an item whose price was never printed |
| invent a field-neutral code | adds a member to §4's `ParseWarningCode` union, which is reshaping the public contract |
| **emit the minors for the fields that contributed to the mean** (chosen) | up to 2 findings per low-confidence item |

**Pinned:** `name_confidence_low` is emitted whenever the item has a name (always true), and
`price_confidence_low` additionally when `priceSource === "detected"` — i.e. when a price word actually
fed the mean. The rule degrades to exact attribution in the one case where attribution is possible
(an item with no resolved price has no price words in its score, so it gets the name code alone), and
elsewhere it flags the contributor set rather than guessing inside it. Over-reporting a review
recommendation is the safe direction; suppressing one is the failure §6's whole design argues against.

`ocr_critical_field_confidence` needs no attribution — §6 line 414 states its condition disjunctively
(*"Essential item name **or** price"*), so a blended score below the critical floor satisfies it
directly. That is why the critical case is one code and the minor case is two.

## V7 — Caps

§6 line 408: *"Cap an item's confidence at 0.5 when a non-advisory critical finding affects it.
Receipt-level criticals affect all items; item-level criticals affect only that item."*

- `min(confidence, 0.5)`, and **a cap never raises**: an item already at 0.31 stays at 0.31.
- `null` is never capped into a number — capping null would be imputing a confidence, which §4 line 325
  forbids. Dev's whole corpus is in this state.
- Receipt-scope criticals (`arithmetic_item_sum`, `arithmetic_total`, `zero_items`, receipt-scope
  `invalid_result_schema`) cap every item; item-scope criticals (`ocr_critical_field_confidence`,
  `item_without_price`, item-scope `invalid_result_schema`) cap one.
- Advisory criticals cap nothing (V8). Caps apply to `validation.items` — the canonical list — and
  never mutate the caller's `ParseResult` (§4 line 319's no-mutation rule extends to the return path:
  items are copied, not shared).
- On dev these caps change **zero visible values** (all confidences are null), so the ticket's dev
  numbers say nothing about cap behaviour; it is covered by authored fixtures only.

## V8 — Advisory semantics

`strictArithmetic: false` (§4 line 323, §6 line 462) pins exactly four behaviours, and the ticket asks
for both modes to be tested:

1. the arithmetic checks **still run** — relaxed mode is not "skip arithmetic";
2. every arithmetic finding carries `advisory: true` — arithmetic findings only, never a confidence or
   schema critical, which is not an arithmetic result and has no advisory mode;
3. advisory findings do **not** set `uncertain` (`uncertain` is defined over *non-advisory* criticals,
   §4 line 291);
4. advisory findings do **not** cap confidence (V7) and do not block actions (blocking is the PWA's
   `validateWorkingBill`, §6 line 464 — out of core's remit).

`items_may_be_missing` is emitted in the arithmetic branch and is therefore advisory under relaxed
mode, even though it is minor: what relaxed mode changes is provenance (extraction doubt vs arithmetic
doubt), not severity.

## V9 — How a finding points at a charge that has no id

`ValidationFinding` carries `itemRefs` / `rowRefs` / `chargeRefs` (all `string[]`, all optional). Items
and rows already have positional ids from 05/06 (`i1…`, `u1…`). Charges do not (V0 item 2), so the
convention is defined here, in the same style and with the same guarantees — position-derived,
deterministic, stable within one `ParseResult`, never from `Date.now()` or key order (DECISIONS/0008
"IDs, purity, determinism"):

| charge | ref |
|---|---|
| `taxes[k]` | `t{k+1}` |
| `otherCharges[k]` | `o{k+1}` |
| `serviceCharge` | `service` |
| `tip` | `tip` |
| `discount` | `discount` |
| `roundOff` | `roundOff` |
| `subtotal` | `subtotal` |
| `grandTotal` | `grandTotal` |

The six scalar fields get fixed names because there is exactly one of each in §4's shape — an ordinal
would be noise. These refs live only in findings; §4's charge shape is not reshaped to carry them.

Every finding is addressed to the thing that caused it: item findings carry `itemRefs`, preserved-row
findings carry `rowRefs`, charge findings carry `chargeRefs`, receipt-scope findings carry none.
Parse warnings that arrived with `itemRef`/`sourceLineIds`/`sourceText`/`sourceBox` keep their address
(`sourceLineIds` → `rowRefs` where a row is implicated).

## V10 — Canonical codes only

§4 line 329: legacy `low_name_confidence` / `low_price_confidence` are mapped to `name_confidence_low`
/ `price_confidence_low` **at the API boundary**, and *"do not maintain two meanings for equivalent
codes"*. In `validate()` the boundary is the re-emission of `ParseResult.warnings` and of
`items[].warnings`:

- input may legally carry a legacy spelling (it is `JSON`-shaped data from a caller, and
  `ParseWarningCode` will not type it — the mapping is a runtime normalisation, not a type widening);
- output — `findings[].code` and `validation.items[].warnings[].code` — carries **canonical only**;
- an unknown code is passed through unchanged rather than dropped, so a future parser code is never
  silently swallowed by the validator.

## V11 — `zero_items` and `invalid_result_schema`

`zero_items`: §4 line 322 attaches *"for an input expected to be an itemized receipt"* to the
condition, and core cannot know intent. Pinned: **emit whenever `items.length === 0`.** The product is
a receipt itemizer, so an itemless result is never success; a blank scan *should* read as critical.
Dev consequence: 42 of 250 receipts (17%) produce zero items and will carry this finding — that is the
05/06 coverage fact §6's finding is designed to expose, not a validator defect.

`invalid_result_schema`: §6 line 419 says *"output violates required types/ranges or contains invalid
numeric values"*. What core can actually check without a schema library, and what §7's "reject zero,
negative, NaN, or infinity" sentence demands of the values that do exist:

- any amount present but not a finite safe integer (paise); `unitPrice`/`lineTotal`/`amount`/`subtotal`/
  `grandTotal` negative (all are positive magnitudes per §4);
- `roundOff` non-zero with a magnitude beyond the V2 band is *arithmetic*, not schema — no finding here;
- `qty` present but not a finite positive integer;
- `confidence` outside `[0, 1]` when non-null;
- duplicate item/row ids, or a warning `itemRef` naming an id that is not in `items` (a dangling
  address is a broken finding, and finding-address integrity is what §6 line 394 is for);
- a `source` field outside its declared enum.

Scope is receipt for whole-result violations (duplicate ids, dangling refs) and item/charge for a bad
value on one entity, per §6's *"Receipt/item as applicable"*.

## V12 — `missing_optional_field` stays unemitted

§6 line 438: *"Emit **only** when a strong receipt cue indicates a value should exist, e.g. printed
TOTAL label with unreadable amount."* V0 item 3 established that this cue does not survive into
`ParseResult`: 06 drops a labelled row with no readable amount, silently and without a warning, and
0010 Q5 counts that population at **568 dev rows**.

So the honest pin is **do not emit it**, rather than manufacture a proxy. The tempting proxies are all
wrong: `subtotalSource === "unresolved"` is 137 receipts of ordinary absence, not a cue; a null tax
`amount` already has 06's `unclassified_charge` and re-emitting it under a second code would be V10's
forbidden "two meanings for equivalent codes". The code stays in §4's union and in `validate()`'s
vocabulary, unused on dev, with the enabling change named in V13 as 06's to make.

## V13 — What 06 handed over, dispositioned

The ticket's three carry-forwards, answered from `validationPins.test.ts`.

**Carry-forward 1 — 187 items with `priceSource: "unresolved"`.** Emitted as findings, not suppressed
(V14's split). Classification rule, using 06's own money predicate verbatim (`%` tokens are printed
rates; a bare 1–2 digit non-zero integer is a count) so the measurement cannot be looser than the
matcher — the exact failure DECISIONS/0010 published its correction table for:

| bucket | test | count |
|---|---|---|
| **data-limited** | no readable money on the item's rows except its own `lineTotal` | **130** |
| **printed but not extracted** | another readable money token `t` with `t × qty === lineTotal`, `qty ≥ 2` | **17** |
| **other money, not reconciling** | survivors exist, none satisfies the multiplication | **38** |
| no `lineTotal` at all | V14 row 14 | **2** |

130 + 17 + 38 + 2 = 187, and the arithmetic closes.

The **130 are data-limited and correct**: the receipt prints `qty` and a line total and no unit price,
and §7 forbids deriving one. `lineTotal` agrees on **133 of 133** comparable pairs across **135** pairs,
**0 contradictions** — re-deriving 06's own claim exactly.

### V13.1 — Correction: the paired-gold check could not see a wrong unit price

This record first published, from `validationPins.test.ts`'s paired census, *"...of `dev/cord-v2`'s gold
items, only 3 annotate `unitPrice` at all, and all 3 match 06's extraction exactly; 0 absent, 0 wrong"* —
repeating the ticket's own framing. **It is wrong, and the error is the matcher's pairing rule, not the
data.** DECISIONS/0006 records `unitPrice` as null on 205 of 254 CORD gold items, i.e. **49 annotated**,
not 3. The census counted 3 because `matchItems` enforces money compatibility *before* a pair exists
(§8.2, Option B: where both sides annotate an amount the integers must be equal), so a gold `unitPrice`
that **conflicts** with 06's is refused as a pair and silently leaves the denominator. A check whose
failing case removes itself from the sample cannot report "0 wrong".

Measured by name similarity alone, with τ = 0.70 over normalized names and money ignored (`validationPins.test.ts`,
*"the matcher's money gate hid 06's wrong unit prices"*):

| population | count |
|---|---|
| dev gold items annotating `unitPrice` | **49** |
| no name-similar parsed item (unreachable — 0008's 16, P5's scrambling) | 44 |
| name-matched, `unitPrice` **exact** | 3 |
| name-matched, `unitPrice` **absent** (06 left it unresolved) | **0** |
| name-matched, `unitPrice` **wrong** | **2** |

**So 06's extracted prices are wrong in 2 known cases, not zero**, and both share one mechanism — the
`qty === 1` rescue at `parse/items.ts:132`, which promotes a printed **line total** to a
**`detected` unit price** when the quantity reads as 1. It fires on an **assumed** 1 as happily as on a
printed one: `cord-v2/dev/8` prints `3X @6500` on one row and `TALAM UNGU 19,500` on the next; 05
classified the first `noise_header`, so the item's quantity is assumed 1, the rescue fires, and
`unitPrice` comes out 1,950,000 against a gold 650,000. Same shape on `cord-v2/dev/68` (`Honey
Mandarin`: 2,600,000 returned against a gold 1,300,000). Both matched names score 1.000 — these are not
pairing noise.

Exposure: **230 of 518 dev items carry the rescue signature** (`quantitySource: "assumed"` and
`unitPrice === lineTotal`). 2 of them are known wrong; 5 are name-checkable in total. The other 225 are
unmeasured, not clean. That is 06's to answer, not a number 07 may quote as a pass rate.

**Carry on it, because it changes a §7 reading:** an assumed quantity is a *guess*, and §7's price table
defines `detected` as *"Parser resolved price from OCR/receipt text"*. A unit price that exists only
because the parser guessed qty 1 was not resolved from receipt text. The rescue is sound when the 1 is
printed; it is §7-inconsistent when the 1 is assumed. Recorded as a 06 regression note; 07 does not
repair it and does not silence it — the item is reported with `priceSource: "detected"`, which is the
state 06 produced.


**The 17 are a 06 defect, and this is the ticket's regression note.** They are not "unit prices the
parser chose not to derive" — the value is *printed on the row* and the multiplication only *verifies*
a token that is already there. `cord-v2/dev/14` i1 is named `@ 12.000 Kroket` with `qty 2` and
`lineTotal 2,400,000`: the row prints both prices, 06 put the unit price **in the name field** and left
`unitPrice` null. Two mechanisms, both visible in the examples:

1. **Marker adjacency.** CORD's `@` prefix marks a unit price, but `readMoney` sets
   `unitPriceMarker` only when `@` is glued to the amount token (`parse/money.ts:65`). When OCR emits
   `@` as its own word the marker is lost — `dev/14` is exactly this. The saving check: across all 187,
   **0 items had a marker token that 06 left unresolved**, so the glued case is never missed; only the
   split-word case is.
2. **No second-money reconciliation.** Nothing in `parse/items.ts` compares a row's other readable money
   against `qty × unit === total`, so the token survives as part of the item name.

Complication worth stating rather than hiding: **141 of the 187 also have `quantitySource:
"unresolved"`,** and the two are the same root cause — `REGULAR 2 35000.00` printed both numbers, 06
attributed neither the quantity nor the unit price, and `qty === null` is also why the `qty === 1`
rescue (`items.ts:132`) could not fire. The 38 "other money, not reconciling" are dominated by this:
the multiplication is unrunnable without a quantity. They are not a third verdict, they are the same
defect one stage earlier. Fixing Q1's quantity-column attribution is likely to collapse 38 and most of
17 together, and that is 06's (or 09b's measurement's) to do, not 07's to work around.

**Carry-forward 2 — the 2 items with no `lineTotal`.** Individually identified, and **neither is
data-limited**:

| receipt | item | row | disposition |
|---|---|---|---|
| `cord-v2/dev/78` | `i1` "Mineral Water", `qty 2` explicit | `2 \| Mineral Water \| 18 000` | **printed and not extracted.** The total is `18 000`; OCR split it into two words and the grammar reads neither, so `lineTotal` is null |
| `sroie/dev/3` | `i1` "CASHIER [NAME] TIME", `qty 1` assumed | `CASHIER [NAME] TIME 12 31 00` | **not an item at all.** A header/footer row with a time in it, classified as an item by 05 and carried through 06 |

So 07's finding is `item_without_price` critical on both (V14), and the *report* says one is a
money-grammar/tokenization gap and the other is a classification false positive. Both are 05/06
defects; neither is a receipt that failed to print something.

**Carry-forward 3 — DECISIONS/0010 Q2's dictionary gap (`Srv Ch`, `SR 6`).** Not 07's to fix, and the
ticket's expectation *"if 07's findings surface them as `unclassified_charge`, that's correct
behavior"* **does not happen**, because the rows never reach `ParseResult`. `Srv Ch Rp 9,736` carries no
label in §5's dictionary, so `chooseCategory` returns null and `readCharges` skips the row whole
(`charges.ts:108`, `if (category === null) continue;`) — there is no charge object left to warn about.
Verified from the shipped parser: across all dev `taxes[]` and `otherCharges[]` emitted, the complete
label set is `gst`, `pajak`, `tax`, `total` — **no `Srv`/`SR` label appears in any charge**, so
`unclassified_charge` cannot fire on it. 07 neither invents the finding nor suppresses the question:
the gap is named in DECISIONS/0010 as "not in §5's list, and 06 does not extend a spec-owned dictionary
on initiative", so surfacing it needs a 06 change (preserve unlabelled money-bearing rows as
`otherCharges` with `sign: "unknown"`, which §5's line 159 already mandates — *"An amount with an
unrecognized label is preserved with its label text and a warning"*). That is a real spec/implementation
gap for the owner, not a validator setting.

## V14 — How `item_without_price` and `price_not_resolved` split one field

§6 lists both for essentially the same state, and naively firing both on `unitPrice === null` would emit
2 findings for one fact — 374 on dev. They are separated by whether the item has *any* money:

- **`item_without_price`, critical** — no `unitPrice` *and* no `lineTotal*. Nothing to split, nothing to
  reconcile; §6's "blocks finalization" is a hard stop. Dev: 2 items.
- **`price_not_resolved`, minor** — no `unitPrice`, but a printed `lineTotal` exists. The row is
  intelligible and the missing value is the per-unit breakdown §7 refuses to derive; §6's "blocks
  finalization until corrected" still holds as a *review* requirement. Dev: 185 items.

Severity, not duplication: exactly one of the two per item.

## V15 — `name_length_outlier`'s sigma multiple

§6 line 433 fixes the statistic (population SD) and the gate (≥5 items) but not the multiple. Pinned
**k = 2.0**, with the dev cost of each candidate measured (`validationPins.test.ts`,
*"name-length outliers"*): only **25 of 250** dev receipts even have ≥5 items, and across those:

| k | items flagged | reading |
|---|---|---|
| 1.0 | **62** of 518 | fires on ~12% of the corpus — noise for a "warning only, not proof of an error" |
| **2.0** | **6** | flagrant only |
| 3.0 | **0** | never fires, so the code is dead |

k = 1.0 is a distribution property, not a finding; k = 3.0 is an unused code. 2.0 sits between them on
the actual data. Side note that keeps the finding honest: the longest name in dev is 107 characters and
the longest among the eligible receipts is **62** — the 107-char name is on a receipt too small for the
check to run, so this finding demonstrably does not catch the worst-looking case, exactly as §6's ≥5
gate intends.

## V16 — The shipped validator's dev census

Every number above was produced by an in-test restatement of these rules while `validate()` did not exist.
It does now, and the census below is the **shipped `validate()`** run over all 250 dev receipts with the
§6 defaults — the same call a consumer makes. It reproduces V1's table, which is the point: the table is
now a property of the code, not of the measurement script.

| code | findings | severity | | code | findings | severity |
|---|---:|---|---|---|---:|---|
| `ambiguous_row` | 820 | minor | | `items_may_be_missing` | 18 | minor |
| `confidence_unavailable` | 250 | minor | | `name_length_outlier` | 6 | minor |
| `qty_assumed` | 231 | minor | | `ambiguous_price_separator` | 2 | minor |
| `price_not_resolved` | 185 | minor | | `item_without_price` | 2 | critical |
| `qty_unresolved` | 141 | minor | | `invalid_result_schema` | 1 | critical |
| `zero_items` | 42 | critical | | | | |
| `arithmetic_total` | 34 | critical | | | | |
| `arithmetic_item_sum` | 27 | critical | | | | |
| `unclassified_charge` | 22 | minor | | | | |

1,781 findings over 250 receipts; **106 critical across 86 receipts** (`uncertain: true` = 86, not the 85
V1 first stated — the extra receipt is the single `invalid_result_schema` below, which the pre-code census
could not have produced). Zero advisory findings, as expected with `strictArithmetic: true`.
`name_length_outlier` = 6 confirms V15's predicted cost exactly. `price_not_resolved` 185 +
`item_without_price` 2 = the 187 carry-forward, with no double-counting.

**No item's confidence was capped, and none could be:** all 518 dev items score null, so the 106 criticals
cap 0 values (V7's "null is never capped into a number" branch is the only one dev can reach). Committed
in `validationPins.test.ts` ("emission census"), which also asserts relaxed mode marks exactly the
`arithmetic_*` findings advisory and nothing else.

The lone `invalid_result_schema` is a real 06 output, not a validator artifact: `sroie/dev/14` item `i10`
("ZRL") carries **`qty: 0` with `quantitySource: "explicit"`** — the receipt printed `0` as a quantity and
06 recorded it as an explicit value. §7 requires a finalized quantity to be *finite and positive* and to
"reject zero, negative, NaN, or infinity", so an explicit zero is exactly the case that rule names. 07
reports it; correcting it is 06's (an explicit zero is arguably a printed fact the parser must not discard,
which would make §7's range the thing to revisit — recorded for the owner rather than decided here).

## Reporting discipline

0008's rule applies verbatim and is the reason this record was written before the code: every number
above is produced by the committed `validationPins.test.ts`, and any figure that cannot be regenerated
from it is marked or omitted. Deltas name both heads — the head this ticket starts from is `de1667f`
(06 merged, 348 tests passing: core 134, pwa 27, benchmarks 187). Session measurements were used to
*find* these numbers and are not what this record publishes.

One published number is deliberately qualified rather than claimed: V0.1's "floors have no dev
coverage" is a negative measurement, and it constrains what 09b may conclude from dev exactly as
0008's rule 3 note constrains its own metric.

## What this record does not decide

- **Whether the 27 `arithmetic_item_sum` + 33 `arithmetic_total` criticals are "correct".** They are
  what §6's rules produce on dev, and V3.1 attributes 11 of the 27 (8 fully, 3 partly) to
  percent-charge rows and 1 to a tender row — **not** to Q5's precedence mechanism, which this record
  first claimed. Whether the remaining 16 are phantom items, wrong amounts or OCR contradictions is 09b's
  per-field measurement, and 07 adds no tolerance to make the number look better.
- **Any change to the floors.** 0.50/0.70 stay as §6 wrote them; M1 exit calibrates (§17). 07 consumes.
- **Setting `included` from an arithmetic match.** 0010 names this as a documented behaviour to be
  decided, not a side effect. V4 keeps every dev charge additive.
- **Implicit round-off tolerance when no round-off was printed.** §6 line 457 says "material mismatch"
  and the round-off band (§6 line 458) is written for a *printed* round-off. 5 of the 33 dev
  `arithmetic_total` criticals are within 100 paise and would vanish under an implicit-round-off rule;
  adopting one is a spec change, so 07 keeps the literal reading and publishes the count.
- **The currency-scaled round-off band.** §6 states the band in ₹ (2 paise, ≤ 100 paise) while dev is
  Rp and RM — amounts whose sensible round-off is Rp 500. 07 pins the band as written, in minor units,
  currency-blind, and reports that the single dev receipt with a printed round-off fails it
  (`roundOffInBand: 0 of 1`). Per-currency scaling is an owner/M1-exit question.
- **Fixing 06's two named defects** (marker adjacency, second-money reconciliation) or 05's
  `sroie/dev/3` false-positive item. 07 emits findings for their consequences and files the note.
- **`validateWorkingBill` and `LockBlocker`.** PWA-owned (§6 lines 398–401); core emits no blocker and
  reads none.
- Nothing here consumes or amends DECISIONS/0006 (floors handed *to* 07, not changed), 0008 or 0010;
  and the provider's 0.5 banding stays untouched per DECISIONS/0007.
