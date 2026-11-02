# 03b: Item matching and scorers

**What to build:** Deterministic predicted-to-annotated item matching and the two scoring tiers on top of 03a's harness — so row classes and parser output can be measured as precision/recall buckets instead of eyeballed. The matcher must be stable: same input, same matches, every time.

**Blocked by:** 03a (benchmark foundation)

**Status:** ready-for-agent

**Effort:** ~42 h · **Roadmap:** workstream 1D part 2 (tasks 1D.5–1D.8, 1D.10; README generation 1D.9 stays in 09b), pulled ahead of its W7–8 slot because 05 measures through these scorers · **Milestone:** M1
**Verify:** `pnpm -r test` (matching/scorer suite) green; two runs on the same fixtures produce a byte-identical report; empty-dataset and no-applicable-fields edge fixtures produce no NaN and no misleading non-zero scores

- [ ] Name normalization (NFC, casefold, punctuation, whitespace) is lossless for meaningful words and digits, with the similarity threshold τ configurable
- [ ] Matching is deterministic and order-respecting, one-to-one, maximizing matched pairs first and name similarity second; a DP or LCS-style procedure, not a greedy pass
- [ ] Monetary equality in matching is integer-paise equality
- [ ] Field-level precision/recall/F1 scorers with macro averaging and explicit null semantics: null-vs-null counts only where the dataset marks the field missing
- [ ] A `benchmark.config` pins τ, score thresholds and the round-off band (gate G8t) plus the results JSON schema; published results pin snapshots, hashes, τ and averaging method
- [ ] Edge guards: empty datasets and no-applicable-fields cases never produce NaN or a misleading non-zero score
