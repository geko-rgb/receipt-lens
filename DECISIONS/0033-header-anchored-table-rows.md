# DECISIONS/0033 — Printed column tables: header-anchored row reconstruction and table-aware tax

Date: 2026-11-08 · Owner-requested bug fix (Phases 1–2 of `next.md`) · **Status: accepted (owner, 2026-11-10),
including the pinned-count moves below.** The approval covers the priced-row-region fix and the audit's pin moves
recorded in `DECISIONS/0035` (`noise_header` −9, `ambiguous` +9 over the dev corpus).
Extends `DECISIONS/0008` P5 (row clustering) and P6 (price column), and `DECISIONS/0010` Q1/Q5/Q7.
Related: `PROJECT(1).md` §5, §7; `DECISIONS/0011` V1/V4, `DECISIONS/0032`.

## The bug, measured

A Saravana Bhavan receipt (720×1280, PP-OCRv6 Small, 2026-09-02) printed its grid like this:

```
Product  Expire  Qty    Rate    Total
Coffee
         2.00    35.00  70.00
Vada
         2.00    25.00  50.00
...
GST Details
HSN      Tax%    CGST    SGST   Cess
996331   2.5     1.67    1.67   0
...
Total            11.29   11.29  0
Total    474.00
```

**No product name shares a printed line with its numbers.** That single fact defeats both row-clustering
rules this repository has:

- §5's y-band (0008 P5) bands words at 0.4 × the weighted median word height. The name line and the numbers
  line are a normal line gap apart — the same gap as between two different products — so joining them would
  merge every consecutive pair of printed lines on the page.
- 0032's anchor rows do the same thing from the other side: an anchor is a *priced* line, and a name-only line
  has no price to anchor to.

Measured on a faithful reproduction of that page (`packages/core/src/parse/table-fixtures.ts`), at the head
before this decision: **0 items, 0 taxes, ₹474 grand total read, 11 rows preserved as `ambiguous`.** The
report's symptom — a `Combo 2 Chapati / P.B. Masala` row reassembled as `combo 2 chapati/,Po8 2.00 Masala
153.00`, `qty_unresolved`, confidence 0.95 — is the same defect seen through the older OCR boxes: the parser
had no column model, so it read description text as numbers and numbers as description.

The GST table was independently unreadable: its rows print **no label at all** (the label is in the header,
four rows above), and its five numbers are not in the item table's `Total` column, so `readCharges` had
neither a label to match nor a price-column entry to choose between. It emitted `unclassified_charge` and no
taxes.

## The decision

Three new stages in `packages/core/src/parse/`, each a pure function of the clustered rows, in this order:
`header.ts` → `rows.ts` → `taxes.ts`. `classifyRows` runs the first two before classification; `readCharges`
consults the third.

### P1 — A header row is named by a vocabulary, with a two-column floor

`HEADER_COLUMN_VOCABULARY` (`patterns.ts`) is 0008 P3 family 1's set widened with the column names retail
receipts actually print (`PRODUCT`, `EXPIRE`, `RATE`, `UNIT`, `MRP`, `HSN`, `CGST`, `SGST`, `EXPIRY`, …). A row
is header-shaped when at least **two** distinct column roles resolve. The floor is what makes the widened
vocabulary safe: a lone `COFFEE` is a one-word row and can never qualify, whatever the vocabulary knows.

The widening is confined to this stage. `matchesHeaderOrNoisePattern` — the predicate 0008 P3 measured — is
**not** changed, so the published corpus numbers for that family remain re-derivable. What the widening buys is
that a real `Product Expire Qty Rate Total` row stops being `ambiguous` and becomes what it is.

### P2 — A second header terminates the first table's span

Every header governs `[its row + 1, next header's row)`. This is what separates the item grid from the GST
grid: without it, the GST breakdown sits inside the item table's span and its rows are read as products.

`isRowShapedTable` additionally refuses a header that names an HSN or a tax column: such a table is the tax
breakdown, and its rows are the charge stage's, never products.

### P3 — Column bands are the header words, capped at 8% of the page

A column's band is its header word's centre with a tolerance of 1.25 × the word's width, floored at 4% of the
page width and **capped at 8%**. The cap is load-bearing: a 240px-wide `U.PRICE` header on one dev receipt
produced a band that covered half the page, and a band that wide reads every stray number as a rate. A value
belongs to the *nearest* band that claims it, so a right-aligned `Total` is never stolen by the `Rate` band
next door.

### P4 — A row that prints money is data, not a header

`readHeaderRow` refuses a row with an amount in the price column. A header may print a currency token (`Rm`,
`Rs.`) but never a price.

### P5 — A name joins the numbers below it, or above it

Within a table's span, a line with no table value that starts **left of the table's first value column** and
carries letters is a *name fragment*. A line whose numbers fill the grid is a *record*; a record takes the
collected name fragments as its name (the printed order), or, when no fragment is waiting, the name-shaped line
directly **below** it (the mirror case). Nothing joins by pixel distance, so a name two lines away cannot be
pulled in, and a footer stamp that happens to start in the name column is excluded by three tests: it is mostly
numeric, it is a printed die (`SR`, `2 X`), or it is labelled/tender-shaped.

The name is the name words plus the record line's *non-value* words. That is what makes `Combo 2 Chapati /
P.B. Masala` keep its `2`: the quantity is the number the `Qty` band claimed, and the `2` inside the
description was never in a band.

### P6 — A record must fill the grid, and its arithmetic is checked

A record is *complete* when it carries a value in every value column its header names. A **partial** row is
a record only when a name is waiting for it — `Coffee` above `2.00 70.00` is a product whose `Rate` the receipt
left blank, and §7 says publish it with the rate unresolved. A partial row with no name waiting (`CASH 85.00`, a
tariff, a subtotal) is not this table's business and leaves the table unconsumed, so the loose pass classifies
it exactly as it did before this stage existed.

Every complete record is then checked: `qty × rate` against the printed total, in integer hundredths, with a
2-paise tolerance. A record that disagrees keeps **all three printed values** and gains a
`row_arithmetic_mismatch` warning. Nothing is repaired: §7 forbids inventing the fourth number.

### P7 — A description may span several lines

Contiguous name fragments are joined in reading order, and the record carries every row it used
(`sourceRowIndexes`, `box`) so the UI can show the evidence.

### P8 — A tender line ends the item table

Once a record has been published, a tender-shaped row (`CASH`, `CHANGE`, …) closes the table: everything below
it is footer, and reading a closing stamp as the name of the tender's figures invents products out of footnotes.

### P9 — Evidence, not defaults

A column the table declared and the row left empty is `null` with its own warning code
(`row_qty_missing`, `row_rate_missing`, `row_total_missing`), never `assumed`. A quantity the row printed in its
`Qty` column is `explicit`. Two different numbers in one column drop that column to unresolved with
`ambiguous_row`, the same condition 0008 P7 rule 2 names.

**A printed quantity that is not a whole number of units is unresolved too.** §10's `Item.qty` is a positive
integer and `ItemUnit` materializes one unit per count, so a `Qty` column printing `0` or `1.5` would publish an
item the bill could never finalize. P9 keeps the printed value in the evidence (`row_qty_not_countable`, whose
message names it) and leaves `qty` unresolved: the receipt said something, and the parser cannot claim it as a
count. Inventing `1` would be worse; dropping the row would be worse still.

### P10 — A GST breakdown is a table, read by column

`HSN`, `SAC`, `CGST`, `SGST`, `IGST`, `CESS`, `UTGST` join the role vocabulary. A header carrying a tax or HSN
column is a tax table; each tax column's band comes from its own header word, and each row's value is read by
position.

A tax column whose total row is `0` (the bug receipt's `Cess`) is read and publishes no charge. It is a real
column printing a real zero, so nothing is invented by leaving it out — and publishing it would ask the creator
to confirm inclusion for ₹0.00, which changes no amount.

### P11 — The total row is the value, never the sum of the rows

The tax table's rows and its total row print the same money twice. The reader takes the **total row's** value
per column: the row labelled `Total`, else a row with an empty label cell filling every tax column, else the
last row that fills every tax column. The table's own rows are then consumed and never re-read by the labelled
charge path, which is what stops ₹22.58 being published for a ₹11.29 tax.

Consumption is limited to rows that print a value under a tax column, so the receipt's `Total 474.00` — printed
under the item table's `Total` — still reaches the charge path as it always did.

### P12 — Inclusion stays open

Nothing here adds a tax to the offset, and the published `ParsedTax` carries no `included` flag. `validate()`'s
inclusion question (0011 V4) is untouched: the creator confirms it in the editor.

## What moved, and what did not

**Accuracy did not move.** SROIE F1 0.6475 and CORD-v2 F1 0.4730 are identical to the previous head, before and
after re-measuring (`benchmarks/results/parser-only-dev.json`). SROIE's gold annotates no items at all, so the
extra items are unscored — this is a UX and correctness fix, not a score claim, and nothing here may be cited
as an accuracy improvement.

Dev row/class/item counts, re-derived from the shipped parser:

| quantity | before | after | cause |
|---|---:|---:|---|
| rows → `item` | 504 | 503 | one SROIE table receipt's product row moves to the table pass |
| rows → `ambiguous` | 834 | 828 | 6 rows of that receipt become one record |
| rows → `noise_header` | 3,824 | 3,831 | 7 rows of that receipt are now table furniture |
| `parse().items` | 518 | 557 | 39 SROIE rows reconstructed from printed tables |
| preserved rows | 820 | 814 | follows `ambiguous` |
| receipts with no items | 42 | 41 | one receipt is no longer empty |
| detected unit prices | 331 | 369 | the 39 new rows carry a printed rate (direct), not a promoted total |
| `qty_unresolved` | 141 | 180 | the new rows print no quantity |
| `criticalFindings` | 106 | 105 | one fewer empty receipt |

Each of those numbers is re-derived by the test that publishes it, with the cause written beside it
(`rowClassification.test.ts`, `quantityMoneyPins.test.ts`, `validationPins.test.ts`, `accuracy.test.ts`). No
threshold was tuned.

## The eval split, measured, and one regression that is not ours

`benchmarks/results/parser-only-eval.json` was **stale before this work**: it was last written at `b5ee3fe`, and
ticket 27's anchor clustering (`e5aec31`) landed after it without re-measuring. So the eval diff a regeneration
produces mixes two changes, and the mix had to be separated before anything could be claimed.

Measured by building `packages/core` at HEAD with this decision's files removed, and again with them:

| eval, cord-v2 | HEAD without 0033 | with 0033 |
|---|---:|---:|
| macro F1 | 0.514907 | **0.514907** |
| predicted items | 300 | **300** |
| every per-field F1 | — | **identical** |

A full field-by-field walk of both artifacts reports **zero differences in `datasets[0]` (cord-v2) on both
splits**. Every eval delta is in `datasets[1]` (SROIE) — item counts, provenance and finding counts, with no
scored field moving, because SROIE's gold annotates items not at all.

The one receipt the owner asked about, `cord-v2/eval/85`, was therefore chased to its actual author. Parsing it
with the core at `e5aec31^` (before ticket 27) and at HEAD:

| `cord-v2/eval/85` | `5d191ef` core | HEAD core |
|---|---:|---:|
| predicted items | 6 | 12 |
| `grandTotal` | 19745000 (scored exact) | 1795000 (scored wrong) |

The receipt prints the quantity on one line, the name on the next and the price below that, with no header, and
a footer block of `Total 197.450` / `14` / `Ttl Makanan 159.500` / `Ttl Minuman 20.000`. Ticket 27's anchor
clustering binds that footer to the last products, so four product rows become ten and the `Total 197.450` line
is consumed into an item instead of being read as the bill's total — leaving `Subtotal 179.500` as the only
total-shaped row for the charge path to take. **That is a 0032 finding, not a 0033 one**, it is on HEAD without
any of this decision's files, and fixing it means changing anchor clustering on receipts that have no header at
all — out of scope here and explicitly left alone.

What this decision does about it: the eval artifact is left at its committed value rather than regenerated, so
`pnpm verify:accuracy` keeps failing until someone decides what to do with ticket 27's regression. Re-pinning it
would have recorded the regression as the baseline and hidden it. The dev artifact *is* regenerated, because its
scored numbers are identical to the committed ones (SROIE 0.6475, CORD-v2 0.4730) and only item counts move.

A related gap, found while measuring: `verify:accuracy` compares a fresh run against a committed artifact, so it
only detects drift when someone remembers to run it — the eval artifact drifted at `e5aec31` for four tickets
without a red build. That is worth a ticket of its own; it is not fixed here.

## Trade-offs

- **39 items whose quantity is unresolved.** SROIE tables print `Description | Qty | Price | Total` but the
  OCR of those receipts does not always put a number in the `Qty` band. P9 publishes them with a warning rather
  than assuming 1. That is more `qty_unresolved` findings on dev, and it is the honest reading.
- **Names keep printed dies** when the die shares a line with the name (`SMOKED DUCK SPAGHETTI 1X SR`). The
  words are the receipt's own and no band claimed them, so removing them would be the parser editing the
  description.
- **The `Expire` column is recognised and unused.** The role vocabulary deliberately has no role for it: it is
  a real column, it is not a quantity, a rate or a total, and pretending otherwise would put expiry dates into
  the arithmetic.
- **A header whose product column is named on a *separate* line is refused** (`Product Expire` / `Qty Rate
  Total`). P3 requires a name cell on the same line as the value columns, so that page builds no table and its
  rows stay preserved — reviewable, never guessed. The bug-report receipt names all five on one line.
- **The anchor path (0032) is untouched.** A page the anchor pass reads correctly is never re-cut by this
  stage: this stage only *reconstructs rows a header describes*, and a two-column page has no such header.

## Reversibility

Reverting `packages/core/src/parse/{header,rows,taxes,classify,index,items,charges,patterns}.ts` and the
`ParseWarningCode` additions in `types.ts` restores the previous behaviour entirely. The pins revert with it;
`DECISIONS/0008`, `0010`, `0011` and `0032` are unchanged documents.
