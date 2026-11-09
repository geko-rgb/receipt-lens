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
