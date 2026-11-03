# DECISIONS/0006 — Name-similarity metric and the `τ_name` pin

Date: 2026-11-03 · Ticket 03b. Closes the Tier-3 gap in `PROJECT(1).md` §8.2: the spec
requires candidate pairs where "normalized-name similarity is at least `τ_name`" but never
defines the similarity function, and never gives `τ_name` a value. §8.6 requires both to be
pinned in `benchmark.config` **before** results are reported; `ROADMAP.md` G8t pre-declares
`0.70` as the M1-exit default.

**Decision: normalized Levenshtein, `τ_name = 0.70`.**

```text
sim(a, b) = 1 − lev(a, b) / max(len(a), len(b))      sim("", "") = 1.0
```

computed over names already normalized per §8.1 — Unicode NFC, casefold, punctuation
replaced by a space, whitespace collapsed, **words and digits kept**. Edit distance is
unit-cost; no early-exit threshold is used inside the DP, so the score is exact.

## Why this surface, and why it decided the question

§8.2 gates a candidate pair on *both* name similarity and integer-paise monetary equality.
So a false candidate can only form between two items that also agree on money. That subset,
not the whole within-receipt pair space, is where a metric can actually do damage. Measured
over `dev/cord-v2` only (254 gold items, 229 distinct normalized names, 228 of them non-empty
— DECISIONS/0004 forbids tuning against `eval/`; all negative counts below are **unordered**
pairs):

| Metric | single-substitution variants kept | false candidates on the **money-equal** surface (n=16) | same-first-word distinct items (n=60) |
|---|---|---|---|
| normalized Levenshtein @0.70 | 99.42% | **0 (0.0%)** | 5 (8.3%) |
| Jaro @0.70 | — | 3 (18.8%) | 43 (71.7%) |
| Jaro-Winkler @0.70 | — | 3 (18.8%) | 43 (71.7%) |

**On the dev money-equal surface, Jaro-Winkler admits 3 of 16 false candidates at τ=0.70
(18.8%), including the same-brand-different-dish pattern; LEV admits 0.** (The earlier working
note said 3 of 17 / 17.6%: §8.2 gates on *both* monetary fields, so a pair whose other amount
conflicts can never become a candidate and was removed from the surface. The committed sweep
measures 16.)

The false candidates Levenshtein refuses and Jaro accepts are real menu pairs, not synthetic
near-duplicates:

- `Jamur Enoki` vs `Jamur Kuping` (dev receipt `079`) — two different mushrooms, same
  receipt, both qty 1, both line totals 800000. Levenshtein 0.500, Jaro 0.819,
  Jaro-Winkler **0.891**. This is the exact pair the money gate cannot rescue, because the
  money gate is what admits it.
- `ICE COFFE MIX` vs `ICE BLACK COFFE` (dev receipt `041`) — Levenshtein 0.333, Jaro-Winkler
  0.847. Both annotate a line total of **0**, so money equality is satisfied trivially here
  while `qty` differs (3 vs 1). §8.2 gates on monetary fields only, so qty is scored, never a
  gate — which is precisely why the name threshold has to carry the discrimination.

Because the matcher's objective is *pair count first*, a spurious high score between two
money-equal distinct items is not merely a wrong tie-break: it lets the DP swap two pairings
and silently convert one false positive plus one false negative into a match that then gets
scored as field agreement. The failure mode is a **quieter** benchmark, which is the one
thing a scorer must never produce. Jaro-Winkler's prefix bonus is structurally the wrong
shape for receipt menus, where the discriminating token is the *last* word
(`MIKA KECIL` / `MIKA BESAR`, `TOP OREO` / `TOP BANANA`).

## Where Jaro-Winkler is better, and why we still lose nothing

Levenshtein is the weaker metric on truncation. Over the 454 right-clipped variants of the dev
name pool — every distinct name cut to 75% and to 50% of its length — it keeps **176 of 454
(38.8%)** at τ=0.70, where Jaro-Winkler keeps **454 of 454**. That is a real gap, and it is
deliberately not bought. A prediction whose name is truncated relative to
gold is a **row-segmentation** failure (ticket 05's geometry work), not a name-spelling
variant; §8.4 wants it to surface as one false positive plus one false negative. A metric
that forgives it would hide a segmentation bug inside the metric whose job is to expose the
downstream consequence of that bug. Note also that the dominant *real* variant classes in
these fixtures — 142/254 gold names print in caps, 60/254 carry punctuation — are reduced to
similarity exactly 1.0 by §8.1 normalization alone, so τ spends its budget on character-level
noise, where Levenshtein behaves monotonically, not on length-level noise.

## Why 0.70 rather than 0.75 or 0.80

The committed sweep over `dev/cord-v2`. Variants are **exhaustive, not sampled** — every
single substitution of a non-space character by a different `a-z0-9` character (97,300 cases),
every adjacent transposition (2,089), every right-clip to 75% and 50% (454) — so nobody has to
trust a seed. False-candidate counts are pairs above τ, out of the surface size in the header.

| τ | substitution kept | transposition kept | truncation kept | money-equal false (n=16) LEV / Jaro / JW | same-first-word false (n=60) LEV / Jaro / JW |
|---|---|---|---|---|---|
| 0.60 | 99.75% | 98.95% | 49.3% | 0 / 5 / 5 | 10 / 55 / 55 |
| 0.65 | 99.75% | 98.09% | 48.2% | 0 / 3 / 3 | 7 / 50 / 50 |
| **0.70** | **99.42%** | **96.74%** | **38.8%** | **0 / 3 / 3** | **5 / 43 / 43** |
| 0.75 | 99.42% | 95.64% | 13.2% | 0 / 1 / 2 | 4 / 24 / 43 |
| 0.80 | 98.71% | 90.09% | 0.0% | 0 / 1 / 2 | 1 / 17 / 43 |
| 0.85 | 96.58% | 66.16% | 0.0% | 0 / 0 / 1 | 1 / 6 / 24 |

The money-equal surface — the surface that can actually produce a false candidate — is at
zero for Levenshtein at every τ from 0.60 to 0.85, so tightening past 0.70 buys that metric no
safety at all while costing transposition tolerance (96.74% → 95.64% → 90.09% → 66.16%) and
truncation tolerance (38.8% → 13.2% → 0%). It does buy the rejected metrics safety — Jaro
3 → 0 and Jaro-Winkler 3 → 1 across the same range — which is another way of saying their
scores are not separated from distinct dishes until τ is uncomfortably tight. Loosening below
0.70 starts admitting same-prefix distinct items for Levenshtein too (5 → 7 → 10 of 60).
**0.70 is the highest-recall end of the flat-safe region**, it is `ROADMAP.md` G8t's
pre-declared default, and no number in this project has been tuned to it, because 03a's
null-parser bootstrap scores 0 on every metric with or without a τ.

## Accepted limitations, stated rather than discovered later

- **Short names tolerate no OCR error.** 12 of the 228 non-empty distinct dev names are ≤4
  normalized characters (`milo`, `tahu`, `paru`, `hot`, `ice`, `ayam`, `100`, …). A single
  substitution in a 3-character name scores 0.667, below τ. Accepted: those names are exactly
  where a wrong pairing is most damaging, and monetary equality still gates the pair.
- **Duplicate names exist in the fixtures, so τ ties are a real case.** 5 of the 100 dev
  receipts carry two gold items whose normalized names are identical — `cha keaw l` ×2 at the
  same integer line total, `sunrise italian soda` ×2, `top oreo` ×2. Every such pair scores
  1.0, so the DP cannot rank one over the other: tie-breaking must be a declared function of
  index order, not of iteration accidents (see the matcher's determinism tests).
- **One dev gold item prints `-` and normalizes to the empty string.** An empty name carries
  no name evidence, so by the formula above it can only pair with another empty name
  (`sim("", x) = 0` for non-empty `x`). This is a fixture fact, not a hypothetical; the
  matcher's test suite pins it rather than special-casing it away.
- **`sim("", "") = 1.0`** is a definition, not a limit of the ratio (which is 0/0). It exists
  so no similarity computation can ever return NaN.

## What this record does not decide

- τ gates *pairing* only. Tier-1 strict and field-level `item.name` agreement use **exact
  equality of normalized names** (§8.1), never "≥ τ" — a name that needs tolerance to match is
  a match for pairing purposes and a field miss for scoring purposes.
- "Compatible monetary fields" (§8.2) is settled as **non-conflicting at the pairing gate**:
  where both sides annotate an amount the integers must be equal, and a field one side lacks
  does not vote. It is *not* a scoring leniency — see the correction below. In `dev/cord-v2`
  gold, `unitPrice` is null on **205 of 254** items (80.7%), `qty` on 56 (22.0%) and `lineTotal`
  on 32 (12.6%), so a gate demanding equality on an unannotated field would refuse about four
  fifths of true pairs and report every price-parse failure as a *missing item*.
- The two OCR confidence floors stay at the §6 defaults (0.50 critical, 0.70 warning) — **ticket 07**
  owns them (`07-validation-findings-and-extract.md`), not this file and not ticket 04: 04 ships the
  OCR provider and implements no validation, so it never reads those floors. Pinned at M1 exit per §17.
- The round-off band (§6: within ₹0.02 of `expected_round_off`, magnitude ≤ ₹1.00) is pinned in
  `benchmark.config` by this ticket because G8t groups all three, but no matcher behaviour
  depends on it.

## Correction (2026-11-03): item-cell null semantics, Option A → Option B

Option A was originally ruled for item-level null semantics on a misreading of §8 as
"unannotated cells excluded"; re-reading shows "null-vs-populated counts as an error" is the
literal rule. Corrected to Option B before any real-parser numbers were published. No published
numbers change today — the null parser never predicts — but this binds when a real parser lands
and will produce lower, more conservative numbers.

The conflation was between two different §8 sentences: *"Unannotated fields are excluded, never
treated as false negatives or as null ground truth"* — which is about **fields a dataset does not
label at all**, and still holds as an exclusion at dataset level — and *"Null-vs-populated counts
as an error for the applicable field"* — which is about an individual **cell**, and is the strict
rule. Item cells now follow it exactly as scalar cells already did under 03a, so the harness has
one rule at both tiers rather than two.

The cost is accepted knowingly: a parser that correctly recovers a unit price on a receipt CORD
never printed is charged a false positive, and `dev/cord-v2` annotates `unitPrice` on only 49 of
254 items, so this is the common case for that field rather than an edge. The alternative was a
lenient reinterpretation of a spec sentence that says the opposite, which would undercut the
"privacy-first **and** accurate, measured honestly" claim in §1. `unannotatedGoldCells` is
published beside `tp/fp/fn` precisely so a reader can separate "the parser was wrong" from "the
dataset did not print it" — §8's own instruction to disclose that this choice affects sparse
fields.

Two things did **not** change with this correction, and a future reader should not assume they
did: the §8.2 pairing gate stays non-conflicting (an unannotated amount does not block a pairing),
and the macro-averaging rule in DECISIONS/0004 is unaffected.

## Deviation (recorded, not hidden): casefold

§8.1 specifies casefold; implemented as locale-independent `toLowerCase()` with a sweep guard
that fails on `ß`, a ligature, or a dotted/dotless `I`. This is an approximation — full Unicode
casefolding would require the CaseFolding.txt mapping tables (NFKC does not cover it, and
bundling them adds an asset to a privacy-first runtime for a handful of characters). The guard
ensures the deviation never silently misbehaves: if a dataset ships a casefold-sensitive
character, the sweep fails and the implementation must be upgraded before the numbers mean what
§8.1 says they mean. Verified absent today over all 254 dev CORD gold item names.

## How this stays honest

The τ-sweep is committed at `benchmarks/src/matching/sweep.ts` and asserts (a) zero false
candidates at τ=0.70 on the dev money-equal surface, (b) the Jamur Enoki/Kuping pair scores
0.500 under LEV and 0.891 under JW, (c) the safe band is 0.60–0.85. Any future change to the
metric or τ must re-derive these numbers; if they change, the sweep fails and the change is
visible.

`sweep.test.ts` turns those guarantees into a per-push CI gate — it needs only the committed
dev fixtures, no raw dataset — and additionally pins the surface sizes (16 / 406 / 60), the
exhaustive variant counts (97,300 substitutions, 2,089 transpositions, 454 truncations) and the
counts above τ for all three metrics, so the tables in this file cannot drift from the artifact
that produced them. The sweep also guards the one shortcut in `matching/similarity.ts`:
JavaScript's `toLowerCase()` is not full Unicode casefolding, and it fails the sweep if a future
fixture ever carries a `ß`, a ligature, or a dotted/dotless `I`.

## Lock

`τ_name = 0.70`, metric `normalized-levenshtein`, scorer version, and the averaging method are
written into `benchmarks/src/benchmark.config.ts` and echoed into every published results JSON
(§8 "every published result pins … `τ` values … and averaging method"). Changing the metric or
τ after a result is published invalidates every published number produced under the old value;
that is a new decision record, a version bump, and an owner decision — not an edit to this one.
