# DECISIONS/0032 — Anchor-based row clustering for three-column receipts

Date: 2026-11-07 · Ticket 27 (PR #27, merge `960e44d`) · **Status: LOCKED (2026-11-07).**
Extends `DECISIONS/0008` P5 (y-band row clustering) and applies P6's price column as the anchor.
Related: `PROJECT(1).md` §5.1/§5.2, `DECISIONS/0007` (rows are never the provider's reading-order
lines), `DECISIONS/0010` Q1 (the quantity column).

## The decision

When a receipt has **both** a detected price column (at least 3 aligned amounts, P6 from raw words)
**and** a detected quantity column (`detectQuantityColumn`, §5's "≥60% of the band's rows hold
integers ≤ 20"), row clustering uses amount-line anchors instead of tolerance-based single-linkage
chaining. Two-column (`name | price`) and single-column receipts fall through to the existing
tolerance path unchanged.

`packages/core/src/parse/geometry.ts`:

- `inferPriceColumnFromWords` — the price column read from words alone, so a column exists before
  any row does. Requires `ANCHOR_MIN_COLUMN_MEMBERS` (3) aligned amounts.
- `clusterRowsByAnchor` — anchor lines are the price column's amount-word **vertical centres**,
  merged within `ANCHOR_MERGE_PX` (8). Each word joins the first line whose reach holds its centre;
  reach is asymmetric and scaled by the anchor word's own box height (`ANCHOR_UP_REACH_RATIO` 0.25
  up, `ANCHOR_DOWN_REACH_RATIO` 0.7 down) and clamped to the neighbouring line, so a tall box can
  never reach past the next row's amount into that row's unit price. Words no line reaches keep the
  y-band rows, which is what preserves headers, footers and short printed lines such as
  `Round off +0.50`.
- `clusterRows` — keeps `clusterRowsByTolerance` as the default and takes the anchor path only when
  the caller established both columns; it also falls back when an anchor line is empty or a row
  still carries two price-column amounts.

No `ParsedItem`/`ParseResult` type and no `validate()` behaviour changes. No benchmark fixture,
expectation or published count was touched.

## Why

A real Indian restaurant receipt (1200×1600, faded print, three printed columns Qty | Price |
Amount, PP-OCRv6 **Small**) parsed **5 of 10** priced rows, with 4 rows left ambiguous. The word
boxes on that page range from **22px to 79px** tall, so §5.1's band — 0.4 × the word-count-weighted
median = **21.86px** — sits inside both the "should merge" and the "should split" distributions: it
split `Malai Soup` / `Paneer Tawa` off their own amount and merged the `Nool Soup Porotta` and
`Matar Paneer` rows into one.

The diagnostic counterfactuals localised the bug to `clusterRows` rather than to recognition or to
the downstream stages: with the same damaged text and corrected geometry the page yields 10/10
rows, and with the same damaged geometry and corrected text it also yields 10/10.

The amount column repeats exactly once per priced row regardless of how badly the names are boxed.
Its word centres on this receipt are 332.5 / 407.5 / 484.2 / 555.8 / 599.2 / 651.7 / 695.8 / 743.3 /
789.2 / 875 — ten lines for ten rows.

## Gating

The literal "nearest anchor" rule was **not** sufficient: names print 24–29px below their amount, so
the next row's amount line is often nearer than the word's own (`Nool Soup Porotta`, `Matar Paneer`).
Reach is therefore asymmetric and height-scaled rather than a plain Voronoi split.

The quantity-column gate is what keeps the change surgical. `detectQuantityColumn` (ticket 06,
§5) distinguishes a three-column Indian receipt (**detected**: `side left, rows 7, share 1`) from the
two-column CORD/SROIE pages (**not detected**). That is the measured reason the 310 benchmark pins
hold: `cord-v2/024` and `sroie/135` would otherwise have been re-cut by this path, moving CORD items
from 713 to 722. Quantity detection is a per-row statistic, so it is measured on the y-band rows
before the anchor path is chosen.

## Trade-offs

- **+5 items** on the real receipt (5 → 10), all five money values correct: grandTotal 194300,
  CGST 4625, SGST 4625, roundOff 50.
- **Zero benchmark regressions** — core 222 / pwa 409 / benchmarks 310, all green, nothing re-pinned.
- One unclassified row remains (`Sub`, the subtotal label, whose up-reach falls outside its anchor's
  band). The subtotal was `null` before this change too.
- Two qty-2 items still carry `unitPrice: null` and names still include the printed unit-price word;
  both are pre-existing `items.ts` behaviour, out of scope here.
- The anchor path is a correction layer, not a replacement: a page the band already reads keeps the
  rows it was measured with, so the published corpus numbers remain re-derivable.

## Reversibility

Reverting `packages/core/src/parse/{geometry,classify,constants}.ts` restores the tolerance path
entirely. No types, no `validate()`, no benchmark fixtures and no dataset measurement were touched,
so no re-measurement is needed to revert.
