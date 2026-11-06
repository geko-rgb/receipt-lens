# DECISIONS/0031 — The LLM fallback is deferred to v2 without a measured comparison (the M2 / gate G6 decision)

Date: 2026-11-06 · Ticket 18, Part A · **Status: owner decision, recorded.**
Supersedes the sentence at `docs/business.md` §16 that claimed an evaluation was underway.
Related: `PROJECT(1).md` §16 M2, §17 (the "decide the LLM fallback only after M1 measurements" loop), §20 item 11,
gate **G6** (`ROADMAP.md` §3, default **No**), and ticket 19, which was opened to produce this decision and is
**not done**.

## The decision

**Deferred to v2.** No LLM fallback is planned, built, benchmarked or claimed for v1, and none exists in the tree:
`parse()` consumes normalized OCR only and nothing in `packages/core` or `packages/pwa` reaches a language model
(`pnpm scan:egress` reports the provider's manifest fetch as the only indirect site).

## Why — the exit bar was not met, and is not met now

M2's exit criterion is *"written decision supported by accuracy, correction rate, download size, cold/warm
latency, and browser compatibility numbers."* Ticket 19's work items are the five measurements behind it. **None of
them has been run.** There is no candidate model selected, no uncertain-subset taxonomy with counts, no held-out
run, no cost ledger. The record therefore cites no figure — a decision memo quoting folklore sizes is the failure
mode §20 item 11 exists to prevent.

What *was* measured is the M1 evidence that made the question answerable in the negative, and it is what the owner
weighed:

| Field | Committed figure | Artifact |
|---|---|---|
| Headline strict exact match, SROIE eval | 60.7% parser-only · 57.3% Tiny · 62.9% Small | `benchmarks/results/{parser-only,end-to-end}-*-eval.json` |
| Ambiguous-row prevalence, CORD | 25.1% / 16.5% with ticket 05's own caveat | `DECISIONS/0014` M7.5 |
| `arithmetic_item_sum` criticals attributed to a classifier gap, not to price | 27 dev receipts | `DECISIONS/0014` M7.2, ticket 20 |
| Cold / warm download of the *current* pipeline | 21,718,277 B / 2,700 B | `benchmarks/results/footprint.json` |
| Default model tier | PP-OCRv6 **Tiny**, retained | `DECISIONS/0015` |

The two accuracy gaps a fallback would target are the ones tickets 20 and 21 file — a label-dictionary gap and a
classification gap — and both are deterministic-parser defects with named code lines (`parse/charges.ts:108`,
`classifyRows`/`readItems`), not recognition failures. Buying a model to work around a dictionary lookup would add
megabytes and a network dependency to a product whose §1 claim is that inference stays on the device. **G6's
default, "No unless the accuracy delta is decisive", was never challenged by any measured delta, because no delta
was measured.**

## What this deferral does *not* satisfy — stated plainly

- `PROJECT(1).md` §20 **item 11** requires the decision be *"recorded with measured data"*. **This record satisfies
  the "recorded" half and explicitly does not satisfy the "measured data" half.** §20 carries the owner-authorized
  note to that effect; a reader who wants the v1 DoD to read as fully met should not find it here.
- `PROJECT(1).md` §16 **M2's five-field exit bar is unmet.** M2 did not close; it was deferred by owner decision.
- Ticket 19's seven work items are all unchecked and remain open. Its `Verify` line — *"a decision record is
  committed citing measured data from the results JSON produced by 08 and 09b"* — is **not** satisfied by this
  file, which cites 08/09b's numbers as context for a deferral rather than as the comparison ticket 19 asked for.
- `docs/business.md` §16 previously asserted an evaluation was in progress with a go/no-go decision coming. That
  claim was false at the time it was read and is corrected to describe this deferral.

## What would unblock it

1. **Select exactly one candidate** small pretrained model runnable in the browser (WASM/WebGPU), with license,
   runtime size and an integration sketch — ticket 19's second item. Nothing is chosen today.
2. **Taxonomy with counts** of the uncertain subset from committed M1 output: which failures are LLM-plausible. The
   first cut is already available from `DECISIONS/0014` M7 and tickets 20/21, and it argues the target set is
   parser-fixable.
3. **The identical held-out protocol** — same fixtures, same scorer (`03b.2`, `matchItems(τ=0.7, money_gate=on)`),
   same splits, no fine-tuning — reporting accuracy and correction rate against the 60.7 / 57.3 / 62.9 baseline.
4. **A cost ledger from the footprint harness** (`DECISIONS/0028`/`0029` protocol): download size, cold/warm
   latency, browser compatibility limits. Adding weights to a 21.7 MB cold visit is the number that decides.
5. **An explicit privacy ruling.** A remote-LLM path contradicts §1 claim 1 and §9's scoped claim; an on-device one
   contradicts nothing but must be re-audited by the ticket-18 harness (`DECISIONS/0030`), which currently proves
   the *absence* of such a dependency rather than the presence of a permitted one.

## Scope restated

**Fine-tuning remains out of scope** for v1 and v2 as written (`PROJECT(1).md` §19), and would need an owner
revision of the v1 plan to enter either. Deferring the fallback does not license fixing tickets 20 and 21 by
guessing: §5's label dictionary and thresholds are spec text, and no tolerance, floor or threshold may be tuned to
make a published number look better.
