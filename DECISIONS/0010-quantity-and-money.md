# DECISIONS/0010 — Quantity columns, money grammars, label matching (the Tier-3 pins for ticket 06)

Date: 2026-11-03 · Ticket 06. Slot 0009 is the still-open skills-tracking record (`HANDOFF.md`), so the
number skips it deliberately; nothing here belongs to that question.

`PROJECT(1).md` §5 specifies quantity rules, a number-format table and a label dictionary, but leaves
the deciding parameters as prose or as an incomplete table: "at least 60% of **its rows** contain
integers ≤ 20, aligned left or right", "`1,23,456.78` = 123456.78", "match the longest label first",
and — the gap underneath all of them — never says how `parse()`, which takes only an `OcrResult`
(§4 line 147), learns *which* locale profile to read a document with. Every constant here decides
either which rows become items or what a number is worth, so each is pinned **before** the parser is
written, with the dev-fixture measurement that bounds it, per §5 line 336 ("Publish the selected
constants after tuning").

Split discipline holds: measured against `benchmarks/fixtures/dev/` only (250 receipts: CORD `valid`
100 + SROIE `train` 150, 5,199 clustered rows). Nothing read `eval/`. The re-derivation of every
number in this record is committed as `benchmarks/src/parser/quantityMoneyPins.test.ts`, in the same
role `rowClassification.test.ts` plays for DECISIONS/0008: if a constant moves, these numbers move and
this record is wrong on its face.

---

## Q1 — Quantity column: what "rows" are, what "aligned" means, and the floor

§5: *"A column qualifies as a quantity column when at least 60% of its rows contain integers ≤ 20,
aligned left or right."* Three undefined terms, and the first one is a circularity trap.

**"Its rows" cannot mean the rows that put a word in the band.** If the band is built from integers
≤ 20, then 100% of its rows contain an integer ≤ 20 by construction and the 60% test can never fail —
the rule would be decoration. So the band must be built from a **broader population than the thing it
is testing for**: candidate bands are clustered over *every* numeric word on the receipt (`isAmountShaped`
words, bare 1–2 digit integers, and quantity-glyph words), and the 60% then asks whether the rows that
touch this band mostly hold small integers or mostly hold money. That is the rule's only possible job —
telling a quantity column apart from a price column — and it is the reading that makes §5 line 361
coherent, where P6 excludes bare integers from the price band precisely because "they are the quantity
column's population".

**"Aligned left or right" reuses P6's language, not a new constant:** a word is in the band when its
**left edge or its right edge** is within `0.05 × image width` of the band anchor — the same
`PRICE_COLUMN_WIDTH_RATIO` that defines the price column, so the parser speaks one geometry language
and the two columns are compared in the same units. The choice is measured, not assumed. Over dev the
qualified bands are essentially insensitive to it: CORD yields 31 receipts with a qualified band at
1%, 2.5%, 5% and 7.5% tolerance within ±1 receipt of each other (26/30/31/31 at floor 3; 9/11/11/11 at
floor 5) because a 1–2 digit word is narrow — its left and right edges are 15–20 px apart on a 576–2304
px page, so both alignments find the same column. The tolerance is the *least* load-bearing part of this
pin and the floor is the most.

**Floor: a band needs ≥ 5 rows before it can qualify.** Below that the majority statistic is not a
measurement, it is the receipt's whole item count agreeing with itself. The cost of the floor is the
number the brief asked for, and it is large and one-sided:

| floor | receipts with a qualified quantity column (dev 250) | CORD /100 | SROIE /150 |
|---|---|---|---|
| 3 | 89 | 31 | 58 |
| **5** | **34** | **11** | **23** |
| 8 | 13 | 4 | 9 |

5 is pinned as recommended. What it costs, itemised over CORD's 305 item rows at floor 5:

| read state on a CORD item row | rows |
|---|---|
| explicit — integer inside a qualified column | 36 |
| explicit — leading `N ×` / `N x` pattern (§5's first clause, no column needed) | 12 |
| a bare integer ≤ 20 present, attributable to nothing → `unresolved` | 101 |
| no quantity-shaped token at all → `assumed` 1 | 155 |
| the only small integer sits in the price band → total, not quantity (Q6) | 1 |

(These five states partition all 305 CORD item rows. Two different integers inside one qualified band is
the sixth state, `unresolved` by disagreement, and dev contains **0** such rows at floor 5 — it exists
at floor 3, where 1 row shows it.)

**101 rows is the honest price of the floor, and it lands in `unresolved`, not in `assumed`.** That is
a deliberate choice with a reason attached. §5's assumed branch fires when quantity is *confidently
absent*; a row printing `1 OREO GREEN TEA SPREAD 52,000` does not have an absent quantity, it has a
number the parser cannot attribute, which is §5's definition of ambiguous. Calling it `assumed` would be
a provenance lie that happens to be value-right — on CORD gold, 166 of 198 annotated quantities are 1
(83.8%), so guessing 1 would score well while recording evidence the receipt never gave. `unresolved`
blocks unit creation and lock (§7), which is the outcome §5 line 343's asymmetry wants: visible,
reviewable, recoverable.

**Measured precision of the column rule, which is what justifies keeping §5's gate at all.** It is not
paranoia — dev contains bare integers that are emphatically not quantities:

```text
SR 6 106.10 6.37              SROIE: 6 is the SST *rate*, not a count
P.Rest 10 % 5,592             CORD:  10 is a percentage
1 HH GUINESS 12 GLASSES 150.00  12 is part of the name
8970669 1 X 19.00 19.00       the leading 8970669 is an item code
```

With the column gate these rows never yield a quantity from the stray integer (they lack a qualified
band, or the integer is excluded by the percent guard below). Without it, all four become explicit
quantities — `SR 6` alone appears on dozens of SROIE receipts. Against CORD gold, a qualified column
produced **0 wrong quantities** (every read that could be compared equalled the annotated value; 9 right
/ 0 wrong at floor 3, and the floor-5 reads land on receipts whose gold quantity is unannotated), while
the same-gated misses are the 101 rows above.

**Percent and code guards, pinned as exclusions from the integer population:**
- a token containing `%`, or an integer immediately followed by a `%`-bearing word, is a **rate** and is
  never a quantity and never votes in the band's numerator;
- a token only counts toward the ≤ 20 test when the word *is* the integer: `^\d{1,2}$` after trimming,
  which is what keeps `8970669` and `95569390-40118` out of it;
- an integer inside the price band is a **total**, never a quantity (Q6 owns that case).

Measured effect of the percent guard on column qualification: **none** on dev (34/250 receipts with or
without it at floor 5). It is kept because it is free, because it is the guard that makes `SR 6` and
`P.Rest 10 %` provably not-quantities rather than accidentally-not-quantities, and because 3 CORD item
rows consist entirely of percent-attached integers today.

**§5's quantity *pattern* is pinned to cover the two-word form, which is more common than the spec's
example suggests.** Across dev the `N x`/`N×` pattern appears **63 times as one word** (`1X`, `2 x`,
`3X`) and **33 times as two** (`1` then a separate `X`/`x`/`*` word):

```text
8970669 1 X 19.00 19.00     [ACCOUNT] 1 X 4.62 4.62     [ACCOUNT] 2 * 12.00 24.00
```

So the pattern is: an integer ≤ 20 followed, with no other word between, by a word whose entire text is
`x`, `X`, `×` or `*`. `*` is included because dev prints it (SROIE loyalty/tax lines); `*N` and `xN`
inverted forms exist in CORD (8 words) and are **not** handled — they sit on non-item rows in dev, and
inventing an order-insensitive pattern for them would read `3 x` out of `1 x 3`-shaped garbage.

**When more than one band qualifies, the leftmost wins** (a quantity column is never right of the
price column; measured: 0 of 34 dev receipts produce a qualified band to the right of the price centre,
and the closest qualified band sits 0.239 of the image width from the price centre — 4.8× the band
tolerance). Tie on position → higher share → lower anchor. Deterministic, no map ordering.

## Q2 — The money grammar, per profile, and the lakh case

§5's table gives separators and one example per profile but no grammar. This is the grammar. A token is
read as money only when it matches its profile's grammar *exactly*; anything else is `unresolved`, never
a reinterpretation. Currency tokens are stripped first (`Rp`/`Rupiah` for id-ID, `RM`/`MYR` for en,
`₹`/`Rs`/`INR` for en-IN), a leading `-` or surrounding `()` sets the sign, and a trailing `/LITRE`-style
suffix is dropped from the token before the grammar test.

| profile | integer part grammar | decimal | refuses |
|---|---|---|---|
| `id-ID` | `^\d{1,3}(\.\d{3})*(,\d{3})*$` — dot groups, and the comma-thousands form the data actually prints | `,` + 1–2 digits | `1,23,456` (lakh), `12.34`, any 4-digit fraction |
| `en` | `^\d{1,3}(,\d{3})*$` or bare `^\d+$` | `.` + 1–2 digits | `1,23,456`, `1.234`, `12,5` |
| `en-IN` | `^\d{1,3}(,\d{3})*$` **or** `^\d{1,2}(,\d{2})+,\d{3}$` **or** bare `^\d+$` | `.` + 1–2 digits | `1,23,4`, `1,2,3`, `1.234`, `12,5` |

**The exact lakh grammar is `^\d{1,2}(,\d{2})+,\d{3}$`** — a 1–2 digit lead group, then one or more
2-digit groups, then exactly one 3-digit final group, with any number of 2-digit groups before it. That
is the whole Indian system: `1,23,456` (1.23 lakh), `12,34,567`, `1,00,000` (1 lakh), `12,34,56,789`
(12 crore). It is *two or more* comma groups; a single comma is western grouping and is covered by the
first branch, which en-IN also accepts. Worked values, pinned by test:

| token | en-IN | en | id-ID |
|---|---|---|---|
| `1,23,456.78` | 12345678 paise | refuses (3-digit group then 2) | refuses |
| `1,00,000` | 10000000 paise | refuses | refuses |
| `12,34,56,789` | 12345678900 paise | refuses | refuses |
| `1,234,567` | 123456700 paise | 123456700 | 123456700 |
| `12,345` | 1234500 | 1234500 | 1234500 |
| `1,23,4` | refuses | refuses | refuses |
| `1,2,3` | refuses | refuses | refuses |
| `1,23,456.789` | refuses | refuses | refuses |
| `8.000` | refuses | refuses | 800000 |
| `20,000` | 2000000 | 2000000 | 2000000 |

Two branches of the en-IN grammar never disagree in value: the lakh branch requires every group after
the last to be 2 digits, the western branch requires all groups to be 3, and no string satisfies both
with a different reading — `12,345` and `1,234` pass the western branch and give the same integer as
the lakh branch would if it applied. **en-IN is a strict superset of en** on this grammar: every token
en reads, en-IN reads identically. That is why the app's profile can be the parser's default without
costing SROIE a single amount (measured below).

**A fraction longer than two digits is never guessed.** `2.5625` is not 256 paise and not 257 paise; it
is not money this parser can read, so it is `unresolved`. This is the harness's own standing rule
(`benchmarks/src/money.ts`: "the same printed string must not silently take two values"), and it is what
makes DECISIONS/0006's money-equality pairing gate meaningful: nothing downstream has to wonder whether a
paise value was rounded into existence. Measured cost on dev: **11 distinct tokens (14 occurrences)** are
readable by neither grammar — `0.5500`, `30.7400`, `1.0000`, `8.0000`, `.0015016` and friends — and
**none of them is a gold amount**.

**Integer overflow guard:** the parse is `BigInt` throughout and refuses above `Number.MAX_SAFE_INTEGER`
paise, because a paise value that cannot be a safe integer is not representable in the public shape.

**No binary float ever touches this.** The grammar produces `BigInt` paise and divides by `100n` nowhere
(§5 Safeguards: "Money parsing must not use binary floating-point equality").

## Q3 — Longest-first, and the tie-break that cannot occur

§5: *"Match the longest label first so `SUBTOTAL` never matches `TOTAL` prematurely."* Ticket 05 already
sorts the dictionary longest-first and uses it as a boolean (DECISIONS/0008 P3). Ticket 06 turns those
rows into typed charges, where the match result must name *which* label won, so the remaining ambiguity
is pinned.

Three shapes a tie can take, and what happens to each:

1. **Two labels of different length starting at the same index** (`TOTAL` inside `SUBTOTAL`, `SERVICE`
   inside `SERVICE CHARGE`). **Longest wins**, §5's rule verbatim. This is the only case §5 names, and it
   is settled by construction: matching scans each index and takes the longest dictionary entry that
   starts there.
2. **Two labels of equal length starting at the same index.** **Impossible, and provably so, not
   merely absent from the data:** at a fixed start index a fixed text determines the substring, and two
   labels of the same length both equal to that substring are the same string. The record states the
   proof rather than a tie-break because a tie-break here would be a rule for a case that cannot exist.
3. **Two labels of equal length at different indices, overlapping** (`sc` at 0 and `ct` at 1 in `sct` —
   the general shape). **Leftmost wins, and the winning span is consumed** — a label cannot be matched
   twice, and a later overlapping match is skipped rather than allowed to overwrite an earlier one.
   Measured over the shipped dictionary — 25 distinct label strings, §5's 21 English/Indian-English
   entries plus the 6 Indonesian ones, `subtotal` and `total` appearing in both lists — **0 pairs of
   distinct equal-length labels can overlap at all**, so branch (3) is unreachable with today's data. It
   is pinned anyway, and the test asserts the invariant over the shipped dictionary, so adding a label is
   a data edit that either keeps the invariant or fails loudly. This mirrors how P3 treats the noise
   families: behaviour defined by data tables, with the shape of the table checked by a test rather than
   by prose.

**A row may legitimately carry two non-overlapping labels** — `CGST 2.50 SGST 2.50`, `TOTAL QTY 3`. Both
matches are recorded, in document order; the classifier's boolean stays as 05 shipped it, and Q5 decides
what the pair of labels means for typing.

## Q4 — How the parser learns the profile (the gap under Q2)

§5 says the parser uses an explicit locale profile and that the app uses `en-IN`, but `parse(ocrResult)`
receives no profile (§4 line 147), and CORD's amounts are id-ID-shaped: 135 `DD.DDD` tokens plus 39
`D.DDD` plus 13 `DDD.DDD`. Reading those under en-IN yields *nothing* — `8.000` is a 3-digit fraction —
so an en-IN-only parser would report CORD's prices as unresolved and §5's "Normalize benchmark ground
truth with the same profile as predictions" would be unsatisfiable, since 03a generated gold with `id-ID`
for CORD and `en` for SROIE.

**Decision: the profile is selected per document from the document's own number shapes, with `en-IN` as
the default when the document says nothing.** Not an added `parse()` option (that would widen the §4
signature, which is spec-locked and needs an owner decision), and not a global constant.

The rule: for every numeric token on the receipt, ask which grammars can read it. A token readable by
**only id-ID** is id evidence, one readable by **only the en family** is en evidence, and tokens readable
by both abstain. The profile with more exclusive evidence wins; on no evidence, `en-IN`. Currency tokens
are not needed to decide, and cannot be: `Rp` appears on just **7 of 100** CORD receipts (so a
currency-driven selection would have nothing to work with on the other 93), and `₹`/`Rs`/`INR` appear on
**0 of 250** dev receipts — the app's own profile is the one the corpus never spells out.

Why the vote is safe rather than clever, in one measured number: over dev, **1,403 tokens are readable by
both profiles and 0 of them are read with different values**. A profile can therefore only ever be
*wrong by omission* — choosing the wrong one makes some amounts unreadable, never turns ₹9.00 into
₹900. Combined with en-IN ⊇ en, the default cannot lose an amount that the other en-family profile would
have read.

**Owner ruling (2026-11-03): profile inference is bounded by exclusivity, not by accuracy.** The
1,403-both / 0-divergent measurement *is* the guarantee — a wrong profile omits tokens, it never
misparses them. The 97/3 and 0/150 vote counts are quality measures, not correctness measures: they say
how often the inference agrees with the profile the dataset was generated with, and nothing downstream may
read them as a bound on error. Default `en-IN` when a document carries no exclusive evidence. No
`parse(locale)` option — §4's signature is the contract.

Accuracy of the vote against the profile each dataset was generated with:

| dataset | votes id-ID | votes en family | tie / no evidence |
|---|---|---|---|
| CORD (generated with id-ID) | 97 | 3 | 0 |
| SROIE (generated with en) | 0 | 150 | 0 |

The 3 CORD misvotes have **zero** id-exclusive evidence (`cord-v2/dev/29`, `/77`, `/90`: id=0, en=5 each),
so choosing the en family there loses no amount — which is exactly the property that makes a misvote
tolerable. Every dev receipt resolves decisively; nothing reached the default. End-to-end effect of the
selected profile, measured by parsing every numeric word and asking whether the gold integers appear:
**370 of 372 annotated bill-level gold amounts (99.5%)** and **221 of 222 CORD gold item line totals
(99.5%)**. The two bill-level misses are `cord-v2/dev/7` (gold −954,500) and `/96` (gold −204,500): the
digits are on the page and read correctly, the *minus* is not printed on the same token — which is a
charge-sign question (Q5), not a grammar failure.

## Q5 — Charge typing, and how many amounts a charge row carries

Labelled rows reach 06 as `noise_header` (DECISIONS/0008 P3 hands them over that way); `classifyRows()`
is the only channel, since `ParseResult` drops noise rows. Over dev, **1,374 of 5,199 rows carry a §5
label**, and what they contain decides the typing rule:

| labelled row | rows | what 06 does |
|---|---|---|
| registration-shaped (`GST NO: …`, matched by P3 family 2) | 106 | **never a charge** — a label match on a tax *identifier* row is not a tax amount |
| label, no readable amount | 509 | ignored (`TOTAL QTY 3`, a bare `SUBTOTAL` heading) |
| label, exactly one readable amount | 636 | typed charge |
| label, two or more readable amounts | 123 | resolved by geometry, else `unclassified_charge` |

(The typing those 636 rows get is in the precedence paragraph below, with its own counts.)

**"How many amounts" is counted over money tokens, not over digits.** A `%` token is a printed rate
(§4's `ParsedTax.rate` is display-only), and a row-leading bare integer ≤ 20 is a quantity — both are
already spoken for, and counting them as amounts would turn `PAJAK 10% 18,182` into an ambiguous row and
lose a real tax. With those two exclusions the 184 raw multi-amount rows become 123, and the multi-amount
rows that survive are genuinely messy (`Subtotal 154 000` — OCR split one amount in two; `Total. 50.000
41,000`).

**A third exclusion, and the number that forces it: 22 single-amount rows carry a bare integer ≤ 20 as
their only number — 19 item counts and 3 printed zero charges.**

```text
Total Item 7      Total Qty 7      Jumlah Item 1      TOTAL ITEMS 2      SUB TOTAL 0      Discount 0
```

`Total Item 7` must not become a 7-paise grand total, and `SUB TOTAL 0` must not be dropped. **The value
discriminates; the geometry does not** — 8 of the 22 sit inside the price band, so "in the column" cannot
tell the count from the charge, while `0` vs non-zero does. So a bare integer ≤ 20 is money on a charge
row only when it is `0`: keeps the 3, drops the 19 to the no-amount class. It is the same predicate Q6
uses for `MIKA KECIL 0`, which is the point — one rule for "a small integer that means an amount",
applied to item rows and charge rows alike, rather than a special case per dataset.

**A multi-amount charge row is resolved by the price column, not by picking.** If exactly one of its
money tokens lies in the price band (P6's geometry), that token is the amount: measured **84 of 123**.
This is not an arbitrary price choice — it is the same pinned alignment rule that identifies an item's
price, applied to a row the classifier already decided is a charge. 38 rows have no band member and 1 has
two, and those become `unclassified_charge` with their label text and amount preserved, not a guess. For
single-amount rows the band is not required (488 of the 631 that sit on a receipt where a price column
could be inferred agree with it anyway, so the band stays a tie-breaker rather than a gate).

**Type precedence on a row carrying labels of two different kinds is load-bearing, not cosmetic: 199
dev rows carry a tax label and an aggregate label together** (8 more carry tax+subtotal; 4 more are
round_off/service/discount mixes). Longest-first then leftmost decides which *string* matched; it does
not decide which *field* the amount belongs to, and dev shows both orders are wrong about half the time:

```text
TOTAL GST : 0.00            TOTAL TAX : 0.28         TAX TOTAL: 0.85      Total Tax Included: Rp 5272.73
TOTAL SALES (EXCLUDING GST) : 80.91     TOTAL INCL. OF GST 15.90     SUB-TOTAL (GST) 15.00     TAKEOUT TOTAL (INCL GST) 26.60
```

The first group is a tax amount; the second is an aggregate whose text *mentions* tax as an inclusion
cue. **Pinned rule: an inclusion/exclusion cue (`incl`, `inclusive`, `excl`, `excluding`, `included in
total`) on the row makes the amount an aggregate (and is the explicit cue §4's `included` field may be
set from); otherwise, on a row carrying both a tax-type label and an aggregate label, the tax type wins,
because a tax total is still a tax and a `TOTAL` that happens to name a tax is the rarer reading.** With
that precedence the single-amount population types as: grand total 408, subtotal 86, tax 80, discount 41,
service charge 19, round-off 2 (636 rows total). Recorded honestly: the cue list is 59 distinct label
shapes deep in dev and the rule above is a two-branch simplification of it, so any row whose aggregate
text 06 cannot read as an inclusion cue will type as a tax and be reviewed as a charge mismatch —
`validate()`'s arithmetic in ticket 07 is what surfaces it, and it is a named follow-up rather than a
silent guess.

**Owner ruling (2026-11-03): tax+aggregate row precedence — inclusion cue → aggregate; no inclusion cue →
tax. 199 dev rows exercise this.**

**Type mapping**, §5's dictionary to §4's public shape, with no reshaping of either:

| label | lands in |
|---|---|
| `cgst` `sgst` `igst` `cess` `vat` `gst` `tax` `pajak` | `taxes[]` as `ParsedTax`, label text preserved per entry, `amount` positive magnitude |
| `service charge` `svc chg` `service` `servis` `sc` | `serviceCharge` (one positive magnitude) |
| `tip` | `tip` |
| `discount` `diskon` | `discount` (positive magnitude; the arithmetic subtracts it) |
| `round off` `round` | `roundOff` — **signed**, the printed `+`/`−` kept |
| `subtotal` `sub total` `jumlah` | `subtotal` + `subtotalSource` |
| `grand total` `total` `net amount` `bill amount` | `grandTotal` + `grandTotalSource` |
| labelled row whose type is not determinable | `otherCharges[]` with `sign: "unknown"` and `unclassified_charge` |

`Included` is never inferred from arithmetic (business.md §6.6): it is set only from an explicit printed
cue, and stays `undefined` otherwise. `source` is `"detected"` for every charge 06 emits.

**Discount and tax signs.** The two gold misses above are sign, not digits: a `Discount … 34,363` row
prints its magnitude unsigned and its meaning does the subtracting. The parser therefore takes a charge's
sign from its **type** (discount ⇒ subtract in the validator, stored positive per §4) and preserves an
explicitly printed `-` only where the public field is signed (`roundOff`, `ParsedOtherCharge.sign`). An
`other` charge with no sign cue stays `sign: "unknown"` and is excluded from arithmetic — §5's
"never guessed" applied to money rather than to rows.

## Q6 — Zero totals: `MIKA KECIL 0`, and the `ITEM COUNT 7` trap

Ticket 05's named regression. P6 excludes bare 1–2 digit integers from the price band to keep the
quantity column out of the alignment test, so a row whose line total *is* a bare integer loses its price
and lands in `ambiguous`.

**The distinguishing signal is geometry, and it is unambiguous on dev.** Over CORD's rows, **34 rows carry
a bare 1–2 digit integer whose right edge lies inside the price band — and all 34 of them are the value
`0`.** Quantity integers, by contrast, never sit in the price band: the 103 gold-matching quantity tokens
found in item rows are at median left edge 0.170 of the page width, and the closest qualified quantity
band is 0.239 of the width from the price centre (Q1). So:

> A bare 1–2 digit integer inside the price band, on a row that has no price candidate at all and passes
> rule 3's name test, is the row's **line total**. Anywhere else in the row it is a **quantity** (Q1), or
> nothing.

Applied to the named case (`cord-v2/dev/8`, the sixth row of `classifyRows()` output): `MIKA KECIL 0`,
band [413.2, 470.8], the `0` at right edge 438 → item, `lineTotal = 0`, `priceSource = "detected"`. Its
gold is `unitPrice: 0, lineTotal: 0`, so the parse is exact on the field CORD annotated.

**Three preconditions, each with a row behind it.** The rescue applies only when (a) the row has **no**
price candidate at all, (b) no other readable money token outside the band either, and (c) the integer is
the value `0`.

- (a) without it, `1 BBQ Sedang Chicken 41,000 0` gains a second in-band number and fires
  `ambiguous_price_separator` — the rescue would *destroy* a real item to record a redundant zero.
- (b) without it, `OS= 0% 0.00 0` (SROIE) is promoted while `0.00` still sits unread on the same row.
- (c) without it, the promotion list gains SROIE's right-aligned item-count rows, whose integers land in
  the band because the *rows* are right-aligned and are not money at all.

The population for and against those conditions, over dev's `ambiguous` rows carrying a bare integer
inside the price band:

| | rows |
|---|---|
| `ambiguous` rows with a bare 1–2 digit integer inside the price band | 45 |
| → tender-shaped, removed by Q7 instead | 9 |
| → no lettered non-price word, so rule 3 still refuses them (they stay preserved) | 8 |
| → **promoted: the integer is `0`** | **17** |
| → not promoted: a non-zero integer (`ITEM COUNT 7`, `NO. OF ITEMS 2`, `MAIN ITEM COUNT 1`, …) | 11 |

All 17 promotions are CORD rows, and CORD contains **no** non-zero integer inside a price band at all (the
34 in-band rows are all `0`), so condition (c) costs nothing in this corpus while excluding 11
fabrications. The 17: `MIKA KECIL 0`, `Top Oreo 0`, `Top Banana 0`, `2 TUTUP SEAL 0`, `2 CUP 14 OZ 0`,
`1 Seaweed Chicken 0`, `U SAM GYEOP 1 0`, `ICE COFFE MIX 3 0`, `ICE BLACK COFFE 1 0`, `0 x1 0` (×2) —
ordinary zero-priced lines, several printing their quantity to the *left* of the band, which is the clean
demonstration that quantity-0 and total-0 are different objects — plus `PB1: 0` (×3) and `CHANGED 0` (×3).
`PB1: 0` is a promo modifier this rule does promote, and `CHANGED 0` is the tender misspelling Q7 does not
catch; both are reported as known false-positive classes rather than patched with a fourth special case.

**Owner ruling (2026-11-03), recorded as accepted cost rather than a defect to fix:** `PB1: 0` (×3) and
`CHANGED 0` (×3) are documented false positives. `CHANGED 0` resolves when family 5 lands (Q7's tender
predicate is word-stem tolerant enough to catch it once the family exists — see Q7's near-miss note).
`PB1: 0` is **retained** because narrowing the rule to exclude it would refuse 17 legitimate rescues
(`Top Oreo 0`, `2 TUTUP SEAL 0` and the rest of the zero-priced item lines). Cost is 3 items per dev
sample.

**`unitPrice` is a separate claim from `lineTotal` and is not inferred from it.** A printed `0` in the
column is the row total; §4's `unitPrice` is filled only where the receipt actually prints a unit price,
and the one marker dev exhibits is `@` (`1X M-Caramel Black Tea @28,000 28,000`, `3X @6500`,
`2 x @ 12.000 24.000`). That is an **8-token population across all 100 CORD dev receipts** — 5 of them on
item rows, 3 where the `@` value equals a gold `unitPrice` — so it is far too small to tune anything
against, and the `@` reading is covered by an authored fixture rather than measured on the corpus. Where
a row prints only a total, `unitPrice` stays `null`/`unresolved` even when `lineTotal` and `qty` are both
known: dividing a total by a quantity to manufacture a unit price is exactly the inference §5's
provenance tables forbid, and it is ticket 12's normalized-unit arithmetic, not the parser's.

## Q7 — Tender rows: dropped as a new pattern family, with the numbers

§5 names no tender class, and DECISIONS/0008 P3 deferred the question to 06 with the count of
*tender-shaped preserved rows* (31 in CORD). The population 06 found is much larger and sits in a
different class: **tenders are not being preserved, they are being sold as items.** Over dev, using 0008's
own predicate (`cash|change|tender|balance|payment|pay|mode pay|round off|diskon|kembali`, word-bounded):

| class of the 423 tender-shaped rows | rows |
|---|---|
| `item` | **204** |
| `noise_header` | 130 |
| `ambiguous` | 86 |
| `continuation` | 3 |

```text
CASH 50,000      CHANGE 4,500     Kembali 27.000     Cash: 28,000     CARD 123,000
```

**0 of the 131 gold↔item pairs `matchItems` finds on dev involves a tender-named item**, and 205 of 713
dev items are tender-named. So the current classifier is not preserving reviewable money — it is
manufacturing 28.6% of the item list as phantom products, and every one of them inflates the item sum
ticket 07's `arithmetic_item_sum` will check.

**Decision: tenders become P3 family 5 in the pattern tables, classified `noise_header` at rule 1.** Two
reasons, and the second is the one §5 cares about:

1. There is no field in the public shape for them. `ParseResult` carries items, taxes, service charge,
   tip, discount, round-off, other charges, subtotal and grand total — no tender, no change, and 06 may
   not reshape that (DQ-03 = B is locked, ADR-008). A value with no home is not a charge; `otherCharges`
   would be a misuse, since a tender is not part of the bill's arithmetic and would corrupt
   `base_computed_total`.
2. `ambiguous` is defined by §5 as "a line that cannot reliably be classified". A tender row is reliably
   classified; parking it in `ambiguous` to keep it visible would be a false statement about the
   classifier's knowledge, and would add 204 `ambiguous_row` warnings to a set that already carries 926.

`noise_header` is nonetheless a **discard**, so P7's guardrail applies to this change as much as to rule 3:
it ships with a pre/post transition table over all 250 dev fixtures, and the reported classes must show
`item → noise_header` as the only movement for these rows, with the empty-name and gold-reachability
assertions re-derived afterwards.

**The P7 invariant changes with this family, per owner ruling.** DECISIONS/0008 P7's guardrail was stated
as an equality (`noise_header` must stay 3,517) because a fixed count is the cheapest way to catch a
silent discard. A named family breaks that equality by design, so the invariant is restated:

> `noise_header` equals base head (3,517) **plus** rows accounted for by a documented pattern family. Any
> increase must be traceable to a named family in the transition table. A rule change that increases
> `noise_header` without a corresponding named-family entry fails the test.

The *spirit* of P7 — no silent discards — is preserved by explanation rather than by a frozen number, and
family 5 is the first named family under it: each of its rows must be individually attributable, i.e. the
transition table lists `item → noise_header` and `ambiguous → noise_header` counts and every moved row
matches the family-5 predicate. The two assertions that must **not** move stay enforced: empty-name items
remain 0, and gold↔item pairs may not fall below the 131 base head scores (condition 3 adds a direct
guard: `tender_named_items_in_ParseResult == 0` on dev fixtures, so a family-5 regression fails loudly
rather than quietly re-inflating the item list).

**`CHANGED 0` resolves when family 5 lands** (owner ruling on Q6's false-positive list). The observed OCR
misspelling is carried as a data-table entry in the family rather than as a stem-tolerance rule: 0008's own
predicate terms plus `changed`, measured at 3 CORD rows. A stem-tolerant matcher would also catch
`PAYMENT`-shaped collisions against genuine items, which is the same trade P3's notice/footer family
defers, not something this ticket invents.

## Q8 — The classifier/parser seam: geometry reads position, money reads meaning

05's `priceCandidates` is amount-shaped **only**: P6's candidate test strips `₹`/`Rs`/`INR`, requires
`^\d[\d.,]*$` after that, and admits a token only on a separator or ≥ 3 digits. Two consequences are
visible on the dev fixtures and are intentional, not defects:

```text
Rp 9,736      isAmountShaped → false  (Rp is id-ID's token, and the word carries an internal space)
-7,800        isAmountShaped → false  (the leading sign is not in the candidate shape)
```

So `Srv Ch Rp 9,736` and `AMOUNT -7,800` reach 06 with **no price candidate**, and 06's money grammar
(§5's profiles) reads them: strip the profile's currency token, honour a leading `-` or surrounding
parentheses, then apply the grammar and land on integer paise.

**Do not fix `Rp` or negative handling inside 05's classifier.** That would move money semantics into
geometry, and the two are deliberately separated: the band answers *"is this the column position where a
line total prints"* from word boxes alone, and it must stay profile-independent, because making it
profile-aware would make the row classes — and therefore DECISIONS/0008's published buckets — a function
of a locale decision that ticket 06 owns. `priceCandidates` remains the geometry predicate 05 pinned;
`isAmountShaped` is not a money test and never was (P6 says so: "it never produces a paise value").

Where the two layers disagree, the seam is the tie-break in one direction only: **06 never re-derives a
row's class, and 05 never produces an amount.** The only place 06 overrides 05 is Q6's promotion, which
adds a *total* to a row the classifier called `ambiguous` because the geometry had no candidate for a
bare `0`; the row's class in `classifyRows()` output is unchanged and stays `ambiguous`, and the
promotion is visible only in `ParseResult.items` (with the row then absent from `unclassifiedRows`, since
§5 keeps those two lists disjoint). Split-layout name reattachment (§5 line 340, P7's last section) reads
`classifyRows()` through the same channel and is reported separately.

## Re-derivation, and the head every 06 delta compares against

**Status of these numbers: session-measured, not yet committed.** DECISIONS/0008's discipline says an
artifact is checked, not claimed, and it is honest to say plainly that this record currently carries
numbers re-derivable only from throwaway scripts. They become evidence when the parser lands, because
pinning the predicates in a test *is* the parser — committing them a commit earlier would put the
implementation ahead of the checkpoint this record was written for. Until then, treat every figure below
as the target the test must reproduce, and treat a mismatch as a correction to this record rather than to
the test.

Every number above is measured over `benchmarks/fixtures/dev/` by the predicates that will be committed
as `benchmarks/src/parser/quantityMoneyPins.test.ts` alongside the parser: the quantity-band builder, the
three money grammars, the profile vote, the label matcher with its three exclusions, and the tender
predicate. The assertions that must hold there, so this record cannot drift from its evidence:

| assertion | value |
|---|---|
| qualified quantity columns at floor 5, tol 5% (dev) | 34 receipts — CORD 11, SROIE 23 |
| qualified columns at floor 3 / floor 8 | 89 / 13 receipts |
| CORD item-row read states at floor 5 | 36 column, 12 pattern, 101 unresolved, 155 assumed, 1 price-band |
| gold-matching CORD quantity tokens with no equal gold quantity elsewhere | 0 rows |
| tokens readable by both profiles, and readable by both with different values | 1,403 / **0** |
| document profile vote | CORD 97 id / 3 en, SROIE 0 id / 150 en, 0 ties |
| gold bill-level amounts reproduced / annotated | 370 / 372 |
| CORD gold item line totals reproduced / annotated | 221 / 222 |
| `ambiguous` rows with a bare integer in the price band, and the promotion split | 45 → 9 tender, 8 nameless, 17 promoted, 11 refused |
| labelled `noise_header` rows, and their typing split | 1,374 → 106 registration, 509 no amount, 636 single, 123 multi |
| tax+aggregate label co-occurrence rows | 199 (8 subtotal+tax, 4 other mixes) |
| tender-shaped rows, and gold pairs lost by dropping them | 423 rows / **0** of 131 pairs |
| equal-length overlapping label pairs in the shipped dictionary | 0 (invariant, not measurement) |

**Base head for every ticket-06 pre/post comparison is `20e4459`** (the ticket-05 merge, `main`). Per
DECISIONS/0008's reporting discipline, a delta without both heads named is not a number: the tender
change (Q7) and the zero-total promotion (Q6) each move rows between classes, so both ship with a
`20e4459 → <shipped head>` transition table over all 250 dev fixtures, in the P7 form — row identity is
`receiptId` + row index, and Q7's `item → noise_header` movement is the case that guardrail explicitly
requires justification for. `noise_header` rising by 204 is expected and is the point; the assertions that
must *not* move are the two 05 pins: empty-name items stay 0, and gold↔item pairs must not fall below the
131 it scores today (05's own `rowClassification.test.ts` gold-reachability buckets will move, and 06's
report must state the new numbers against `20e4459` rather than silently re-pin them).

## What this record does not decide

- **Whether the floor of 5 is right for real receipts.** It is right for the app's asymmetry (an
  unattributed integer must not become an explicit quantity), and it is the number the brief asked to
  pin. The 101-row CORD cost is published, and 09b's per-field quantity score is the signal that would
  justify revisiting it — with `eval/` unread until then.
- **Split-layout name reattachment** (the `PC 9.00 0.00` / name-row case, DECISIONS/0008 P7's last
  section). 06 reaches `noise_header` through `classifyRows()` and must decide what a name row deserves;
  that is content parsing but it is not one of these seven pins, and its transition table ships with it.
- **Adding label dictionary entries.** `Srv Ch Rp 9,736` (a service charge on a real CORD shape), `SR 6`,
  `PAY MODE` and friends are not in §5's list, and 06 does not extend a spec-owned dictionary on
  initiative. The gap is measured and reported for the owner; §17's open loops is where it belongs.
- **Whether the profile arrives as a `parse()` option instead of being inferred.** Q4 chose inference
  because §4's signature is spec-locked; if the owner would rather thread an explicit
  `{ locale }` argument through `parse()`/`extract()`, that is an API change and an owner decision, and it
  would make Q4's vote moot rather than wrong. The measured cost of inference on dev is 0 lost amounts.
- **The tax-inclusion cue vocabulary.** Q5's two-branch precedence reads `INCL`/`EXCL` text as an
  aggregate marker; it does **not** set `ParsedTax.included`, because business.md §6.6 makes inclusion an
  explicit-cue decision and 06's cue parsing is one step short of claiming that. `included` stays unset
  for now, which means ticket 07's arithmetic treats every tax as additive — the safe direction, and the
  one that surfaces a wrong guess as a finding instead of hiding it in a total.
- **Confidence floors, `item_without_price`, `zero_items`, arithmetic.** Ticket 07.
- **The 16 CORD gold names absent from every classified row.** A diagnostic carried to 06, blocking 09b's
  number quality and not this ticket's; its findings are reported separately and pin nothing here.
- Nothing here consumes or amends `DECISIONS/0006` (`τ_name = 0.70` stays the matcher's, unread by the
  parser), and the provider's 0.5 banding stays untouched per `DECISIONS/0007`.
