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
