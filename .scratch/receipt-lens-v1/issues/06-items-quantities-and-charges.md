# 06: Items, quantities, provenance and labelled charges

**What to build:** Item rows become structured items with names, quantities and integer-paise prices, each value carrying where it came from; labelled money rows become typed charges — taxes, service charge, tip, discount, signed round-off — instead of items; and any labelled amount the dictionary does not recognize is preserved with its amount and a warning rather than guessed at.

**Blocked by:** 05 (row geometry and classification)

**Status:** ready-for-human

**Effort:** ~38 h · **Roadmap:** workstream 1B (tasks 1B.4–1B.8) · **Week:** W5–6 · **Milestone:** M1
**Verify:** `pnpm -r test` runs the provenance/label/locale suite over cached fixtures covering all listed fixture receipts

- [x] A quantity column is inferred only where one exists, using the stated integer and majority rule; a missing printed quantity is tentatively 1 with an assumed marker, an ambiguous quantity is unresolved with no value, and these are the only three states the parser emits — `quantity.test.ts`, and the dev states committed in `quantityMoneyPins.test.ts` (87 column / 54 pattern / 137 unresolved / 225 assumed / 1 conflicting of 504 item rows). §5's 60% majority is **inert on dev** (34 receipts at 50%, 60% and 75% alike); the floor of 5 is what decides.
- [x] Money parsing uses explicit locale profiles including Indian lakh grouping, and every amount lands on an integer-paise boundary — `money.test.ts` pins the grammar table; `1,23,456.78` → 12345678 paise, `1,23,4` and `1,23,456.789` refused. Dev: 372/372 gold bill-level amounts and 222/222 CORD gold item line totals reproduced, equal to an oracle profile.
- [x] The label dictionary matches longest-first over the English/Indian-English label set, so a two-word tax label never fragments into a phantom item — `labels.test.ts`; `SUBTOTAL` never reads as `TOTAL`, `SERVICE CHARGE` stays one label, and the equal-length overlap the tie-break would need is proven impossible against the matcher (0 witness strings).
- [x] Recognized labels produce typed charges: tax entries, service charge, tip, discount, and a signed round-off in paise — 682 dev rows typed (grandTotal 393, tax 138, subtotal 82, discount 45, service 21, roundOff 3). `tip` fills on **0 dev receipts**: no dev receipt prints one, so that branch is covered by an authored fixture, not by the corpus.
- [x] An unclassified labelled charge keeps its label text and amount and carries a warning, rather than becoming an item or being dropped — 16 dev rows land in `otherCharges` with `sign: "unknown"`, an `unclassified_charge` warning carrying the row's text and box, and `amount: null` because an amount this parser cannot establish is not an amount it may choose.
- [x] Recognized labels populate the canonical public charge shape owned by 02 — tax entries, service charge, tip, discount, signed round-off and other charges, not a discriminated union — consuming it as defined and never redefining it — `packages/core/src/types.ts` is untouched by this ticket.
- [x] Each item's printed line total is retained separately from anything later computed — `lineTotal` is the row's price-column amount (or a promoted `0`) and nothing computes it from other fields; `unitPrice` is read from a printed `@` marker or equals the total only at quantity 1, and is never `lineTotal ÷ qty`.
- [x] Fixtures cover wrapped names, a two-part tax pair, an included-tax receipt, an unlabelled money row, and a receipt with no quantity column — `parse/fixtures.ts` (`WRAP_1`/`WRAP_2`, `TAX_PAIR_ROW`, `INCLUDED_TAX_ROW`, `NAMELESS_AMOUNT_ROW`, `ITEM_A`+`ITEM_B`), asserted in `parse.test.ts` and `classify.test.ts`.

**Not done here, by design:** `validate()` stays ticket 07's. The parser emits `qty_assumed`,
`qty_unresolved`, `unclassified_charge` and 05's two ambiguous codes; the confidence floors,
`item_without_price`, `price_not_resolved`, `name_length_outlier` and every arithmetic finding belong to
§6 and to 07.

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
measured 441 dev rows as tender-shaped, of which **209 were classified `item`** — so the carry-forward's
premise (that tenders sat in the preserved set) was wrong: they were manufacturing 28.6% of the dev item
list as phantom product, and 0 of the 131 gold↔item pairs involved one. Family 5 joins P3's data tables,
matches at rule 1 and classifies these rows `noise_header`.

> Tenders are classified `noise_header` and not reachable from `ParseResult`. ADR-008 locked the public
> shape and it has no tender field. Tenders exist only in the internal `classifyRows()` output. Publishing
> tenders would require a public-shape extension (an ADR change), not a classifier change.

The P7 invariant was revised to carry named families (`noise_header` == base 3,517 + rows attributable to
a documented family); see DECISIONS/0008 and DECISIONS/0010 Q7. Guard added per condition 3:
`tender_named_items_in_ParseResult == 0` over dev fixtures.

**`MIKA KECIL 0` parses.** 49 CORD rows carry a bare 1–2 digit integer inside the price band; 44 of them
are the value `0`, and the 5 that are not are `Total Item 7`, `Total Qty 7`, `TOTAL ITEMS 2`,
`Total item 3 Total Qty 3` and `Free Kembalian 50` — counts, not money. Gold quantity tokens never reach
that band, so position distinguishes quantity-0 from total-0. **14 rows promoted, every one with
`lineTotal === 0`** (asserted). `PB1: 0` (×3) retained as a documented false positive; `CHANGED 0` and
`Kembalian 0` are caught by the family instead. Full rule and numbers: DECISIONS/0010 Q6.

**Two things the transition table forced open.** (1) Family 5 initially moved 38 rows that were not
tender-shaped into `noise_header`, because rule 1 runs before P7's priced-rows counter and a discarded
tender stopped opening the item region for everything below it. A tender prints at the *end* of the priced
block, so its price-column entry still marks item position; the family is now counted as opening the
region and the unattributed movement is 0. (2) Q6's rescue was refusing the very rows it exists for:
`2 TUTUP SEAL 0` prints a quantity and a total, and the quantity read as "another amount on the row".
Promotions went from 8 to 14 when small integers and rates were excluded, the same way Q1 and Q5 exclude
them.

## Investigate before 09b publishes a gold-recovery number (carried by 05; not blocking 06)

Investigate the **16 CORD gold names not appearing in any classified row** (`rowClassification.test.ts`
reports the bucket: 156 reached / 37 dropped / 45 preserved-but-unreached / **16 absent**, of 254 gold
names). That is a floor no parser improvement can fix — those gold names are not reachable from any
classified row at all. It could be split-layout (a name above row 14 that gets dropped), a fixture quirk
(the gold name matches no OCR text), or a classifier failure. If these are split-layout cases resolvable
by reattachment, they belong in 06's scope. If they are fixture quirks or dropped noise, they need to be
enumerated so 09b's gold-recovery metric can state them as a floor rather than a parser failure. Not
blocking 05; **blocking 09b's number quality.**

### Findings — the 16 absent gold names (investigated 2026-11-03)

**Verdict: row geometry, not the classifier's four rules, and not a fixture quirk in the sense the
carry-forward suspected. 06 cannot fix it and 09b must state it as a floor.**

Method: for each of the 16, take the annotated line that carries the gold name, compare the vertical
spread of that line's own word centres against the parser's y-band tolerance (P5's `0.4 ×` the
word-count-weighted median word height), and check whether every word of the name exists somewhere in the
row set.

| result | count |
|---|---|
| gold names whose text appears nowhere in the OCR | **0 of 16** |
| gold names whose every word is present in some classified row | **16 of 16** |
| gold names whose words are present but **not contiguous in any one row** | 16 of 16 |
| receipts involved | 7 of 100 (`dev/2`, `/24`, `/25`, `/37`, `/40`, `/41`, `/94`) |

CORD's reference OCR gives the words of one annotated line staggered vertical positions. The annotated
line's own word-centre spread runs from **0.3× to 3.4× the band tolerance** (median 2.2×), so
single-linkage clustering — which 0008 P5 pinned as a *chain*, deliberately transitive — either splits
one printed line or, with a tight line pitch, chains two printed lines into one row. The row's words are
then ordered by x, which interleaves them:

```text
cord-v2/dev/24  line "PAIN AU CHOCOLATE"   word centres span 13.5px against a 21.6px tolerance
              → ROW 1 [ambiguous] "1 1 PAIN CHOCO AU CUSTARD CHOCOLATE PASTRY 12,000 9,000"
cord-v2/dev/94  line "Emily's Shrimp Scampi Fettucine"  span 46.5px against 13.6px  (3.4×)
              → ROW 1 [ambiguous] "1 Emily's Shrimp Scampi"
cord-v2/dev/40  line "Gojek French Fries"  span 49px against 16px  (3.1×)
              → ROW 4 [item] "Gojek French 1 70,000"
```

Two consequences for 09b, both stated rather than smoothed:

1. **The 16 are a floor for the current clustering, not for the parser's content reading.** Reaching them
   means revisiting P5's tolerance or replacing single-linkage chaining — a 0008 decision, and 0008
   already says what the tuning signal for it is: 03b's row-classification bucket, which needs a real
   parser (now: this ticket's) before it can be read. Reattachment does not help: the words are already in
   a row, mixed with a neighbour's, which is a different problem from a name row sitting above an
   all-number row.
2. **Substring containment, the metric `rowClassification.test.ts` uses, is the wrong shape for these
   receipts in both directions.** It scores the 16 as absent although every word was read, and it silently
   *credits* a scrambled row that happens to contain the name contiguously by accident. 09b should state
   gold-name reachability as field-level (the matcher 03b committed) rather than as a substring test, and
   report the 16 as a geometry-bounded set with the mechanism named.

At this ticket's head the buckets are 164 reached / 37 dropped / 37 preserved / **16 absent** of 254,
against `20e4459`'s 156 / 37 / 45 / 16. `absent` is unchanged, which is the point: nothing in 06's scope
moved it, and four names moved from preserved to reached because removing the phantom tenders let real
rows keep their names.
