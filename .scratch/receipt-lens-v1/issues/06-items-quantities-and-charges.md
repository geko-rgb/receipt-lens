# 06: Items, quantities, provenance and labelled charges

**What to build:** Item rows become structured items with names, quantities and integer-paise prices, each value carrying where it came from; labelled money rows become typed charges — taxes, service charge, tip, discount, signed round-off — instead of items; and any labelled amount the dictionary does not recognize is preserved with its amount and a warning rather than guessed at.

**Blocked by:** 05 (row geometry and classification)

**Status:** ready-for-agent

**Effort:** ~38 h · **Roadmap:** workstream 1B (tasks 1B.4–1B.8) · **Week:** W5–6 · **Milestone:** M1
**Verify:** `pnpm -r test` runs the provenance/label/locale suite over cached fixtures covering all listed fixture receipts

- [ ] A quantity column is inferred only where one exists, using the stated integer and majority rule; a missing printed quantity is tentatively 1 with an assumed marker, an ambiguous quantity is unresolved with no value, and these are the only three states the parser emits
- [ ] Money parsing uses explicit locale profiles including Indian lakh grouping, and every amount lands on an integer-paise boundary
- [ ] The label dictionary matches longest-first over the English/Indian-English label set, so a two-word tax label never fragments into a phantom item
- [ ] Recognized labels produce typed charges: tax entries, service charge, tip, discount, and a signed round-off in paise
- [ ] An unclassified labelled charge keeps its label text and amount and carries a warning, rather than becoming an item or being dropped
- [ ] Recognized labels populate the canonical public charge shape owned by 02 — tax entries, service charge, tip, discount, signed round-off and other charges, not a discriminated union — consuming it as defined and never redefining it
- [ ] Each item's printed line total is retained separately from anything later computed
- [ ] Fixtures cover wrapped names, a two-part tax pair, an included-tax receipt, an unlabelled money row, and a receipt with no quantity column

## Regression carried to you by ticket 05 (2026-11-03)

`MIKA KECIL 0` (CORD dev `cord-v2/dev/8` row 5) is currently classified **ambiguous** because P6
excludes bare 1–2 digit integers from the price band. If 06's money parser can distinguish quantity-0
from total-0, this row should parse correctly. If not, escalate.

36 CORD rows sit in this bucket (see the cause table in DECISIONS/0008 P7), so it is not one row — it
is a class. The counter-example that keeps P6's exclusion honest: admitting those integers into the
band measurement made SROIE's ambiguous rate worse, 14.8% → 18.0%.

Also yours, per DECISIONS/0008 P7: `noise_header` rows — including split-layout item **names** — are
not in `ParseResult`. Reaching them requires `classifyRows()`. And the 64 CORD ambiguous rows that are
"a price with no name" (e.g. `1,818` alone) are the amount half of exactly those split layouts: the
name is in the row above, in `noise_header`.
