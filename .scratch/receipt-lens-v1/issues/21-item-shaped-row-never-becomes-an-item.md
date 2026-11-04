# 21: An item-shaped price-bearing row that never becomes a ParsedItem

**What to build:** A receipt line that looks like a product and prints an amount in the price column becomes
a `ParsedItem`, or it is reported as a *reason* rather than just preserved — so that a two-line receipt does
not silently produce a one-item bill that the creator has to reconstruct by hand.

**Blocked by:** 05 (row geometry and classification), 06 (items, quantities and charges)

**Status:** ready-for-human

**Effort:** ~8 h · **Roadmap:** workstream 1B follow-up · **Week:** — · **Milestone:** M1 exit / M3 carry
**Verify:** `pnpm -r test` (the parser suites) and the reproduction in `playwright/bill-editor.spec.ts`

## Surfaced by

Ticket 11's acceptance receipt, drawn at 900×1200, `bold 56px monospace`, x=60, y=220+160·i:

```
RECEIPT
COFFEE 4.50
NAAN 60.00
TOTAL 100.00
```

`parse()` returns **one item** — `i1` "COFFEE", `qty 1` `quantitySource: "assumed"`,
`unitPrice 450` `priceSource: "detected"` — and preserves `NAAN 60.00` as `unclassifiedRows[0]` (`u1`,
`reason: "ambiguous"`, `ambiguous_row`). Both lines are item-shaped and both carry a price-column amount;
only one of them became an item.

Ticket 11 does the right thing with it: the editor lists the draft, shows `ambiguous_row` as a coded
finding, and the acceptance walk then *completes the bill by hand*, which is exactly ticket 11's own
acceptance case ("so a partial receipt can still become a complete bill"). **The editor behaviour is
correct; the parse is the gap**, and it is filed here rather than papered over in the editor.

## The question, per the owner's framing

> Investigate whether this is the same class as the 27 `arithmetic_item_sum` criticals (charge/tender rows →
> items) or a new class (item-shaped rows → not items).

The two directions are opposite, which is why it is not automatically ticket 20's problem in new clothing:

| | ticket 20's class | this row |
|---|---|---|
| Mechanism | a charge/tender label outside §5's dictionary → 05 keeps the row in class `item` → 06 consumes the amount as a line total | the row is **not** turned into an item; it lands in `unclassifiedRows` |
| Effect on Σ items | over-counts → `arithmetic_item_sum` critical | under-counts → `items_may_be_missing` (0011 V1 row 3/5), the parsimonious reading of an incomplete list |
| Direction | too many items | too few items |

So the first thing this ticket must answer is which it is, with evidence: the `%`/tender mechanism is
already measured on dev (8 of 27 excesses attributed exactly), and nothing in DECISIONS/0008 P7,
DECISIONS/0010 Q2/Q5/Q7 or DECISIONS/0011 explains a *priced, lettered, non-percentage* row being dropped.
If it turns out to be a new class, name it and pin its trigger condition; if it is ticket 20's class seen
from the other side, say so and link the two.

## Work items

- [ ] Reproduce at row level: print 05's `classifyRows` result and 06's `readItems` decision for the four
      lines above. Establish *which* predicate refuses `NAAN 60.00` — the price column, the quantity band,
      the continuation test, or the name rule (`§5` line 347's continuation and the "row with no name"
      refusal both produce this shape).
- [ ] Decide whether the fix is classification (05) or item reading (06), and publish a pre/post table
      naming both heads (DECISIONS/0008 P7's rule — a classification change must show what moved and where
      it went, and must not silently move rows into the discard class).
- [ ] Check the dev corpus for the population of this class: how many dev receipts have ≥1
      `ambiguous_row` that carries a price-column amount **and** letters and **no** `%` token and is not a
      tender label. If it is large, this is a recall bug, not a curiosity, and M1-exit accuracy needs the
      number restated.
- [ ] If a row genuinely cannot be classified as an item, keep the current behaviour (preserve + warn) and
      make the *reason* addressable, so the UI can say "this line was not added because X" instead of
      leaving the creator to notice a missing item. That is an `UnclassifiedRow` question for ticket 13,
      which already owns the "explicitly excluded" gap (DECISIONS/0020 T8).

## Constraints

- `ParseResult`, `ParsedItem`, `UnclassifiedRow` and `ParseValidationResult` are not reshaped here.
- No tolerance, floor or threshold is tuned to make a number look better (the standing rule DECISIONS/0011
  published for the validator, and the same one that stops 20 from widening the label dictionary on
  initiative).
- The §5 label dictionary and §5's thresholds are spec text; `PROJECT(1).md` is not edited by an
  implementing agent except by owner instruction.
- Ticket 11's `playwright/bill-editor.spec.ts` currently *depends* on this behaviour (it asserts the
  preserved `ambiguous_row` and completes the bill by hand). If this ticket changes the parse, update that
  spec's arithmetic in the same commit and say so — do not leave a green suite that asserts a bug.
