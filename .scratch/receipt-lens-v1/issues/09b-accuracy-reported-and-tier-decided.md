# 09b: Accuracy reported, model tier decided

**What to build:** The data-analysis half of milestone one: published accuracy generated from committed CI results with the datasets' language and labelling limits stated next to the numbers, the recommended model tier confirmed or revised against the measured alternative on identical fixtures, and the tuning defaults pinned.

**Blocked by:** 04 (on-device OCR provider), 07 (validation and findings) — scoring protocol from 03b

**Status:** done — merged pending owner review (2026-11-04)

**Effort:** ~20 h · **Roadmap:** tasks 1E.3 (Tiny-vs-Small) and 1D.9 (README table generation), plus G3/G8t closure · **Week:** W8–9 · **Milestone:** M1
**Verify:** accuracy tables regenerate byte-identically from committed results JSON; the tier decision note is committed citing both runs

- [x] The alternative, larger model set is measured against the same fixtures through the same provider, and the default recommendation (gate G3) is confirmed or revised on that data with the reasoning recorded in a committed note
- [x] Published accuracy tables are generated from committed machine-readable results, with per-dataset labelling coverage and the language mismatch disclosed beside them
- [x] The declared headline evaluation mode is stated where the numbers are published
- [x] Threshold and tolerance defaults exercised by this ticket (τ, confidence floors, round-off band — gate G8t) are pinned in benchmark configuration and documented as such

## Evidence (2026-11-04)

**Decision records.** `DECISIONS/0014-accuracy-modes.md` pins the two modes (headline = parser-only,
secondary = end-to-end, never blended), the per-dataset scoring and language scope, the metric
configuration every number travels with, and seven publication limits; **M8 corrects its own ceiling
claim from the measurement** (end-to-end is not numerically bounded by parser-only, because the modes also
differ in line grouping). `DECISIONS/0015-model-tier-decision-criteria.md` commits the G3 thresholds
**before** the Small download and resolves them after: A +5.54 pp (marginal band), B +0.044 (fails),
C holds → **Tiny remains the default**, owner-decidable with the measured data, criteria re-runnable.

**Artifacts, all committed.** `benchmarks/results/parser-only-{dev,eval}.json`,
`end-to-end-{tiny,small}-{dev,eval}.json` (+ dated/sha archive copies), and
`diagnostic-item-names-cord-v2-dev.json`. The README accuracy block is generated from them by
`benchmarks/scripts/render-accuracy-table.mjs`; CI regenerates it and fails on drift, and the same check
discharges G8t by comparing each artifact's τ / metric / floors / round-off band / scorer version against
`benchmark.config.ts` **and** against the values `DECISIONS/0006`, `DECISIONS/0011` and ROADMAP G8t declare.

**Headline numbers (SROIE English, eval, strict Tier 1).** 60.7% parser-only (219/361) — the published
headline and the OCR-error ceiling; 57.3% end-to-end with Tiny (207/361); 62.9% with Small (227/361).
CORD (out-of-language layout bucket, ADR-010): strict 2/100 dev and 0/100 eval parser-only, 0/100 both
splits end-to-end for either tier.

**Gate G3 measurement, same protocol both tiers.** Small costs 4.96× the model bytes (31.13 MB vs
6.28 MB), ~2.2× the projected cold download, and **3.8× the median inference** (494 ms → 1,880 ms over the
same 461 eval receipts), and gains +5.54 pp on SROIE eval strict with no CORD item-field regression. C4's
two vendor-manifest traps reproduced on Small exactly as on Tiny (detection output is full resolution, not
H/4; recognition output already softmax, not logits) — measured and corrected before the run, so the
comparison was not decided by an export quirk.

**Carry-forwards, all handled.** (1) modes reported separately with the headline named where the numbers
are published; (2) price accuracy separated from name accuracy — `item.lineTotal`/`item.unitPrice` F1 per
dataset and mode, plus SROIE's receipt-level `grandTotal`, with ticket 04's faded-thermal anecdote kept
out of the percentages; (3) every paired-gold number states `matchItems(τ=0.70, money_gate=on|off)`, and
`money_gate=off` leads the README table because it is the only column that can see a wrong price (dev 2 of
5 reachable gold unit prices actively wrong, eval 3 of 11); (4) the 27 `arithmetic_item_sum` criticals are
published with their attribution and explicitly not cited as accuracy evidence; (5) `detected` is split
direct vs promoted-line-total (dev 331 = 101 + 230, reproducing `validationPins.test.ts` exactly; 06's
rescue-gate fix has **not** landed); (6) floors stated as unexercised in the headline mode and first
observable end-to-end (all 2362/15352 dev words scored), while remaining declared defaults, not
calibrated; (7) `zero_items` published as "itemization could not be proven", not parser failures;
(8) SROIE-only English claim, CORD headers state Indonesian/out-of-language, and SROIE headers state
grand-total-only.

**CORD `item.name` = 0.212 diagnosed before publishing, per the owner's condition.** It is a parser
defect, not a language effect: the metric is flat at 0.212 across τ 0.50–0.90 (so τ is not the cause and
τ was not touched), word order accounts for 0 of 82 paired misses, and 80 of 82 misses have the gold
tokens as a strict subset of the prediction with the surplus being pure digits in 70 cases — every one on
a continuation-merged item. **The printed quantity is being folded into `Item.name`.** Filed on tickets
05/06 with the mechanism, the counts and the artifact; the README states the defect beside the number.

**Not done, deliberately.** The ambiguous-row gold-class split ticket 05 asked for cannot be computed from
committed artifacts: the pinned CORD snapshot carries no non-financial lines (`DECISIONS/0004`), so there
is no gold noise-header/continuation class, and the fixtures drop CORD's per-line category. Recorded as
`DECISIONS/0014` M7.5 with what would be needed (a per-line gold-category sidecar) rather than proxied.

**M1-exit calibration of the floors is still an open loop** (§17): it needs a calibration-corpus decision,
which is a dataset-selection choice for the owner, not a tuning parameter.

**Verified locally:** `pnpm install --frozen-lockfile` not needed (no dependency change) ✓ `pnpm build` ✓
`pnpm typecheck` ✓ `pnpm -r test` **463 passing** (core 222, pwa 27, benchmarks 214) ✓
`pnpm verify:accuracy` (dev + eval byte-identical) ✓ `pnpm verify:accuracy-table` (6 artifacts, G8t
verified) ✓ `pnpm verify:results` ✓ `pnpm verify:fixtures` 715 files byte-identical ✓ `pnpm scan:pii`
idempotence clean, 51 advisories unchanged ✓ `pnpm verify:footprint` ✓
`node scripts/model-manifest.mjs --check` ✓ `node benchmarks/scripts/diagnose-item-names.mjs --check` ✓
fixtures budget 12.0 MB / 50 MB; largest committed new file 127 KB (< 1 MB ceiling) ✓.
**harness/dist/main.js unchanged at 141 KB**, so ticket 08's measurement was not disturbed by adding a
second, benchmark-only bundle. Disk: **53 GB free** on `/home`; ~1.4 MB of new tracked text
(2 decision records, 11 result JSONs, 5 scripts, 3 harness/TS sources); `assets/models/candidate/`
(31.13 MB) is git-ignored and **not** committed. Raw OCR was never written: the runs used no
`--keep-ocr`, and the committed artifacts carry counts and outcomes only (no `text`/`name` keys).


## Required from 09b, added by ticket 05 (2026-11-03)

The row-classification bucket must report preserved (`ambiguous`) rows **split by gold class**:
gold item (false-ambiguous, a recall miss), gold noise/header (correct-ambiguous — the price P7
deliberately pays for visible review), gold charge (false-ambiguous). Ticket 05 measured **25.1%
ambiguous on `dev/cord-v2` (198 of 788 rows) and 16.5% on `dev/sroie` (728 of 4,411)** with rule 3's
lettered-content condition and the header zone keyed to the price column; without this split the number
is a rate, not a metric, and cannot be judged. The rate is high **by design** — P7 preserves what it
cannot determine instead of discarding it — so the bucket that decides whether 25.1% is a limitation or
a bug is this split, not the headline.

**The row-classification precision/recall bucket is CORD-only; SROIE supports only total-level
scoring. The README must state this beside the metric.** SROIE annotates `total` only
(DECISIONS/0002), so it has no gold item or charge class to compare against, and its 728 ambiguous
rows are unjudgable by construction — which is exactly why the split has to be reported rather than
the headline rate.

## Required before 09b publishes (carried by ticket 06, 2026-11-03)

**Gold-name recovery must be re-derived with 03b's field matcher, not substring containment.** The shipped
164/254 number in `rowClassification.test.ts` is substring-based and mis-scores 16 geometry-fragmented
gold names (all 16 have every word present in the row set, none of them contiguous — see 06's ticket
file). **Do not publish the substring number in the README.**

**Also re-derive the "gold pairs 131→135" delta with 03b's matcher and confirm it was not
substring-computed; if it was, the delta is unreliable.** Verification as of this writing: both sides are
`matchItems` at τ 0.70 with the money-compatibility gate, committed in
`benchmarks/src/parser/quantityMoneyPins.test.ts` ("re-derives the base head's pairing…"), which
reconstructs the 05 head through the `tenderFamily: false` seam — 713 items / 131 pairs against
518 items / 135 pairs. The pairing delta is therefore matcher-derived and stands; the *reachability*
number (164/254) is the one that is not, and 09b must replace it. Expect the matcher's figure to be lower;
it is the honest one.

## Comments

**Carried by ticket 07 (2026-11-03).**

**Confidence floor behavior is tested on authored fixtures only.** Dev corpus has 0/10,424 scored OCR
words, so every dev receipt takes `confidence_unavailable` and every floor comparison is skipped. Do not
cite dev as evidence for floor precision/recall. The README must state floors are tested on authored
fixtures, not dev. Measurement: `benchmarks/src/parser/validationPins.test.ts` ("dev reference OCR
supplies no confidence at all") — 10,424 words and 5,604 lines, 0 non-null scores, and 518/518 parsed
items with `confidence: null`. Dev fixtures are dataset *reference OCR* (DECISIONS/0003); neither CORD
nor SROIE annotates a recognition score. The only non-null source in the repo is ticket 04's real-receipt
harness output, which is not a benchmark fixture.

**Emission census on dev (250 receipts): 86/250 carry ≥1 non-advisory critical** — 42 `zero_items`,
34 `arithmetic_total`, 27 `arithmetic_item_sum`, 2 `item_without_price`, 1 `invalid_result_schema` (a
receipt can carry several). 1,781 findings total, 106 of them critical. Strict receipt-score floor is
roughly 34% on dev. Report this with the breakdown, so "X% strict" reads as "X% strict with 86 receipts
blocked by specific criticals". Also: `zero_items` fires on any zero-item `ParseResult`; `validate()`
cannot distinguish "receipt wasn't itemized" from "parse failed". The 42 is mixed — 09b must state this
limitation. The census is the shipped `validate()` run over dev, committed in
`validationPins.test.ts` ("emission census") — not a restatement of the rules.

**Unit-price provenance must be split before any `detected` accuracy is published.** Current dev corpus:
**331 items with `priceSource: "detected"`, of which 230 are line totals promoted on an assumed qty 1**
(ticket 06's rescue note). Pending 06's rescue-gate fix, **do not publish "detected unit price accuracy"**
without distinguishing the two sources — the 230 are derivative, not direct. Gating the rescue on
`explicit` moves `detected` from 331 to roughly 101, so any pre-fix number is measuring a different
population than the post-fix one. Counts committed in `validationPins.test.ts` ("price provenance").

**Confidence floors (0.50/0.70) are consumed from DECISIONS/0006 as pinned defaults.** Dev corpus has no
scored OCR words (0 of 10,424), so floors are tested on authored fixtures only, not dev. M1-exit
calibration is an open loop requiring a calibration-corpus decision — no such corpus exists today, and
creating one is a dataset-selection decision, not a tuning parameter. **The README must state floors are
defaults, not measured.**
