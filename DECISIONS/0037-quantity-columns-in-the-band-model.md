# DECISIONS/0037 — Quantity columns enter the value-band model, gated by §5's own test

Date: 2026-11-10 · Ticket 25 (filed in `DECISIONS/0036`'s appendix, diagnosed in `c43b6d2`) ·
**Status: decided — implemented, pins re-derived with written causes, published figures re-measured.**
Relates to `DECISIONS/0035` (header-free pairing's band model), `DECISIONS/0036` (eval re-measurement),
`DECISIONS/0010` Q1/Q6 (§5's quantity column), `DECISIONS/0011` (the published dev census),
`DECISIONS/0014` (the published accuracy table).

## The defect, measured

`inferValueColumns` (`parse/geometry.ts`) is the one band model the parser has: it collects the right edges of a
row's **amount-shaped** words, clusters them within 5% of image width, and returns the bands with at least three
members. `IS_AMOUNT_SHAPED("1")` is false, so a page that prints its count column as bare integers contributed **no
point at all** for that column. Two consequences followed, and both were measured on committed fixtures:

- `harness/out/image1.ocr.json` (the Saravana Bhavan page's own OCR) formed bands `893×14`, `768×6`, `742×4` and
  never saw the `612` column, so `inferPairingRoles` could not evidence `qty × rate == total` anywhere and scored
  **0** on every permutation — the page published nothing from pairing even though its arithmetic is perfect.
- `cord-v2/eval/85` printed the same shape of count column, and its rows still could not be evidenced.

`DECISIONS/0035` Amendment E already names "integer quantities 0–999" as candidates; the stage simply never
collected them. That is the defect ticket 25 records.

## The decision

1. **Admit bare-integer candidates to the band model, and only when the page prints a quantity column.** A new
   predicate `isQuantityShaped(text)` (`/^\d{1,3}$/`) says what a *candidate* is; it does not decide what a band is.
2. **The gate is §5's existing test, reused rather than re-derived.** `inferValueColumns(rows, width, limit,
   admitQuantities)` takes a boolean the caller supplies, and `pairs.ts` supplies
   `pagePrintsQuantityColumn(rows, width)` — which is exactly `detectQuantityColumn(bands, width, priceColumn) !==
   null`, the function `classify.ts` already uses to decide whether a page has a quantity column at all
   (`≥ QUANTITY_BAND_MIN_ROWS = 5` rows, `≥ QUANTITY_QUALIFY_SHARE = 0.6` of them `≤ QUANTITY_MAX_VALUE = 20`).
   One implementation, one answer, both stages. A page with no such column gets the bands it always got.
3. **A printed `0` is never a quantity.** `quantityOf` accepted `0`; with bare integers admitted, published items
   started carrying `qty 0`, which §4 declares out of range — five new **critical** `invalid_result_schema` findings
   appeared on eval SROIE. `quantityOf` now requires `1 ≤ qty ≤ 999`. The row keeps the two printed numbers it does
   have and loses only the count, which is what the page prints.
4. **Nothing else in the stage moved.** Roles are still earned by arithmetic majority in integer paise, `≥2` paired
   rows are still required before publishing, `roleSource` is still `arithmetic | positional | null`, and a page
   whose rows print one amount each still publishes nothing (Amendment A/C unchanged).

## Acceptance, re-measured with `benchmarks/scripts/diagnose-row-layouts.mjs`

`--a benchmarks/fixtures/eval/cord-v2/085.json --b harness/out/image1.ocr.json`:

| page | bands (amount-only → with counts) | roles | score | published |
| --- | --- | --- | --- | --- |
| `0032/image1` (Saravana) | `893×14, 768×6, 742×4` → **`893×14, 768×6, 743×5, 612×9`** | `qty@612`, `rate@743`, `total@893` | **9** | `roleSource arithmetic` |
| `cord-v2/eval/85` | `1599×5, 1560×9, 1518×3` → `+742×11` | `qty@742, rate@1560, total@1599` | **0** | `roleSource positional`, **0 records** |

The discriminator is the one `DECISIONS/0036`'s appendix measured and this ticket was told to preserve: **0 of 17**
amount lines on `eval/85` carry two amounts (the page prints quantity + amount and nothing else, so `qty × rate ==
total` is unsatisfiable), against **8 of 16** on the Saravana page. Adding the count column does not create
arithmetic where the page never printed a rate. `DECISIONS/0036`'s accept disposition therefore stands unchanged:
eval cord-v2 macro F1 is still **0.514907** and `eval/85` still publishes no record from pairing.

## Movement, attributed pin by pin

Four SROIE dev receipts change, and they change because their count column now qualifies. Every moved number below
is measured against `c43b6d2`.

| receipt | what the page prints | before | after |
| --- | --- | --- | --- |
| `sroie/dev/34` | `SR: …` product lines, `1 / 2 / 5 / 10` in a count column, `RSP` and `AMOUNT` columns | 4 items (all of them totals rows: `[ACCOUNT] 25.00`, `TOT QTY: 28`, …) | **13 items** (9 real products, the same 4 totals rows) |
| `sroie/dev/8` | same shape | 3 items (totals rows only) | **7 items** (4 real products) |
| `sroie/dev/4` | product name and an item code on one line | 5 items, two of them named `079567600084 11.23 KLEENSO …` / `9090822 4.50` | 5 items, the same two now read as `WD40 27ML …` / `HANDKERCHIEF 71386#…` |
| `sroie/dev/86` | same shape | 4 items, three named `<code> <amount> <product>` | 4 items, the same three with the code prefix gone |

Corpus-wide deltas, all of them on those four receipts:

| measure | before | after | cause |
| --- | ---: | ---: | --- |
| dev items (`parse()`, both datasets) | 603 | **616** | 13 SROIE products pairing can now read |
| dev `priceSource detected` / `direct` | 428 / 205 | **441 / 218** | the same 13 print a price on the row; `derivative` unmoved at 223 |
| dev `quantitySource explicit` | 200 | **213** | the same 13 print their count in the table's own column |
| dev class census `item` | 462 | **457** | code-prefix fragments on `dev/{4,86}` are no longer products (`noise_header` +39, `continuation` −3, `ambiguous` −31) |
| dev preserved rows (`ambiguous_row`) | 667 | **636** | the 31 rows pairing now reads on those receipts |
| dev findings total | 1,710 | **1,679** | those 31 `ambiguous_row` findings go with the rows |
| dev `totalFindings` table `ambiguous_row` | 667 | **636** | as above; no other code moves |
| dev `sameValueUnderExplicitOrUserQty` | 145 | **152** | seven more items reach the explicit-quantity side of the rescue split |
| dev `receiptsWithAtLeast5Items` / `1σ` outliers | 33 / 82 | **35 / 91** | two receipts now have ≥5 items; 2σ and 3σ unmoved at 7 / 0 |
| **dev accuracy (cord-v2, sroie)** | 0.473012 / 0.647482 | **0.473012 / 0.647482** | CORD is byte-identical (`0 changed receipts`); SROIE gold annotates no items |
| eval cord-v2 | 0.514907, 300 items, 648 findings / 54 critical | **identical** | no eval CORD receipt is affected |
| eval sroie (item census only) | 837 items, 2,801 findings / 131 critical | **852 items, 2,718 findings / 131 critical** | 15 items read, `price_not_resolved` 224 → 138; **criticals unchanged**, and no new `invalid_result_schema` |

Two honest notes on that table. First, `dev/8` and `dev/34` gained real products **while keeping the totals rows they
already published as items** (`[ACCOUNT] …`, `TOT QTY: …`, `SR 6 …`): those rows were items at `c43b6d2` too, so the
change did not introduce them, and removing them is a separate classification question, not this band model's.
Second, the eval SROIE item count differs from the pre-change artifact by more than the dev count because eval prints
more of these receipts (852 vs 837); the critical count is unchanged, which is the number that gates locking.

## Rejected alternatives

- **Admit every bare integer unconditionally.** Measured: it makes counts, item codes and the `2` of `2x` into band
  members on pages that print no count column. `detectQuantityColumn` exists precisely to answer "is there a count
  column here", and `classify.ts` already gates on it.
- **Re-derive a local quantity test inside `geometry.ts`.** That would make two answers to one question drift apart;
  §5's test is reused through a caller-supplied boolean instead.
- **Make `inferValueColumns` call `detectQuantityColumn` itself.** `quantity.ts` imports `geometry.ts`, so this would
  invert the dependency (or duplicate the test). The caller that owns the page-level decision passes it down.
- **Publish a `0` and let the finding carry it.** §4 forbids it and it costs a critical per row; a row that prints no
  count simply publishes without one.

## What this does not do

- It does not repair `cord-v2/eval/85` (ticket 24). That page prints no rate column, so no band admission can make
  its arithmetic check out; `DECISIONS/0036`'s accept disposition and ticket 24's outcome-2 diagnosis both stand.
- It does not change any role-assignment, pairing, or classification rule, and it adds no new mechanism beside
  `inferValueColumns` — one band model, one quantity test, one magnitude gate.
- It does not touch OCR preprocessing, the review UI (ticket 23), or the totals rows the SROIE fixtures still publish.

## Tests

- `parse/geometry.test.ts` — `isQuantityShaped` accepts `1`/`999` and refuses `0.00`, `1,999`, `2026`, `2x`; the count
  column is absent from the bands unless the caller admits it, present when it does, and still needs
  `ANCHOR_MIN_COLUMN_MEMBERS` when a page merely prints a `1` here and a `2` there.
- `parse/pairs.test.ts` — a six-row page printing `1/2/3` counts proves the roles arithmetically and publishes every
  record; through `parse()` the same page publishes `explicit` quantities and no `invalid_result_schema` finding; a
  printed `0` is never published as a quantity (the row keeps its rate and total); a column of item codes (`101…106`)
  is not a quantity column and yields no quantity.
- Re-derived pins: `quantityMoneyPins` (read states, base-head class totals, item/pair counts, provenance),
  `rowClassification` (class census, preserved rows), `validationPins` (item count, price provenance, name-length
  eligibility, emission census), `scoring/accuracy` (provenance split, item totals, the committed dev artifact).
