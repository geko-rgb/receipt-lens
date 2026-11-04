# DECISIONS/0014 — Accuracy modes: which number is the headline, what each mode can prove

Date: 2026-11-04 · Ticket 09b.

`PROJECT(1).md` §8 requires two measurements and one rule about how they are published:

> **Parser-only:** feed normalized/reference OCR text and boxes to `parse()` to isolate parsing errors.
> **End-to-end:** run OCR on receipt images, then parse, to include OCR errors. Report separately;
> **README headline must say which number it uses.**

The spec names both modes and demands a headline choice but never makes it, and the two modes answer
different questions about different products. This record makes the choice, pins the metric
configuration every published number has to travel with, and states what each mode cannot show. It is
the accuracy-side counterpart of `DECISIONS/0012`, which did the same job for the footprint.

---

## M1 — The headline is parser-only. End-to-end is published beside it, never blended.

**Headline: parser-only, `cached-reference-ocr-node`** — the shipped `parse()` fed the committed
reference-OCR fixtures in Node. **Secondary: end-to-end, `pp-ocrv6-browser`** — real OCR over the
dataset receipt images in headless Chromium, then the same `parse()`.

Parser-only is the headline for three reasons, in the order that mattered:

1. **It isolates the thing this project builds.** The product claim in §1 is an honest *parser and
   splitter*, and ADR-002 makes the OCR tier swappable — so OCR error is a variable the product can
   change without touching `parse()`. A number that mixes the two cannot be read as a statement about
   the parser, and cannot be compared across tiers. End-to-end is what the *user* gets, so it is
   published, but it is not the claim.
2. **It is the only mode that is reproducible where the code is reviewed.** Parser-only runs from
   committed fixtures on any clone, no dataset download, no browser, no GPU, no model file — which is
   what makes it a per-push CI gate. End-to-end needs the 2.7 GB raw snapshot and Chromium, so it is a
   local measurement whose *result* is committed, exactly like ticket 08's footprint (DECISIONS/0012
   F1: the measurement is not run in CI; the check that the published table matches the committed
   artifact is).
3. **§8 already fixed its direction:** reference-OCR fixtures make every parser-only score a
   **ceiling** on real-world accuracy for one thing — the recognition noise the fixtures never carry
   (DECISIONS/0003) — and it is not an upper bound on the end-to-end number, because the modes also differ
   in line grouping (M8). Publishing both shows the size of the OCR difference rather than hiding it behind
   whichever number is more flattering.

The README states the mode inside the headline sentence, not in a footnote, and each table column
header names its mode. A number without a mode is not publishable.

**Never blended:** no average, no "overall accuracy", no combined bar across CORD and SROIE or across
modes. ADR-010 forbids mixing CORD into the English claim; §8 forbids mixing the modes. The only
cross-mode arithmetic allowed is the explicit per-dataset gap between the two numbers, labelled as the
OCR gap.

## M2 — What each mode feeds `parse()`, and what changes between them

| | parser-only | end-to-end |
|---|---|---|
| Input | committed fixtures in `benchmarks/fixtures/<split>/` | the dataset's own receipt **images**, row-indexed to the same fixtures |
| Line grouping | CORD: the dataset's `valid_line`; SROIE: harness y-clustering (DECISIONS/0003) | the provider's reading-order line view — a *third* grouping, neither of the fixture ones |
| Text | dataset reference OCR, **PII-redacted** (DECISIONS/0005) | raw OCR from the image — **un-redacted** |
| Confidence | `null` on every word (0/10,424 on dev) | a real per-character CTC score on every word |
| Runtime | Node, deterministic, CI | headless Chromium + WASM, local, timings vary |
| Score direction | **parser-quality isolation (not a ceiling on end-to-end)** | **user-experience number (not bounded by parser-only)** |

Two consequences that are easy to miss and expensive to gloss:

- **Line grouping differs between modes, so an end-to-end miss is not always an OCR miss.** The
  provider's `0.5 × median word height` reading-order banding (DECISIONS/0007) is not the parser's §5
  y-band and not SROIE's fixture banding. A row a human would call one line can reach `parse()` split
  in two. That is a real property of the shipped pipeline, so it belongs in the end-to-end number and
  must be named as a segmentation contribution when it is visible.
- **Gold is redacted; end-to-end predictions are not.** DECISIONS/0005 removed SROIE
  company/address tokens from the fixtures, so a header line reads `CASHIER [NAME] TIME` in parser-only
  and `CASHIER SARIMAN TIME` in end-to-end. Only `grandTotal` is scored from SROIE and only item/
  bill-level money from CORD, so **no scored cell contains a redacted token** — the mismatch is real
  but lands outside the scored surface. Recorded rather than assumed: the end-to-end artifact carries
  the redaction tally of the fixtures it is compared against, and the raw OCR text is **never written
  into a committed file** (M6).

## M3 — Scoring scope per dataset, which is also the language scope (ADR-010)

Fields a dataset does not label are excluded, never null-scored (ADR-003); the exclusion list is read
from each committed provenance header, not restated here.

| Dataset | Language | Scored fields | Never scored |
|---|---|---|---|
| **SROIE** (headline English) | English | `grandTotal` only, mapped from the annotated `total` | every item field, every charge field, `subtotal` |
| **CORD v2** (out-of-language) | Indonesian | `item.name`, `item.qty`, `item.unitPrice`, `item.lineTotal`, `subtotal`, `grandTotal`, `serviceCharge`, `discount`, `taxTotal` | `tip`, `roundOff` (annotated nowhere in the snapshot) |

SROIE therefore **cannot produce an item-level or price-field number at all** — it annotates no items
(DECISIONS/0002). This collides with the 04 handoff, which asks 09b to measure "price-field accuracy
specifically" for the Tiny-vs-Small decision: the dataset that carries the English headline claim is the
one that cannot test prices at item level. It is answered, not fudged:

- **Price evidence comes from three places, each named as what it is.** (1) CORD item money:
  `item.unitPrice`/`item.lineTotal` field F1 plus gold-annotated paired checks with
  `matchItems(τ=0.70, money_gate=on)` and, separately, `money_gate=off` (§M5). (2) SROIE `grandTotal`
  strict equality — a *receipt-level* money read, integer-paise exact, the only money SROIE can prove.
  (3) Ticket 04's documented single-receipt observation (`Total 9.00` → `1.00`, `Cash 10.00` → `000` on
  a 463 px thermal scan), which is **one receipt, session-measured, and quoted as an anecdote**, never
  promoted to a percentage. A tier decision that rests on (1)+(2) is honest; one that rests on (3) is
  not, and (3) is not load-bearing here.
- **Header row-classification is CORD-only by construction.** DECISIONS/0004: the pinned CORD snapshot
  carries only annotated financial lines, so it cannot contain a noise-header or continuation row — the
  direction that limitation runs is the opposite of what ticket 05's carry-forward assumed (see M7).

## M4 — The metric configuration every published number travels with

Pinned in `benchmarks/src/benchmark.config.ts` (gate G8t), which is the source of truth; this section
records what the pins *mean* for publication, and the renderer reads the values out of the committed
results JSON rather than from this file.

- **Item pairing: `matchItems(τ = 0.70, money_gate = on)`** — normalized Levenshtein over §8.1
  normalization, order-respecting one-to-one LCS DP, pair count first and total similarity second
  (DECISIONS/0006, §8.3). Money compatibility at the gate means **non-conflicting at integer paise**: a
  field one side lacks does not vote (§8.2, DECISIONS/0006 Option B).
- **τ gates pairing only.** Field agreement is exact: normalized-string equality for names, integer
  equality for money and quantity. Two names that needed tolerance to be paired are a field miss (§8.5).
- **Cell null semantics: strict (Option B, the 2026-11-03 correction in DECISIONS/0006).**
  gold-null + predicted-null = abstention (never a hit); gold-null + predicted-value = **false
  positive**; gold-value + no prediction = false negative; disagreement = both. `unannotatedGoldCells`
  is published beside every item field so a reader can see how much of a field's error rate is the
  dataset simply not printing the value — CORD annotates `unitPrice` on 49 of 254 dev gold items, so for
  that field this is the common case, not an edge.
- **Tier 1 strict** means every field the dataset labels agrees on that receipt; a receipt with nothing
  labelled is excluded from the denominator, never auto-matched (§8, `scoring/report.ts`).
- **Tier 2** is per-field micro precision/recall/F1, with a dataset-level unweighted macro over fields
  that produced at least one scored cell (DECISIONS/0004).
- **Confidence floors 0.50 critical / 0.70 warning and the round-off band ±₹0.02, ≤₹1.00** are consumed
  as pinned defaults (DECISIONS/0006, DECISIONS/0011). **They are not calibrated and 09b does not
  calibrate them**: §17's M1-exit calibration needs a calibration corpus, which does not exist, and
  creating one is a dataset-selection decision for the owner, not a tuning parameter here.

> **Publication rule (DECISIONS/0008, restated because 09b is the ticket that publishes):** any
> paired-gold number must name its matcher configuration — `matchItems(τ=0.70, money_gate=on)` or
> `money_gate=off`. The money gate is a *precondition* of pairing, so a gate-on census can only ever
> report "0 wrong prices" among the pairs it kept: exactly the field the gate tests is the field it
> hides. Where a price claim is made, both configurations are reported and the difference is the
> evidence.

## M5 — The gold-name number 09b publishes is the matcher's, not the substring one

Ticket 06 carried this forward: the 164/254 "gold-name reachability" figure in
`benchmarks/src/parser/rowClassification.test.ts` is substring-containment based and mis-scores the 16
geometry-fragmented CORD gold names (every word present in the row set, none contiguous).

- **The published name metric is `item.name` field recall/f1 from the committed scorer, measured with
  `matchItems(τ=0.70, money_gate=on)`.** It is lower than the substring figure and it is the honest
  one; it is re-derivable from a committed results JSON, which the 164/254 number is not.
- **The substring figure is withdrawn from publication.** It stays in `rowClassification.test.ts` as a
  geometry-reachability diagnostic (it answers "are the words on the page at all?", which is a real
  question about ticket 05's segmentation) but it may not appear in the README or in any accuracy claim,
  and nothing in the accuracy artifact is derived from it.
- **The pairing delta (131 → 135 gold pairs) is matcher-derived and stands** — verified by ticket 06 in
  `quantityMoneyPins.test.ts`, which reconstructs the 05 head through the `tenderFamily` seam. Only the
  reachability figure needed replacing.

## M6 — What the artifacts are, and the rule that makes them re-derivable

| Artifact | Producer | Runs | Committed |
|---|---|---|---|
| `benchmarks/results/parser-only-<split>.json` (+ dated/sha copy) | `benchmarks/src/measure-accuracy.ts` → `pnpm measure:accuracy` | Node, dev + eval, CI-checkable | yes |
| `benchmarks/results/end-to-end-<tier>.json` (+ dated/sha copy) | `benchmarks/scripts/run-end-to-end.mjs` | Chromium + raw images, **local only** | yes |
| `<!-- accuracy:begin -->` block in `packages/core/README.md` | `benchmarks/scripts/render-accuracy-table.mjs --write` | CI `--check` fails on drift | yes |

Rules, all of them consequences of DECISIONS/0008's "artifacts are checked, not claimed":

1. **Every published number is a pure function of a committed results JSON.** No accuracy figure may be
   typed into the README, a decision record, or a PR body without naming the artifact and key that
   produced it. Session-measured figures are either omitted or labelled session-measured.
2. **The results JSON is deterministic**: no timestamps in content (the date lives in the archive
   filename, as `report-results.ts` already does), fixed key order, no host paths, and the §8 pins
   echoed inside it (snapshot hash, provider + model hash, scorer version, normalization, τ, test count,
   averaging).
3. **No receipt text leaves the browser into a committed file.** The end-to-end artifact carries
   counts, ids, and numeric scores only. Raw per-receipt OCR stays in `harness/out/` (git-ignored),
   which holds it to the same standard DECISIONS/0005 set for fixtures: nothing identifiable is
   committed, and nothing that *could* be is written where a `git add` would pick it up.
4. **A tier swap does not silently re-date an old number.** Each end-to-end artifact names its tier,
   its manifest hash and its asset bytes, so a table row cannot outlive the model that produced it
   (DECISIONS/0012 F11's trigger, applied to accuracy).

## M7 — Limitations that must sit next to the numbers, not behind them

Each of these is a carry-forward from an earlier ticket. They are published as table footnotes or as
fields of the results JSON, whichever the reader hits first.

1. **`zero_items` is a mixed bucket and stays mixed.** `validate()` cannot distinguish "this receipt
   was not itemized" (a gas-station single-total slip) from "the parse failed". The 42 dev receipts are
   reported as **42 receipts where itemization could not be proven**, never as 42 parser failures, and
   the same figure is named for eval with its own count.
2. **The strict floor is attributed, not asserted.** The dev strict number is bounded by 86/250
   receipts carrying at least one non-advisory critical. The breakdown ships with it: `zero_items` (42,
   mixed per (1)), `arithmetic_total` (34, a validation finding), `arithmetic_item_sum` (27),
   `item_without_price` (2, data limitation), `invalid_result_schema` (1). The 27 `arithmetic_item_sum`
   criticals are **05/20 classifier gaps** — charge and tender rows classified as items, so
   `readCharges` never saw them (DECISIONS/0011, ticket 20) — and are not parser-price bugs and not
   accuracy evidence. **No accuracy claim in 09b cites them.**
3. **`detected` unit price is two populations and is reported as two.** Dev carries 331
   `priceSource: "detected"` items, of which 230 are line totals promoted on an *assumed* qty 1
   (ticket 06's rescue at `parse/items.ts`). Direct-detected and derivative are separate rows; there is
   no single "detected unit price accuracy" number anywhere in the README. If ticket 06's rescue-gate
   fix has landed, the artifact says so and the split is re-measured rather than assumed — the pre-fix
   and post-fix figures describe different populations (331 vs roughly 101).
4. **Confidence floors are unexercised in the headline mode.** Parser-only fixtures carry 0 scored OCR
   words, so every receipt takes `confidence_unavailable` and no floor comparison runs. In end-to-end
   mode every word *is* scored, so the floors first become observable there — which is a mode
   difference, and the README says the floors are tested on authored fixtures and exercised by
   end-to-end OCR, never by the headline number. **The floors remain declared defaults, not measured
   values**, in both modes: exercising them is not calibrating them (§17's open loop, M4).
5. **CORD does not test row classification, and 09b therefore does not publish a gold-class
   `ambiguous` split.** Ticket 05 asked for ambiguous rows split by gold class (item / noise-header /
   charge). DECISIONS/0004 establishes that the pinned CORD snapshot contains no non-financial lines at
   all, so there is no gold noise-header or continuation class to split against, and the committed
   fixtures drop the CORD category per line, so even the item-vs-charge split is not recoverable from a
   committed artifact. The 25.1% / 16.5% ambiguous rates remain what ticket 05 published, with its own
   caveat; **the split requires a per-line gold-category sidecar that does not exist**, and inventing a
   proxy from the fixture text would be the "measurement predicate that is not the predicate under test"
   failure DECISIONS/0008 names. Filed as needed-but-not-built rather than quietly approximated.
6. **Both modes are ceilings for OCR error, in the narrow sense — see M8.** Fixtures carry no OCR error,
   and development against `dev/` removes bugs that `eval/` would otherwise have shown, so the second
   reason applies to both modes (the parser underneath the end-to-end numbers is the dev-tuned one).
   M8 corrects the stronger reading: end-to-end is *not* numerically bounded by parser-only, because the
   modes also differ in line grouping.
7. **SROIE fixture lines are harness-derived, not dataset facts** (DECISIONS/0003), and SROIE's
   `train` split is reused as dev because the snapshot has no validation split. Only `grandTotal` is
   scored from SROIE, so no itemized field is tuned on it.
8. **CORD `item.name` F1 0.212 is a measured parser defect, not a language effect, and it is published
   beside that fact.** Diagnosis in `DECISIONS/0015` M-4 and
   `benchmarks/results/diagnostic-item-names-cord-v2-dev.json`: the metric is flat across τ 0.50–0.90,
   word order accounts for 0 of 82 paired misses, and 80 of 82 have gold's tokens as a strict subset of
   the prediction with the surplus being printed quantity digits on continuation-merged rows. The fix
   belongs to tickets 05/06; 09b files it with the mechanism rather than quietly publishing the number or
   quietly fixing it inside a measurement ticket.

## M8 (post-ticket correction) — parser-only is not a ceiling on end-to-end

**Reference OCR fixtures use harness-derived y-clustering (SROIE) or dataset-provided line grouping
(CORD); real OCR produces its own grouping. On receipts with competing totals, different groupings reach
`parse()` differently, so end-to-end can exceed or fall below parser-only depending on grouping luck.
SROIE dev: 16 receipts up, 11 down, net +5; SROIE eval: Small exceeds parser-only by 2.2 pp. The two modes
are complementary measurements, not ordered. Do not present either as a ceiling on the other in README or
any report.**

Owner-confirmed 2026-11-04 after the first four end-to-end runs contradicted the wording this record
originally carried in M2 ("end-to-end sits at or below it") and the unqualified ceiling statement inherited
from `DECISIONS/0003`/`0004`. What survives is the narrower claim about *recognition noise*, which is the
reason parser-only is the headline (M1): the fixtures carry no OCR error, so a field score against them
isolates the parser — and, symmetrically, ticket 04's faded-thermal price misreads are a fact about the
product that can **only** be seen end-to-end.

- **Measured, not argued.** SROIE eval strict: parser-only 60.66% (219/361), end-to-end **Tiny 57.34%**
  (207/361), end-to-end **Small 62.88%** (227/361) — `parser-only-eval.json` vs
  `end-to-end-{tiny,small}-eval.json`. Small sits 2.2 pp **above** the reference-OCR figure on the same
  receipts, and Tiny below it: the movement goes both ways.
- **Mechanism, with an example.** `sroie/dev/12` prints `SUBTOTAL : 15.90`, `TOTAL EXCL. OF GST 15.00`,
  `TOTAL INCL. OF GST 15.90` and `TOTAL AMT ROUNDED 15.90` against gold 15.90. Which candidate reaches
  `parse()` is decided by grouping, so a weaker recognizer with luckier grouping can beat the fixture on
  that receipt; 11 dev receipts moved the other way. Per-receipt counts are in the committed artifacts'
  `receiptRecords`.
- **Required phrasing from here on.** "Reference OCR and real OCR use different line grouping, so neither
  is a strict ceiling on the other — real OCR can occasionally produce better grouping than the reference
  fixtures. The number a user experiences is the end-to-end number with the default model." The generated
  README block carries exactly that framing, so a hand-typed "ceiling" sentence in a future report is the
  drift this section exists to catch.

## What this record does not decide

- **Tiny or Small.** Gate G3's default is *keep Tiny unless the strict-metric gap is material*, and
  "material" is undefined in both `PROJECT(1).md` and `ROADMAP.md`. `benchmark.config.ts` deliberately
  records no acceptance threshold, so 09b does not invent one either: the comparison, the recommendation
  and the reasoning about "material" belong to `DECISIONS/0015`, written against the artifacts this
  record defines.
- **Whether the parser changes.** 09b measures. `parse()`'s behaviour, the label dictionary and the
  rescue gate are tickets 05/06/20's, and a fix prompted by an `eval/` observation is contamination
  (DECISIONS/0004) — stop and report instead of applying it.
- **Calibrating the floors.** Needs a calibration corpus that does not exist; owner decision (§17).
- **`PROJECT(1).md` §8's wording.** Unedited, per the standing rule. §8 asks for the headline to name
  its mode and for results to pin the protocol; this record is how those instructions are discharged,
  not a change to them.
