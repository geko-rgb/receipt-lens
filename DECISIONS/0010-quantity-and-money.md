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
and the two columns are compared in the same units. It is not the load-bearing half of this pin: a 1–2
digit word is narrow — its left and right edges are 15–20 px apart on a 576–2304 px page — so the left
and right alignments find the same column, and the floor is what decides.

**Floor: a band needs ≥ 5 rows before it can qualify.** Below that the majority statistic is not a
measurement, it is the receipt's whole item count agreeing with itself. The cost of the floor is the
number the brief asked for, and it is large and one-sided:

| floor | receipts with a qualified quantity column (dev 250) | CORD /100 | SROIE /150 |
|---|---|---|---|
| 3 | 90 | 31 | 59 |
| **5** | **34** | **11** | **23** |
| 8 | 13 | 4 | 9 |

**§5's 60% majority does no work on dev, and that is worth saying out loud.** At the floor of 5,
qualification returns 34 receipts at a 50% share, 34 at 60% and 34 at 75%: every band dev forms is
either all small integers or all money, so there is no middle case for the threshold to adjudicate. The
rule is still pinned as §5 states it — it is the *floor* that decides, and the majority is what makes the
floor meaningful on a receipt where the two interleave.

5 is pinned as recommended. What it costs, itemised over all 504 dev item rows at floor 5:

| read state on a CORD item row | rows |
|---|---|
| explicit — integer inside a qualified column | 87 |
| explicit — leading `N ×` / `N x` pattern (§5's first clause, no column needed) | 54 |
| a bare integer ≤ 20 present, attributable to nothing → `unresolved` | 137 |
| no quantity-shaped token at all → `assumed` 1 | 225 |
| two different integers inside one qualified band → `unresolved` by disagreement | 1 |

(These five states partition all 504 dev item rows at this head. **137 rows is the honest price of the
floor** — 27% of the item list, where CORD alone contributes 94 unattributed rows against 36 column
reads.)

**137 rows is the honest price of the floor, and it lands in `unresolved`, not in `assumed`.** That is
a deliberate choice with a reason attached. §5's assumed branch fires when quantity is *confidently
absent*; a row printing `1 OREO GREEN TEA SPREAD 52,000` does not have an absent quantity, it has a
number the parser cannot attribute, which is §5's definition of ambiguous. Calling it `assumed` would be
a provenance lie that happens to be value-right — on CORD gold, 166 of 198 annotated quantities are 1
(83.8%), so guessing 1 would score well while recording evidence the receipt never gave. `unresolved`
blocks unit creation and lock (§7), which is the outcome §5 line 343's asymmetry wants: visible,
reviewable, recoverable.

**Measured precision of the column rule, which is what justifies keeping §5's gate at all.** Over the
paired CORD items, a qualified column produced **0 wrong quantities** (37 reads agreed with the annotated
value, 0 disagreed), and the misses are the unattributed rows above. It is not
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
produced **0 wrong quantities**: of the CORD items `matchItems` pairs with a gold quantity annotated, 37
agree exactly and 0 disagree. (The paired set is small because CORD annotates quantity on 198 of 254
items while the matcher pairs on name similarity; the disagreement count is the number that matters here,
and it is zero.) The gated misses are the 137 rows above.

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

**§5's quantity *pattern* is pinned to cover the two-word form, which is common enough to matter.**
Across dev the pattern appears **63 times as one word** (`1X`, `2 x`, `3X`) and **33 times as two** (`1`
then a separate `X`/`x`/`*` word) — counted over the row set by the committed test:

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

Why the vote is safe rather than clever, in one measured number: over dev's 3,259 words that carry a
digit and could plausibly be read as a number, **1,338 are readable by both profiles and 0 of them are
read to different values** (194 id-only, 1,900 en-family-only, 1,402 readable by neither — dates, item
codes, and the 4-digit decimals §5 refuses to guess). A profile can therefore only ever be *wrong by
omission*: choosing the wrong one makes some amounts unreadable, never turns ₹9.00 into ₹900. Combined
with en-IN ⊇ en, the default cannot lose an amount that the other en-family profile would have read.

**Owner ruling (2026-11-03): profile inference is bounded by exclusivity, not by accuracy.** The
1,338-both / 0-divergent measurement *is* the guarantee — a wrong profile omits tokens, it never
misparses them. The 40/5/55 and 0/150/0 vote counts below are quality measures, not correctness
measures: they say how often the inference agrees with the profile the dataset was generated with, and
nothing downstream may read them as a bound on error. Default `en-IN` when a document carries no exclusive evidence. No
`parse(locale)` option — §4's signature is the contract.

Accuracy of the vote against the profile each dataset was generated with:

| dataset | votes id-ID | votes en family | no exclusive evidence |
|---|---|---|---|
| CORD (generated with id-ID) | 40 | 5 | 55 |
| SROIE (generated with en) | 0 | 150 | 0 |

55 CORD receipts show no exclusive evidence either way and take the `en-IN` default, and they are exactly
the harmless case: no evidence means every amount on the receipt is readable by both profiles, and both
give the same integer. The 5 that vote for the en family against CORD's id-ID generation profile likewise
carry little or no id-exclusive evidence — the vote is decided by what is actually on the page, not by
which dataset the fixture came from.

End-to-end, measured by parsing every word and asking whether the gold integers appear:
**372 of 372 annotated bill-level gold amounts** and **221 → 222 of 222 CORD gold item line totals** —
**100% on both**, once the money grammar strips `$` (12 dev receipts print `TOTAL AMOUNT: $8.20`, a
currency token §5's table does not list) and reads a printed minus sign (`-Rp 34,363`, the two amounts
this record first counted as misses). And the claim that matters is not that the inference is accurate
but that it is **free**: reading the same corpus with an oracle profile — `id-ID` for every CORD receipt,
`en-IN` for every SROIE one, i.e. knowing the answer — reproduces exactly the same set of amounts,
asserted against the inferred run. Inference costs zero measurable amounts on dev. For scale, a fixed
`en-IN` parser would have read 316 of 372 and a fixed `id-ID` one 225 of 372, so the profile question is
real and the vote resolves it.

## Q5 — Charge typing, and how many amounts a charge row carries

Labelled rows reach 06 as `noise_header` (DECISIONS/0008 P3 hands them over that way); `classifyRows()`
is the only channel, since `ParseResult` drops noise rows. Over dev, **1,374 of 5,199 rows carry a §5
label**, and what they contain decides the typing rule:

| labelled row | rows | what 06 does |
|---|---|---|
| registration-shaped (`GST NO: …`, matched by P3 family 2) | 108 | **never a charge** — a label match on a tax *identifier* row is not a tax amount |
| label, no readable amount | 568 | ignored (`TOTAL QTY 3`, a bare `SUBTOTAL` heading); 21 of these hold only a non-zero count and are ignored *because* of the rule below |
| label, exactly one readable amount | 616 | typed charge |
| label, two or more amounts, one of which is in the price column | 66 | typed charge from the band member |
| label, two or more amounts, none resolvable by the band | 16 | `otherCharges` + `unclassified_charge`, never a guess |

(616 + 66 = 682 rows get typed; the typing rule is in the precedence paragraph below.)

**"How many amounts" is counted over money tokens, not over digits.** A `%` token is a printed rate
(§4's `ParsedTax.rate` is display-only), and a row-leading bare integer ≤ 20 is a quantity — both are
already spoken for, and counting them as amounts would turn `PAJAK 10% 18,182` into an ambiguous row and
lose a real tax. With those two exclusions the raw multi-amount population drops to the 82 rows above
(66 resolved + 16 not), and the ones that survive are genuinely messy (`Subtotal 154 000` — OCR split one
amount in two; `Total. 50.000 41,000`).

**A third exclusion, and the number that forces it: 24 labelled rows carry a bare integer ≤ 20 as their
only number — 21 non-zero item counts and 3 printed zero charges.**

```text
Total Item 7      Total Qty 7      Jumlah Item 1      TOTAL ITEMS 2      SUB TOTAL 0      Discount 0
```

`Total Item 7` must not become a 7-paise grand total, and `SUB TOTAL 0` must not be dropped. **The value
discriminates; the geometry does not** — most of these integers are right-aligned into the price band
precisely because their *rows* are right-aligned, so "in the column" cannot tell a count from a charge,
while `0` vs non-zero does. A bare 1–2 digit integer is therefore money on a charge row only when it is
`0`: keeps the 3, drops the 21 to the no-amount class. It is the same predicate Q6
uses for `MIKA KECIL 0`, which is the point — one rule for "a small integer that means an amount",
applied to item rows and charge rows alike, rather than a special case per dataset.

**A multi-amount charge row is resolved by the price column, not by picking.** If exactly one of its
money tokens lies in the price band (P6's geometry), that token is the amount: measured **66 of 82**.
This is not an arbitrary price choice — it is the same pinned alignment rule that identifies an item's
price, applied to a row the classifier already decided is a charge. The 16 rows where no band member
disambiguates become `unclassified_charge` with their label text preserved and the amount left `null`,
because an amount this parser cannot establish is not an amount it may choose. For single-amount rows the
band is not required at all: 616 of them have one money token and there is nothing to choose between.

**Type precedence on a row carrying labels of two different kinds is load-bearing, not cosmetic: of
dev's 836 tax-labelled rows, **207 also carry an aggregate label** (measured with the shipped matcher —
this record first said 199 against a looser substring predicate, and the test's number is the one that
stands). Longest-first then leftmost decides which *string* matched; it does
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
that precedence the 682 typed rows land as: grand total 393, tax 138, subtotal 82, discount 45, service
charge 21, round-off 3. Across the 250 receipts that fills `taxes` on 117, `grandTotal` on 213,
`subtotal` on 82, `discount` on 43, `serviceCharge` on 19, `roundOff` on 3 and `otherCharges` on 14 —
and **`tip` on 0**: no dev receipt prints a tip, so that branch is covered by an authored fixture, not by
the corpus. Recorded honestly: the cue list is 59 distinct label shapes deep in dev and the rule above is
a two-branch simplification of it, so any row whose aggregate text 06 cannot read as an inclusion cue
will type as a tax and be reviewed as a charge mismatch — `validate()`'s arithmetic in ticket 07 is what
surfaces it, and it is a named follow-up rather than a silent guess.

**Owner ruling (2026-11-03): tax+aggregate row precedence — inclusion cue → aggregate; no inclusion cue →
tax. 207 dev rows exercise this.**

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

**The distinguishing signal is geometry, and it is clean on dev.** Over CORD's rows, **49 rows carry a
bare 1–2 digit integer whose right edge lies inside the price band, and 44 of those integers are the value
`0`.** Quantity integers by contrast do not sit in the price band at all: the gold-matching quantity
tokens found in item rows cluster at a median left edge of 0.170 of the page width (Q1), and the five
non-zero in-band integers are exactly the rows that must not be money — `Total Item 7`, `Total Qty 7`,
`TOTAL ITEMS 2`, `Total item 3 Total Qty 3` and `Free Kembalian 50`. So:

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
- (c) without it, the promotion list gains the right-aligned item-count rows, whose integers land in the
  band because the *rows* are right-aligned and are not money at all.

The result at this head: **14 CORD rows promoted to items, and every one of them has `lineTotal` exactly
0** — asserted over the fixture set, so a promotion that invents a non-zero total fails. They are
`MIKA KECIL 0` (the named regression), `Top Oreo 0`, `Top Banana 0`, `2 TUTUP SEAL 0`, `2 CUP 14 OZ 0`,
`1 Seaweed Chicken 0`, `U SAM GYEOP 1 0`, `ICE COFFE MIX 3 0`, `ICE BLACK COFFE 1 0`, `0 x1 0`, `Kembalian 0`
(×2), and `PB1: 0` (×3). Several print their quantity to the *left* of the band, which is the clean
demonstration that quantity-0 and total-0 are different objects — and the reason condition (b) had to
exclude small integers: an earlier version read `2 TUTUP SEAL 0`'s own quantity as "another amount on the
row" and refused the very rows this rule exists for, taking promotions from 14 down to 8.

`PB1: 0` is a promo modifier this rule does promote. `CHANGED 0` (3 CORD rows) no longer appears here at
all: family 5 catches it first, which is the resolution the owner's ruling predicted.

**Owner ruling (2026-11-03), recorded as accepted cost rather than a defect to fix:** `PB1: 0` and
`CHANGED 0` are documented false positives. `CHANGED 0` resolved when family 5 landed (the vocabulary
carries the misspelling as data). `PB1: 0` is **retained** because narrowing the rule to exclude it would
refuse the legitimate rescues (`Top Oreo 0`, `2 TUTUP SEAL 0` and the rest). Cost is 3 items per dev
sample. `Kembalian 0` (×2) was added to the tender vocabulary on the same reasoning once 06 saw it being
promoted: it is Indonesian for "change due", and a rescue that promotes a payment line is the exact
failure mode condition (c) exists to prevent.

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

| class of the 441 tender-shaped rows at the base head (20e4459) | rows |
|---|---|
| `item` | **209** |
| `noise_header` (rule 1 already caught them via a charge label or another family) | 134 |
| `ambiguous` | 92 |
| `continuation` | 6 |

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
   classifier's knowledge, and would add 209 `ambiguous_row` warnings to a set that already carries 926.

`noise_header` is nonetheless a **discard**, so P7's guardrail applies to this change as much as to rule 3:
it ships with a pre/post transition table over all 250 dev fixtures, measured through a
`tenderFamily: false` seam that first re-derives 0008's own published totals exactly (713 / 43 / 3,517 /
926) before anyone trusts it to produce the "before" column.

**A second-order effect the owner's conditions forced into the open.** Rule 1 runs before P7's priced-rows
counter, so a tender row that stops being an item also stops *opening the item region* — and every
price-less row beneath it falls back into the header zone and gets discarded. Taken literally that moved
38 dev rows into `noise_header` which are not tender-shaped at all. Excluding family 5 from that
interaction is the deliberate call: **a tender prints at the end of the priced block, so its price-column
entry still marks item position**, which is what P7's counter is documented to measure. Families 1–4 keep
0008's behaviour unchanged, which is why `CGST 2.50` still does not open the region. With that, the
family's movement is attributable row by row and the unattributed list is empty — the check
`quantityMoneyPins.test.ts` runs.

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

Every number in this record is committed as an assertion in
`benchmarks/src/parser/quantityMoneyPins.test.ts`, measured over `benchmarks/fixtures/dev/` by the
shipped parser itself — the band builder, the three money grammars, the profile vote, the label matcher
with its exclusions, and the tender predicate. DECISIONS/0008's discipline is that an artifact is checked,
not claimed, and a session's arithmetic is not evidence; this file is the artifact.

Three of the record's original figures were measured with throwaway predicates that the shipped code does
not reproduce, and the test's numbers are now the record's. They are listed here because a silent
correction is not a correction:

| the record said | the shipped parser measures | why it moved |
|---|---|---|
| 1,403 tokens readable by both profiles | 1,338 (0 divergent either way) | the voting population is now every word carrying a digit, so currency-prefixed and signed words are counted |
| profile vote CORD 97/3, SROIE 0/150, 0 ties | CORD 40/5/**55 no-evidence**, SROIE 0/150/0 | the old predicate treated ungrouped integers (`2018`) as id-only evidence; they are readable by both and abstain |
| gold amounts 370/372, line totals 221/222 | **372/372 and 222/222** | `$` joined the currency strip list and printed minus signs are read, which is what the two "sign misses" turned out to need |
| tax+aggregate co-occurrence 199 rows | 207 of 836 tax-labelled rows | the old count used a substring test, the shipped matcher requires whole words |
| 34 CORD in-band integers, all zero | 49 rows, 44 zero, 5 non-zero counts | measured over all classes at this head, not only over preserved rows |
| 17 zero-total promotions | **14** | `CHANGED 0` is caught by family 5 first, `Kembalian 0` was added to the family, and one defect was fixed: the rescue had been refusing rows that print a quantity |
| labelled-row split 106/509/636/123 | 108 registration / 568 no amount / 616 single / 66 band-resolved / 16 unresolvable | the exclusions in Q5 are applied by the shipped token filter, not by the measurement script |
| quantity read states over CORD's 305 items | over dev's 504 items: 87 column, 54 pattern, 137 unattributed, 225 absent, 1 conflicting | restated over the whole corpus at this head |
| floor sensitivity 89/34/13 | 90/34/13 | one SROIE receipt qualifies at floor 3 that the shipped builder had not counted |
| tender rows 423, items 204 | **441 rows, 209 items, 92 ambiguous, 134 already noise, 6 continuations** | the shipped vocabulary carries `changed`, `paid` and `kembalian` |

The assertions, as committed:

| assertion | value |
|---|---|
| qualified quantity columns, floor 3 / 5 / 8 | 90 / **34** / 13 receipts (CORD 31/11/4, SROIE 59/23/9) |
| §5's 60% majority at 50% / 60% / 75%, floor 5 | 34 / 34 / 34 — the threshold is inert on dev, the floor is not |
| dev item-row read states | 87 column, 54 pattern, 137 unattributed, 225 absent, 1 conflicting (504 rows) |
| quantity pattern words, glued vs two-word | 63 / 33 |
| CORD paired quantities: agreed / disagreed | 37 / **0** |
| numeric words: both profiles / divergent / id-only / en-only / neither | 1,338 / **0** / 194 / 1,900 / 1,402 |
| profile vote | CORD 40 id / 5 en / 55 none; SROIE 0 / 150 / 0 |
| gold amounts reproduced, inferred vs oracle profile | 372/372 and 222/222 — **equal** |
| labelled rows → registration / no amount / single / band-resolved / unresolvable | 1,374 → 108 / 568 / 616 / 66 / 16 |
| typed charges by category | grandTotal 393, tax 138, subtotal 82, discount 45, service 21, roundOff 3 |
| receipts where each public charge field fills | taxes 117, grandTotal 213, subtotal 82, discount 43, service 19, roundOff 3, other 14, **tip 0** |
| tax-labelled rows also carrying an aggregate label | 207 of 836 |
| CORD integers inside the price band: rows / zero / non-zero | 49 / 44 / 5 |
| zero-total promotions, all with `lineTotal === 0` | **14** |
| equal-length overlapping label pairs | 0 (invariant, checked against the matcher, not the data) |
| base head re-derived with family 5 off | 713 / 43 / 3,517 / 926 — DECISIONS/0008's own numbers |
| family-5 transitions | item→noise 209, ambiguous→noise 92, continuation→noise 6, unattributed **0** |
| `noise_header` at this head | 3,517 + 307 = **3,824** |
| tender-shaped items in `ParseResult` | **0** (owner condition 3) |
| empty-name items | **0** (0008 P7's rule 3 guard, unchanged) |
| items / gold pairs / gold-name buckets at this head | 518 items, **135** pairs, reached 164 / dropped 37 / preserved 37 / **absent 16** |

**Base head for every ticket-06 pre/post comparison is `20e4459`** (the ticket-05 merge, `main`); the
shipped head of this ticket is the commit that lands the parser. Row identity is `receiptId` + row index,
so every moved row is matched, and Q7's `item → noise_header` movement is the case P7's guardrail
explicitly requires justification for. `noise_header` rising by 307 is the point of the change, not an
accident of it; the assertions that must not move are 0008's own — empty-name items stay 0, gold↔item
pairs do not fall below the 131 the base head scored (they rise to 135), and `rowClassification.test.ts`
is re-pinned in the same commit that changes them, with both heads named in its comment.

## What this record does not decide

- **Whether the floor of 5 is right for real receipts.** It is right for the app's asymmetry (an
  unattributed integer must not become an explicit quantity), and it is the number the brief asked to
  pin. The 137-row dev cost is published (94 of them CORD), and 09b's per-field quantity score is the
  signal that would justify revisiting it — with `eval/` unread until then.
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
- **The 16 CORD gold names absent from every classified row.** Carried to 06 as a diagnostic; 06
  investigated it and the findings are in the ticket file. Summary: all 16 have every word present in the
  row set, and none has its words contiguous in any row — CORD's own word boxes are slanted (the
  annotated line's word centres span 0.3× to 3.4× the parser's y-band tolerance), so single-linkage
  clustering interleaves two printed lines into one row and orders the mix by x. Not reachable by
  reattachment (the words are already in a row, just scrambled with a neighbour's), and not a fixture
  quirk in the sense of text missing from OCR. It is P5's clustering, which 0008 pinned and which only
  03b's row-classification bucket can argue a change to. Pin nothing here; 09b states 16 as a floor.
- Nothing here consumes or amends `DECISIONS/0006` (`τ_name = 0.70` stays the matcher's, unread by the
  parser), and the provider's 0.5 banding stays untouched per `DECISIONS/0007`.
