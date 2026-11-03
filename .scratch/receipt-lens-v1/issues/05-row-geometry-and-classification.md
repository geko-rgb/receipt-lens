# 05: Read the rows — geometry and row classification

**What to build:** A pure, deterministic step that turns normalized OCR words into rows and classifies each row as an item, a continuation of the item above it, header/noise, or ambiguous — so wrapped item names stop becoming phantom items and GSTIN lines stop becoming line items, while anything unrecognized is set aside visibly instead of vanishing.

**Status:** in-review — implemented on `ticket/05-row-geometry-and-classification`, `pnpm -r test` 264 passing

**Effort:** ~26 h · **Roadmap:** workstream 1B (tasks 1B.1–1B.3) · **Week:** W4–5 · **Milestone:** M1
**Verify:** `pnpm -r test` runs the row geometry/classification suite over cached fixtures; two runs on the same fixture produce byte-identical output

**Blocked by:** 03b (matching and scorers — row classes must be measurable as buckets); 03a (loaders and fixture cache) is its prerequisite

- [x] Words are grouped into rows by y-band clustering with a count-weighted tolerance expressed relative to median word height, and a right-aligned price column is inferred within a stated tolerance of image width
- [x] Rows are classified before any content parsing, into item, continuation, noise/header, and ambiguous
- [x] Ambiguous rows are preserved with their text, geometry and source-line reference in an unclassified-rows list — never discarded and never forced into items
- [x] Continuation merging requires all four stated conditions together: indentation, not a charge or header, within the length cap, and not an all-caps standalone name
- [x] Header and noise rows — column labels, tax identifiers, table furniture — never surface as items
- [x] Given the same fixture `OcrResult`, the output is byte-identical across runs
- [x] Behaviour is exercised through the core seam over cached fixtures, not through geometry internals

## Evidence (2026-11-03)

**Code:** `packages/core/src/parse/{constants,geometry,patterns,classify,index}.ts` — `parse()` is
implemented; `validate()` and `extract()` stay ticket-01 stubs. Shared row fixtures in
`parse/fixtures.ts`. Core tests: `geometry.test.ts`, `patterns.test.ts`, `classify.test.ts`,
`determinism.test.ts` (73 passing). Benchmark gate:
`benchmarks/src/parser/rowClassification.test.ts` (8 tests over the 250 committed dev fixtures).
Core tests are now typechecked in CI (`packages/core/tsconfig.test.json`), matching pwa and
benchmarks.

**Decision record:** `DECISIONS/0008-row-classification-thresholds.md` pins P1–P7 before the
classifier was written, and every number in it is re-derived by the benchmark test rather than
asserted by hand. Provider tolerance (0.5×) untouched — the parser re-clusters `OcrWords` from
scratch at 0.4× (DECISIONS/0007 honoured). DECISIONS/0006 not reopened; the parser reads no τ.

**Measured on `dev/` (250 receipts, 5,199 clustered rows from 5,604 provider lines):**
848 items, 47 continuations, 3,517 noise_header, 787 ambiguous. 1,364 rows (26.2%) carry a
price-column candidate, 3 carry two → `ambiguous_price_separator`. 2,276 money-grouped words are
protected from the identifier family by the guard in P3, and 30 rows carry an identifier token. Byte-identity: 0 failures across two
`parse()` runs on all 250 fixtures, and 20 repeats on the authored full receipt.

**Two things the review round changed in the rules, not just in prose:**
- *Telephone family in* (P3 family 4). Measured effect in `dev/` is **date suppression, not phones**:
  2 of 250 receipts carry telephone-shaped content and both sit in the header zone; 26 distinct
  grouped-digit tokens are dates. Exactly 1 row — `09/03/2018 21:28 0001` — would otherwise have
  become an item, and now does not.
- *The family fires on an identifier-only row*, i.e. every word is a grouped-digit token, a
  letter-free amount, or a telephone label. Measured: 30 dev rows carry a token and exactly 1 is
  identifier-only. A token-anywhere rule would have force-deleted the other 29 — 22 were already
  `noise_header`, **8 were `ambiguous` and are now preserved for review** (`CLOSED: 29-10-2017`,
  `FRIDAY 29-12-2017 TIME : 20:17`, `19/02/2018 16:45 [ACCOUNT]`). No dev item carries a token
  today, so the row test protects visible rows rather than rescued items; `F/CASTELL 187057-75 …`
  and `2 HH ASAHI 1+1/2 …` were never at risk because SROIE's reference OCR emits those lines as
  one whole-line word, and a token containing letters fails the shape test before the row test.

**§5 fourth-clause deviation, recorded in P7:** price-less rows after the first item are classified
`ambiguous` (preserved, warned) rather than `noise_header` (deleted). 787 dev rows are visible for
review because of this, including ticket 04's `THANK YOU` footer block. Owner-approved.

**Split name/price layouts, verified not merged:** the brief's `PC 9.00 0.00 2.00` case was checked
before accepting. Row 14's centres span 577.2–577.7, row 15's span 604.1–605.7, gap 26.4 px against
an 8.60 px band (0.4 × the 21.49 weighted-median word height) — they stay two rows and nothing is
merged. 05 emits the name row as `noise_header` and the amount row as an item named `PC 9.00 0.00`:
the single price-column word is stripped by geometry, the two off-column amounts stay in the name
because telling discount from unit price is ticket 06's job. The loss is the *name*. Accepted as a limitation
and recorded in P7.

**Gates run locally:** `pnpm install --frozen-lockfile` ✓ `pnpm build` ✓ `pnpm typecheck` ✓
`pnpm test` 264 passing (core 73, pwa 27, benchmarks 164) ✓ `pnpm scan:pii` idempotence clean,
advisories unchanged at 51 ✓ `pnpm verify:results` byte-identical ✓ fixture budget 12.0 MB / 50 MB ✓
`node scripts/model-manifest.mjs --check` ✓

**Out of scope, deliberately:** quantities, money parsing, locale profiles and typed charges
(ticket 06) — items carry `qty: null`, `unitPrice: null` and `"unresolved"` sources; validation and
confidence floors (ticket 07). `01-143008` is a known family-4 miss (`.` is not a group separator,
because treating it as one would fire the family on `1.234.567`).
