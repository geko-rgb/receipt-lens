# 04: On-device OCR provider

**What to build:** A browser OCR provider that loads PP-OCRv6 detection and recognition models plus the recognition dictionary from assets this app hosts itself, runs them locally on a receipt image, and returns normalized OCR — words with boxes and confidence — behind a swappable provider interface. A minimal harness page turns a dropped image into that JSON so the rest of the pipeline can be developed against real output.

**Blocked by:** 01 (walking skeleton)

**Status:** done — implemented, verified, real-receipt evidence below. Pushed to
`origin/ticket/04-on-device-ocr-provider`, **no PR yet** (owner opens it after review). The one open
review item — whether acceptance runs in a browser or in Node — is closed in "Where acceptance runs"
below: it is Playwright-driven headless Chromium, and the OCR executes in the page.

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
327 ms load / 503 ms inference for a 463×1013 receipt on the first run, 582 ms / 952 ms on this
session's re-run — cold/warm variance, so treat both as indicative. Ticket 08 measures footprint,
ticket 09b compares Tiny vs Small.

**Known gap, not fixed here.** OCR runs on the main thread. `PROJECT(1).md` §3 sketches
`ocr/worker.ts`; nothing in this ticket needs it and it needs bundler plumbing, so the pipeline
is written as pure functions a worker can wrap later. Left for 09a/10 (offline proof / capture).
Recorded as `DECISIONS/0007`.

**Where acceptance runs: the browser, not Node.** `harness/run-acceptance.mjs` imports `chromium`
from `@playwright/test` (line 13) and launches headless Chromium (line 26) against the page
`harness/serve.mjs` serves, feeds the photo through `page.setInputFiles("#file", …)`, waits on
`window.__receiptLensHarness`, then writes `page.screenshot()` and the JSON. Inference itself executes
**inside the page**: `harness/src/main.ts` builds the provider with `assetBaseUrl: "/assets/models/"`
and `wasmPaths: "/ort/"` and times with `performance.now()`; `packages/core/src/ocr/pp-ocrv6.ts` asks
for `executionProviders: ["wasm"]` and imports `onnxruntime-web/wasm`. **`onnxruntime-node` is not a
dependency anywhere** — the only ORT package in any manifest is `onnxruntime-web`
(`packages/core/package.json`). Node is a driver plus a static server and never opens a session. The
evidence corroborates it: a fresh run records `executionProvider: wasm` with `session.numThreads: 4`.
`numThreads: "auto"` only reaches 4 when the page is cross-origin isolated — `pp-ocrv6.ts:55-59`
documents that otherwise it drops to one thread because `SharedArrayBuffer` is unavailable — and
isolation exists only because `serve.mjs` sends COOP/COEP. A Node-side session has no such server and
could not have produced those headers or that thread count.

This is what the browser-based claims need. §9 M1 step 1 says "Load a minimal harness page that invokes
the core OCR/parser pipeline"; §3 pins cached `OcrResult` fixtures for per-commit Node parser
benchmarks while "full OCR end-to-end runs are on-demand in a headless browser", and §8's
"benchmark runtime and reproducibility" repeats it. §2/§3: "Only the OCR provider is
browser-runtime-specific". The brief also cited §18, but §18 is *Owner Decisions — Resolved*
(DQ-01–04) and carries no browser claim, so there is nothing there to satisfy.

**Still open from §9 M1 (ticket 09a, not this gate).** Steps 3–4: precache assets, then block outbound
network and assert inference still succeeds. The driver already records every request origin and today
observes exactly one — same-origin `http://127.0.0.1:<ephemeral>` — which is half of step 4
("record attempted requests"), but no blocking assertion runs yet.

## Real-receipt evidence

- **Image:** `benchmarks/datasets/raw/sroie/assets/ex.jpg` — real photographed Malaysian receipt
  (463×1013, faded dot-matrix print), from the SROIE snapshot already pinned and license-cleared
  (CC-BY-4.0 as declared by the mirror, `DECISIONS/0002`). Not committed: raw datasets are git-ignored.
- **Raw output:** `harness/out/ex.ocr.json` (git-ignored) + `harness/out/ex.png` (harness screenshot).
- **Reproduce:** `pnpm build && node harness/run-acceptance.mjs` (headless Chromium — see "Where
  acceptance runs" above).
- **Determinism:** after this session's rebuild the run produced **byte-identical line text and
  confidences**; only wall-clock timings and the ephemeral server port differ. Aggregate stats
  reconfirmed: **29 lines / 75 words, mean line confidence 0.849, range 0.414–0.996, no nulls.**

**Verbatim output**, copied out of `harness/out/ex.ocr.json` exactly as the model emitted it — missing
spaces, stray `]` and all, one line per record prefixed with its confidence:

```text
0.996  tan woon yann
0.951  BOOK TA .K (TAMAN DAYA)SDN BHD
0.908  789117-W
0.917  NO.5: 55,57 & 59,JALAN SAGU18]
0.921  TAMAN DAYA]
0.906  81100JOHOR BAHRU]
0.917  JOHOR]
0.914  Document No：1D0116/104
0.984  Date 25/12/20188:13.39 PM
0.956  Cashier MANIS
0.995  Member
0.906  CASHBILL
0.761  CODE/DES0 PNC日 DIsd AMCUN
0.625  QTY R17 四
0.858  95569390-40118 KF MODELLNGCLAY KIDDY HSH
0.854  PC 9.00 0.00 2.00
0.859  Total 1.00
0.879  Rour ing Adustment 0.00
0.974  Round d Total (RM): 9.00
0.414  2
0.900  Cash 000
0.880  CHANGE 00
0.831  2.00
0.904  GOODS SOLID ARE NOT REIURNABTEOK
0.964  FXCHANGEABLE
0.421  41HH453:9史脑
0.441  20自话，战情序说，
0.996  THANK YOU
0.798  PLEASECOIE AGAIN I
```

**Correction to the previous version of this section.** It quoted a tidied rendering as if it were the
model's own text — `Rounding Adjustment 0.00`, `95569040-40118 KP MODELLING CLAY KIDDY HSH`,
`Rounded Total (RM): 9.00`, `GOODS SOLD ARE NOT RETURNABLE OR EXCHANGEABLE`,
`Date 25/12/2018 8:13:39 PM` — and labelled the whole list "recognized correctly and legibly". None of
those five strings is what the model produced. Only `tan woon yann`, `Document No：1D0116/104`,
`Cashier MANIS`, `CASHBILL` and `THANK YOU` were verbatim. The gate still passes, but it must be
recorded at its real strength, so the block above is the evidence and the prose below reads against it.

**What is right.** Header identity comes through cleanly and at the top of the confidence range:
customer name, business registration `789117-W`, `Document No：1D0116/104` (full-width colon
preserved), `Cashier MANIS`, `CASHBILL`, `Member`, `THANK YOU`. Address lines are readable
notwithstanding dropped spaces and a stray `]`. The item row and its money are present —
`95569390-40118 KF MODELLNGCLAY KIDDY HSH` and `PC 9.00 0.00 2.00` — and the rounded total carries an
exact price: `Round d Total (RM): 9.00`. Recognizable item text and item prices, which is what this
ticket gates on.

**What is wrong.** Three classes, all character-level:
- *Right-hand amounts*: `Total : 9.00` → `Total 1.00`, `Cash 10.00` → `Cash 000`,
  `CHANGE 1.00` → `CHANGE 00`, plus a lone `2` at 0.414 and a stray `2.00` box. Money digits are the
  worst-hit field on the page.
- *Word and label spacing*: `(TAMAN DAYA)SDN BHD`, `JALAN SAGU18]`, `MODELLNGCLAY`,
  `PLEASECOIE AGAIN I`, `Date 25/12/20188:13.39 PM` (the seconds colon also degraded to a period),
  `Rour ing Adustment`, `Round d Total`.
- *Non-Latin footer*: Thai/Chinese glyphs are garbage (`41HH453:9史脑`, `20自话，战情序说，`) and the
  `CODE/DES0 PNC日 DIsd AMCUN` / `QTY R17 四` header row scores 0.761 / 0.625 — expected from a
  6905-entry Latin-centric dictionary.

**Why this is accuracy, not a pipeline defect.** Several lines decode with *zero* character errors at
the top of the range (`tan woon yann` and `THANK YOU` at 0.996, `Document No：1D0116/104` at 0.914),
and the glyphs that fail in the amount column decode correctly elsewhere: `9.00` and `Total (RM):` in
the rounded total, `0.00` in `Rour ing Adustment 0.00`, `PC` on the item line. A wrong channel order,
a wrong dictionary offset or a broken CTC decode would corrupt every line uniformly rather than
selectively hitting faint glyphs — and both the vocabulary assertion (6906 = 6905 + 1) and the
declared-activation guard pass before any text is produced. (The earlier draft argued this from
`Rounding`/`Adjustment` decoding correctly; it does not, so that example is withdrawn — the argument
above uses only lines quoted verbatim.) Quantifying and improving this is ticket 09b; ticket 05
consumes `OcrResult` fixtures rather than live OCR.

**Amount-column forward note (for ticket 09b).** Measure **price-field accuracy separately from
aggregate character accuracy**, per integer-paise equality (§8.4). Tiny on faded thermal misreads
right-hand amount glyphs — `9.00 → 1.00`, `10.00 → 000`, `CHANGE 1.00 → CHANGE 00` — and a
character-error rate that looks acceptable can still carry a price that is wrong by an order of
magnitude. These misreads are direct evidence for spec §14 **ADR-002** (Tiny as the default,
"published Tiny recognition accuracy … is not a promise of accuracy on price-critical receipts"), and
not for `DECISIONS/0002`, which is the SROIE snapshot record. Improvement path: Small model, better
thermal preprocessing, or a price-specific dictionary — owned by ticket 09b.

**Review flag.** This section quotes a real receipt in full (customer name, address, document number,
date). It is the SROIE sample already pinned and licensed CC-BY-4.0 per `DECISIONS/0002`, and the raw
JSON stays git-ignored, but the ticket itself is committed — trim the header lines before merge if
that is preferred. `DECISIONS/0005`'s pending proprietor-name ruling covers fixtures, not ticket prose.

## Test coverage added

`packages/core/src/ocr/pp-ocrv6.test.ts` (11 tests) drives the whole pipeline through injected
seams (fake ORT runtime, fake canvas environment, real committed models + real dictionary):
blank image → zero-word result with no error; dictionary-mapped decode of `TOTAL 340.00` with word
splitting and real confidences; vocabulary mismatch → `RECOGNIZE_FAILED`; declared-activation
drift → `RECOGNIZE_FAILED`; tampered asset → `MODEL_LOAD_FAILED`; undecodable file →
`IMAGE_UNREADABLE`; second non-PP-OCRv6 provider satisfies the contract with all-null confidence;
`ocr()` without a provider is a `TypeError`. Suite: core 15, pwa 27, benchmarks 156.
