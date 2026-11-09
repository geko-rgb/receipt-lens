# DECISIONS/0034 — Receipt metadata and footer phrases: the two rows that should never block a bill

Date: 2026-11-08 · Owner-requested bug fix (`next.md` issues 1, 4, 6) · **Status: accepted (owner, 2026-11-10),
including the pinned-count moves below and the amendment in the last section.**
Extends `DECISIONS/0008` P7 (row classification) and `DECISIONS/0033` (header-anchored table rows).
Related: `PROJECT(1).md` §5, §7; `DECISIONS/0010` Q1/Q6, `DECISIONS/0011` V1/V4.

## The bug, measured

A restaurant KOT receipt printed its bill block at the right margin:

```
Bill No: 210373
Date: 05-10-26
Time: 12:01:58
```

and the review screen sold it:

```
BillNo   qty 1
₹2,10,373.00 each
₹2,10,373.00
detected · assumed   confidence 0.98   qty_assumed
```

Three separate failures, one cause each:

1. **`Bill No: 210373` is a row with a number on it.** 0008 P7's families cover charges, tenders, column
   headings and identifiers; none of them names a *field*, so the row fell through to `item` — and
   `210373` sat in the price column, which is all the item stage needs. Every metadata line on every receipt
   did the same: `Date:`, `Time:`, `KOT No`, `GSTIN`, `Cashier`, `Waiter`.
2. **The footer was preserved, not read.** `THANK YOU VISIT AGAIN` is not a charge and has no number, so it
   was kept as `ambiguous` and appeared in the review list as a row the owner had to tick *Exclude* before the
   bill could lock (issue 4's complaint, verbatim).
3. **`Amount` was not a total.** `Particulars | Qty | Rate | Amount` was rejected as a table because `AMOUNT`
   mapped to the `rate` role, which leaves the table with no line-total column (`0033`'s `isRowShapedTable`).
   That is issue 2's root cause on the reference-quality fixture: the parser had the header and refused it.

## P1 — a row is metadata when a field label *opens* it

`parse/patterns.ts` gains a family (`readMetadata` / `isMetadataRow`) with a `MetadataField` union: `bill_number`,
`invoice_number`, `order_number`, `date`, `time`, `table`, `kot`, `gstin`, `phone`, `cashier`, `waiter`.
The rule is positional, not keyword-based:

- the label must be the row's **first** words (so `Pineapple lime` is safe, and so is a product line that
  merely contains `Date pudding`);
- a single-word label needs either a separator (`Bill No: …`, `KOT/…`) or a tail that is *only* numbers,
  dates and times (`KOT 12`, `Time 12 01 58`);
- labels whose value is always alphabetic (`Cashier`, `Waiter`, `GSTIN`, `Table`) may take a word value,
  because `Cashier: RAJU` prints nothing else;
- matching is token-based, so a provider that prints `Table No : A 4` and one that prints `Table`, `No`, `A 4`
  on three words both read;
- `GSTIN`/`GST IN`/`GST Nos` and `Bill No`/`Bill Number`/`Invoice No` are one field each — the union is about
  meaning, not spelling.

Guards are tests, not prose (`metadata.test.ts`, `kot.test.ts`): `Table water`, `Date pudding`,
`Combo 2 Chapati`, `Pineapple lime`, `7 Up 500ml` and `Combo 2 Chapati / P.B. Masala` all stay products. A
product may contain "No" and numbers; the label has to open the row.

Classified rows carry the field (`metadataField`) so the evidence is inspectable and the review UI can group
by it later. A metadata row is *not* an item candidate, *not* preserved for review, and *not* a lock blocker.

## P2 — a footer phrase is ignored when it prints no money

`footerPhraseIn` / `isFooterInstructionRow`: no digit, at most ten words, and a phrase from a small vocabulary
(`thank you`, `visit again`, `welcome`, `please`, `no refund`, `powered by`, `have a nice day`, …). A footer
**with** money (`THANK YOU 25.00`) is not ignored — it is preserved as `ambiguous` with its text and lines,
because that is a row the receipt printed an amount on.

Ignored rows keep `ignoredReason`, so nothing is discarded without a reason on the row.

## P3 — `Amount` is the line total, and header rows are never ambiguous

`parse/header.ts` H1: `AMOUNT`/`AMT` → role `total`, with `AMT` added to the structural vocabulary in
`patterns.ts`. `Qty | Rate | Amount` is now a row-shaped table. `classify.ts` also stops asking the header stage's
own header rows to defend themselves: a row the table pass identified as a header is `noise_header`, never
`ambiguous`, so `Particulars Qty Rate Amount` cannot block a lock.

## P4 — an inline record never borrows the name below it

`rows.ts` H3: the mirror case (numbers above their name) now requires that the value row printed **no** name
word of its own. Before, a row that already had a name (`combo 2 chapati … 153.00`) could take the *next*
line's text as part of its name — the inverse of the reported bug and a source of wrong names.

## P5 — what blocks a bill (issue 4)

Unchanged in the lock module, changed in what reaches it: metadata and ignored rows are not in
`unclassifiedRows`, so they cannot appear in `unclassified_rows_unreviewed`. Every existing blocker stands —
`grand_total_missing`, `payer_missing`, unassigned units, draft items, unresolved charges, and a genuinely
unreadable row kept for review. `packages/pwa/tests/bill/receipt-lock.test.ts` drives the real parser through
the real `validate()`/`beginFrom()` for both directions.

## Measurement — dev (the tuning split, 250 receipts)

Row classes before → after (`rowClassification.test.ts` re-derives this table, `quantityMoneyPins.test.ts`
re-derives the family-off base):

| class | 0033 shipped | now | why |
|---|---:|---:|---|
| item | 503 | 462 | −41 metadata rows that were products |
| continuation | 37 | 31 | −6 |
| noise_header | 3,831 | 3,599 | −232 |
| ambiguous | 828 | 672 | −156 |
| metadata | — | 336 | new |
| ignored | — | 99 | new |

The movement is **435 rows and nothing else**: 336 + 99 = 435 = 41 + 6 + 232 + 156. Row conservation still
holds (5,199 rows across all six classes), and every one of the 435 is individually attributable to
`isMetadataRow` or `isFooterInstructionRow` — the pins in `rowClassification.test.ts` say so in the same
breath as the counts.

Consequences the pins now publish: preserved review rows 814 → 658 (7 receipts stop having any), the
`ambiguous_row` finding 814 → 658, `taxOnly` noise rows 836 → 745, charge-labelled rows 1,374 → 1,283,
`registration` rows 108 → 58, name-length 1σ outliers 74 → 82 with the longest eligible name falling 62 → 58
(the long outliers *were* the metadata lines). `mixed` (tax ∧ aggregate) is untouched at 207, which is what
says the precedence rule's own population did not move.

## Measurement — accuracy does not move

Dev, every scored field byte-identical before and after (`benchmarks/results/parser-only-dev.json`):
cord-v2 macro F1 0.473012, sroie 0.647482, CORD items 245. The item count moves 557 → 603 because 46 more
SROIE rows are read from a table whose line-total column is headed `AMOUNT`, and SROIE gold annotates **no**
items — those 46 are unscored, exactly as 0033's 39 were. `detected` 369 → 428 and `direct` 140 → 205 for the
same rows; `derivative` 229 → 223 where the assumed-qty rescue is no longer needed.

Eval is **not** re-pinned. Its committed artifact was already stale at HEAD (0033 records ticket 27's
`cord-v2/eval/85` regression and leaves `verify:accuracy` red as the honest signal). A fresh eval run with
this work reproduces 0033's documented fresh-HEAD cord-v2 figure exactly (macro F1 0.514907, 300 items) and
moves only SROIE item count 708 → 837 — unscored, because SROIE gold has no item annotations. So this work
adds no scored eval movement on top of the ticket-27 question, and the artifact stays as it was.

## What this does **not** fix (measured, not omitted)

The real image in `images/` (Receipt A, 720×1280, PP-OCRv6 Small, through the built shell in Chromium) now
yields: grand total ₹474.00, GST unresolved, **one** item — `combo 2 chapati/,Po8 2.00 Masala 153.00`, total
₹306.00, `qty_unresolved` — and **12** preserved rows. Diagnostic: `pnpm build`, serve `packages/pwa/dist/app`
with `/assets/models/`, upload the JPEG, read the review panel. The cause is **OCR plus a missing stage**, not
this decision's rows:

- the OCR reading of that page has no recognisable `Particulars Qty Rate Amount` line at all, so `header.ts`
  has no table to anchor on and `rows.ts` never runs;
- names and numbers arrive on **separate rows, numbers first** (`2.00 35.00 70.00`, then `vada`), so
  header-free name/value pairing is the missing stage — a real gap, with this run's OCR output as its fixture.
- parts of the text are genuinely OCR-garbled (`Po8` for `P.B`, `Wtnin 2gis`, `saraerana ron se`,
  `ocrec re`). Those rows are not confidently decorative and stay visible for review rather than being
  discarded, which is issue 4's Category D by design.

Receipt B (the KOT page the metadata bug came from) exists only as `kot-fixtures.ts`, derived from the owner's
report — no image of it is in this repository, so no image-level claim is made for it.

## Pins moved (all re-derived from the shipped code, none hand-edited to pass)

`benchmarks/src/parser/rowClassification.test.ts` (row classes, preserved rows), `quantityMoneyPins.test.ts`
(base-head classes, tender-family transitions 92 → 90, read states, tax/charge censuses, base items 712 → 671,
items 557 → 603, provenance states), `validationPins.test.ts` (operand presence, item-sum directions,
unresolved-price split, price provenance, no-line-total list, name-length outliers, emission census,
money-gate population), `scoring/accuracy.test.ts` (provenance totals, item count, critical census).
`packages/core/src/parse/classify.test.ts` and `determinism.test.ts` gained the two new classes (conserved but
unpublished).

Verified green: core 289 / pwa 460 / benchmarks 310, `pnpm typecheck` clean, `pnpm build` clean,
`verify:results` matches, `scan:egress` 0 violations. Playwright was run for the real-image probe described
above and not re-run in full (no app-surface change).

## Amendment 2026-11-10 — the two families the audit left behind (owner decision)

The disposition audit in `DECISIONS/0035` kept five Saravana rows in review and named two of them as families this
record deliberately did not cover: `Sman :-3` (a staff line) and `Sales Type ： DINING` (the receipt's own order type).
The owner's decision was to add both, and it changes what the parser understands, not what it extracts.

| Row | Family added | Why it is safe | What changes |
| --- | --- | --- | --- |
| `Sman :-3` | `waiter` — narrow labels `Sman`, `Salesman`, `Captain` (no `alphaValue`), alongside the existing `Waiter`, `Steward` | The label needs a separator or a value that carries no letters, exactly like `Table`; the printed `:-3` is the **value**, never part of the label match. `Sman special 180.00`, `Salesman combo 220.00` and `Captain Fries 200.00` stay products. | Saravana preserved rows 7 → 5. |
| `Sales Type ： DINING` | `sales_type` — two-word labels `Sales Type`, `Sale Type` | A two-word label is evidence on its own, like `Bill No`; the full-width colon OCR returns is part of the value, as with every other family. | Same row leaves review. |

`Steward` was **not** narrowed. It already carries `alphaValue` (`Steward Ramesh` is staff, exactly like `Cashier:
Ramesh`), and narrowing one pre-existing family while leaving `Cashier`/`Waiter` alone would be an inconsistency
dressed as a fix. The three new words are narrow because they are new: nothing in the corpus depends on them, so the
strict rule costs nothing and protects product names. This is the judgment the owner invited ("if the evidence is too
thin, keep it preserved") applied in the direction the evidence supported.

Tests: `packages/core/src/parse/metadata.test.ts` gains one family test asserting both readings, the narrow refusals,
and `Steward Ramesh`. `headerless.test.ts` and `playwright/real-receipts.spec.ts` move 7 → 5 with the cause written at
the assertion. **No benchmark pin moved** — no dev-corpus row opens with these labels, so dev accuracy and both
`parser-only-dev.json` figures are byte-identical.
