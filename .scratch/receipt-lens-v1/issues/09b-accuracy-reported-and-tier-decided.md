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
