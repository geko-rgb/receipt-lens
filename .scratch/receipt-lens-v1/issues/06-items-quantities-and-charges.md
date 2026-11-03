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

`MIKA KECIL 0` (CORD dev `cord-v2/dev/8` row 5 — a 0-based index into `classifyRows()` output, so the
sixth row) is currently classified **ambiguous** because P6
excludes bare 1–2 digit integers from the price band. If 06's money parser can distinguish quantity-0
from total-0, this row should parse correctly. If not, escalate.

52 CORD rows sit in this bucket (see the cause table in DECISIONS/0008 P7 — the test that pins it
counts a tender-shaped `CHANGE: 0` as tender first, so 52 is the remainder), so it is not one row — it
is a class. The counter-example that keeps P6's exclusion honest: admitting those integers into the
band measurement made SROIE's ambiguous rate worse, 14.8% → 18.0%.

Also yours, per DECISIONS/0008 P7: `noise_header` rows — including split-layout item **names** — are
not in `ParseResult`. Reaching them requires `classifyRows()`. And the 64 CORD ambiguous rows that are
"a price with no name" (e.g. `1,818` alone) are the amount half of exactly those split layouts: the
name is in the row above, in `noise_header`.

The preserved set is bigger than it looks, deliberately: the header zone is keyed to the price column
rather than to rule 3's verdict, which returned 66 rows (31 CORD, 35 SROIE) that an intermediate head
discarded. CORD now preserves 198 of 788 rows, of which 13 are name rows sitting directly above an
all-number row — the split-layout reattachment, counted. `DECISIONS/0008` P7's guardrail applies to you
as well as to 05: any rule change in 06 that could move a row into a discard class ships with a
pre/post transition table over the dev fixtures.

## Resolved by this ticket (2026-11-03)

**Tender rows: dropped as pattern family 5, and documented as unreachable from `ParseResult`.** 06
measured 423 dev rows as tender-shaped, of which **204 were classified `item`** — so the carry-forward's
premise (that tenders sat in the preserved set) was wrong: they were manufacturing 28.6% of the dev item
list as phantom product, and 0 of the 131 gold↔item pairs involved one. Family 5 joins P3's data tables,
matches at rule 1 and classifies these rows `noise_header`.

> Tenders are classified `noise_header` and not reachable from `ParseResult`. ADR-008 locked the public
> shape and it has no tender field. Tenders exist only in the internal `classifyRows()` output. Publishing
> tenders would require a public-shape extension (an ADR change), not a classifier change.

The P7 invariant was revised to carry named families (`noise_header` == base 3,517 + rows attributable to
a documented family); see DECISIONS/0008 and DECISIONS/0010 Q7. Guard added per condition 3:
`tender_named_items_in_ParseResult == 0` over dev fixtures.

**`MIKA KECIL 0` parses.** All 34 CORD rows carrying a bare 1–2 digit integer inside the price band are
the value `0`, and gold quantity tokens never reach that band (nearest qualified quantity band is 0.239 of
image width from the price centre), so position distinguishes quantity-0 from total-0. 17 promotions;
`PB1: 0` (×3) and `CHANGED 0` (×3) accepted as documented false positives — `CHANGED 0` is caught by
family 5's vocabulary, `PB1: 0` is retained because excluding it would refuse 17 legitimate rescues.
Full rule and numbers: DECISIONS/0010 Q6.

## Investigate before 09b publishes a gold-recovery number (carried by 05; not blocking 06)

Investigate the **16 CORD gold names not appearing in any classified row** (`rowClassification.test.ts`
reports the bucket: 156 reached / 37 dropped / 45 preserved-but-unreached / **16 absent**, of 254 gold
names). That is a floor no parser improvement can fix — those gold names are not reachable from any
classified row at all. It could be split-layout (a name above row 14 that gets dropped), a fixture quirk
(the gold name matches no OCR text), or a classifier failure. If these are split-layout cases resolvable
by reattachment, they belong in 06's scope. If they are fixture quirks or dropped noise, they need to be
enumerated so 09b's gold-recovery metric can state them as a floor rather than a parser failure. Not
blocking 05; **blocking 09b's number quality.**
