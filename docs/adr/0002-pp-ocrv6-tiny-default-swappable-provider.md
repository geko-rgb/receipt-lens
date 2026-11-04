# ADR-002: PP-OCRv6 Tiny default with swappable provider

Status: **locked default, reversible** (seeded from `PROJECT(1).md` §14; the Tiny-vs-Small comparison is ticket 09b, gate G3).

PP-OCRv6 Tiny is the v1 starting default behind `OcrProvider` and `onnxruntime-web`. Tiny is a starting default, not a proven receipt-accuracy winner: compare Tiny and Small during M1 and retain reversibility. Switching tiers must not change `parse()` or the normalized OCR contract.

The former "~4.3 MB complete OCR pipeline" claim is withdrawn. Publish only measured numbers: detection/recognition models, dictionary, runtime/WASM, app JS, initial download/cache size, cold/warm latency (ticket 08). Vendor benchmark accuracy is not a promise of accuracy on price-critical receipts.

**Ticket 08 discharged that instruction (2026-11-04).** The numbers are measured and committed in
`benchmarks/results/footprint.json`, and the published table in `packages/core/README.md` is generated
from that file — CI regenerates it and fails on drift, and the same check re-derives every byte count
from this tree. The claim itself stays withdrawn; nothing in this repo may quote a deployment size that
is not in that generated block. Two things the folklore got wrong are now visible: the inference runtime
is the largest single asset by a wide margin (its WASM binary alone outweighs all three model files
together), and the runtime binary is not held in the HTTP cache at that size, so a warm visit is not
free. Both are in the table with their measured values.

## Swap procedure (reversibility, as required by 1E.5)

Changing tier is a manifest change, not a code change — `parse()` and the normalized `OcrResult`
contract never see it:

1. Obtain the candidate assets and verify each SHA-256 against the pinned upstream browser manifest;
   record the upstream revision in `scripts/model-manifest.mjs`'s `ASSETS`/`UPSTREAM` pins.
2. Replace the files in `assets/models/`, regenerate with `node scripts/model-manifest.mjs`, and update
   `providerVersion`/`preset`. The provider reads channel order, mean/std, DB thresholds, recognition
   sizing, `dictionaryEntries` and the decoder's `outputActivation` from that manifest, so preprocessing
   that differs from Tiny's travels with the weights instead of silently mis-decoding (ticket 04's
   already-corrected full-resolution `H`×`W` detection output and already-softmax recognition output are
   the two traps this mechanism exists for).
3. `pnpm test`, then `node harness/run-acceptance.mjs` on the declared image, then
   `pnpm measure:footprint` — a tier swap changes the footprint, so the committed measurement is part of
   the swap, not a follow-up.
4. The cache key (§9: provider version + manifest hash) moves with the manifest bytes, so an updated app
   can never run against incompatible old assets once ticket 17's service-worker cache exists.

Not yet exercised: no tier has been swapped end-to-end. 1E.3/09b runs Small through this procedure and
the identical benchmark protocol; until that comparison is measured, "reversible" is a design property,
not a demonstrated one.
