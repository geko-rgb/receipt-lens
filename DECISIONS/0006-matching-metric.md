# DECISIONS/0006 — Name-similarity metric and the `τ_name` pin

Date: 2026-11-02 · Ticket 03b. Closes the Tier-3 gap in `PROJECT(1).md` §8.2: the spec
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

| Metric | positives kept (1-substitution) | false candidates on the **money-equal** surface (n=17) | same-first-word distinct items (n=60) |
|---|---|---|---|
| normalized Levenshtein @0.70 | 97.4% | **0 (0.0%)** | 8.3% |
| Jaro @0.70 | 99% | 3 (17.6%) | 71.7% |
| Jaro-Winkler @0.70 | 99% | 3 (17.6%) | 71.7% |

The false candidates Levenshtein refuses and Jaro accepts are real menu pairs, not synthetic
near-duplicates:

- `jamur enoki` vs `jamur kuping` — two different mushrooms, same receipt, same price.
  Levenshtein 0.500, Jaro 0.819, Jaro-Winkler 0.891.
- `ice coffe mix` vs `ice black coffe` — Levenshtein 0.333, Jaro-Winkler 0.847.

Because the matcher's objective is *pair count first*, a spurious high score between two
money-equal distinct items is not merely a wrong tie-break: it lets the DP swap two pairings
and silently convert one false positive plus one false negative into a match that then gets
scored as field agreement. The failure mode is a **quieter** benchmark, which is the one
thing a scorer must never produce. Jaro-Winkler's prefix bonus is structurally the wrong
shape for receipt menus, where the discriminating token is the *last* word
(`MIKA KECIL` / `MIKA BESAR`, `TOP OREO` / `TOP BANANA`).

## Where Jaro-Winkler is better, and why we still lose nothing

Levenshtein is the weaker metric on truncation: at τ=0.70 it keeps 78% of names cut to 75%
of their length and 0% of names cut to 50%, where Jaro-Winkler keeps 100%. That is a real
gap, and it is deliberately not bought. A prediction whose name is truncated relative to
gold is a **row-segmentation** failure (ticket 05's geometry work), not a name-spelling
variant; §8.4 wants it to surface as one false positive plus one false negative. A metric
that forgives it would hide a segmentation bug inside the metric whose job is to expose the
downstream consequence of that bug. Note also that the dominant *real* variant classes in
these fixtures — 142/254 gold names print in caps, 60/254 carry punctuation — are reduced to
similarity exactly 1.0 by §8.1 normalization alone, so τ spends its budget on character-level
noise, where Levenshtein behaves monotonically, not on length-level noise.

## Why 0.70 rather than 0.75 or 0.80

Levenshtein sweep over `dev/cord-v2` (positives are synthetic single edits of real dev names,
seeded and reproducible):

| τ | 1-substitution kept | adjacent-transposition kept | within-receipt distinct false (n=406) | money-equal distinct false (n=17) | same-first-word false (n=60) |
|---|---|---|---|---|---|
| 0.60 | 98.6% | 95.5% | 1.48% | 0.0% | 16.7% |
| 0.65 | 98.6% | 93.2% | 0.99% | 0.0% | 11.7% |
| **0.70** | **97.4%** | **90.5%** | **0.74%** | **0.0%** | **8.3%** |
| 0.75 | 97.4% | 87.8% | 0.74% | 0.0% | 6.7% |
| 0.80 | 95.2% | 78.4% | 0.00% | 0.0% | 1.7% |
| 0.85 | 90.2% | 49.5% | 0.00% | 0.0% | 1.7% |

The money-equal surface — the surface that can actually produce a false candidate — is at
zero for every τ from 0.60 to 0.85, so tightening past 0.70 buys no safety there and costs
transposition tolerance (90.5% → 87.8% → 78.4% → 49.5%). Loosening below 0.70 starts
admitting same-prefix distinct items (8.3% → 11.7% → 16.7%). **0.70 is the highest-recall end
of the flat-safe region**, it is `ROADMAP.md` G8t's pre-declared default, and no number in
this project has been tuned to it, because 03a's null-parser bootstrap scores 0 on every
metric with or without a τ.

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
- The reading of "compatible monetary fields" (§8.2) when one side's amount is `null` is
  **not settled here**; it has been reported to the owner as an open interpretation question,
  and the matcher is not written until that answer lands. It is not a corner case: in
  `dev/cord-v2` gold, `unitPrice` is null on **205 of 254** items (80.7%), `qty` on 56 (22.0%)
  and `lineTotal` on 32 (12.6%). A gate that demanded equality on any field the gold side
  never annotated would refuse about four fifths of true pairs and report a price-parse
  failure as a *missing item* — the opposite of what §8's field-level diagnostics are for.
- The two OCR confidence floors stay at the §6 defaults (0.50 critical, 0.70 warning) —
  ticket 04 owns them, not this file.
- The round-off band (§6: within ₹0.02 of `expected_round_off`, magnitude ≤ ₹1.00) is pinned in
  `benchmark.config` by this ticket because G8t groups all three, but no matcher behaviour
  depends on it.

## Lock

`τ_name = 0.70`, metric `normalized-levenshtein`, scorer version, and the averaging method are
written into `benchmarks/src/benchmark.config.ts` and echoed into every published results JSON
(§8 "every published result pins … `τ` values … and averaging method"). Changing the metric or
τ after a result is published invalidates every published number produced under the old value;
that is a new decision record, a version bump, and an owner decision — not an edit to this one.
