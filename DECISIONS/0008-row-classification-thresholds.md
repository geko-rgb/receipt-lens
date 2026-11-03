# DECISIONS/0008 — Row-geometry and row-classification thresholds (the Tier-3 pins for ticket 05)

Date: 2026-11-03 · Ticket 05.

`PROJECT(1).md` §5 specifies the parser's geometry contract but leaves four of its constants as
prose ("within tolerance", "no more than twice the median … seen so far", "not an all-caps
standalone line", "known header/noise patterns such as …"). Every one of them decides which rows
become items, so each is pinned here **before** the classifier is written, with the dev-fixture
measurement that bounds it. §5 line 336 itself requires this: "Publish the selected constants
after tuning."

Split discipline holds: every number below is measured against `benchmarks/fixtures/dev/` only
(250 receipts: CORD `valid` 100 + SROIE `train` 150) plus the git-ignored ticket-04 harness output
(`harness/out/ex.ocr.json`, re-checkable locally, never committed). Nothing read `eval/`.

## P1 — Continuation length cap

**`cap = max(20, 2 × median(item-name lengths already accepted))`, compared against the candidate
row's trimmed, single-space-joined text length in characters.** An item's measured length is its row
text **minus the single price-column word** — P6 already identified that word by geometry, so
removing it is not content parsing, and it keeps the median at name length rather than priced-row
length (`MIKA GORENG` = 11, not `MIKA GORENG 8.000` = 17, which would lift the cap from 22 to 34 and
let long header rows merge). The cap **does not grow when a continuation is absorbed**: a run of
accepted fragments would otherwise raise the ceiling for the next one until a header row fit under
it. The median is the same count-weighted lower-crossing statistic as P4, so no interpolated
half-length can appear.

§5 says "no more than twice the median item-name length seen so far". "Seen so far" is a running
median over the items accepted *above* this row, so at row k it is computed over items 1..k−1 and
the current row never votes on its own cap. The warm-up is the undefined part: with one prior item
named `TEA` the median is 3 and the cap is 6, which refuses almost every real wrapped name. The
floor of 20 chars is what makes n=1..3 survivable, and it is inert in steady state — measured over
the 254 `dev/cord-v2` gold item names: median 13, p75 18, p90 22, p95 24, max 31, so `2 × median`
is 26 and only binds the floor when the running median drops below 10.

The cap is a **merge gate**, not an item-name gate: it never decides whether a row is an item, only
whether a price-less row may be appended to the item above it. So it cannot lose an item; the
worst it can do is leave a genuine fragment unmerged, and §5's own asymmetry then applies — a
refused continuation is preserved visibly (or emitted as critical `item_without_price`), a wrongly
merged one is invisible.

## P2 — All-caps standalone line

**A row is an "all-caps standalone line" when its joined text contains at least one ASCII
uppercase letter, contains no ASCII lowercase letter, and is ≤ 25 characters.** Form:
`/[A-Z]/.test(t) && !/[a-z]/.test(t) && t.length <= 25`.

§5's condition "it is not a standalone all-caps line" blocks continuation merging only. Two
sub-questions are undefined: what "all-caps" tolerates, and what "standalone" bounds.

*Digits and punctuation are allowed inside the caps test; lowercase is the only disqualifier.*
Rejecting digits would un-block `QTY R17` and `TABLE 4`-shaped furniture from merging, which is
the opposite of the rule's intent. Allowing them costs nothing because the length bound carries
the actual discrimination.

*25 characters* is the measured choice. Over `dev/`, 2,295 clustered rows are price-less, single
all-caps words; their length distribution is p50 13, p75 22, p90 29, p95 32, max 55. The bound is
a release valve — above it, the all-caps signal stops blocking a merge — so the sensitivity is:

| K | rows that lose the standalone-name block | share of the 2,295 |
|---|---|---|
| 15 | 969 | 42.2% |
| 20 | 679 | 29.6% |
| **25** | **349** | **15.2%** |
| 30 | 169 | 7.4% |
| 40 | 18 | 0.8% |

25 sits just past p75 of the single-word population, so the block stays active over the short,
header-shaped bulk (`STARTERS`, `THANK YOU`, `TABLE 4`) while long all-caps lines — far more likely
wrapped name fragments than section heads — can still merge.

The bound applies to the joined row, so the population it really gates is wider than single words:
**3,592 price-less all-caps rows of any word count** — p50 17, p75 24, p90 31, p95 35, max 63 — of
which 783 (21.8%) are released past 25. Those are long shout-caps strings: wrapped notices and
printed terms rather than section heads.

Releasing a row from the caps test does not merge it; the other three §5 conditions still have to
hold. On ticket 04's real receipt the 5-word footer notice `GOODS SOLD ARE NOT REIURNABTEOK` (31
chars) is released by the bound and still refuses to merge, because its predecessor row is not an
item.

English-only v1 (ADR-010), so non-ASCII letters are neither required nor excluded by the test.

## P3 — Header/noise pattern families

§5 names three families by example — `QTY ITEM PRICE` (column labels), `TABLE 4` (table
furniture), `GSTIN: …` (tax identifiers). Those three plus one shape-only family 05 adds on
measurement (family 4) are implemented as **data tables**, and the set is **not closed**: it
matches §5's three examples, but the label dictionary is extensible by data, so a future noise
family (an additional header shape, a new identifier format, a notice class) is a one-row edit to
a table rather than a code change. That is the honest framing — P3 is a starting point sized to
what dev exhibits, not a maximal set.

1. **Column-label row.** Every word of the row has an alphabetic core (non-letters stripped,
   uppercased) inside a fixed label vocabulary, and the row has ≥ 2 words. Vocabulary: `QTY`,
   `ITEM`, `PRICE`, `DISC`, `DISCOUNT`, `AMOUNT`, `DESC`, `DESCRIPTION`, `CODE`, `TOTAL`,
   `SUBTOTAL`, `SUB`, `GST`, `CGST`, `SGST`, `IGST`, `TAX`, `CESS`, `VAT`, `SERVICE`, `CHARGE`,
   `SC`, `SVC`, `CHG`, `RM`, `RP`. Catches `CODE/DESC PRICE DISC AMOUNT`, `QTY RM RM`,
   `QTY ITEM PRICE`. The ≥2-word floor keeps a lone `TOTAL` out of this family — it belongs to
   the charge labels below, which is a different job.
2. **Tax / business registration identifier.** Label-anchored only: `GSTIN`, `GST ID`, `TRN`,
   `SST NO`/`SST ID`, `TAX ID`/`TAX NO`/`TAX REG`, `BRN`, `ROC`, `REG NO`/`REG.` followed by a
   value. Label anchoring is load-bearing: the bare-registration-shape rule (`9–12 digits`,
   `digits-letter`) would also match CORD item codes such as `95569390-40118`, so 05 does not use
   a shape-only rule.
3. **Table furniture.** A row that is exactly `TABLE <int>` (optionally punctuated), and a
   `TABLE`/`TBL` + integer prefix inside a longer row.
4. **Telephone / grouped-digit identifier — added on measurement, the one family §5 does not
   name.** A *word* is an identifier token when, after stripping quotes and brackets, it splits on
   `- / : ␠` into ≥ 2 groups that are all **1–7 digits**, totalling **8–13 digits**, and it is
   **not** money-grouped. Family 4 marks the row noise/header only when the **whole row** is
   identifier-shaped (see the row test below).

   The 1–7 group bound is the discriminator between a telephone and a SKU: `044-2356901` (3+7) is
   in, `95569390-40118` (8+5) is out. The `:` in the separator set is what makes `09/03/2018 21:28`
   one identifier rather than a date plus an orphaned `21:28`.

   The **money-grouping guard is what makes this safe**: a token matching `^\d{1,3}([.,]\d{2,3})+$`
   — `1.234.567`, `1,23,456` — is a formatted amount under §5's number-format contract, not an
   identifier, and is excluded before the digit-group test. Without it the family would fire on
   Indonesian and Indian grouped prices: **2,276 money words in dev are protected by that guard.**
   With it, **0 identifier tokens land inside a price column** across all 250 dev receipts — the
   guard is not a refinement, it is the whole reason the family can exist.

   What the family actually catches in dev is worth stating because it is not what the owner's
   question anticipated. Telephone-shaped content is rare and sits in headers: 2 of 250 receipts
   carry it (`TELEPHONE 03- 40212008`, `019-2616 281`, plus `TELL 187057-75`), and both are above
   the first item, so the positional rule already caught them. Running the shape test across all
   5,199 dev rows yields **30 rows carrying a token, 28 of them distinct, and essentially all of them
   dates** — `25/12/2018`, `29-12-2017`, `06/03/2018 20:01`, `01/03/18 19:14`.

   **The family fires on the row only when the row is nothing but identifiers** — every word is an
   identifier token, a letter-free amount, or a telephone label (`TEL`, `FAX`, `PHONE`, `HOTLINE`,
   `HP`, `MOBILE`, …). Measured over dev: **30 rows carry at least one token, and exactly 1 of them
   is identifier-only.** The other 29 break down as 22 already `noise_header` (caught positionally
   or by another family) and **8 `ambiguous`** — `CLOSED: 29-10-2017`, `FRIDAY 29-12-2017 TIME :
   20:17`, `19/02/2018 16:45 [ACCOUNT]`. A token-anywhere rule would have force-deleted those 8 into
   `noise_header`, trading visible review rows for silent ones, which is the wrong direction for the
   same reason P7 rule 6 goes the other way.

   **No dev item carries an identifier-shaped token today**, so the letters test is not rescuing an
   observed item — it is the cheap half of the protection and it stays because real receipts print
   SKUs as their own words. Two rows I first believed were at risk are not: `F/CASTELL 187057-75
   TACK-IT 2 SR 12.00` and `2 HH ASAHI 1+1/2 SR 77.80` survive because SROIE's reference OCR emits
   them as **one whole-line word**, and a token containing letters fails the shape test before the
   row ever reaches the restriction. The row-level test is the second line of defence, not the first.

   Exactly **1** row pairs the identifier-only shape with a price candidate, and that is the phantom
   05 would otherwise emit:

   ```text
   09/03/2018 21:28 0001     -> identifier-only + price candidate -> noise_header, not an item
   ```

   So the family's measured value in dev is **date-and-time suppression**, and its telephone
   population is 0 priced rows. It is pinned as a *grouped-digit identifier* family covering
   date/time/telephone/registration shapes rather than a telephone-only regex, because that is what
   the data contains; a narrower telephone-only rule would be a rule that fires on nothing here.
   The `044-2356901 9.00` case in the ticket-05 brief is real in Indian receipts and is caught by
   the same shape; it is covered by a hand-authored fixture, since dev has no priced telephone row
   to exercise it (per DECISIONS/0004, row classification is tested by authored fixtures, not CORD).

Plus §5's first bullet, which is a *positional* rule, not a pattern: rows above the item region
(P7 rule 5, where the zone ends at the first row carrying a price-column entry rather than at the
first row rule 3 accepts as an item) are `noise_header` whatever they say. That is what covers
`Document No:`, `Date`,
`Cashier`, `Member`, `CASH BILL` on the receipts measured here — no pattern needed for them.

**Charge labels are a separate list from the noise patterns.** §5 line 387 ("Charge labels are
matched before numeric rows are classified as products") means a row carrying a §5 label-
dictionary term is not a product. 05 uses the §5 dictionary terms as a **boolean** — *is this row
labelled* — and never as a typed charge: `cgst`, `sgst`, `igst`, `cess`, `vat`, `gst`, `tax`,
`service charge`, `sc`, `svc chg`, `service`, `tip`, `discount`, `subtotal`, `sub total`, `grand
total`, `net amount`, `bill amount`, `total`, `round off`, `round`, plus the CORD bucket `pajak`,
`servis`, `diskon`, `jumlah`. Matching longest-first over multi-word terms, exactly as §5 line 379
requires. **Ticket 06 owns turning those rows into `ParsedTax`/`ParsedOtherCharge`**, and 05 hands
them over as classified rows with their label match recorded, which is why a labelled row is
`noise_header` here rather than simply discarded — §5's own bullet puts label matches in that
class, and the row data still has to reach 06.

**Tender rows were a known, accepted gap; ticket 06 closed it as pattern family 5.** Rows like `CASH`,
`Change:` and `Pay Cash Change :9,000` were classified `ambiguous` to keep them visible for review (31 of
CORD's preserved rows on the shipped classifier, counted by the tender predicate committed in
`rowClassification.test.ts`; 22 while the header zone was still keyed to rule 3's item). 06 measured the
wider population and found the deferral's premise was wrong: 423 dev rows are tender-shaped and **204 of
them are classified `item`**, i.e. tenders were not being preserved, they were becoming phantom products
(0 of the 131 gold↔item pairs involves one). Family 5 (tenders) now matches at rule 1 and classifies them
`noise_header`; see DECISIONS/0010 Q7 for the attribution table and the P7 invariant revision that comes
with it.

### Reported, not implemented: the notice/footer family

Footer notices and greetings (`THANK YOU`, `PLEASE COME AGAIN`, `GOODS SOLD ARE NOT RETURNABLE`)
are still **not** a pattern family. They are price-less, so P6 gives them no price candidate and P7
rule 6 lands them in `ambiguous` — preserved in `unclassifiedRows` rather than discarded, which is
the outcome §5 line 343 asks for. A notice family would move them from `ambiguous` to
`noise_header`, i.e. trade a visible review item for a silent deletion, and it needs the same
measured cost analysis family 4 got before it is added.


## P4 — "Word-count-weighted median" is a defined statistic, and the definition matters

**Weighted median over one observation per word, resolved by the lower-crossing rule: sort the
distinct word heights ascending with weight = number of words at that height; the median is the
smallest height whose cumulative weight ≥ half the total word count.** No interpolation, no
average of two middle values, so the tolerance is always a height some real word has.

§5 says the median is "word-count-weighted" without giving the tie rule. This is not pedantry —
over the 250 dev receipts the definition moves the number materially:

| alternative | mean divergence | max | receipts affected |
|---|---|---|---|
| classic interpolated median (average of the two middle values) | 0.37% | 7.7% | 38 / 250 |
| median of per-line medians (line-weighted) | 2.55% | 37.3% | 117 / 250 |

The observation unit is the **word**, which is what "word-count-weighted" means and what
distinguishes it from a median over line heights: a receipt whose header lines are one fat word and
whose item lines are four thin words gets a tolerance from the lines that actually have words in
them. The 37.3% max divergence against line-weighting is the measured cost of getting that wrong,
and it is the larger of the two by an order of magnitude: getting the *unit* of observation wrong
distorts the tolerance far more than getting the tie rule wrong.

**Stated honestly against DECISIONS/0007.** That record separates the provider's banding from the
parser's by two differences: the value (0.5 vs 0.4) and the statistic ("unweighted median of word
heights" vs "word-count-weighted median"). The value difference is simply true. The statistic
difference is narrower than it reads and worth stating exactly: the provider takes
`heights[floor(n/2)]` over the sorted word heights — the **upper** middle for an even word count —
while P4's count-weighted crossing takes the **lower** middle. They agree whenever the receipt has an
odd number of words, and on an even count they agree only when the two middle heights are equal.
Measured over dev, **146 of the 250 receipts have an even word count and the two statistics return
different heights on 38 of them**. So they are different statistics, not one statistic under two
names, and neither substitutes for the other. What also keeps the two code paths separate and non-substitutable is:

- the **membership rule**: the provider compares a word's centre against the *running mean centre
  of the band* (order-dependent, radius rule); the parser uses P5's chain rule;
- the two tolerances remain **0.5 × and 0.4 ×** and must not be aligned; cached `OcrResult`
  fixtures are keyed by provider version and model hash (§3), so touching the provider's constant
  invalidates them for no parsing gain.

0007's operative instruction — "Ticket 05 tunes §5's constant and must not align the provider's" —
is followed: the provider is untouched, and §5's statistic is now defined rather than asserted.

## P5 — Y-band membership: chain rule, not radius rule

**Sort words by vertical centre (ties broken by left edge); start a new row whenever the gap
between consecutive centres exceeds `tol = 0.4 × P4`; words in a row are ordered left-to-right.**
Single-linkage in one dimension: transitive, order-independent in result, and free of the
running-mean drift that lets a radius rule absorb a word into a band it never overlapped.

`tol` floors at 1 px so a zero-height degenerate word cannot collapse the page. Measured effect:
over the 250 dev receipts the provider publishes 5,604 reading-order lines and the parser
re-clusters them into 5,199 rows (405 merges) — CORD is the case that needs it, because its
reference OCR publishes `1`, `REAL GANACHE` and `16,500` as three separate lines of one visual
row. On ticket 04's real thermal scan the clustering reproduces all 29 provider lines as 29 rows,
i.e. it neither invents splits nor merges the wrapped notice. 0.4 vs 0.5 changes the row count on
40 of 250 receipts (5,199 rows at 0.4 against 5,080 at 0.5), so the constant is load-bearing and
stays §5's value: §5 calls 40% "an initial
heuristic to be tuned on development data", and the row-classification buckets 03b scores are the
tuning signal. Until 09b reports them, 0.4 is kept as published rather than tuned to a number this
ticket cannot measure honestly.

## P6 — Price column: which cluster, what band, and the fallback

**Candidate word.** After stripping `₹`/`Rs`/`INR`, the token matches `^\d[\d.,]*$` **and** either
contains a separator or has ≥ 3 digits after separators are removed. Bare 1–2 digit integers are
excluded on purpose: they are the quantity column's population (§5 line 361), and admitting them
puts quantity right edges into the price alignment test. `9.00`, `16,500`, `800000` qualify;
`2`, `00`, `25/12/2018` do not. **This is a geometry predicate, not money parsing** — it never
produces a paise value, and ticket 06 still owns the §5 locale profiles and integer-paise
boundary.

**Cluster.** Right edges of candidate words, sorted descending; a cluster is an anchor (its largest
edge) plus every edge within `0.05 × image width`; qualified clusters need **≥ 2 members**; the
price column is the **rightmost** qualified cluster. Measured over the 250 dev receipts: 117 give
exactly one qualified cluster, 115 give several (the rightmost rule is what makes that choice
deterministic), 16 give none, and 2 carry too few numeric words to infer anything.

**Row candidate.** A word is a price candidate for its row when `|rightEdge − columnCenter| ≤
0.05 × width`. A row with exactly one candidate is a priced row; two or more emit
`ambiguous_price_separator` and create no item (§5 line 345). Measured: 1,364 of 5,199 dev rows
(26.2%) get a candidate and only 3 rows have two — the separator case is real but rare, so 05's
coverage of it is fixture-authored rather than dataset-authored.

**Measured cost of excluding bare 1–2 digit integers, stated because it is not free.** Split by
dataset on the shipped classifier (rule 3's lettered-content condition and the price-keyed header
zone, P7), `dev/`: CORD `valid` is 788 rows → 305 items, 26
continuations, 259 `noise_header`, **198 ambiguous (25.1%)**; SROIE `train` is 4,411 rows → 408
items, 17 continuations, 3,258 `noise_header`, **728 ambiguous (16.5%)**. CORD — the split where
every row is an annotated financial category — is the worse of the two, which is what §5's "initial
heuristic" warning is for. Of CORD's 198, the causes are itemised in P7's table; the ones belonging
to this rule are **52 rows that carry a bare 1–2 digit integer and no price-column entry** (the
bucket takes tender-shaped `CHANGE: 0` and `PB1: 0` first, so this count is the remainder) — what the
quantity argument excludes. `CHANGE: 0` is fine to lose, but `MIKA KECIL 0` is a **gold item whose line
total really is 0**, so the exclusion that keeps the quantity column out of the price band also costs
a real item. Carried to ticket 06 as a named regression, with the counter-measurement that
admitting those integers into the band pushes SROIE the wrong way (14.8% → 18.0% before rule 3
landed), so the fix has to come from money parsing, not from the band.

**Fallback, for the 16 qualified-cluster-free receipts.** A priced receipt with a single line item
would otherwise have no column and therefore no items at all. When no cluster reaches 2 members, a
row's price candidate is its own rightmost candidate word. The state is recorded on the internal
row record (`columnFallback`) so 06/07 can tell an inferred column apart from a per-row guess, and
so the benchmark can bucket it.

### Sensitivity of the 5% tolerance (3 / 5 / 7 / 10% of image width)

§5 calls 5% an "initial tolerance" and §5 line 336 requires the published constant to be
justified, so the alternatives are measured rather than asserted. Rows-with-a-candidate is the
recall side (more rows recognized as priced); rows-with-two-or-more is the cost side (each becomes
an `ambiguous_price_separator` and creates no item):

| tolerance | no column inferable | single cluster | ≥2 clusters | rows with ≥1 candidate | rows with ≥2 (ambiguous) |
|---|---|---|---|---|---|
| 3% | 18 | 116 | 116 | 1,295 (24.9%) | **3** |
| **5% (§5)** | **18** | **117** | **115** | **1,364 (26.2%)** | **3** |
| 7% | 15 | 120 | 115 | 1,586 (30.5%) | 6 |
| 10% | 2 | 134 | 114 | 1,697 (32.6%) | **58** |

**5% is pinned.** It buys 69 more recognized price rows than 3% at zero ambiguity cost — the
ambiguous count is identical at both, so 3% is strictly worse. Raising it to 7% would buy another
222 rows but starts eating separator cases (3 → 6), and 10% is the failure mode the table exists to
show: recognition rises only 6% more while `ambiguous_price_separator` rows multiply **nineteen-fold**
(3 → 58), because a 10% band swallows the quantity and discount columns into the price column. 5%
sits on the flat part of that cliff. §5's own value is confirmed, not overridden; the 7% option is
recorded as the one worth revisiting if 09b's row buckets show price rows being missed at 5%.


## P7 — Classification order, and the rule for a row that satisfies none of the classes

§5 gives four classes and leaves the case "price-less, not a continuation" undecided — its own
clauses put it in `noise_header` ("no price-column entry and no plausible continuation context")
*and* describe it as `ambiguous` in the next bullet. **A single forward pass, in this order:**

1. a column-label / tax-identifier / table-furniture / grouped-digit-identifier pattern (P3
   families 1–4), **or** a §5 charge-label term → `noise_header`
2. ≥ 2 price candidates → `ambiguous`, emit `ambiguous_price_separator`
3. exactly 1 price candidate **and at least one other word carrying a letter** → `item`
3b. exactly 1 candidate but no lettered non-price word → `ambiguous` (rule 3's cast-off, pinned below)
4. 0 candidates, all four continuation conditions hold → `continuation`, merged into the previous item
5. 0 candidates and no priced row seen yet (still above the item region) → `noise_header`
6. otherwise → `ambiguous`

**The header zone is keyed to the price column, not to rule 3.** Rules 2, 3 and 3b each mark their row
an *item-region row*: any entry in the price column ends the zone rule 5 depends on, whether or not the
row is an item. The counter is incremented after rule 1 and before rule 2, so a pattern-matched header
row that happens to carry an amount (`CGST 2.50`) does not open the item region.

> §5's "above the first item" is interpreted as document position, not classification status. The
> header zone ends when any item-region row appears (identified by presence of a price-column entry),
> regardless of whether that row passes rule 3's name test. This interpretation is required to preserve
> nameless priced rows for review rather than discarding them as noise_header.

The two candidate triggers — "any priced row seen" and "any row with a price-column entry" — are the
same statement once rule 3's cast-off is admitted as an item-region row, and they are also the same
measurement: `>= 1` and `=== 1` differ only on rows with two or more candidates, and the dev set has
three such rows, none of them above the item region, so both variants produce byte-identical output.
`>= 1` is implemented because it states the concept (a price-column entry marks item position) instead
of leaving the exception to be discovered by the next rule change.

**Rule 3's lettered-content condition is pinned, per owner ruling.** The first cut of this rule
promoted any row with one price candidate to an item, so a row whose entire content *is* the price —
`1,818` alone in `cord-v2/dev/2` row 3 (rows here are the 0-based index into `classifyRows()` output) —
became an item with an **empty name**: 49 of them in CORD, 34
in SROIE. A nameless row is a phantom item by §5's own definition, so rule 3 now additionally
requires a non-price word containing a letter, and a priced row with no name falls to `ambiguous`
(rule 6): **preserved in `unclassifiedRows`, visible, and still carrying its money.**

**The honest consequence for the ambiguous rate, stated because it went the other way from the
number this record first carried.** Rule 3 alone took CORD's ambiguous share from 133 of 788 (16.9%) to
167 (21.2%): 64 nameless priced rows left `item` for `ambiguous`. Keying the header zone to the price
column (above) takes it to **198 of 788 (25.1%)**, and that is the rate the shipped classifier reports.
Neither of the two earlier figures was right: 13.3% came from a variant that let the nameless priced
rows fall through rule 5 instead, sorting 39 of them into `noise_header` — *deleting money rows* to make
a rate look better — and 21.2% was deflated by 66 more rows silently discarded through the same hole
(31 CORD, 35 SROIE; the 62 quoted during review was the same hole measured from the pre-rule-3 head,
which had preserved 4 of them as continuations of phantom items).
An intermediate head of this ticket briefly carried that discard, and the transition table below is how
it was caught. §5 line 343's rule is that unrecognised content is set aside visibly, and a discarded
price is unrecoverable by ticket 06 while a preserved one is reattachable.

**Pre/post transition table for the two ruled changes, over all 250 dev fixtures** (row identity is
`receiptId` + row index, so every row is matched; nothing entered or left the row set):

| transition | CORD | SROIE |
|---|---|---|
| `item → ambiguous` (rule 3's lettered test) | 64 | 71 |
| `continuation → ambiguous` (they merged into a phantom item) | 1 | 3 |
| `→ noise_header`, either change, either dataset | **0** | **0** |
| `noise_header → ambiguous` (zone decoupling, measured on the intermediate head) | 31 | 35 |

The intermediate head (rule 3 with the zone still keyed to `itemsSeen`) is the regression this table
exists to catch: it moved 66 rows *out* of `ambiguous` and *into* `noise_header`, because a nameless
priced row no longer opened an item and rule 5's "still above the first item" was true of everything
below it. `Pepenero Pastel`, `kaya bred` and `chapsal twister donnut` are wrapped name fragments in that
population — each sits directly above a row that is nothing but its numbers, which is exactly the
split-layout case P7 reports below.

> **Rule changes must include a pre/post transition table across the dev fixture set.** A rule that
> moves rows from any non-noise class into `noise_header` requires explicit justification, because
> `noise_header` is a discard and cannot be recovered by ticket 06 without internal reach-back. The
> rule 3 → rule 5 interaction that dropped rows in this ticket is the template: any rule change that
> affects "first item seen" or the header-zone boundary must be measured against pre-change output
> before merge.
>
> **Invariant revised by ticket 06 (owner ruling, 2026-11-03).** The original form was an equality —
> `noise_header == 3,517`, the base head's count — which is the cheapest way to catch a silent discard
> but which a *named* pattern family is entitled to break. Restated:
>
>> `noise_header` equals base head (3,517) **plus** rows accounted for by a documented pattern family.
>> Any increase must be traceable to a named family in the transition table. A rule change that
>> increases `noise_header` without a corresponding named-family entry fails the test.
>
> The spirit — no silent discards — is preserved by explanation, not by a frozen count. Family 5
> (tenders, DECISIONS/0010 Q7) is the first named family under the revised invariant, and its rows must be
> individually attributable: the transition table reports the `item → noise_header` and
> `ambiguous → noise_header` counts and every moved row matches the family predicate.

**Tenders are `noise_header`, and therefore not reachable from `ParseResult`.** Recorded in both this
record and ticket 06's file because it is the one class a reviewer cannot see in the output: **tenders are
classified `noise_header` and not reachable from `ParseResult`. ADR-008 locked the public shape and it has
no tender field. Tenders exist only in the internal `classifyRows()` output. Publishing tenders would
require a public-shape extension (an ADR change), not a classifier change.** The same reachability limit
P7 already documents for split-layout name rows applies here, and it is why `classifyRows()` is exported.

Shipped totals **at this head (`20e4459`)**: 713 items, 43 continuations, 3,517 `noise_header`, 926
`ambiguous` of 5,199 rows. Ticket 06's pattern family 5 (tenders) moves 307 of them and republishes these
figures as 504 / 37 / 3,824 / 834; the numbers in this record stay the base head's, they are what
`classifyRows(ocr, { tenderFamily: false })` re-derives, and DECISIONS/0010 Q7 carries the transition.
CORD is 305 / 26 / 259 / 198; SROIE is 408 / 17 / 3,258 / 728, i.e. 16.5% ambiguous from 14.8%. The
`noise_header` total is identical to the pre-rule-3 classifier's — 259 CORD and 3,258 SROIE — which is
what "no row was discarded that was previously preserved" means as a number, and it is pinned in
`rowClassification.test.ts`. Empty-name items across all 250 dev receipts: **0**, also gated there.

Post-fix causes of CORD's 198 preserved rows, bucketed by the predicates now committed as a test in
`benchmarks/src/parser/rowClassification.test.ts`. An earlier version of this table used ad-hoc
predicates that no longer re-derive; these are restated and applied in the order the test states —
tender before bare integer, because `CHANGE: 0` is both — and a name row counts as a split-layout
candidate only when the row directly beneath it is nothing but numbers:

| cause | rows | example |
|---|---|---|
| priced row with no name (rule 3's cast-off) | 64 | `1,818`, `20,000` |
| price prints as a bare 1–2 digit integer (P6 excludes it) | 52 | `MIKA KECIL 0`, `PB1: 0` |
| other price-less content | 32 | `Less Ice`, `1.00` |
| tender / payment line, unnamed by §5's dictionary | 31 | `CASH`, `Pay Cash Change :9,000` |
| name row above an all-number row (split layout) | 13 | `TRIPPLE CHEESE` above `17,000` |
| percent / modifier line | 4 | `70%`, `PB1 10%` |
| more than one price candidate (rule 2) | 2 | `1 1 PAIN CHOCO AU CUSTARD…` |

**One correction to a number this record published earlier: gold-name recovery was overstated at 70%.**
The measurement compared gold names against item name text with a substring test, and an empty name
matches every substring (`"mika kecil".includes("")` is true), so the 49 empty-name items each counted
as a recovery. The corrected figure this record then carried — 142 of 253 (56.1%) — does not re-derive
either, and is superseded by the measurement pinned in `rowClassification.test.ts`: **156 of the 254
`dev/cord-v2` gold item names (61.4%) are reachable in an item name** under case-folded,
whitespace-collapsed substring containment against `parse().items`. The remaining 98 split by where
their text actually is: **37 are carried only by a `noise_header` row** (unrecoverable from
`ParseResult`), 45 are carried by a preserved `ambiguous` row (06's to reattach), and 16 appear in no
row at all, which is an OCR/annotation gap rather than a classification one. The `dropped` count is the
number the zone decoupling was for: 44 under the intermediate head, 37 under the shipped one, so 7 gold
names came back from the discard class. Fixing rule 3 by itself changed neither figure (157 reached, 37
dropped before it): it changed whether the failures were disguised as items.

Both contested clauses are §5 bullets, so the ordering is the reinterpretation, and it is stated
rather than buried. **This is a deliberate, recorded deviation from §5, not an oversight:** §5's
fourth `noise_header` clause ("rows with no price-column entry and no plausible continuation
context") is honored for rows *above the item region* — rule 5. Below it, such rows are
classified `ambiguous` rather than `noise_header` — rule 6 — so unusual post-item rows are visible
for review rather than silently discarded. The trade is more `ambiguous_row` warnings: on ticket
04's real thermal receipt it is the footer block (`THANK YOU`, `PLEASE COME AGAIN`, the two notice
lines and two misread CJK/garbage lines) arriving in `unclassifiedRows` instead of disappearing.
`noise_header` is a silent deletion and `unclassifiedRows` + minor `ambiguous_row` is a recoverable
outcome for a human reviewer, which is the asymmetry §5 line 343 itself draws. Rules 1–6 depend
only on rows already classified, so a fixture cannot produce different output by reordering the
input.

**Why a price-less row is not an item, even though §6 has critical `item_without_price`.** That
finding needs a reachable trigger, and this design gives it one: rule 3 makes a row an item
*because* it has a price candidate, and 06 can fail to parse that candidate into paise. A row with
no candidate at all never becomes a candidate item here, which is also what "Header/noise rows …
never trigger `item_without_price`" (§5 line 344) demands.

**Split name/price layouts, verified not merged.** Some thermal layouts print the item name and its
amounts on two lines. Ticket 04's real receipt is one:

```text
row 14  95569390-40118 KF MODELLNGCLAY KIDDY HSH   word centres 577.2–577.7
row 15  PC 9.00 0.00 2.00                          word centres 604.1–605.7   (2.00 is the column word)
```

**Verified before accepting, per review: 05 does not merge these two rows.** The gap between them
is 26.4 px against a y-band tolerance of 8.60 px (0.4 × the 21.49 weighted-median word height), so
P5 keeps them as two separate rows and the classifier decides their classes independently — 05's
contract is per-row classification, and it is honoured. What 05 actually emits, run against
`harness/out/ex.ocr.json`: an item named `PC 9.00 0.00` for row 15, and row 14 as `noise_header`.

- row 14: price-less, predecessor is a column-label row so rule 4 cannot apply, and it sits above
  the item region, so rule 5 makes it `noise_header`;
- row 15: one price candidate (`2.00`; the column anchor is 449.2 and its band is [426.0, 472.3])
  → the receipt's first `item`.

Re-measured on the shipped classifier (the locally retained `harness/out/ex.ocr.json`, never committed,
per DECISIONS/0005): unchanged, and unchanged for a reason worth stating — all fourteen rows above the
name row carry no price-column entry at all, so the zone was open under both the `itemsSeen` and the
`pricedRowsSeen` test. The decoupling moves rows that follow a *nameless* priced row; a receipt whose
header block is entirely text is untouched by it.

The item's `name` is not the whole row text: P6 already identified `2.00` by geometry, so 05 strips
the single price-column word and leaves `PC 9.00 0.00`. The two amounts that are *not* in the column
survive into the name, because deciding what they are — discount, unit price, quantity — is ticket
06's content parsing, and 05 has no business guessing. So the residual limitation is narrower than
first reported and it is a *lost name*: the item exists with its price, its human-readable name is
attached one row too low, and the name row is discarded as header. No §5 class expresses "item whose price is on the next
row", which is why it is reported rather than fixed by inventing a fifth class in a ticket whose
whole contract is the four in §5. It is the first thing the row-classification bucket in 03b's
scorers should surface when a real parser runs the benchmark.

**Stating the reachability limit explicitly, because it is not obvious from the code.** Row 14 is
`noise_header`, and `noise_header` rows appear **nowhere in `ParseResult`** — not in `items`, not in
`unclassifiedRows`, not in `warnings`. They exist only in the `ClassifiedRow[]` that `classifyRows()`
returns, which `parse()` consumes inside the same call. So ticket 06 has a path to that name row only
if it goes through `classifyRows()` — which is exported from `@receipt-lens/core` for exactly this
reason — and not through the parse result. This is the same channel 06 must already use to turn
charge-labelled `noise_header` rows into typed charges (P3), so it is a real path rather than a
theoretical one, but it is an internal one and it has to be taken deliberately. Reattaching a name
row to the priced row beneath it is a content-parsing decision, not a reclassification, and belongs
to 06 for the reason §5 line 340 gives: rows are classified before their contents are parsed.

**Split-layout name reattachment (row 14, the `PC` case) requires 06 to access `classifyRows()`
output, not just `ParseResult`. `ParseResult` drops `noise_header` rows. The 06 implementer must read
DECISIONS/0008 P7 and use the internal channel, or split-layout names are unrecoverable.**

## Reporting discipline

> Pre/post deltas in reports must name the two heads being compared (e.g. "base head `528c989` →
> shipped head `e00394e`"). Deltas that don't name both heads are ambiguous and must be re-derived
> against an explicit pair before publication. Every published number in a report should be reproducible
> from a test or committed artifact; session arithmetic is not a source of truth. The
> `noise_header == 3,517` assertion is the model: the claim is enforced by a check, not by a report.

This ticket published three deltas that had to be corrected, and all three trace to the same missing
piece — a comparison whose two sides were never named. The heads are `9dcc8e1` (classifier as first
shipped, phantom empty names), `4826236` (rule 3's lettered test, header zone still keyed to items — the
regressed head) and `e00394e` (rule 3 plus the price-keyed zone — shipped). "62 rows discarded" and the
gold-name pair "46 → 38" were measured `9dcc8e1 → 4826236` while being reported as though the pair were
`4826236 → e00394e`; "142 of 253 (56.1%)" was described as case-folded substring containment over
non-empty names, which re-derives as 156 of 254, so the arithmetic behind it was not the arithmetic
described either. Each corrected figure now lives in a committed assertion
(`rowClassification.test.ts`: 198 preserved rows, 3,517 discarded, 156/37/45/16 gold-name split), which
is the only reason the correction is durable rather than a fourth number in a later message.

Same principle ticket 03a applies to fixtures and 03b to results: **artifacts are checked, not claimed.**
A report line that cannot be regenerated from a committed artifact is a claim about a session, and a
session is not evidence.


## IDs, purity, determinism

Row ids, item ids (`i1`, `i2`, …) and unclassified-row ids (`u1`, …) are assigned by the single
forward pass in P7, derived from position, never from `Date.now()`, `Math.random()`, map
iteration accidents or object key order. `parse()` reads the fixture `OcrResult` without mutating
it and never shares a nested reference into the output (words it needs are copied), per §4 line
319. Every classification decision is a function of geometry, text and the rows already passed.

## What this record does not decide

- **Quantities, money values, locale profiles and typed charges.** §5's quantity-column rule (60%
  of rows, integers ≤ 20), the number-format table and the label→charge taxonomy are ticket 06's.
  05 classifies rows and infers a column; it emits no paise.
- **Validation.** Confidence floors, `item_without_price`, `zero_items` and the arithmetic
  validator are ticket 07's; `validate()` stays the ticket-01 stub.
- **Whether 0.4 or 5% move.** §5 calls both initial heuristics to be tuned on development data,
  and the tuning signal is the row-classification bucket in the benchmark. Neither is retuned here
  without that measurement, and DECISIONS/0007's ban on touching the provider's 0.5 stands.
- **The notice/footer family.** Added to the pattern tables only when it carries the same measured
  cost analysis P3 family 4 got; today those rows land in `unclassifiedRows`, which is safe.
- Nothing here consumes or amends `DECISIONS/0006`. `τ_name = 0.70` and normalized Levenshtein
  belong to the benchmark matcher; the parser never reads them, and `benchmark.config` is untouched.
