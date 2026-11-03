# 04: On-device OCR provider

**What to build:** A browser OCR provider that loads PP-OCRv6 detection and recognition models plus the recognition dictionary from assets this app hosts itself, runs them locally on a receipt image, and returns normalized OCR — words with boxes and confidence — behind a swappable provider interface. A minimal harness page turns a dropped image into that JSON so the rest of the pipeline can be developed against real output.

**Blocked by:** 01 (walking skeleton)

**Status:** done — implemented, verified, real-receipt evidence below. Not yet merged.

**Effort:** ~30 h · **Roadmap:** workstream 1A (tasks 1A.1–1A.5) · **Week:** W3 · **Milestone:** M1
**Verify:** `pnpm -r test` passes the provider contract tests; the harness page renders an `OcrResult` and prints load/inference time and asset bytes; real-receipt evidence is attached to this ticket

- [x] The `OcrProvider`/`OcrResult` types from 01's API stubs are finalized here — **extended nothing**; both interfaces are byte-identical to ticket 01's transcription
- [x] Detection, recognition and dictionary assets are served from this deployment with content-hashed names and a manifest; no third-party CDN is required at any point
- [x] The provider sits behind an `OcrProvider` interface that a second, non-PP-OCRv6 implementation can satisfy
- [x] Output is a normalized `OcrResult`: words, boxes and confidence, in a coordinate space the parser can rely on
- [x] Operational failures are typed and distinct — unreadable image, model load failure, recognition failure — while a blank or word-free image is a valid zero-word result, not an error
- [x] Confidence is `null` when the provider has no meaningful score, and never an invented number
- [x] Provider version plus manifest hash are exposed for later cache invalidation
- [x] A harness page accepts a file, runs inference and displays the resulting `OcrResult` JSON with no other UI
- [x] Running a real receipt photo through the harness produces recognizable item text and prices (manually inspected, evidence attached to this ticket)
- [x] Load time, inference time and asset bytes are printed by the harness

## Implementation notes (2026-11-03)

**Layout.** `packages/core/src/ocr/{model-manifest,pp-ocrv6}.ts` + `ocr/pp-ocrv6/{detect,recognize,lines,image}.ts`.
`provider.ts` keeps the interface and now implements `ocr()` as provider delegation. Nothing
reshares the contract; `parse()`/`validate()` remain ticket 01's throw-stubs.

**The manifest drives inference, not just downloads.** `assets/models/manifest.json` now also
carries channel order, mean/std, DB thresholds, recognition sizing and the CTC decoder facts, and
the provider reads them at load. Two of those values **contradict the upstream browser manifest**
and were silent-corruption traps, both established by measurement (`scripts/inspect-ocr-sessions.mjs`,
`harness/out/probe.mjs`), not assumption:

| Claim (upstream) | Measured | Consequence if trusted |
|---|---|---|
| det output `[N,1,H/4,W/4]` | `[N,1,H,W]` at 96×160 and 480×640 | box coordinates off by 4× |
| rec output `ctc_logits` | already softmax: every timestep row sums to 1.000 | confidences all ≈ 1/6906 (observed 0.0003) |

Both are recorded beside the values in `scripts/model-manifest.mjs`, and `ctcGreedyDecode` now
refuses output whose declared activation does not match the data, so the second one cannot
recur silently. Dictionary mapping is `class 0 = blank, class i → dictionary line i-1`, asserted
against the model's class count (6906 = 6905 + 1) before any text is produced.

**Model assets were already committed** by ticket 01; this ticket re-verified all three SHA-256s
against `chenmohan/web-sdk-pp-ocrv6`'s pinned manifest (byte-exact) and turned those hashes into
enforced pins in the generator (`--check` mode). 6,277,292 bytes total — well under the 20 MB
threshold, no new binaries.

**Postinstall.** `onnxruntime-web` has no install hook; the blocked script belonged to its
transitive dependency `protobufjs`. Its `postinstall` only reads the consuming `package.json` two
levels up to print a version-scheme warning, and in pnpm's virtual store that file is absent, so
it returns in its catch block. Denied in `pnpm-workspace.yaml` with that reasoning;
`pnpm install --frozen-lockfile` stays script-free.

**Performance context.** WASM execution provider, 4 threads (COOP/COEP set by the harness server):
327 ms load, 503 ms inference for a 463×1013 receipt. Indicative only — ticket 08 measures
footprint, ticket 09b compares Tiny vs Small.

**Known gap, not fixed here.** OCR runs on the main thread. `PROJECT(1).md` §3 sketches
`ocr/worker.ts`; nothing in this ticket needs it and it needs bundler plumbing, so the pipeline
is written as pure functions a worker can wrap later. Left for 09a/10 (offline proof / capture).

## Real-receipt evidence

- **Image:** `benchmarks/datasets/raw/sroie/assets/ex.jpg` — real photographed Malaysian receipt
  (463×1013, faded dot-matrix print), from the SROIE snapshot already pinned and license-cleared
  (CC-BY-4.0 as declared by the mirror, `DECISIONS/0002`). Not committed: raw datasets are git-ignored.
- **Raw output:** `harness/out/ex.ocr.json` (git-ignored) + `harness/out/ex.png` (harness screenshot).
- **Reproduce:** `pnpm build && node harness/run-acceptance.mjs`

**What I saw.** 29 lines / 75 words, mean line confidence 0.849 (range 0.414–0.996, no nulls).
Recognized correctly and legibly: `tan woon yann`, `BOOK TA .K (TAMAN DAYA) SDN BHD`,
`NO.5: 55,57 & 59,JALAN SAGU 18,`, `81100 JOHOR BAHRU`, `Document No：1D0116/104`,
`Date 25/12/2018 8:13:39 PM`, `Cashier MANIS`, `CASHBILL`,
`95569040-40118 KP MODELLING CLAY KIDDY HSH`, `PC 9.00 0.00`, `Rounding Adjustment 0.00`,
`Rounded Total (RM): 9.00`, `GOODS SOLD ARE NOT RETURNABLE OR EXCHANGEABLE`, `THANK YOU`,
`PLEASE COME AGAIN !`. Item text and item prices are present and readable, which is what this
ticket gates on.

Character errors are concentrated in the faint right-hand amount column: `Total : 9.00` read as
`Total 1.00`, the item amount `9.00` as `2.00`, `Cash 10.00` as `Cash 000`, `CHANGE 1.00` as
`CHANGE 00` (plus a stray `2.00` fragment on its own box). Thai/Chinese footer glyphs are
garbage, as expected from a 6905-entry Latin-centric dictionary. These are **accuracy** limits of
Tiny on a 463 px-wide thermal scan, not pipeline defects: the same glyphs decode correctly
elsewhere on the page (`9.00` in the rounded total, `Rounding`/`Adjustment`), which rules out
wrong channel order, wrong dictionary offset and wrong CTC decode. Quantifying and improving this
is ticket 09b (Tiny vs Small), and ticket 05 consumes `OcrResult` fixtures rather than live OCR.

## Test coverage added

`packages/core/src/ocr/pp-ocrv6.test.ts` (11 tests) drives the whole pipeline through injected
seams (fake ORT runtime, fake canvas environment, real committed models + real dictionary):
blank image → zero-word result with no error; dictionary-mapped decode of `TOTAL 340.00` with word
splitting and real confidences; vocabulary mismatch → `RECOGNIZE_FAILED`; declared-activation
drift → `RECOGNIZE_FAILED`; tampered asset → `MODEL_LOAD_FAILED`; undecodable file →
`IMAGE_UNREADABLE`; second non-PP-OCRv6 provider satisfies the contract with all-null confidence;
`ocr()` without a provider is a `TypeError`. Suite: core 15, pwa 27, benchmarks 156.
