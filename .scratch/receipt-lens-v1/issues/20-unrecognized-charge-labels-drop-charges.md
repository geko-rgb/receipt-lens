# 20: Unrecognized charge labels silently drop charges from ParseResult

**What to build:** A labelled money row whose label is outside §5's dictionary still becomes a visible,
addressable charge with a warning, instead of disappearing — so that `validate()`'s arithmetic can
reconcile a receipt whose service charge prints as `P.Rest 10%`, `PB1 (10%)`, `SERV CHARGE 10%` or
`SR@6%`, and so a reviewer sees an unclassified charge rather than a total that silently fails to add up.

**Blocked by:** 06 (items, quantities and charges) — the code path is 06's; 07 reported the consequence
and did not repair it.

**Status:** ready-for-human

**Effort:** ~8 h · **Roadmap:** workstream 1B follow-up (1B.6 label dictionary) · **Week:** — · **Milestone:** M1
**Verify:** `pnpm -r test` runs the charge-preservation suite; `pnpm -r test` re-derives the dev counts
committed in `benchmarks/src/parser/validationPins.test.ts` against the fixed parser

## The gap

§5 line 159 states the requirement twice, in the parser rules and in business.md §11.5:

> An amount with an unrecognized label is preserved with its label text and a warning (`unclassified_charge`)
> — never guessed into an item, never dropped.

`parse/charges.ts:108` does the opposite:

```ts
if (category === null) continue;   // DECISIONS/0010 Q2/Q5: label not in §5's dictionary
```

A row that carries a readable amount but no dictionary label reaches no field of `ParseResult`. There is
then nothing for `validate()` to address: 07's `unclassified_charge` finding **cannot** fire on a row that
produced no charge object. The spec's own remedy is unreachable for exactly the rows it was written for.

This is not the `Srv Ch` curiosity DECISIONS/0010 Q2 recorded as a reported-but-not-fixed gap. It affects
**every** unrecognized label, and dev shows it is the common case, not the edge case.

## Measured evidence (dev, 250 receipts)

- The complete label set that ever reaches `ParseResult` charges is `gst`, `pajak`, `tax`, `total` —
  committed in `validationPins.test.ts` ("emission census"). Every other charge label in the corpus is
  invisible.
- **11 of the 27** dev receipts where Σ item line totals exceed the printed subtotal have an item whose
  printed row carries a `%` token; **for 8 the excess is exactly those items' sum**. Committed in
  `validationPins.test.ts` ("the item-sum criticals are over-inclusive item lists").
- The leaked rows are ordinary Indian/Indonesian/Malaysian service-charge and SST prints:
  `PB 1 10% 8.100`, `P.Rest 10 %`, `PB1 (10%)`, `P. Resto 10%`, `SERV CHARGE 10%`, `SR 6% 54.56`,
  `SR= 6% 559.53`, `SR@6% 40.00`, `10% SRV CHG`, `SR ((@6%)`.
- Tender labels leak the same way and are **not** in DECISIONS/0010 Q7's tender family either: 06's own
  `matchesTenderFamily` accounts for the excess on only **1 of 27**, leaving `BCA Card 308,000`
  (`cord-v2/dev/22`) and `DEBIT BCA 52,000` (`cord-v2/dev/84`) as items.
- The parse is not wrong about subtotals: where CORD annotates a subtotal, 06 reads it correctly on
  **21 of 21** checkable receipts. The item list over-counts because a charge row was never recognized
  as a charge.

## Why the label is the whole problem

`matchesChargeLabel` is a dictionary lookup, so an unknown label is not merely unclassified — it removes
the row from the class the classifier consults. §5 line 385's safeguard, *"Charge labels are matched
before numeric rows are classified as products"*, therefore cannot fire, and 05 keeps the row in class
`item`. 06's charge reader only ever visits `noise_header` rows, so the amount is consumed as a line total
instead. The gap and the classification leak are one defect seen from two sides.

## Work items

- [ ] Preserve an unrecognized-label row that carries a readable price-column amount as
      `otherCharges[]` with `sign: "unknown"` + `unclassified_charge`, per §5 line 159. Amount not
      guessed, type not guessed, row not dropped.
- [ ] Owner ruling needed on the dictionary: which labels enter §5's list. The dev population is
      `PB` / `P.Rest` / `PB1` / `P. Resto` (service charge), `SR` / `SST` / `SERV CHARGE` / `SRV CHG`
      (service charge and SST), and `DEBIT`/`CREDIT`/`BCA`/`CARD` payment lines (tender, not charge).
      06 does not extend a spec-owned dictionary on initiative (DECISIONS/0010 Q2), and neither does
      this ticket.
- [ ] Whether a `%`-bearing row may be classified as a charge at all without an amount, and what that
      does to the header zone (DECISIONS/0008 P7's priced-rows counter — the same interaction Q7's
      tender family had to answer, with the same transition-table requirement).
- [ ] Re-derive the 27-receipt census after the fix; the acceptance signal is that `arithmetic_item_sum`
      criticals on dev drop from 27 toward the phantom-item residue, **with no tolerance added to 07**.

## Constraints

- `ParseResult`, `ParsedItem` and `ParseValidationResult` are not reshaped.
- The §5 label dictionary is spec text; `PROJECT(1).md` is not edited and the dictionary is not widened
  by an implementing agent.
- The transition table rule from DECISIONS/0008 P7 applies: a classification change must publish a pre/post
  table naming both heads, and must not silently move rows into the discard class.
