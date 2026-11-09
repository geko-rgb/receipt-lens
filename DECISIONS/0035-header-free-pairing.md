# DECISIONS/0035 — Header-free row reconstruction: pairing descriptions with the numbers they sit by

Date: 2026-11-09 · Owner-requested bug fix (`next.md`, "Implementing Header – Free Receipt Row
Reconstruction") · **Status: accepted (owner, 2026-11-10)**, including the disposition audit's honest 7/3 preserved
figures, the priced-row-region fix that produced them, the dev-corpus pin moves, and the consolidation table.
Extends `DECISIONS/0033` (header-anchored table rows) and `DECISIONS/0034` (metadata and footer rows).
Related: `DECISIONS/0008` P5/P6, `DECISIONS/0010` Q1/Q5, `DECISIONS/0011` V1/V4/V17, `DECISIONS/0032`.

## The bug, measured

`images/WhatsApp Image 2026-11-06 at 22.48.34.jpeg` (Saravana Bhavan, 720×1280) is a real receipt, and its real
OCR output does not contain the header a reader sees:

```
roduct
Expire Qty Rate Total          <- `Product` lost its `P`; no cell over the names
offee
2.00 35.00 70.00               <- the description is ABOVE its numbers
vada
2.00 25.00 50.00
Chappathi Empty
2.00 24.00 48.00
combo 2 chapati/,Po8 2.00 Masala 153.00 306.00
Total 474.00
GST 996331 996331 996331 996331 Total HSN Details …
```

At the head this record starts from, that page produced **₹474.00 read, 1 item, 12 preserved rows** — the one item
assembled `combo 2 chapati/,Po8 2.00 Masala 153.00` with `qty_unresolved`, and the other three products lost in
rows the lock then demanded the creator clear by hand.

The header pass (`0033`) is right to refuse this page: `Expire Qty Rate Total` names three value columns and no name
column, and 0033 P3 requires a name cell before it will bound a table. What was missing was any *other* way to say
"this description goes with those numbers".

## What this record adds — one stage, one geometry

`packages/core/src/parse/pairs.ts`:

- **Numeric rows.** `inferValueColumns` (`geometry.ts`) clusters the right edge of every amount-shaped word into
  value bands — the same clustering the single price column uses, widened from "the price column" to "any money
  column". Tolerance is
  `max(6px, 2% of image width)` — 14.4px on this page, where 4% would have merged the rate column into the tax
  column beside it.
- **Roles by arithmetic (Amendment C).** Every 2- and 3-band subset is enumerated and scored by
  `qty × rate = total` in integer paise, ±1 (Amendment B). The best-scoring assignment wins; ties break rightmost,
  then by member count. `roleSource` records `arithmetic` when at least two rows agreed, `positional` otherwise.
  **Only `arithmetic` may publish products.** On this page `2.00 × 35.00 = 70.00`, `2.00 × 25.00 = 50.00`,
  `2.00 × 24.00 = 48.00`, `2.00 × 153.00 = 306.00` — four rows agree, so the bands are proved, not guessed.
- **Descriptions by the page's own side (Amendment D).** `descriptionSide` counts which arrangement explains more
  rows — description above its numbers, or below — and the page's majority decides. On this page: three rows above,
  two below, so `above`. Distance alone was measured and rejected: on a CORD receipt `SAYUR` sits 46px above one
  numeric row and 44px above another, and a pixel tie-break assigns it to the wrong product.
- **One reach, both layouts.** The description is the contiguous run of ≤2 readable rows on that side, and a row
  already used is not used again, so `Combo 2 Chapati` / `P.B. Masala` is one product while its neighbour keeps its
  own name.
- **Amendment A.** A numeric row with no description on that side is `unpaired` — it never becomes an item with an
  assumed quantity. This is the mechanism that manufactured the ₹2,10,373 phantom item in `0034`'s report, and
  `headerless.test.ts` asserts the class cannot arise here.
- **Amendment E gates.** Quantities are whole 0–999 counts (`PAIRING_QUANTITY_MAX_VALUE`); rates and totals
  money-shaped; and `magnitude.ts`'s 1000× median gate is applied to every rate/total candidate here, so an
  amount-shaped identifier is rejected by this stage on the same rule the classifier's price column uses. A band
  needs three members before it is a column at all (`ANCHOR_MIN_COLUMN_MEMBERS`), so a page with two money rows
  yields no roles and no items.
- **A header printed *inside* the item zone is not a description.** The first draft of this stage assembled
  `Expire Qty Rate Total Coffee` as one name; header rows are now excluded from the description search by index,
  not only by the "above the table" position rule.
- **Name plausibility.** A description whose only words are a currency token (`SR`), a reader tag (`[ACCOUNT]`) or
  a lone `X` is not a name; such rows are reported `description_not_a_name` rather than published as products.
- **Two is the floor.** Fewer than two paired rows is a coincidence, not a table; the stage reports
  `too_few_paired_rows` and publishes nothing.

`classify.ts` runs the stage over exactly the rows the header tables did **not** consume, so the two stages can never
publish the same row twice, and a recognised `Product | Qty | Rate | Total` table keeps its own reading.

### A structural-row guard the tax table needed

With the items right, the Saravana bill still could not be locked: one clustered row —
`GST 996331 996331 996331 996331 Total HSN Details …` — was read by the charge path as a `gst` charge **with no
amount**, producing `draft_charges_unresolved (o1)` and `tax_inclusion_unresolved (o1)`. The row is the receipt's tax
*breakdown*, not a charge, and `readTaxTables` could not read it as a table because the OCR had merged the whole
table into one line. `charges.ts` now skips a row carrying an `HSN`/`SAC` marker (the same marker `isTaxTable`
trusts) — a row that names a single tax column (`CGST 1.67`, and `CGST SGST 5.00` in `parse.test.ts`) is untouched.

## Measured: the two real photographs

Both photographs were run **once through the shipped app** — built shell, Chromium, `PP-OCRv6 Small`,
`/assets/models` same-origin, no network — and their OCR output captured verbatim as
`packages/core/src/parse/real-ocr-fixtures.ts` (Amendment H). `playwright/real-receipts.spec.ts` is that run, kept
as the gate; the fixture tests replay its output. Names below are the OCR's, not a reader's: `offee` stays `offee`,
`Po8` stays `Po8` (Amendment G).

### Saravana Bhavan — `WhatsApp Image 2026-11-06 at 22.48.34.jpeg`

29 OCR lines, 25 clustered rows. Numeric-row detection: 4 numeric rows, all in the value columns
(qty band centre ≈ 382px, rate ≈ 470px, total ≈ 572px); score 4 for `(qty, rate, total)`, next best 1. Pairing:
`above`, 4/4 rows paired, 0 unpaired. Final `ParseResult` (abridged to the money):

| # | name (as OCR read it) | qty | source | unit price | source | line total |
|---|---|---|---|---|---|---|
| 1 | `offee` | 2 | explicit | ₹35.00 | detected | ₹70.00 |
| 2 | `vada` | 2 | explicit | ₹25.00 | detected | ₹50.00 |
| 3 | `Chappathi Empty` | 2 | explicit | ₹24.00 | detected | ₹48.00 |
| 4 | `combo 2 chapati/,Po8 Masala` | 2 | explicit | ₹153.00 | detected | ₹306.00 |

`grandTotal` ₹474.00 (`detected`), subtotal absent, taxes none. The four rows the reader sees (70/50/48/306) sum
to the printed 474 with nothing over.

**Preserved rows: seven, not zero** — and that figure is this record's disposition audit (§ "Disposition audit"
below), not the `0` this page reported at first. The seven are the trailing block below the totals; extraction is
untouched. The bill can be locked once the creator dismisses them, which is §5 rule 7 doing its job.

### KOT counter — `WhatsApp Image 2026-11-06 at 22.48.35(1).jpeg`

9 OCR lines, proper header `Particulars | Qty | Rate | Amount`. One product: `D Pineapple lime`, qty 3 (explicit),
₹25.00 (detected), ₹75.00 — read by the *header* path, not this stage, which is the point of Amendment D's one
geometry. `Bill No 210373` and the date/time rows are `metadata` (`0034`) and appear in no item. The ₹4.50 sambar the
ticket never charges for is not invented.

## What this does not fix

- **The header pass's refusal.** `Expire Qty Rate Total` still builds no table; this stage is what reads the rows
  instead. 0033's `table.test.ts` case for a split header now asserts the products, not an empty item list.
- **Garbled text.** `offee`, `Po8`, `Chappathi Empty` stand as read and are editable in review. Deskew, threshold and
  contrast work is a separate ticket (Amendment G).
- **Dev accuracy.** On the dev corpus this stage publishes **nothing**: 1 CORD receipt and 0 SROIE receipts survive
  its gates (headers cover the rest, and the header-free CORD page — `cord-v2/dev/26`, names above numbers — has no
  arithmetic agreement to prove roles with, so it stays for review). cord-v2 macro F1 is therefore unchanged at
  0.473012; sroie 0.647482. Items on sroie rise 273 → 358 and CORD's item fields move by ±1 pair, both from the
  `0033`/`0034` work that the committed dev artifact predates — this record regenerates that artifact so it matches
  the shipped parser, and `pnpm verify:results` and the dev half of `verify:accuracy` pass.
- **`parser-only-eval.json`** is untouched: `verify:accuracy` stays red on ticket 27's documented eval regression,
  as Amendment I requires.
- **Locking a bill.** The roster (participants, payer, unit assignment) is still the app's flow. This record removes
  every blocker that came from *reading* the page — the twelve unread rows and the unamounted `gst` charge — but the
  page's trailing illegible block stays in review (see the disposition audit). Two of those rows are a staff name and
  a `Sales Type` line: a metadata family for them is a small, separate change, not this stage's business.

## Consolidation after the final review (architecture, not behaviour)

The stage's first cut carried four small re-implementations. Each is now one implementation, and the two
photographs still read identically — the dev corpus, the item count and both real images are unchanged.

| Responsibility | Before | Now |
| --- | --- | --- |
| Magnitude gate (1000× median: an amount-shaped identifier is not money) | applied only by the classifier's price column; this record claimed it covered the reconstructed rows, which was **false** — `pairs.ts` had no gate at all | `parse/magnitude.ts` holds the rule (`PRICE_MAGNITUDE_MULTIPLE`, `medianOfSorted`, `amountGate`, `exceedsGate`, `magnitudeOutlier`); `classify.ts` and `pairs.ts` both call it, and the pairing stage now gates every rate/total candidate on the page's own median |
| "Which band is the rate column" | `geometry.ts` exported `inferRateColumn`, a second band model derived from the price column, with **no call site anywhere** (it was a leftover of the 0033 patch that never applied) | deleted; `inferValueColumns` is the one band model, and `pairs.ts` assigns roles over its bands arithmetically |
| Horizontal centre of a word box | private `centerOf` in both `header.ts` and `pairs.ts` | `geometry.ts`'s `horizontalCenter`, used by both |
| Quantity plausibility cap | `MAX_QUANTITY = 999` local to `pairs.ts`, next to `QUANTITY_MAX_VALUE = 20` (a different question: qualifying a quantity *column*) | `constants.ts`'s `PAIRING_QUANTITY_MAX_VALUE`, named for what it answers |
| Positional fallback's provenance | `reconstructWithoutHeader` returned `roleSource: null` when the arithmetic could not prove the columns, erasing the `positional` decision that `inferPairingRoles` reported for the same page | the early return carries `assigned.source`, so "looked and could not prove" is reported as `positional`, not as "never ran" |
| Item region on a reconstructed page | §5's `pricedRowsSeen` advanced only for rows the classifier itself priced, so a page whose priced rows were all reconstructed classified every trailing row as header noise (see the disposition audit) | a reconstructed priced row counts as the item-region row it is; trailing rows now reach §5 rule 7 and are preserved |

What was already reused and stays reused: `columnValue` (one token reader, `header.ts`), `isAmountShaped`
(`geometry.ts`), `ROW_ROUNDING_TOLERANCE` (`rows.ts`, so ±1 paisa is the same tolerance in both reconstruction
paths), `TableRecord`/`ReconstructionEvidence`/`ReconstructResult` (one record shape, so `buildItems`, item
validation and `validate/arithmetic.ts` treat a paired row exactly like a header row), and the classifier's
`magnitudeOutlier` seam rather than a private copy of the rule.

Deliberately **not** merged: `header.ts`'s `columnOf` matches a word's **centre** against a header label's band
(values are right-aligned under a centred label), while `pairs.ts` matches a word's **right edge** against a band
built from right edges. Same question, two anchors, because the two pages print their columns differently; the
anchors are documented at both call sites rather than forced into one function that would have to take a mode flag.

## Provenance: what earns `detected`, `assumed`, `unresolved` for a cross-line pair

`DECISIONS/0011` V17 is the validation-facing statement of this table; it is repeated here because a reader of this
record should not have to hold two files open, and the two rows must be changed together if either moves.

| field | `detected` when | `assumed` when | `unresolved` when |
|---|---|---|---|
| name | a description run (≤2 readable rows on the page's own side) is adjacent to the numeric row and carries a word of ≥2 Latin letters that is not a currency/unit token | — (a name is read or the numeric row stays unpaired; nothing is invented) | the numeric row has no adjacent description, or its only words are a marker (`SR`, `[ACCOUNT]`, `X`) |
| qty | a band role is proved by arithmetic agreement on ≥2 rows and the word there is an integer 0–999 | — (unpaired rows never reach an item, so `assumed qty 1` cannot arise from this stage) | the page's arithmetic names no qty column, or the cell is not an integer count |
| rate | as qty, plus `magnitude.ts`'s gate (1000× the page's median amount) | — | no rate column was proved, or the cell fails the money/magnitude gates |
| line total | the word sits in the proved total column | — | no total column was proved |

`assumed` is empty by construction, which is the point: this stage can only read a value that is printed in a column
whose role arithmetic proved on more than one row. A stage that cannot prove its columns reports `roleSource:
"positional"` and publishes nothing (so does one that pairs fewer than two rows) — that is the path a one-product,
header-free receipt takes, and it leaves every field unresolved rather than inventing a quantity of 1.

## Disposition audit — all 26 clustered rows of the Saravana page

One-time audit required before this record could be accepted: every row the classifier saw on the photograph, the
bucket it landed in, and the evidence for that bucket. Strings are the redacted replay fixture's
(`real-ocr-fixtures.ts`), so `[INVOICE_001]` is a bill number and `[TAX_REG]` a registration number; the extraction
names are the OCR's own. Conservation: **26 rows in, 26 rows accounted for** — 7 item rows (4 records), 1 header row,
8 header/metadata/tender rows, 3 charge rows, 7 preserved. Nothing is dropped without a reason, and no bucket below
rests on "it was at the bottom of the page".

| # | verbatim (row text) | bucket | evidence |
|---|---|---|---|
| 0 | `[INVOICE_003] A R E` | ignored (header zone) | above the first priced row; no label, no price, no money in the price column → §5 rule 5 |
| 1 | `FST NNo [TAX_REG]` | ignored (header zone) | same; the registration value carries no money |
| 2 | `POS INVOICE` | ignored (header zone) | same |
| 3 | `:[INVOICE_001]` | ignored (header zone) | same |
| 4 | `:[DATE] [TIME] PM` | ignored (header zone) | same; the date is not a metadata family value, and it is above the header |
| 5 | `roduct` | ignored (header zone) | the `Product` heading the OCR lost its `P` from; explicitly excluded as a description by `headerFloorIndex` |
| 6 | `Expire Qty Rate Total` | ignored (header row) | the printed column header: `findHeaderTables` recognises three value columns and no name column, so it is refused as a *table* (`0033` P2) but is still the header row |
| 7 | `offee` | item | name run for row 8 — paired record `offee` |
| 8 | `2.00 35.00 70.00` | item | value row for that record: qty 2, rate 35, total 70, arithmetic agrees |
| 9 | `vada` | item | name run for row 10 |
| 10 | `2.00 25.00 50.00` | item | value row: 2 × 25 = 50 |
| 11 | `Chappathi Empty` | item | name run for row 12 |
| 12 | `2.00 24.00 48.00` | item | value row: 2 × 24 = 48 |
| 13 | `combo 2 chapati/,Po8 2.00 Masala 153.00 306.00` | item | inline description and its own values: 2 × 153 = 306 (the `2` inside `chapati/,Po8` is name text, not a quantity) |
| 14 | `Total 474.00` | charge (grand total) | `chargeLabel` `Total`; read as the printed grand total, never as a product |
| 15 | `GST … HSN Detail … CGST 1.14 1.19 1.67 129 SGST … Cess 0 0` | charge (tax breakdown) | `chargeLabel` `GST`; also names tax/HSN columns, so `isTaxTable` claims it — the clustering merged the whole GST block into one row |
| 16 | `Paid Amount:0.00 WrA` | ignored (tender) | `matchesTenderFamily`: a payment row prints money and is not a purchase |
| 17 | `Total 4 Items PeENE` | charge (item count / footer total) | `chargeLabel` `Total` |
| 18 | `Sman :-3` | **ambiguous-preserved** | no label family claims it (`Salesman` is not in 0034's metadata list), no price, no money in a column: a staff line the parser cannot justify discarding |
| 19 | `Sales Type ： DINING` | **ambiguous-preserved** | same: a `Sales Type` line is plausibly metadata, but no shipped family reads it, and guessing at label words is not this stage's job |
| 20 | `Cash Sale` | ignored (tender) | `matchesTenderFamily` |
| 21 | `ocrec re` | **ambiguous-preserved** | below the item region, no price, no money, no label |
| 22 | `e` | **ambiguous-preserved** | same |
| 23 | `Wtnin 2gis` | **ambiguous-preserved** | same — the question this audit asked about this row has the answer "nothing justifies a discard" |
| 24 | `[BUSINESS] [BUSINESS]` | **ambiguous-preserved** | the vendor name line, illegible; below the item region and unreadable, so it is preserved rather than declared understood |
| 25 | `[BUSINESS] [BUSINESS] [BUSINESS]` | **ambiguous-preserved** | same |

**What the audit changed.** The page reported `unclassifiedRows: 0` before it, and that zero was an accident of a
counter. §5's rule 5 asks "is this row above the item region?" through `pricedRowsSeen`, which only rows the
classifier *itself* priced ever advanced. On this page every priced row was reconstructed, so the counter stayed at
zero and rows 18–25 fell into rule 5's discard even though they sit below the items. The classifier now counts a
reconstructed priced row as the item-region row it is, and those seven rows reach rule 7 ("set aside visibly"), which
is what §5 says about a row nobody understood. Two row groups needed their own evidence rather than a position:

- **tender rows** (16, 20) are rule 1's `matchesTenderFamily`, a label, not a position;
- **tax-table rows** are claimed by `taxes.ts`'s own column test (new `isTaxTableDataRow`), not by the table's span —
  a span runs to the next header or to the end of the page, and sweeping the trailing block in with it is exactly how
  an unread row would end up looking understood. Without this, every receipt with a GST breakdown would publish its
  CGST/SGST rows as "review me" while the tax stage was reading them.

Measured effect, dev corpus, all attributed in the pins: `noise_header` 3,599 → 3,590, `ambiguous` 658 → 667,
`preservedRows` 667, `ambiguous_row` findings 667, `totalFindings` 1,701 → 1,710, `receiptsWithPreserved` 165 → 167.
The nine rows are eight SROIE product lines (`ENOKI TEMPURA`, `PANDAN GINGER`, `ROAST CHICKEN RICE`, `TEA`,
`HD40 1L COTIN`, `300PCSLOT100CANDY - ASSORTED`, `100 PLUS [1.50]`, `DISC $.20 X 5 -1.00`) plus one card-reference
line. Accuracy is unchanged: cord-v2 0.473012, sroie 0.647482, items 245/358. The KOT photograph gains the same
treatment: its three trailing marks (`1`, `PNITIVIEC`, `ei2`) are preserved, so its bill also waits for a dismissal.

## Public API compatibility: the removed `inferRateColumn`

`inferRateColumn` was deleted from `geometry.ts` and `core/index.ts`. **This breaks no consumer**, and no
compatibility decision is required:

- it never existed in a commit — `git log -S inferRateColumn -- packages/core/src` is empty, so it lived only inside
  this uncommitted change set;
- `@receipt-lens/core` is `0.0.0` and unpublished (`publishConfig` is public but no release exists); its only
  consumers are `packages/pwa` and `benchmarks`, joined by `workspace:*`;
- neither of them, nor any test, ever imported it (`grep -rn inferRateColumn packages/*/src` returns nothing outside
  this record).

Had it shipped, removing an exported function would be a major bump plus a deprecation cycle. The alternative —
keeping a second, unreferenced "which column is the rate" model alive to protect a phantom consumer — is the kind of
dead code next.md asks not to restore. When the package is first published, the API decision is what it exports at
that moment, not what a working tree carried for two days.

## Privacy: the photographs stay local, the replay is the artifact (DECISIONS/0005)

Two decisions, both now explicit rather than accidental:

1. **`images/` is git-ignored.** The two photographs (Saravana Bhavan, KOT counter) are third-party receipt scans
   and this repository is public, so they never enter it. `playwright/real-receipts.spec.ts` runs against them as a
   **local acceptance gate** and skips with a message when they are absent; the committed, redacted replay below is
   the CI artifact. Before this entry the skip was a side effect of the directory being untracked; the `.gitignore`
   comment says what it is.
2. **`real-ocr-fixtures.ts` is redacted per 0005's classes.** One placeholder per printed word, so token count, boxes,
   ordering and x-extent survive and the replay exercises the same parsing paths:

| class | placeholder | what it was here | count |
|---|---|---|---|
| invoice / receipt number | `[INVOICE_nnn]` | the page's bill number and its two document/serial identifiers | 3 |
| tax / business registration | `[TAX_REG]` | the 15-digit FSSAI-class licence number (`FST NNo …`) | 1 |
| transaction date / time | `[DATE]`, `[TIME]` | one date and one time per photograph | 2 + 2 |
| business identity | `[BUSINESS]` | the illegible vendor-name/address block (2 tokens + 3 tokens) | 5 |

Dates and times are placeholders rather than synthetic values: 0005 rules that a date is *removed*, not re-invented,
and a redacted fixture must never be presented as verbatim output. The consequence is stated rather than hidden —
the replay no longer covers date-value normalisation (the benchmark fixtures do). **Kept verbatim**, because they are
what these fixtures measure (0005's keep list): item descriptions (`offee`, `vada`, `Chappathi Empty`,
`combo 2 chapati/,Po8 Masala`), quantities, rates, line totals, the printed grand total, charge labels (`Total`,
`GST`, `CGST`, `SGST`, `Cess`), and the tax breakdown's HSN code. **Residuals 0005 does not require redacting and
this record does not invent an identity for**: `A R E` (logo fragments beside a redacted identifier), `Sman :-3`
(a staff name with no `CASHIER`/`SALES PERSON` label — 0005's accepted-residual ruling), and the illegible marks
`ocrec re`, `e`, `Wtnin 2gis`, `1`, `PNITIVIEC`, `ei2`. None of them carries a printable identity, and inventing a
placeholder for them would make the audit table above describe text the model never produced.

Re-run after the redaction: ticket 18's privacy assertions and `pnpm scan:egress` — see the handoff entry for the
figures.

## Tests

- `packages/core/src/parse/pairs.test.ts` (19) — one test per arrangement `next.md` §2/§6 name, on hand-authored
  geometry: numbers above and below their descriptions, uneven spacing, a repeated product, a bare number with no
  description, an arithmetic mismatch left intact, the total column proved when it is printed leftmost, a
  four-digit year refused as a quantity, garbled names kept verbatim, currency/reader-tag names refused, metadata
  and charge labels kept out of names, and a header row excluded mid-page.
- `packages/core/src/parse/headerless.test.ts` (7) — the two photographs end to end: names, quantities, prices,
  totals, grand total, the arithmetic ranking, the role provenance, and no row left for review.
- `packages/core/src/parse/table.test.ts` — the split-header case now asserts the three products reconstructed
  without a header while the table stays refused.
- `playwright/real-receipts.spec.ts` (2) — the image-level gate itself: real model, built shell, both photographs,
  including the ₹474/₹75 totals and "no lock blockers". Skips cleanly when the photographs are absent.
- The same file covers the two claims this record makes outside its main line: **the magnitude gate** (`refuses a
  printed identifier that sits in the rate and total bands` — a self-consistent `1 210373.00 210373.00` row that must
  not become a ₹2,10,373 product — and its converse, a real ₹9,000 line on a page of ₹35 ones), and **a single-product
  header-free receipt** (one row cannot make a column, so `roleSource: null`; three aligned rows whose arithmetic
  disagrees report `positional` and publish nothing; `parse()` leaves the bill with no items and the printed numbers
  preserved).
- Enumeration → role evidence, unpaired rows, name guards and the two-record floor are exercised through the
  photograph fixtures; `pairingInternals` is exported for the report's ledger.
