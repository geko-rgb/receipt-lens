# 09b: Accuracy reported, model tier decided

**What to build:** The data-analysis half of milestone one: published accuracy generated from committed CI results with the datasets' language and labelling limits stated next to the numbers, the recommended model tier confirmed or revised against the measured alternative on identical fixtures, and the tuning defaults pinned.

**Blocked by:** 04 (on-device OCR provider), 07 (validation and findings) — scoring protocol from 03b

**Status:** ready-for-agent

**Effort:** ~20 h · **Roadmap:** tasks 1E.3 (Tiny-vs-Small) and 1D.9 (README table generation), plus G3/G8t closure · **Week:** W8–9 · **Milestone:** M1
**Verify:** accuracy tables regenerate byte-identically from committed results JSON; the tier decision note is committed citing both runs

- [ ] The alternative, larger model set is measured against the same fixtures through the same provider, and the default recommendation (gate G3) is confirmed or revised on that data with the reasoning recorded in a committed note
- [ ] Published accuracy tables are generated from committed machine-readable results, with per-dataset labelling coverage and the language mismatch disclosed beside them
- [ ] The declared headline evaluation mode is stated where the numbers are published
- [ ] Threshold and tolerance defaults exercised by this ticket (τ, confidence floors, round-off band — gate G8t) are pinned in benchmark configuration and documented as such

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
