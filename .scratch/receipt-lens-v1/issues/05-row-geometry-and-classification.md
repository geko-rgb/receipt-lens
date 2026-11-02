# 05: Read the rows — geometry and row classification

**What to build:** A pure, deterministic step that turns normalized OCR words into rows and classifies each row as an item, a continuation of the item above it, header/noise, or ambiguous — so wrapped item names stop becoming phantom items and GSTIN lines stop becoming line items, while anything unrecognized is set aside visibly instead of vanishing.

**Status:** ready-for-agent

**Effort:** ~26 h · **Roadmap:** workstream 1B (tasks 1B.1–1B.3) · **Week:** W4–5 · **Milestone:** M1
**Verify:** `pnpm -r test` runs the row geometry/classification suite over cached fixtures; two runs on the same fixture produce byte-identical output

**Blocked by:** 03b (matching and scorers — row classes must be measurable as buckets); 03a (loaders and fixture cache) is its prerequisite

- [ ] Words are grouped into rows by y-band clustering with a count-weighted tolerance expressed relative to median word height, and a right-aligned price column is inferred within a stated tolerance of image width
- [ ] Rows are classified before any content parsing, into item, continuation, noise/header, and ambiguous
- [ ] Ambiguous rows are preserved with their text, geometry and source-line reference in an unclassified-rows list — never discarded and never forced into items
- [ ] Continuation merging requires all four stated conditions together: indentation, not a charge or header, within the length cap, and not an all-caps standalone name
- [ ] Header and noise rows — column labels, tax identifiers, table furniture — never surface as items
- [ ] Given the same fixture `OcrResult`, the output is byte-identical across runs
- [ ] Behaviour is exercised through the core seam over cached fixtures, not through geometry internals
