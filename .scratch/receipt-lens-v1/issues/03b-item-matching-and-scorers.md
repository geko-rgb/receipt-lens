# 03b: Item matching and scorers

**What to build:** Deterministic predicted-to-annotated item matching and the two scoring tiers on top of 03a's harness — so row classes and parser output can be measured as precision/recall buckets instead of eyeballed. The matcher must be stable: same input, same matches, every time.

**Blocked by:** 03a (benchmark foundation)

**Status:** claimed — implementation complete on `ticket/03b-item-matching-and-scorers`, all six boxes met, 184 tests green, PR not yet opened

**Effort:** ~42 h · **Roadmap:** workstream 1D part 2 (tasks 1D.5–1D.8, 1D.10; README generation 1D.9 stays in 09b), pulled ahead of its W7–8 slot because 05 measures through these scorers · **Milestone:** M1
**Verify:** `pnpm -r test` (matching/scorer suite) green; two runs on the same fixtures produce a byte-identical report; empty-dataset and no-applicable-fields edge fixtures produce no NaN and no misleading non-zero scores

- [x] Name normalization (NFC, casefold, punctuation, whitespace) is lossless for meaningful words and digits, with the similarity threshold τ configurable
- [x] Matching is deterministic and order-respecting, one-to-one, maximizing matched pairs first and name similarity second; a DP or LCS-style procedure, not a greedy pass
- [x] Monetary equality in matching is integer-paise equality
- [x] Field-level precision/recall/F1 scorers with macro averaging and explicit null semantics: null-vs-null counts only where the dataset marks the field missing
- [x] A `benchmark.config` pins τ, score thresholds and the round-off band (gate G8t) plus the results JSON schema; published results pin snapshots, hashes, τ and averaging method
- [x] Edge guards: empty datasets and no-applicable-fields cases never produce NaN or a misleading non-zero score

## Comments

2026-11-03 — Seams S5 (matching) and S6 (field scorers), TDD with the fixtures 03a committed.

**Files.** `benchmarks/src/benchmark.config.ts` (new — G8t pins: `τ_name 0.70`, confidence floors
0.50/0.70, round-off band ±2 / ≤100 minor units, `scorerVersion 03b.1`, `resultsSchemaVersion 1.1`,
declared results JSON schema, averaging rule). `benchmarks/src/matching/similarity.ts` (§8.1
normalization, unit-cost Levenshtein, Jaro-Winkler kept only as the rejected counterfactual),
`matching/matcher.ts` (LCS-shaped DP: candidate gate = name ≥ τ **and** monetary compatibility,
objective = pair count then total similarity, declared tie order take → drop gold → drop
predicted), `matching/sweep.ts` + `sweep.test.ts` (the committed DECISIONS/0006 evidence).
`scoring/itemScores.ts` (cell rules), `scoring/report.ts` (two tiers, macro, coverage, protocol
echo), `scoring/resultsSchema.test.ts`, `report-results.ts` (license passthrough).
**Decisions:** `DECISIONS/0006-matching-metric.md` new; `DECISIONS/0005` gained the
placeholder-stripping rule.

**Owner rulings taken, not assumed.** (1) Metric: normalized Levenshtein — the brief's prior was
tested; Jaro-Winkler admits 3 of 16 false candidates on the dev money-equal surface at τ=0.70
(`Jamur Enoki`/`Jamur Kuping`, same receipt, same line total: 0.891 under JW vs 0.500 under LEV),
Levenshtein admits 0 across the whole 0.60–0.85 band. (2) Money compatibility at the **pairing
gate**: non-conflicting — a field one side left unannotated does not block a pairing, while an
amount both sides annotate must be integer-equal. (3) τ-sweep committed as a per-push CI gate.

**Ruling reversed on re-reading the spec (2026-11-03, same day).** The first pass also applied
"unannotated does not vote" to *scoring*, excluding a gold-null/prediction-populated cell from
field P/R/F1. §8 says the opposite at cell level — "Null-vs-populated counts as an error for the
applicable field" — so item cells are now **strict**, the same rule 03a already applied to
scalars: that cell is a false positive, and the receipt fails Tier 1. Full record, including the
accepted cost (a correct unit price on a receipt CORD never printed is charged) and the
`unannotatedGoldCells` counter published so a reader can tell "parser wrong" from "dataset did not
print it", in DECISIONS/0006. No published number moved: the null parser never predicts.

**Conventions decided.** Macro skips a *labeled* field with no scored cells at all in the sample
(its ratios would be the 0/0 convention, not a measurement); recorded in DECISIONS/0004, with
`macro.listed` beside `macro.fields` so the exclusion is visible rather than silent.
`benchmark.config` deliberately pins **no** accuracy-acceptance threshold — neither the spec nor
ROADMAP defines one (G3 asks whether a gap is "material" without saying when), so inventing one
would have been a fabricated gate.

**Deviation recorded.** §8.1 says "casefold"; JS has no casefold, so normalization uses
locale-independent `toLowerCase()`, which differs for `ß`, ligatures and dotted/dotless `İ`. None
occur in either pinned snapshot — `sweep.ts` fails the build if a future fixture introduces one.

**Verified.** `pnpm build` ✓ `pnpm typecheck` ✓ (tests included) `pnpm -r test` → core 4, pwa 27,
benchmarks 156, **187 passing** (was 125). `pnpm report:results` + `pnpm verify:results` →
`dev-null-bootstrap.json matches a fresh run over the committed fixtures` (byte-identical).
`pnpm verify:fixtures` → 717 files byte-identical (exit 0). `pnpm scan:pii` → idempotent, 0
changes on re-run. Budget 12.0 MB / 50 MB. Bootstrap still exactly 0 on every metric, both dev
datasets, `NaN` absent from the report; the item tier now publishes real denominators
(`item.name` 254 gold cells, `item.unitPrice` 49 annotated / 205 **unannotated**,
`item.qty` 198 / 56, `item.lineTotal` 222 / 32).

**Two self-corrections, both measured rather than assumed.** The money-equal surface holds **16**
distinct-item pairs, not the 17 first reported — §8.2 gates on both monetary fields, so a pair
whose other amount conflicts was never a candidate. And truncation retention is **38.8%**, not the
78% a seeded sample happened to show; the sweep is exhaustive now (97,300 substitutions, 2,089
transpositions, 454 clips), so every figure in DECISIONS/0006 is reproducible without a PRNG.

**Label contradiction, flagged per reporting rules:** `Week: W7–8` is a planning hint; this ticket
was pulled ahead of it because ticket 05 measures through these scorers. `Milestone: M1` and the
`Blocked by: 03a` line are consistent with what shipped.

**Housekeeping closed on owner instruction:** `03a-benchmark-foundation.md` still read
`Status: ready-for-agent` with nine unticked boxes although PR #5 merged it (`44678e7`). Its
boxes are ticked in a separate ticks-only commit, on the basis of what this session verified
directly: loaders and provenance present, fixtures regenerating byte-identically, the bootstrap
scoring exactly 0 with no NaN, `verify:results` reproducible, and strict + field-level tiers with
labelled coverage in the report. Its `Status:` line and body text are untouched — 03a's own
record, not this session's.
