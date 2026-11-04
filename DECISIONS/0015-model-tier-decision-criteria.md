# DECISIONS/0015 — Model-tier decision criteria (gate G3), committed before the Small measurement

Date: 2026-11-04 · Ticket 09b · **Status: criteria part binding now, measurement part open.**

ADR-002 makes PP-OCRv6 Tiny the v1 default and keeps it reversible: "compare Tiny and Small during M1;
retain Tiny unless benchmark evidence justifies changing it". ROADMAP G3 words the same rule as **keep
Tiny unless the strict-metric gap is material**, and neither document defines *material*. `benchmark.config.ts`
records no acceptance threshold on purpose — an accuracy-acceptance number is not in the spec, so
inventing one after seeing the data is the failure mode this file exists to prevent.

These criteria were written and committed **before** the Small weights were downloaded and **before** any
end-to-end number for Small exists. They were approved by the owner as the decision rule. If the
measurement does not satisfy them, the answer is Tiny — and the answer cannot be renegotiated by
re-reading the numbers, only by a new owner decision that says which clause it is changing and why.

---

## C0 — The cost side is fixed, so only the accuracy side can move

| | Tiny (shipped default) | Small (candidate) | ratio |
|---|---|---|---|
| Model + dictionary bytes | 6,277,292 B (6.28 MB) | 31,133,548 B (31.13 MB) | **4.96×** |
| — detection | 1,780,590 B | 9,880,512 B | |
| — recognition | 4,462,639 B | 21,159,378 B | |
| — dictionary | 34,063 B (6,905 entries) | 93,658 B (18,709 entries) | |
| Cold first-visit download (`DECISIONS/0012`, measured) | 21,299,089 B (21.30 MB) | ~46.16 MB, projected | |

The cold figure for Small is **arithmetic, not a measurement**: ticket 08's measured 21,299,089 B minus
the measured 6,279,992 B model+dictionary group plus the same group at Small's bytes. It is labelled
projected because it re-enters a published table only after `pnpm measure:footprint` runs against the
swapped tier (DECISIONS/0012 F11 trigger 2 — "the model tier changes" — makes re-measurement part of a
swap, not a follow-up).

The 14,848,852 B ORT WASM, which is the bulk of the cold download and re-downloads on every visit
(F10/F12), is tier-independent: **Small adds model bytes to a download whose largest component it does
not touch.** Latency is measured and published per tier as a cost, and is **not** a gate — no latency
threshold was pre-declared, and a number that decides after the fact decides nothing.

## C1 — The thresholds

All four quantities are read from committed `benchmarks/results/` artifacts, in **end-to-end mode**
(`DECISIONS/0014` M1: the mode that includes OCR error, which is the only mode where a tier can differ),
on the **SROIE eval split** — the published English claim — and on **CORD eval** for the guard. Field
paths are named because "price-field accuracy on SROIE" has to be pinned to something computable:
SROIE annotates no item field (`DECISIONS/0002`), so its price surface is the receipt-level `grandTotal`.

| Id | Quantity | Artifact path | Rule |
|---|---|---|---|
| **A** | SROIE eval end-to-end **strict rate** | `datasets[dataset=sroie].strict.rate` | Small − Tiny ≥ **+10.0 pp** |
| **B** | SROIE eval end-to-end **price-field F1** = `grandTotal` | `datasets[dataset=sroie].fields[field=grandTotal].f1` | Small − Tiny ≥ **+0.15** |
| **C** | CORD eval end-to-end **item-field F1 guard** | mean and each of `item.name`, `item.qty`, `item.unitPrice`, `item.lineTotal` | no field may fall more than **0.01** below Tiny's |
| **D** | Which tier ships | A, B, C together | see below |

**D — the decision:**

- **Both A and B fail** → **Tiny remains the default.** Recorded, no amendment to ADR-002.
- **A or B passes AND C holds** → **Small replaces Tiny.** ADR-002 is amended with the measured evidence,
  the swap runs through ADR-002's four-step procedure (upstream hash verification, `pnpm test`,
  `node harness/run-acceptance.mjs`, `pnpm measure:footprint`), and the committed footprint is replaced
  in the same change that changes the tier.
- **A or B lands in the marginal band — strict +5.0 pp to +10.0 pp, or F1 +0.10 to +0.15 — and C holds**
  → the outcome is a **cost/benefit tradeoff, and the owner decides with the measured data in front of
  them. Default remains Tiny absent an explicit override.** An agent does not resolve this band; it
  presents it.
- **A or B passes but C fails** (Small wins on English money and loses on CORD item fields) → **Tiny
  remains.** The comparison is not allowed to buy a headline claim by spending a field the product also
  parses; ADR-010 makes CORD the layout bucket, not a throwaway.

A and B are joined by **AND** for the "Small replaces" branch because they are the same surface
(SROIE's `grandTotal`) seen two ways — receipt-level strict and field-level F1 — and a tier change that
moves one but not the other is a matching artifact, not an accuracy gain.

## C2 — How the thresholds are measured, so they cannot move either

- **Same protocol for both tiers, differing in one variable.** Same images, same fixture row-index
  pairing, same `parse()` running in Node, same scorers, same `benchmark.config` pins. `DECISIONS/0014`
  M2: the only thing between `parser-only-<split>.json` and `end-to-end-<tier>-<split>.json` is where the
  `OcrResult` came from.
- **`matchItems(τ=0.70, money_gate=on)` for every scored number, and the paired-gold rule from
  `DECISIONS/0008`:** any price claim states its gate state and publishes the `money_gate=off` census
  beside it. A tier comparison that only cites the gated column cannot see a wrong price at all.
- **τ is not a variable here.** `DECISIONS/0006` locks it; a diagnostic sweep at another τ (see C4)
  answers a question about the metric and changes nothing published.
- **Determinism required.** The scorer is pure, so the only non-determinism is OCR output. Ticket 04
  measured byte-identical OCR across runs on the same image; the driver aborts on any image it cannot
  pair with its gold by pixel size, so a mismatched receipt cannot quietly enter a threshold.
- **Sample sizes are published with the deltas, not hidden by them.** SROIE eval = 361 receipts;
  CORD eval = 100 receipts, 270 gold items. A +10 pp claim on 361 receipts is roughly 36 receipts; the
  number is stated with its denominator so a reader can weigh it.
- **dev is a consistency check, not a tiebreaker.** If dev and eval point in opposite directions, the
  threshold is evaluated on eval as specified here and the disagreement is reported in the decision
  section — not resolved by choosing the friendlier split (`DECISIONS/0004`'s discipline).

## C3 — What a swap would additionally require (not accuracy questions)

If D selects Small, none of the following is optional, and all of it is ADR-002 and §9 text rather than
new policy:

1. `assets/models/` replaced, each SHA-256 re-verified against the pinned upstream revision,
   `node scripts/model-manifest.mjs` regenerated, `providerVersion`/`preset` updated — the candidate
   manifest's **measured** preprocessing values, never the advertised ones (C4).
2. `pnpm test`, `node harness/run-acceptance.mjs`, `pnpm measure:footprint` — the footprint artifact and
   its README table change in the same PR as the tier, because a published size that does not describe
   the shipped model is the "~4.3 MB" failure again.
3. The cache key (`providerVersion` + manifest hash, §9) moves with the bytes; ticket 17's service-worker
   cache must be shown to hold the new set before the old cache is deleted.
4. Every published accuracy number regenerated from new artifacts, with the old tier's artifacts either
   re-labelled as historical or superseded by dated copies — no table row quoting Tiny after Small ships.

## C4 — Known measurement hazards this decision has to survive

Both traps were discovered on Tiny and both fail *quietly* — plausible output instead of an error
(ticket 04):

- **Detection output resolution.** The upstream browser manifest advertises `["N",1,"H/4","W/4"]` for
  every preset; Tiny's export emits **full resolution**. Small's declared value is an unverified claim
  until `node scripts/inspect-ocr-sessions.mjs --dir assets/models/candidate` measures it, and the
  candidate manifest is corrected to the measurement before Small runs.
- **Recognition output activation.** The same manifest says `ctc_logits`; Tiny's graph is **already
  softmax**, and applying softmax again gave every word confidence ~0.0003 on the first real run. The
  probe now reports row sums and fails when the declared activation contradicts them; the candidate
  manifest may not ship on the advertised value.

A Small run measured through either uncorrected trap would produce a **lower** number than Small
deserves, i.e. it would bias the decision toward Tiny — which is the safe direction, but it would not be
a measurement of Small. So the probe is a precondition of the comparison, not a courtesy.

## C5 — The open question the criteria cannot close: is 10 pp reachable?

Ticket 04's price-field finding — `Total 9.00` → `Total 1.00`, `Cash 10.00` → `000` on a 463 px thermal
scan — is **one receipt, session-measured**, and is not evidence for a threshold or against one. The
honest statement of the risk: if Tiny's end-to-end SROIE strict is already very low, +10 pp is a large
jump for a 4.96× model; if it is already near the parser-only ceiling (60.7%), +10 pp is unreachable
because the parser, not OCR, is the binding constraint. **Either way the rule stands.** If Small wins on
nothing, that is the answer G3 asked for, and the README says the default is kept on measured evidence
rather than on inertia.

## C6 — Diagnostic that is allowed precisely because it changes nothing

`DECISIONS/0006` is closed and not reopened (standing rule), so the CORD `item.name` investigation runs a
diagnostic sweep at other τ values and reports what it finds. It may not move τ, and no published number
in this ticket is produced at anything other than τ = 0.70. A finding that the metric shape is wrong for
Indonesian item names is **filed as an M2 input with the measurement attached**, exactly as ticket 07
filed the §5 line 159 dictionary gap as ticket 20 rather than fixing it inside a measurement ticket.

## What this record does not decide

- The measurement itself. Sections C7+ are appended **after** the runs, with their artifact paths.
- Whether an LLM fallback is needed (ticket 19, M2) — a tier decision is not a parser-architecture decision.
- Any change to `PROJECT(1).md`, to `parse()`, or to `benchmark.config.ts`.

---

# Part 2 — the measurement (appended after the runs; criteria above unchanged)

Date: 2026-11-04 · Same session, after all four end-to-end runs completed.

Artifacts of record — every number below is read out of these committed files, and the deltas were
computed from them rather than from a session transcript:

- `benchmarks/results/end-to-end-tiny-dev.json`, `end-to-end-tiny-eval.json`
- `benchmarks/results/end-to-end-small-dev.json`, `end-to-end-small-eval.json`
- `benchmarks/results/parser-only-dev.json`, `parser-only-eval.json`
- `benchmarks/results/diagnostic-item-names-cord-v2-dev.json` (C6's diagnostic)

Re-derive: `pnpm run:end-to-end -- --tier tiny --split dev` (and `--split eval`, `--tier small`), then
`node benchmarks/scripts/diagnose-item-names.mjs`.

## M-1 — C4's two traps reproduced on Small, exactly as they did on Tiny

`node scripts/inspect-ocr-sessions.mjs --dir assets/models/candidate` measured, before any Small run:

| value | upstream browser manifest claims | Small measures |
|---|---|---|
| detection output shape | `["N",1,"H/4","W/4"]` | 96×160 → `[1,1,96,160]`, 480×640 → `[1,1,480,640]` — **full resolution** |
| recognition output | `ctc_logits` | every output row sums to **1.000** — **already softmax** |

The candidate manifest at `assets/models/candidate/manifest.json` was written from the measured values,
and `benchmarks/scripts/fetch-candidate-model.mjs` now carries them with this evidence in its comments, so
a re-fetch produces the corrected manifest rather than the advertised one. Had the run gone ahead on the
vendor's numbers, every Small confidence would have collapsed to ~0.0003 and Small would have looked
worse than it is — a tier decision decided by an export quirk.

Asset verification: all three fetched bytes matched their pins (det `d73e0058…`, rec `5435fd74…` against
the upstream manifest; dictionary `f65bebb1b09b62b691094f0c83e73c2623c81eb477996707e783cdebe41ba519`,
93,658 B, recorded at fetch because no upstream hash exists for a plain file).

## M-2 — The thresholds, applied

Both splits, because C2 says dev is a consistency check and it happened to agree in direction.

| Id | Quantity | Tiny | Small | Δ | Declared rule | Result |
|---|---|---|---|---|---|---|
| **A** | SROIE eval end-to-end strict | 57.34% (207/361) | **62.88% (227/361)** | **+5.54 pp** | pass ≥ +10 pp; marginal +5 to +10 | **marginal band** |
| **B** | SROIE eval end-to-end `grandTotal` F1 | 0.6216 | 0.6657 | +0.0441 | pass ≥ +0.15; marginal +0.10 to +0.15 | **fails** |
| **C** | CORD eval item F1s | name 0.2294 · qty 0.2802 · unitPrice 0.0221 · lineTotal 0.4470 | name 0.2514 · qty 0.2836 · unitPrice 0.0463 · lineTotal 0.4903 | +0.0220 · +0.0034 · +0.0243 · +0.0434 | no field more than 0.01 below Tiny | **holds** (Small is better on all four) |
| dev cross-check | SROIE dev strict / F1 | 57.72% / 0.6056 | 63.76% / 0.6597 | +6.04 pp / +0.0541 | — | same direction, same bands |

Costs measured in the same runs (loopback, this machine, unthrottled, one page per run, n=250 dev / n=461
eval receipts — these are run observations, not a substitute for ticket 08's declared-class measurement):

| | Tiny | Small | ratio |
|---|---|---|---|
| model + dictionary bytes | 6,277,292 B | 31,133,548 B | 4.96× |
| model load | 330 ms (eval run) / 573 ms (dev run) | 465 ms / 806 ms | ~1.4× |
| inference per receipt, median | 494 ms eval (446 ms dev) | **1,880 ms eval (1,738 ms dev)** | **3.8×** |
| OCR mean word confidence | 0.9520 | 0.9833 | — |
| cold first-visit download | 21.30 MB (measured, `DECISIONS/0012`) | ~46.16 MB **projected** from the same protocol | 2.2× |

## M-3 — The finding the criteria could not anticipate: the "ceiling" is not a ceiling across modes

Small's end-to-end SROIE eval strict (**62.88%**) is **higher than the parser-only reference-OCR number
for the same receipts (60.66%)**. That is not a scoring bug — it is `DECISIONS/0003`'s line-reconstruction
caveat arriving with interest:

- SROIE fixture lines are **harness-derived** (fixed 0.5 × median-word-height y-clustering), not dataset
  facts, and they are additionally **PII-redacted** (`DECISIONS/0005`).
- End-to-end lines come from the provider's reading-order view — a *third* grouping.
- Where a receipt prints several competing totals (`TOTAL EXCL. OF GST 15.00`,
  `TOTAL INCL. OF GST 15.90`, `TOTAL AMT ROUNDED 15.90` — receipts `sroie/dev/12` and `/15`), which
  candidate `parse()` sees depends on grouping rather than on OCR quality, and the difference can go both
  ways. Measured on dev SROIE: **16 receipts where real OCR got the total and the fixture did not, 11 the
  other way** for Small; 14 up / 18 down for Tiny.

Consequences, recorded rather than smoothed over: **`DECISIONS/0003`'s "every score produced against them
is a ceiling"** and **`DECISIONS/0014` M2's "at or below the ceiling"** hold only when the line grouping is
held fixed. Across modes it is not fixed, so end-to-end is not bounded by parser-only on SROIE.
`DECISIONS/0014` carries the correction. This also weakens C5's worry that B was unreachable-by-construction:
B still failed on the measurement, not on the arithmetic.

## M-4 — The CORD `item.name` diagnosis (C6), before publication

Measured in `diagnostic-item-names-cord-v2-dev.json` over the 100 dev CORD receipts:

- **The metric threshold is not the cause.** `item.name` F1 is **0.212 at every τ from 0.50 to 0.90**
  while the pair count moves from 146 to 79. τ decides pairing; name agreement is exact normalized
  equality, so sweeping τ redistributes pairs without moving field agreement. Possibility (2), "τ=0.70
  is too strict for Indonesian names", is rejected by measurement. τ is **not** changed.
- **Word order is not the cause.** Of 82 name misses among paired items, **0** are same-tokens-different-
  order, and exactly **1** unpaired gold item would be admitted by sorted-token similarity.
- **The cause is a name-span bug, and it is precise: 80 of the 82 misses have gold's tokens as a strict
  subset of the prediction, and in 70 of those 80 the surplus tokens are pure digits.** Every one of the
  80 sits on an item whose name spans **multiple source lines** (`singleLine: 0, multipleLines: 80`).
  Verbatim from the artifact: gold `REAL GANACHE` → predicted `1 REAL GANACHE`; gold
  `Kopi Susu Kolonel` → `Kopi Susu Kolonel 1`; gold `Choco Peanut Bread` → `2 Choco Peanut Bread`.
  **The printed quantity is being folded into `Item.name` when ticket 05's continuation rows merge.**
- The remaining damage is a different class: of 119 unpaired gold items, **68 have no prediction anywhere
  on the receipt above 0.20 similarity** and 90 have every token present on the page — items that never
  became items (the 05/20 charge/tender classification gap and ticket 06's geometry fragmentation), not a
  naming problem.

So the answer to the question "is 0.212 honest?" is: **it is honest as measured, and it is a fixable
parser defect, not a language effect.** It belongs to tickets 05/06 (the continuation merge should consume
the quantity token it already reads as `qty`, or the name span should exclude a token the quantity column
claimed). 09b does not fix it: `DECISIONS/0014` M7 and this ticket are measurement documents, and a
parser change made here would land without its own pin table. **Filed, with the mechanism, the count, the
70/80 digit evidence and the artifact path, and the README says so beside the number** rather than
publishing 0.212 as though it were a language limitation.

## D — The decision, as the pre-committed rule resolves it

C1/D has one branch that fits this outcome: **A landed in the marginal band (+5.54 pp eval, +6.04 pp dev,
so consistently ≥5 and <10), B failed (+0.044 against a +0.10 marginal floor), and C holds.** The rule's
text for that case: *the outcome is a cost/benefit tradeoff, and the owner decides with the measured data
in front of them. Default remains Tiny absent an explicit override.*

**Tiny remains the v1 default.** No ADR-002 amendment. Three things are worth saying about why, beyond
the rule:

1. **The gain is real but narrow, and it is one field.** Small beats Tiny on all four CORD item F1s and on
   SROIE's `grandTotal`, but nothing in the corpus shows Small fixing the two things that actually cap
   accuracy: the quantity-in-name defect (M-4, a parser bug both tiers inherit) and charge/tender row
   classification (ticket 20). `item.unitPrice` stays at F1 0.046 under Small versus a 0.058 parser-only
   figure — a 4.96× model does not move the field a bill splitter most needs, because the field's problem
   is provenance and annotation sparsity, not glyph recognition.
2. **The cost is not narrow.** 4.96× the model bytes, ~2.2× the projected cold download, and **3.8× the
   measured median inference time** (494 ms → 1,880 ms on the same 461 eval receipts). §1's claims are
   honesty about accuracy *and* about footprint; a 2× download and 4× wait is the kind of tradeoff the
   owner makes, not the kind a benchmark session makes for them.
3. **A is not a clean pass at a different threshold either.** The 5.54 pp difference on SROIE eval is
   20 receipts out of 361, and M-3 shows part of the mode difference is line grouping rather than
   recognition quality. A tier decision that turns on 20 receipts whose movement is partly a grouping
   artifact should not be made in a hurry.

**What would change this.** The same criteria re-run after (a) ticket 06's quantity-in-name fix, (b)
ticket 20's charge/tender classification, or (c) a receipt corpus that is actually Indian English rather
than Malaysian English (SROIE) — because C0's cost column is fixed, the accuracy side has to move, and on
this corpus the parser is the binding constraint. That is the honest content of "default remains Tiny
absent an explicit override": the data supports keeping Tiny, and it does not support *closing* G3.

## What this record now decides

- Gate G3: **Tiny remains**, on the marginal-band branch of the pre-committed rule, with the measured
  comparison above and the artifacts to re-derive it.
- **Owner-confirmed 2026-11-04, explicitly not overridden to Small.** The owner's stated reasoning, in
  their words: 5.54 pp is marginal-band per the pre-committed criteria; the 05/06 defects cap both tiers
  and are fixable; 4.96× bytes and 3.8× latency is a real user cost; the margin is 20 receipts partly
  explained by a grouping artifact. **Revisit condition, recorded so it is not re-litigated casually: if
  the tickets 05/06 defects are fixed and Small's margin holds on a re-measurement after those fixes,
  revisit. Not now.** A future session may not re-open G3 without either that re-measurement or an
  explicit owner override of this line.
- The vendor-manifest trust finding that made the comparison meaningful (both traps reproduce on Small) is
  promoted to its own record, **`DECISIONS/0016`**, and its rule binds every future tier: measure with
  `scripts/inspect-ocr-sessions.mjs` before measuring accuracy.
- The swap procedure is now **demonstrated rather than designed** for everything short of shipping:
  ADR-002's step-1 hash verification, the candidate manifest mechanism, the measured-preprocessing rule
  (C4), and a full ADR-002-protocol benchmark run through the same provider were all exercised. What has
  not been exercised is step 3's footprint re-measurement, because no swap was made.
- `DECISIONS/0014` carries the M8 correction this measurement forced (parser-only is not a ceiling on
  end-to-end); it is recorded there, not smoothed over here.
- CORD `item.name` is filed on tickets 05 and 06 with the mechanism and the artifact (M-4), and the README
  states the defect beside the number. The tier decision is deliberately not sequenced behind those fixes;
  the revisit condition above is how they reconnect.

