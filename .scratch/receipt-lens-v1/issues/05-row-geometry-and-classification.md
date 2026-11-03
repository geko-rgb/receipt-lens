# 05: Read the rows — geometry and row classification

**What to build:** A pure, deterministic step that turns normalized OCR words into rows and classifies each row as an item, a continuation of the item above it, header/noise, or ambiguous — so wrapped item names stop becoming phantom items and GSTIN lines stop becoming line items, while anything unrecognized is set aside visibly instead of vanishing.

**Status:** in-review — implemented on `ticket/05-row-geometry-and-classification`, `pnpm -r test` 264 passing

**Effort:** ~26 h · **Roadmap:** workstream 1B (tasks 1B.1–1B.3) · **Week:** W4–5 · **Milestone:** M1
**Verify:** `pnpm -r test` runs the row geometry/classification suite over cached fixtures; two runs on the same fixture produce byte-identical output

**Blocked by:** 03b (matching and scorers — row classes must be measurable as buckets); 03a (loaders and fixture cache) is its prerequisite

- [x] Words are grouped into rows by y-band clustering with a count-weighted tolerance expressed relative to median word height, and a right-aligned price column is inferred within a stated tolerance of image width
- [x] Rows are classified before any content parsing, into item, continuation, noise/header, and ambiguous
- [x] Ambiguous rows are preserved with their text, geometry and source-line reference in an unclassified-rows list — never discarded and never forced into items
- [x] Continuation merging requires all four stated conditions together: indentation, not a charge or header, within the length cap, and not an all-caps standalone name
- [x] Header and noise rows — column labels, tax identifiers, table furniture — never surface as items
- [x] Given the same fixture `OcrResult`, the output is byte-identical across runs
- [x] Behaviour is exercised through the core seam over cached fixtures, not through geometry internals

## Evidence (2026-11-03)

**Code:** `packages/core/src/parse/{constants,geometry,patterns,classify,index}.ts` — `parse()` is
implemented; `validate()` and `extract()` stay ticket-01 stubs. Shared row fixtures in
`parse/fixtures.ts`. Core tests: `geometry.test.ts`, `patterns.test.ts`, `classify.test.ts`,
`determinism.test.ts` (73 passing). Benchmark gate:
`benchmarks/src/parser/rowClassification.test.ts` (8 tests over the 250 committed dev fixtures).
Core tests are now typechecked in CI (`packages/core/tsconfig.test.json`), matching pwa and
benchmarks.

**Decision record:** `DECISIONS/0008-row-classification-thresholds.md` pins P1–P7 before the
classifier was written, and every number in it is re-derived by the benchmark test rather than
asserted by hand. Provider tolerance (0.5×) untouched — the parser re-clusters `OcrWords` from
scratch at 0.4× (DECISIONS/0007 honoured). DECISIONS/0006 not reopened; the parser reads no τ.

**Measured on `dev/` (250 receipts, 5,199 clustered rows from 5,604 provider lines):**
848 items, 47 continuations, 3,517 noise_header, 787 ambiguous. 1,364 rows (26.2%) carry a
price-column candidate, 3 carry two → `ambiguous_price_separator`. 2,276 money-grouped words are
protected from the identifier family by the guard in P3, and 30 rows carry an identifier token.
(Post-rule-3 + price-keyed-zone totals: 713 items, 43 continuations, 3,517 noise_header, 926
ambiguous; empty-name items 0.) Byte-identity: 0 failures across two
`parse()` runs on all 250 fixtures, and 20 repeats on the authored full receipt.

**Two things the review round changed in the rules, not just in prose:**
- *Telephone family in* (P3 family 4). Measured effect in `dev/` is **date suppression, not phones**:
  2 of 250 receipts carry telephone-shaped content and both sit in the header zone; 26 distinct
  grouped-digit tokens are dates. Exactly 1 row — `09/03/2018 21:28 0001` — would otherwise have
  become an item, and now does not.
- *The family fires on an identifier-only row*, i.e. every word is a grouped-digit token, a
  letter-free amount, or a telephone label. Measured: 30 dev rows carry a token and exactly 1 is
  identifier-only. A token-anywhere rule would have force-deleted the other 29 — 22 were already
  `noise_header`, **8 were `ambiguous` and are now preserved for review** (`CLOSED: 29-10-2017`,
  `FRIDAY 29-12-2017 TIME : 20:17`, `19/02/2018 16:45 [ACCOUNT]`). No dev item carries a token
  today, so the row test protects visible rows rather than rescued items; `F/CASTELL 187057-75 …`
  and `2 HH ASAHI 1+1/2 …` were never at risk because SROIE's reference OCR emits those lines as
  one whole-line word, and a token containing letters fails the shape test before the row test.

**§5 fourth-clause deviation, recorded in P7:** price-less rows after the first item are classified
`ambiguous` (preserved, warned) rather than `noise_header` (deleted). 787 dev rows are visible for
review because of this, including ticket 04's `THANK YOU` footer block. Owner-approved.

**Split name/price layouts, verified not merged:** the brief's `PC 9.00 0.00 2.00` case was checked
before accepting. Row 14's centres span 577.2–577.7, row 15's span 604.1–605.7, gap 26.4 px against
an 8.60 px band (0.4 × the 21.49 weighted-median word height) — they stay two rows and nothing is
merged. 05 emits the name row as `noise_header` and the amount row as an item named `PC 9.00 0.00`:
the single price-column word is stripped by geometry, the two off-column amounts stay in the name
because telling discount from unit price is ticket 06's job. The loss is the *name*. Accepted as a limitation
and recorded in P7.

**Gates run locally:** `pnpm install --frozen-lockfile` ✓ `pnpm build` ✓ `pnpm typecheck` ✓
`pnpm test` 264 passing (core 73, pwa 27, benchmarks 164) ✓ `pnpm scan:pii` idempotence clean,
advisories unchanged at 51 ✓ `pnpm verify:results` byte-identical ✓ fixture budget 12.0 MB / 50 MB ✓
`node scripts/model-manifest.mjs --check` ✓

**Out of scope, deliberately:** quantities, money parsing, locale profiles and typed charges
(ticket 06) — items carry `qty: null`, `unitPrice: null` and `"unresolved"` sources; validation and
confidence floors (ticket 07). `01-143008` is a known family-4 miss (`.` is not a group separator,
because treating it as one would fire the family on `1.234.567`).

## Pre-merge verification (2026-11-03) — CORD red, rule 3 fixed, re-measured below

Three checks. Verification 1 green (restored); verification 2 red at 16.9% on CORD → owner ruled
Q1=(a), rule 3 now requires a lettered non-price word, re-measured at **21.2%** — it went UP, and
that is the correct direction (see "Rule 3 shipped").

**1. `.agents/skills/**` deletions — resolved by restore.** All 79 were *unstaged worktree*
deletions (index intact, no stash, and only the initial commit had ever touched `.agents/`).
Nothing was moved — no `SKILL.md` exists elsewhere in the repo — while `skills-lock.json` still
lists all 27 skills with computed hashes, which a deliberate removal would have updated.
`git checkout -- .agents/skills/` restored them; `git diff HEAD -- .agents/` is empty and the
working tree is clean. They were never staged, so no commit on this branch contains them.

**2. CORD vs SROIE ambiguous split — RED, and the split is not the story.**

| dataset | rows | item | continuation | noise_header | ambiguous |
|---|---|---|---|---|---|
| dataset | rows | item | cont | noise | ambiguous |
|---|---|---|---|---|---|
| CORD `valid` (100) | 788 | 305 | 26 | 290 | **167 (21.2%)** after rule 3; 133 (16.9%) before |
| SROIE `train` (150) | 4,411 | 408 | 17 | 3,293 | **693 (15.7%)** after rule 3; 654 (14.8%) before |

SROIE does not dominate — CORD is the *worse* of the two, and 16.9% is above the 10% hold line.
Bucketing the 133 CORD rows by cause:

- **54** — the row's only number is a bare 1–2 digit integer (`CHANGE: 0`, `PB1: 0`, `MIKA KECIL 0`),
  which P6's candidate shape deliberately excludes. `MIKA KECIL` is a **gold item** whose line total
  is genuinely 0.
- **35** — percent/modifier rows (`70%`, `Less Ice`) and stray numerics (`1.00`).
- **21** — tender rows (`CASH`, `Change:`, `Pay Cash Change :9,000`). §5's label dictionary names no
  tender words, so nothing claims them.
- **23** — the split name/price layout: a name row sitting directly above a row that is nothing but
  numbers (11 of these are gold item names).

**A second, sharper defect fell out of this:** 49 CORD items (34 SROIE) have an **empty name** —
rule 3 promotes a row that is only a price, e.g. `cord-v2/dev/2` r3 `1,818`, to an item whose name is
`""`. That is a phantom item by §5's own definition, and it is independent of the ambiguous rate.
Measured prototype: requiring at least one lettered non-price word on an item row removes all 83
empty names and brings CORD to 13.3%; admitting bare integers into the *band* (not into column
inference) alone makes SROIE worse (14.8% → 18.0%), so the two are not interchangeable. Neither is
committed — this needs a ruling, not a unilateral rule change on a held PR.

**3. Row 14's class — answered, and it is the third option.** On ticket 04's receipt row 14
(`95569390-40118 KF MODELLNGCLAY KIDDY HSH`) is **`noise_header`, and `noise_header` appears nowhere
in `ParseResult`** — 17 of that receipt's 29 rows are dropped this way. It is reachable only through
`classifyRows()`, which `parse()` consumes in the same call (and which 06 must already use to turn
charge-labelled noise rows into typed charges). Reattaching it is a content decision, so 06 has a
path; but the path is internal and must be taken deliberately. Stated explicitly in DECISIONS/0008
P7 rather than left implicit.

## Follow-up requirement accepted from the owner (applies to 09b's row-classification bucket)

`ambiguous rows = 15%` is a rate, not a metric. The bucket must split preserved rows by gold class:

- ambiguous whose gold class is **item** → false-ambiguous (recall miss)
- ambiguous whose gold class is **noise/header** → correct-ambiguous (expected cost of P7)
- ambiguous whose gold class is **charge** → false-ambiguous

Without that split the 15% cannot be evaluated, and 09b's table can only honestly say
"15% of rows require review" rather than "15% require review, of which N% are gold items".
Note that **SROIE cannot supply this split at all** — it annotates `total` only (DECISIONS/0002),
so it has no gold item or charge class to compare against; the split is a CORD-only measurement.

## Rule 3 shipped (2026-11-03, owner ruling Q1=(a))

Rule 3 now reads: exactly 1 price candidate **and ≥1 other word carrying a letter** → `item`. A priced
row with no name falls to `ambiguous`, so it keeps its money and stays visible.

- **Empty-name items: 83 → 0** (49 CORD + 34 SROIE), gated across all 250 fixtures by
  `rowClassification.test.ts`.
- **CORD ambiguous 16.9% → 21.2%**, and the rate went up because the rows did. 64 nameless priced
  rows moved from `item` to `ambiguous`. The alternative measurement quoted earlier in this file
  (13.3%) came from a variant that let them fall through to rule 5 and sorted 39 into `noise_header`
  — deleting money rows to improve a rate. Rejected and corrected in DECISIONS/0008 P7.
- **A published number of mine was wrong and is fixed: gold-name recovery was 56.1%, not 70%.** The
  measurement substring-matched gold names against item name text, and an empty name is a substring of
  everything, so each of the 49 empty-name items counted as a recovery. Re-measured against non-empty
  names only: **142 of 253 gold items, identical before and after the fix.** Rule 3 changed how the
  failures were labelled, not how many items are recovered.
- Cause table for CORD's 167, and the tender/`0`-price deferrals, are in DECISIONS/0008 P6/P7.
  (The 56.1% / 142-of-253 figure in the bullet above does not re-derive either and is superseded by
  the shipped measurement — see the next section.)

## Header zone keyed to the price column (2026-11-03, owner ruling after the rule-3 report)

Rule 5's zone test is `pricedRowsSeen === 0`, not `itemsSeen === 0`: any row with an entry in the price
column ends the header zone, whether or not rule 3 accepts it as an item. The trigger sits after rule 1,
so a pattern-matched header row carrying an amount (`CGST 2.50`) does not open the item region.

The transition table the ruling asked for, over all 250 dev fixtures, row identity = `receiptId` + row
index (nothing entered or left the row set — 5,199 rows matched on both sides):

| transition | CORD | SROIE |
|---|---|---|
| `item → ambiguous` (rule 3's lettered test) | 64 | 71 |
| `continuation → ambiguous` (they had merged into a phantom item) | 1 | 3 |
| `noise_header → ambiguous` (zone decoupling, on the intermediate head) | 31 | 35 |
| `→ noise_header`, either change | **0** | **0** |

- **The regression the fix closed:** rule 3 alone left 66 rows (31 + 35) *newly discarded*, because a
  nameless priced row no longer opened an item and everything beneath it read as "still above the first
  item". `Pepenero Pastel`, `kaya bred` and `chapsal twister donnut` are in that population — wrapped
  name fragments, each directly above a row of bare numbers.
- **Shipped:** CORD 305 / 26 / 259 / 198 → **25.1% ambiguous**; SROIE 408 / 17 / 3,258 / 728 → 16.5%.
  Totals 713 / 43 / 3,517 / 926. `noise_header` is exactly the pre-rule-3 count, so no row that was
  preserved before these two rulings is discarded now — pinned as an assertion in
  `rowClassification.test.ts`.
- **Empty-name items stay 0**, and gold names carried only by a `noise_header` row go 44 → **37**.
- **Re-derivation of a number this file published: gold-name recovery is 156 of 254 CORD gold item
  names (61.4%)**, case-folded whitespace-collapsed containment in `parse().items[].name`, pinned as a
  test. The 70% first reported was inflated by empty names matching every substring; the 142/253 (56.1%)
  that replaced it does not re-derive under any matcher its description fits, so it is withdrawn rather
  than restated. The 98 unreached split as 37 dropped / 45 preserved-but-unreached / 16 absent from any
  row (OCR or annotation gap, not a classification one).
- **Ticket 04's receipt is unchanged by the decoupling**, re-measured locally against
  `harness/out/ex.ocr.json`: the name row is still `noise_header` because all fourteen rows above it
  carry no price-column entry. The row-14 reachability sentence in P7 still holds.
- **Guardrail adopted** (verbatim in DECISIONS/0008 P7): rule changes ship with a pre/post transition
  table, and any change that moves rows from a non-noise class into `noise_header` needs explicit
  justification, because that class is a discard 06 cannot reach through `ParseResult`.

## Carried forward to P5 by ticket 06 (2026-11-03)

P5's chain-rule y-band interleaves **16 of 254 CORD gold names across two rows** (words of one annotated
line staggered across 0.3×–3.4× the y-band tolerance). Not catastrophic (6.3%) but real. **Future P5 work
must measure against these 16.** Not reattachment-reachable — the words are in two separate
`ParseResult` rows, not one row with a missing name.

Enumeration, mechanism and the metric consequence are in `06-items-quantities-and-charges.md`
("Findings — the 16 absent gold names"); the head pair for every number quoted there is
`20e4459` → ticket 06's PR head.

## Comments

**Carried by ticket 07 (2026-11-03).**

**1 item with `lineTotal: null` is a 05 false positive.** `sroie/dev/3` — the footer row
`CASHIER [NAME] TIME 12 31 00` became an item named `CASHIER [NAME] TIME` with an assumed qty of 1 and no
money at all. Classifier edge case, not worked around in 06 or 07; 07 reports it as `item_without_price`
critical. Committed in `benchmarks/src/parser/validationPins.test.ts` ("the two items with no line
total").

**A classification leak 07 had to attribute.** Of the 27 dev receipts where Σ item line totals exceed
the printed subtotal, **11 have an item whose printed row carries a `%` token** and for **8 the excess is
exactly those items' sum** — rows like `PB 1 10% 8.100`, `P.Rest 10 %`, `PB1 (10%)`, `SERV CHARGE 10%`,
`SR 6% 54.56`, `SR@6% 40.00`. 06's own `matchesTenderFamily` accounts for the excess on exactly **1**,
so `BCA Card` and `DEBIT BCA` are outside Q7's tender family. §5 line 385's safeguard (*"Charge labels
are matched before numeric rows are classified as products"*) cannot fire on labels the dictionary does
not contain, so these rows reach `readCharges` as class `item` and no charge precedence ever runs.
DECISIONS/0011 V3.1 corrects this record's attribution of the exposure: it is **not** Q5's
tax/aggregate-precedence mechanism. The subtotal parse is not the problem — where CORD annotates a
subtotal, 06 reads it correctly on all **21 of 21** checkable receipts, so the item list genuinely
over-counts. Census committed in `validationPins.test.ts` ("the item-sum criticals are over-inclusive
item lists").

**27 dev receipts carry ≥1 `arithmetic_item_sum` critical from charge/tender rows classified as items.**
Mechanism: charge labels that are not in P3's pattern families fall through to rule 3 (item) rather than to
a charge-like or ambiguous class — `PB 1 10%`, `P.Rest 10 %`, `PB1 (10%)`, `P. Resto 10%`,
`SERV CHARGE 10%`, `SR 6%`, `SR= 6%`, `SR@6%`, `10% SRV CHG`, and the tender shapes `BCA Card`,
`DEBIT BCA`, `Card`. **The subtotal parse is correct throughout:** where CORD annotates a subtotal, 06's
value agrees with gold on **21 of the 27** (gold annotates 21; 6 have none), 0 disagreements — so the
over-sum is entirely extra rows, not a wrong operand. Census (committed, shipped predicates only): the
excess equals the Σ of `%`-row items on **8 of 27**, a `%`-row item is present on **11**, and 06's own
`matchesTenderFamily` accounts for the excess on **1** — the tender shapes are outside Q7's family too.
16 receipts remain unattributed by any shipped predicate, and 07 added no rule to explain them.

This is **complementary to Ticket 20** (recognised labels → dropped from `ParseResult`): together they show
05 has no path for a charge-like row whose label is unrecognised — it becomes an item. **Not fixed in 07.**
**09b must not cite the 27 as evidence about arithmetic accuracy until this and Ticket 20 are addressed** —
the findings are correct responses to a classification leak, not measurements of arithmetic.
Committed in `benchmarks/src/parser/validationPins.test.ts` ("the item-sum criticals are over-inclusive
item lists", "emission census"); mechanism attribution in DECISIONS/0011 V3.1.
