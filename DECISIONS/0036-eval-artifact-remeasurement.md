# DECISIONS/0036 — The stale eval artifact: one receipt, accepted, and re-measured with its cause

Date: 2026-11-10 · Ticket 27 follow-up (the `parser-only-eval.json` gap recorded in `HANDOFF` 2026-11-08) ·
**Status: decided — accept the regression, re-pin the eval artifact, file the repair as its own ticket.**
Relates to `DECISIONS/0032` (anchor row clustering), `DECISIONS/0033`/`0034` (row classes), `DECISIONS/0004`
(dev/eval protocol), `DECISIONS/0014` (the published accuracy table).

## What was red, and why

`pnpm verify:accuracy` compares `benchmarks/results/parser-only-{dev,eval}.json` byte for byte against a fresh run of
the shipped `parse()` over the committed fixtures. Dev matched; **eval did not** — because the eval artifact was last
written at `b5ee3fe`, and ticket 27's anchor clustering (`e5aec31`, `DECISIONS/0032`) never re-measured it. The stale
file therefore published a number the shipped code no longer produces. Nothing about the dev split was involved.

Run at HEAD (`48f913e`, this work included):

| split | committed artifact | fresh run at HEAD |
| --- | --- | --- |
| cord-v2 · eval | macro F1 **0.522858**, 294 predicted items, 55 criticals | macro F1 **0.514907**, 300 predicted items, 54 criticals |
| sroie · eval | macro F1 **0.661631** | macro F1 **0.661631** (identical), item census moves only |

The fresh figures reproduce the number the 2026-11-08 handoff recorded (`0.514907`, 300 items), so the measurement is
stable and the artifact was simply behind.

## The diagnosis: exactly one receipt moved, and it is not the parser guessing

A receipt-by-receipt diff of the two artifacts (all 100 cord-v2 and 361 sroie records compared field by field) finds
**one** changed receipt:

```
cord-v2/eval/85   predictedItems 6 -> 12   grandTotal exact -> wrong   criticals 1 -> 0
```

Every other cord-v2 record is byte-identical. SROIE's 56 changed records change only `predictedItems`; SROIE scores
`grandTotal` alone, and no `grandTotal` moved, which is why its macro F1 is unchanged.

That receipt prints a **quantity column** (bare `1`/`2`/`3` at x ≈ 700) and a right-aligned amount column
(x ≈ 1525–1600), so `DECISIONS/0032`'s gate fires: anchor clustering on the amount lines. Its rows are laid out
one printed record per two lines, with the amount **below** its name:

```
1046  703    3            <- qty
1048  775  Nasi Putih     <- name      (38 px above its amount)
1086 1364  30.000         <- amount
```

`clusterRowsByAnchor`'s reach is deliberately asymmetric — `ANCHOR_UP_REACH_RATIO` 0.25 up, `0.7` down — because on
the receipt 0032 was built for, names print *below* their amounts. The premise is false on this page, so each anchor
claims the **next** record's name and quantity (18 px below it, inside the down-reach) while its own name sits 38 px
above, outside the up-reach. The shift is systematic: `1 Nasi Tambah 30.000`, `2 Ayam Pop 7.000`, and at the totals
block `Total 17.950` — the `Total` label bound to the *tax* row's amount, while the real `197.450` was left as its own
unpaired line. The grand total then resolved from the subtotal row (`179.500`), which is the `exact → wrong` flip.

The trigger itself is also weak on this page: it fires because two *band* rows chained three printed records each
(`"1 1 1 Telur Kerupuk Ikan Bawal Dadar Kuah Besa 28.500 15.000 18.000"`), so the 24.8 px tolerance demonstrably
failed — but the anchor path then fails on eight rows instead of two.

## The counterfactual, measured

Forcing the band path for this page (`clusterRows(..., anchorEligible = false)`, throwaway build, no commit) restores
the committed numbers exactly: cord-v2 macro F1 0.522858, 300 → 294 predicted items, `cord-v2/eval/85` back to 6 items
and `grandTotal exact`, and **every cord-v2 receiptRecord identical to the committed artifact**. So the regression is
entirely owned by the anchor path on this one page, and reverting that gate would close the number.

## Why it is accepted rather than guarded away

A guard that falls back to the band path *only* on pages shaped like this is the obvious next idea, and four candidate
premise checks were measured. None separates the two pages:

| Candidate guard | cord-v2/eval/85 | 0032's receipt | Verdict |
| --- | --- | --- | --- |
| labels nearer *above* than below each anchor | fires the wrong way — the *next* row's name is 18 px below, nearer than its own 38 px above | same failure | no |
| a quantity word inside every anchor's band | passes (the next row's qty lands in the band) | passes | no |
| every anchor band holds a name-like word | passes | passes | no |
| band failure localised to one row | fails (two rows chained) | fails | no |

Every remaining discriminator I could construct asks the *classification* question ("which words are this row's
name"), not the geometry question, and answering it here is exactly what `DECISIONS/0035`'s pairing stage does — after
rows exist. Doing it inside clustering would be a new parser feature whose acceptance criterion, measured honestly,
is "it recovers 0.008 macro F1 on the eval split", which is tuning to the test set.

The honest repair is a row model for **records whose amount prints below their name** (multi-line rows), which is a
stage of its own: filed as ticket **24** with this receipt as its fixture and the counterfactual above as its target.

## The decision

1. **Accept** the cord-v2 eval regression as a documented consequence of `DECISIONS/0032`, not as a new baseline.
2. **Re-pin** `benchmarks/results/parser-only-eval.json` to HEAD's behaviour, with this record as its written cause —
   the rule is "no pin moves without a written cause", not "no pin may ever move". Publishing a number the code does
   not produce is the worse dishonesty: it is the artifact, not the parser, that was wrong.
3. **Publish the movement**, not just the new file: `packages/core/README.md`'s accuracy table is regenerated from the
   artifacts, so eval cord-v2 shows **0.515** (was 0.523), `grandTotal` 62/91 correct (was 63), `taxTotal` 17/40 (was
   18), and the item fields move correspondingly. Nothing is rounded away or suppressed.
4. **Nothing else is claimed.** Dev cord-v2 0.473012 / sroie 0.647482 are unchanged; dev pins do not move; the two
   real photographs (4 products ₹474.00, 1 line ₹75.00) are untouched; no test is weakened and no fixture edited.
5. **Ticket 27's scope ends here.** The isolation the owner asked for is kept: this commit touches only the eval
   artifact, its dated archive, the rendered table and this record.

## What is left open (deliberately)

- **Ticket 24** — multi-line records (amount below its name), gated the way `0032` gates its own path, with
  `cord-v2/eval/85` as the fixture. Its definition of done is the counterfactual: cord-v2/eval/85 back to 6 items with
  `grandTotal exact` **without** weakening the 0032 receipt (10 items) or any dev pin.
- The eval split remains a *stress* split, out-of-language for cord-v2 (`DECISIONS/0004`/`ADR-010`): the English
  headline claim is SROIE, whose F1 is unchanged to six decimal places.

## Appendix — the ticket-24 attempt (2026-11-10): no generalizable repair, acceptance stands

Ticket 24 asked for the real repair. The diagnosis below is the whole of it, reproducible with
`node benchmarks/scripts/diagnose-row-layouts.mjs --a benchmarks/fixtures/eval/cord-v2/085.json --b
harness/out/image1.ocr.json`. **Conclusion: there is still no generalizable fix, so this record's disposition stands and
no production code changed.**

### The trace, both pages, one script

| | `cord-v2/eval/85` (the regression) | `harness/out/image1.ocr.json` (0032's page) |
| --- | --- | --- |
| band tolerance | 24.80 px | 21.86 px |
| price column | 1599 ±89, `fallback: false` | 893 ±60, `fallback: false` |
| quantity column | detected, anchor 708, 9 rows, share 1 | detected, anchor 592, 7 rows, share 1 |
| value bands (`inferValueColumns`) | `1599×5, 1560×9, 1518×3` — all three are **right-edge jitter of the one amount column** | `893×14, 768×6, 742×4` — amount plus two rate sub-bands |
| anchor lines (amount lines) | 17 | 16 |
| band rows → anchor rows | 14 → 20 | 22 → 21 |
| pairing role source | `positional` | `positional` |
| pairing records published | **0** | **0** |
| shipped `parse()` | 12 items, `grandTotal: null` | 10 items, `grandTotal: null` |

Band rows vs anchor rows on `eval/85` — the divergence in one table. The band path is *nearly* right (11 of 14 rows are
one printed record) but chains three records twice; the anchor path re-cuts the whole page and shifts every record by
one line:

```
band   [ 0] y=1046 "3 Nasi Putih"                       anchor [ 0] y=1046 "3 Nasi Putih"
band   [ 1] y=1086 "1 Nasi Tambah 30.000"               anchor [ 1] y=1086 "1 Nasi Tambah 30.000"      <- 30.000 is Nasi Putih's
band   [ 5] y=1354 "1 1 1 Telur Kerupuk Ikan Bawal ..."  anchor [ 5] y=1305 "Cb"
                                                        anchor [13] y=1727 "Subtotal"                   <- lost its 179.500
                                                        anchor [14] y=1747 "Pajak Rest. 10% 179.500"
                                                        anchor [15] y=1802 "Total 17.950"               <- Subtotal's/Pajak's money
```

The last two lines are the mechanism of `grandTotal exact → wrong`: `Total` is bound to the *tax* row's amount, so total
resolution falls back to the subtotal.

### Why the pairing stage cannot be the route (first move's answer: **No**)

`inferPairingRoles` scores every assignment it can make and returns `positional` with the ledger
`rate@1560+total@1599 → 0`, `qty@1518+rate@1560+total@1599 → 0` on `eval/85`: the page prints **qty and amount only**
(one amount-shaped word per record, 0 of 17 amount lines carries two), so no row can ever satisfy `qty × rate = total`
and Amendment C forbids publishing without arithmetic proof. Routing `eval/85` to pairing therefore publishes *nothing* —
it is not a fallback that exists.

The same trace found a **real defect in the band model** (not the anchor path): `inferValueColumns` counts only
amount-shaped words, and `isAmountShaped("1") === false`, so a page whose quantity column is printed as bare integers
has no quantity band at all. On 0032's page the roles are therefore `qty@742` (a rate sub-band), score **0**, and
pairing publishes nothing *even though its rows are correct*. Adding bare integers 0–999 as band candidates — the
candidates Amendment E already names — makes that page prove `qty@612 × rate@743 = total@893` with **score 9**
(`arithmetic`), while `eval/85` stays at score 0. That is a genuine improvement, but it is not this regression's fix and
it changes a verified page's route, so it is filed as ticket 25 rather than smuggled in here.

### The candidate rules, measured and refused

Each was tested against both pages before any code was written; the acceptance bar was "separates these two pages
cleanly", and none does:

| Candidate gate on the anchor path | `eval/85` | 0032's page | Verdict |
| --- | --- | --- | --- |
| nearest description is *above* its amount (the inverted premise) | 9 of 17 | 7 of 16 | no |
| a quantity word inside each anchor's band | passes (the *next* row's qty lands there) | passes | no |
| a quantity word within half the amount's height of the amount's line | 12 of 17 | 13 of 16 | no |
| every amount line carries ≥2 amounts (a printed rate) — majority rule | 0.00 | 0.50 | no: refuses 0032 too |
| most *priced rows* carry ≥2 amounts (a printed rate) | 0.17 | 0.80 | **yes, but it separates for the wrong reason**: the two `eval/85` rows that look like "rate + amount" are chained OCR boxes, so the rule would be right by accident and would also disable the anchor path on any real three-column receipt whose rate column OCR dropped. Refused as tuned-to-the-split. |

Two further candidates were recorded in the main body (band-failure localisation, and a "which grouping scores better"
beauty contest); both are refusals for the same reason.

### What the repair actually needs

`eval/85`'s records are **two printed lines each**: `qty + name`, then the amount ~38 px below, and the *next* record's
`qty + name` sits 18 px below that amount, inside any reach a geometry rule can use. No clustering rule can separate
"this amount belongs to the line above it" from "that name belongs to the line above it" without a record model that
spans two lines — which is what ticket 24 is, and why it stays open with this trace as its evidence.

## Closure of ticket 24 (2026-11-10)

Ticket 24 is **closed as outcome 2 — no generalizable fix**, and this record's accept disposition is the standing
answer for `cord-v2/eval/85`. `DECISIONS/0037`'s quantity-column work does not change that: the page prints no rate, so
`qty × rate == total` is unsatisfiable there and pairing still publishes nothing (`score 0`, `roleSource positional`).
The eval cord-v2 macro F1 therefore stays at **0.514907** with this ticket's artifact, and any future repair has to
start from the record model described in the appendix above — not from a band or clustering guard.
