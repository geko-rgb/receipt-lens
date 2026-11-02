# DECISIONS/0003 — Fixture keying and fixture provenance

Date: 2026-11-02 · Owner decision (ticket 03a kickoff).

**Reference-OCR fixtures are keyed by dataset snapshot hash only.** The provider and
model dimensions do **not** enter the key for these fixtures; they apply to future
OCR-derived fixtures generated on demand (ticket 04 provider, ticket 09b measurement),
not to CI parser fixtures.

This is a recorded deviation from `PROJECT(1).md` §8 and from 03a's ticket line "keyed
by snapshot + provider + model hash with full keys". The ticket text stays as written;
this file supersedes it for the reference-OCR fixture class.

**Snapshot hash definition** (computed from `benchmarks/datasets/dataset-manifest.json`
over bytes verified against the pins on 2026-11-02, all 12 files byte-exact):
`sha256` of the per-dataset canonical list — files sorted by name, one `"<name> <sha256>"`
line each, `\n`-terminated lines, trailing newline.

- `cord-v2` = `aa5f5674d40e710046c3e0ba30829b9e10937b7a45b185b0c706c2171d6d0c94`
- `sroie` = `483632b50b77561ec732d35487c8ff790b8c8380fce42305fcaab9ee665cccd4`

Manifest `files[].name` values are relative to `benchmarks/datasets/raw/<datasetKey>/`,
not to `raw/`.

**These fixtures are the dataset's reference OCR, not our OCR's output** (spec §8
parser-only mode). They are derived from dataset annotations alone, so they are
deterministic from the dataset and CI isolates parser regressions from OCR noise. Every
score produced against them is therefore a **ceiling** on real-world accuracy, never an
estimate of it; the report states its headline mode explicitly.

**Line reconstruction.** SROIE fixtures reconstruct line boundaries via deterministic
y-clustering; CORD uses the dataset's own line grouping (`valid_line`). **SROIE fixture
lines are harness-derived, not dataset facts.**

- SROIE gives a flat word list with `[x1,y1,x2,y2]` rectangles and no line membership.
  Words are ordered by (`yCenter`, `x1`) and a new line starts when a word's `yCenter`
  differs from the current band's running `yCenter` by more than `0.5 × median word
  height` across the receipt. Fixed constant, no tuning against any score.
- CORD `valid_line` entries are already lines; each becomes one `OcrLine`, words in
  annotation order, boxes from the `quad` corner points.
- Confidence is `null` for every word in both datasets: neither snapshot provides a
  meaningful OCR score and fabricating one is forbidden. This keeps the
  `confidence_unavailable` path exercised by the whole benchmark.
- Line grouping affects only the parser's input shape. SROIE gold is grand-total-only,
  so no score depends on how SROIE words were grouped into lines.
