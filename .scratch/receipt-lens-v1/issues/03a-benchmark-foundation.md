# 03a: Benchmark foundation — loaders, fixture cache, null-parser bootstrap

**What to build:** The scoring harness skeleton that reads pinned receipt datasets and cached OCR fixtures, with the non-negotiable null-parser proof: a parser that produces nothing must provably score zero against non-empty annotated data, so a scoring bug can never be mistaken for accuracy. No matching or scorers yet — that is 03b.

**Blocked by:** 01 (walking skeleton — provides the pinned dataset manifest and the `OcrResult` contract)

**Status:** ready-for-agent

**Effort:** ~32 h · **Roadmap:** workstream 1D part 1 (tasks 1D.1–1D.4) · **Week:** W2 · **Milestone:** M1
**Verify:** `pnpm -r test` (benchmark suite) green; the null-parser bootstrap runs in CI against non-empty data and fails the build if any score is non-zero

- [ ] Two dataset loaders read the pinned manifest committed by 01 — the layout-stress bucket and the grand-total-only set — each recording source, licence and content hash, and declaring which fields its annotations actually label; unlabeled fields are excluded from scoring, never null-scored
- [ ] Runs entirely on cached OCR fixtures in Node — no browser, no network
- [ ] The fixture cache is keyed by snapshot + provider + model hash with full keys, and regenerates deterministically by script
- [ ] The null-parser bootstrap scores exactly 0 on strict match and every field precision/recall/F1 against non-empty sets; NaN is impossible
- [ ] Report format carries a strict exact-match tier alongside field-level precision/recall/F1, per dataset, with labelled-field coverage stated in the output
- [ ] Null and missing-value semantics are explicit and disclosed in the report rather than silently skipped
- [ ] Locale normalization used for annotations matches the locale profiles applied to predictions
- [ ] Two runs on the same fixtures produce a byte-identical report
- [ ] Machine-readable results are written to a stable committed location so published numbers can be regenerated
