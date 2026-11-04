# @receipt-lens/core

Receipt parsing that runs entirely in the browser: OCR on-device, a deterministic parser, and a
validator that only checks what the receipt actually printed.

No image, OCR text, or parsed field ever leaves the device. Inference runs locally through
`onnxruntime-web` against self-hosted, content-hashed model assets — there is no third-party endpoint
in the request path, and the pipeline contains no network call other than fetching those assets from
the app's own origin.

`playwright test --grep @offline` proves the inference path runs to completion with outbound network
blocked after the assets load, making no cross-origin request and sending no receipt-image bytes; it
is M1 scope only — not a service-worker or full-PWA audit, and not an offline-reload proof (that is
ticket 17).

## Quickstart

```bash
npm install @receipt-lens/core
```

One call, if you want one:

```ts
import { extract } from "@receipt-lens/core";

const result = await extract(file, {
  provider: "pp-ocrv6",
  criticalOcrConfidenceFloor: 0.5,
  warningOcrConfidenceFloor: 0.7,
  strictArithmetic: true,
});

result.ocr;        // normalized lines and words, with boxes and scores
result.parse;      // items, quantities, prices, taxes, charges, subtotal, grand total
result.validation; // findings, `uncertain`, and the canonical validated items
```

Or the stages separately — `extract()` is exactly this composition and holds no logic of its own:

```ts
import { ocr, parse, validate } from "@receipt-lens/core";

const ocrResult = await ocr(image, { provider });        // any OcrProvider
const parseResult = parse(ocrResult);                     // pure: OCR in, new result out
const validation = validate(parseResult, {
  criticalOcrConfidenceFloor: 0.5,
  warningOcrConfidenceFloor: 0.7,
  strictArithmetic: true,
});
```

`parse()` accepts normalized `OcrResult` only — never an image, never provider-specific raw output — and
is pure and deterministic: the same input produces a byte-identical result, the input is never mutated,
and no nested reference is shared into the output.

## Options

| option | default | meaning |
|---|---|---|
| `criticalOcrConfidenceFloor` | `0.50` | below it, an item's name/price score is a critical finding |
| `warningOcrConfidenceFloor` | `0.70` | between the two floors is a review signal, not a rejection |
| `strictArithmetic` | `true` | `false` keeps running every arithmetic check but marks its findings `advisory` |

`criticalOcrConfidenceFloor` must not exceed `warningOcrConfidenceFloor`. A reversed or out-of-range pair
throws a `RangeError` rather than being silently repaired — that is caller misuse, not an operational
failure, so it never borrows one of the three error codes below.

These floors are **initial defaults, not calibrated probabilities**. They are exercised by authored
fixtures: the benchmark corpus is dataset reference OCR, which supplies no recognition score at all
(0 of 10,424 words), so every benchmarked receipt takes the `confidence_unavailable` path and no floor
comparison runs. Dev data is not evidence for or against a floor value.

## Findings

`validate()` returns extraction findings — never a single blended confidence number:

```ts
interface ValidationFinding {
  severity: "critical" | "minor";
  code: string;                 // stable; react to this, never to `message`
  scope: "receipt" | "item" | "row" | "charge";
  message: string;
  itemRefs?: string[];          // e.g. ["i7"]
  rowRefs?: string[];           // e.g. ["u3"]
  chargeRefs?: string[];        // e.g. ["t1", "subtotal", "grandTotal"]
  advisory?: boolean;           // only in relaxed arithmetic mode
}
```

Three properties worth building against:

- **Conditional.** A check runs only where the receipt gives both operands and their meaning is known.
  A receipt that prints no subtotal never gets an item-sum verdict — in either direction, not even
  "items may be missing". An item sum below the printed subtotal is reported as possibly-missing rows,
  not as a contradiction; only a sum above it can be one.
- **Addressed.** Every finding names the item, row, or charge that caused it, so a UI can highlight the
  line rather than the receipt.
- **Never silent.** An itemless result is a `zero_items` critical, not an empty success. Missing unit
  prices are reported at the severity the data supports: an item with no money at all is critical
  (`item_without_price`); an item that printed a line total but no unit price is a review finding
  (`price_not_resolved`), because deriving the unit price by division is forbidden by design.

`uncertain` is true when a non-advisory critical finding exists. A non-advisory critical also caps the
confidence of the items it affects at `0.5` — receipt-level criticals cap every item, item-level ones cap
one. A cap never raises a lower score and never turns `null` into a number.

With `strictArithmetic: false`, arithmetic findings carry `advisory: true`: they display, they do not set
`uncertain`, they do not cap confidence, and they do not block anything.

## Errors

`ocr()` and `extract()` throw `ReceiptLensError` for operational failures only, with exactly three codes:
`IMAGE_UNREADABLE`, `MODEL_LOAD_FAILED`, `RECOGNIZE_FAILED`. A blank scan is **not** an error — it is a
valid zero-word `OcrResult` that parses to zero items and validates to a `zero_items` finding.

## What this package does not do

`validate()` checks parse-derived data and nothing else. It cannot know whether bill units are assigned,
whether a payer exists, whether drafts are resolved, or whether the bill can lock. Those are the PWA's
`validateWorkingBill(workingBill): BillValidationResult`, which owns all bill-state findings and
`LockBlocker[]`. Core exposes no blocker type, and a minor finding can still block a PWA action — the UI
reads codes, never message text.

## Provider

The default is `pp-ocrv6` (PP-OCRv6 Tiny, WASM), swappable through the `OcrProvider` interface:

```ts
import { createPPOCRv6Provider, type OcrProvider } from "@receipt-lens/core";

const provider: OcrProvider = createPPOCRv6Provider({ assetBaseUrl: "/models/" });
```

Assets — detection model, recognition model, dictionary — are served from your own origin, listed in
a manifest that pins each asset's byte size and SHA-256; the provider verifies both before it
compiles anything. Model binaries are not shipped inside this package. Content-hashed *file names*
and the service-worker model cache are ticket 17's work; until then the cache key is the manifest
hash and the names below are the plain upstream ones.

<!-- footprint:begin -->
<!-- generated by benchmarks/scripts/render-footprint-table.mjs from benchmarks/results/footprint.json.
     Do not edit this block by hand. Regenerate with: node benchmarks/scripts/render-footprint-table.mjs --write -->

## Footprint, measured

Not claimed — measured. Every number below is generated from the committed results file
`benchmarks/results/footprint.json` (protocol `receipt-lens-footprint/1`, schema `1.0`, measured `2026-11-04` at `16ae8de`, 5 samples per phase per class).
CI regenerates this block and fails on drift. The old "~4.3 MB complete OCR pipeline" figure is withdrawn (ADR-002) and does not reappear here; what follows is this deployment's measurement.

### What a first visit downloads

| Component | Request | Bytes | MB | Kept for the next visit | Bytes of record |
|---|---|---:|---:|---|---|
| **Model and dictionary** | | **6,279,992** | **6.28** | | |
| Model manifest | `/assets/models/manifest.json` | 2,700 | 0.00 | yes — 304 | committed · assets/models/manifest.json |
| Detection model (PP-OCRv6 Tiny) | `/assets/models/PP-OCRv6_tiny_det.onnx` | 1,780,590 | 1.78 | yes — 304 | committed · assets/models/PP-OCRv6_tiny_det.onnx |
| Recognition model (PP-OCRv6 Tiny) | `/assets/models/PP-OCRv6_tiny_rec.onnx` | 4,462,639 | 4.46 | yes — 304 | committed · assets/models/PP-OCRv6_tiny_rec.onnx |
| Recognition dictionary | `/assets/models/PP-OCRv6_tiny_rec.txt` | 34,063 | 0.03 | yes — 304 | committed · assets/models/PP-OCRv6_tiny_rec.txt |
| **Inference runtime (onnxruntime-web, WASM)** | | **14,873,590** | **14.87** | | |
| Inference runtime JS loader | `/ort/ort-wasm-simd-threaded.mjs` | 24,738 | 0.02 | yes — 304 | lockfile-pinned · ort-wasm-simd-threaded.mjs |
| Inference runtime WASM | `/ort/ort-wasm-simd-threaded.wasm` | 14,848,852 | 14.85 | **no** | lockfile-pinned · ort-wasm-simd-threaded.wasm |
| **Application** | | **145,507** | **0.15** | | |
| Harness page (HTML) | `/` | 981 | 0.00 | yes — 304 | committed · harness/index.html |
| Application script (core + runtime JS glue) | `/dist/main.js` | 144,526 | 0.14 | yes — 304 | built · harness/dist/main.js |
| **Initial download, empty cache** | 11 requests for 8 assets (3 re-fetches of the runtime loader, one per WASM worker thread) | **21,299,089** | **21.30** | | min 21,299,089 / max 21,299,089; 2,019 B of response headers on top, as counted by the page |
| **Kept by the browser cache** | 7 of 8 assets | **6,450,237** | **6.45** | returned as 304 on later visits | this is the whole cache today: no service worker yet (§9 cache keying is ticket 17) |
| **Not kept: re-downloaded every visit** | `/ort/ort-wasm-simd-threaded.wasm` | **14,848,852** | **14.85** | no | paid again on each of the 10 warm samples |
| **Second visit, over the network** | 11 requests | **14,848,852** | **14.85** | | 3,000 B of response headers on top, as counted by the page |

MB = 10⁶ bytes. The receipt image is not in this table on purpose: it is user data, never a network request.

**Initial download: 21.30 MB. Second visit: 14.85 MB** — lower than cold because 7 of 8 assets revalidate from HTTP cache (304), but not zero, because Chromium's HTTP cache retains ~6–8 MiB per entity and the 14.85 MB ONNX Runtime WASM exceeds that limit. Ticket 17's service-worker Cache API is expected to reduce second-visit bytes to zero for cached assets. Until then, users re-download the WASM on every reload.
Re-downloaded in full every visit: `/ort/ort-wasm-simd-threaded.wasm` (14,848,852 B). Measured with a 512 MB HTTP disk cache, so this is not a too-small-cache artifact.

### How long it takes

| Class | Phase | App ready | OCR ready | First result | Model load | Inference | Download |
|---|---|---:|---:|---:|---:|---:|---:|
| desktop-chromium-unthrottled | cold | 45 ms | 545 ms | **1136 ms** | 500 ms | 616 ms | 21.30 MB |
| desktop-chromium-unthrottled | warm | 16 ms | 186 ms | **688 ms** | 173 ms | 503 ms | 14.85 MB |
| desktop-chromium-unthrottled | repeat | — | — | **468 ms** | 0 ms | 468 ms | 0.00 MB |
| desktop-chromium-cpu4x | cold | 58 ms | 1289 ms | **3185 ms** | 1232 ms | 1899 ms | 21.30 MB |
| desktop-chromium-cpu4x | warm | 29 ms | 668 ms | **2565 ms** | 637 ms | 1878 ms | 14.85 MB |
| desktop-chromium-cpu4x | repeat | — | — | **1844 ms** | 0 ms | 1844 ms | 0.00 MB |

*App ready* is page plus script, before any model byte moves; *OCR ready* is when a receipt could
be answered at all (manifest fetched, models downloaded and verified, WASM compiled, both sessions
created); *first result* adds decode, detection, recognition, `parse()` and `validate()`. Medians
above; cold spread per class:

- `desktop-chromium-unthrottled`: cold 976–1751 ms, n=5, warm 636–1190 ms, n=5
- `desktop-chromium-cpu4x`: cold 3171–3227 ms, n=5, warm 2498–2613 ms, n=5

### Declared conditions

| | |
|---|---|
| Browser | chromium 156.0.8078.4 (headless true), Playwright 1.64.1 |
| Machine | AMD Ryzen 5 5600H with Radeon Graphics, 12 logical cores, 15 GB RAM, linux x64, kernel 7.3.1-1-cachyos |
| Node | v26.13.0 |
| Runtime | onnxruntime-web 1.31.1, `wasm`, 4 WASM threads, crossOriginIsolated true |
| Under test | @receipt-lens/core 0.0.0, provider `pp-ocrv6` version `1.0.0-tiny+sha256.0179bb711e74`, preset `tiny` (model 1.0.0, Apache-2.0, 29 lines / 75 words on the declared image) |
| Image | `benchmarks/datasets/raw/sroie/assets/ex.jpg` (463×1013, 70,139 B) — user data, not app footprint: it is never a network request (the page reads the File object directly). Declared because it sets the inference time. |
| Bytes counted by | summed from the origin's own request log (harness/serve.mjs), which sees WASM and worker loads that page resource timings do not; HTTP header bytes are excluded |
| Timing anchor | performance.timeOrigin of the measured document. appReadyMs is the instant the page was handed to the driver to attach the image, so it carries one Playwright round-trip; harnessLatencyMs reports the polling lag on the other side of the run. |
| Central value | median, with min and max published beside it. With n=5 no percentile is claimed. |
| Latency basis | cold and warm are timed from their own navigation, page load included; the repeat phase has no navigation and is the duration from the receipt being handed over to the result arriving, with everything already in memory. That is why the repeat row carries no app-ready or OCR-ready figure. |

### Classes

- **Desktop Chromium (headless), this machine at native speed** — physical desktop machine, loopback origin, no bandwidth throttling, no network emulation
- **Desktop Chromium (headless), 4x emulated CPU throttle** — the same physical machine with Chromium's Emulation.setCPUThrottlingRate at 4x (the Lighthouse slow-4x convention). Emulation, not a device: it slows script, WASM compile and inference, and says nothing about a phone's memory, GPU or network stack.

> **Emulation caveat.** Slow class is 4× Emulation.setCPUThrottlingRate on the same machine (Lighthouse slow-4× convention). This is a declared emulation, not a representative phone measurement. Mobile hardware latency will be higher.

### Serving mode of this measurement

- Scope: core runtime + harness wrapper; PWA not built — re-measure after tickets 10a, 10
- Entry: harness/index.html — the PROJECT(1).md §9 M1 minimal inference harness page
- Harness-only bytes: harness/index.html (981 B) is the only separable harness-authored file — not separable in the current bundle: harness/dist/main.js is one esbuild output combining harness/src/main.ts, packages/core/dist and the onnxruntime-web JS glue, so the harness wrapper's share of those bytes is not isolated. The bundle total is not the eventual PWA's total.
- Server: harness/serve.mjs — one same-origin HTTP/1.1 origin on 127.0.0.1, no reverse proxy
- Cache: cache-control: no-cache + ETag revalidation (serve.mjs cacheMode=validate, added by ticket 08; the default stays no-store)
- Encoding: identity — nothing is compressed, so wire bytes equal file bytes
- App script: harness/dist/main.js: esbuild ESM bundle of packages/core/dist plus onnxruntime-web/dist/ort.wasm.bundle.min.mjs (77,024 bytes of runtime JS glue). Not minified at the core layer, and not the PWA — tickets 10a and 10 do not exist yet.
- Source maps: harness/dist/main.js.map exists but a headless page without devtools never requests it
- Threads: ORT runs on the WASM execution provider with 4 threads under COOP/COEP cross-origin isolation (serve.mjs sets both headers)

### Not in this table

- excluded: the receipt image itself — user data, and never a network request
- excluded: HTTP request/response header bytes (a few hundred bytes per asset per visit)
- excluded: anything a service worker would cache: this deployment has no service worker yet (ticket 17), so the HTTP cache is the whole cache
- not measured: any real phone, tablet or low-end laptop — the 4x class is an emulated CPU rate, not a device
- not measured: network latency and bandwidth beyond loopback; on a real link add RTT and whatever the connection delivers, which is why bytes are published per asset and not only as a total
- not measured: peak memory: the WASM heap, the decoded image buffers and both inference graphs are resident after load and are not sized here
- not measured: parse() and validate() separately: they run in the same frame as inference on this page, so firstResultMs includes them and modelLoadMs does not
- not measured: PP-OCRv6 Small, quantized builds, or a lazy/deferred model load (1E.3, ticket 09b, and the risk R2 contingencies)

Re-derive it: `node benchmarks/scripts/measure-footprint.mjs && node benchmarks/scripts/render-footprint-table.mjs --write`.
<!-- footprint:end -->

## Entry points

`@receipt-lens/core` resolves to an ES module of isomorphic code. Only the OCR provider is
browser-runtime-specific; `parse()`, `validate()` and the split math run unchanged under Node, which is
how the benchmark harness exercises them.
