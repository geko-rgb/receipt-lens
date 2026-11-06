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

<!-- accuracy:begin -->
<!-- generated by benchmarks/scripts/render-accuracy-table.mjs from benchmarks/results/{parser-only,end-to-end}-*.json.
     Do not edit this block by hand. Regenerate with: node benchmarks/scripts/render-accuracy-table.mjs --write -->

## Accuracy, measured

**Two numbers, read together.** On the SROIE English test split, strict exact match: **60.7% with reference OCR** (the parser's score when the text handed to it is already correct), versus **57.3% with Tiny OCR and 62.9% with Small OCR** on the same receipts. Reference OCR and real OCR use different line grouping, so **neither is a strict ceiling on the other** — real OCR can occasionally produce better grouping than the reference fixtures (`DECISIONS/0014` M8). **The number a user experiences is the end-to-end number with the default model.** The tier comparison behind that default, with the measured alternative, is `DECISIONS/0015`.

**The price rows that can actually see a wrong price are the `money_gate=off` ones.** §8.2 makes money compatibility a *precondition* of pairing, so the gated census is structurally incapable of reporting a mismatched amount, and `DECISIONS/0008` requires both columns to be published. Read the gated column as "how the scorer pairs items"; read the ungated column as "how the parser reads money".

Every figure below is generated from committed results JSON in `benchmarks/results/` (scorer `03b.2`, `matchItems(τ=0.7, money_gate=on)`, normalized Levenshtein per `DECISIONS/0006`, confidence floors 0.50/0.70 and round-off band ±₹0.02/≤₹1.00 per `DECISIONS/0011`; gate G8t verified by this generator). CI regenerates this block and fails on drift.

### Tier 1 — strict exact match

| Mode | Dataset | Language | Receipts | Scoreable | Strict | Rate | Macro F1 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| **parser-only (headline)** | cord-v2 · dev | Indonesian (out-of-language) | 100 | 100 | 2 | 2.0% | 0.473 |
| **parser-only (headline)** | sroie · dev | English | 150 | 149 ( 1 unlabelled, excluded) | 90 | 60.4% | 0.647 |
| **parser-only (headline)** | cord-v2 · eval | Indonesian (out-of-language) | 100 | 100 | 0 | 0.0% | 0.523 |
| **parser-only (headline)** | sroie · eval | English | 361 | 361 | 219 | 60.7% | 0.662 |
| end-to-end Tiny | cord-v2 · dev | Indonesian (out-of-language) | 100 | 100 | 0 | 0.0% | 0.425 |
| end-to-end Tiny | sroie · dev | English | 150 | 149 ( 1 unlabelled, excluded) | 86 | 57.7% | 0.606 |
| end-to-end Tiny | cord-v2 · eval | Indonesian (out-of-language) | 100 | 100 | 0 | 0.0% | 0.449 |
| end-to-end Tiny | sroie · eval | English | 361 | 361 | 207 | 57.3% | 0.622 |
| end-to-end Small | cord-v2 · dev | Indonesian (out-of-language) | 100 | 100 | 0 | 0.0% | 0.438 |
| end-to-end Small | sroie · dev | English | 150 | 149 ( 1 unlabelled, excluded) | 95 | 63.8% | 0.660 |
| end-to-end Small | cord-v2 · eval | Indonesian (out-of-language) | 100 | 100 | 0 | 0.0% | 0.494 |
| end-to-end Small | sroie · eval | English | 361 | 361 | 227 | 62.9% | 0.666 |

Strict means *every field that dataset supports agrees on that receipt* (§8 Tier 1). It is one number per row, not a rate to be read as usable-or-not: the CORD rows carry nine scored fields including four item fields, the SROIE rows carry one. `Macro F1` averages the dataset's scored fields unweighted.

**What parser-only does not count.** Parser-only accuracy measures what the parser classifies automatically. Rows the parser cannot classify are preserved as ambiguous rows and can be manually added to the bill via the review screen — the review workflow exists for exactly this reason. A user who reviews ambiguous rows will see higher effective accuracy than the parser-only number suggests, because the parser-only number is what the automated path alone achieves without any manual recovery. Ticket 21 tracks the prevalence of priced-but-ambiguous rows; v1 does not publish a percentage for this.

**Where the automated path loses money, and what happens to it.** `arithmetic_item_sum` is not accuracy evidence — where it fires, it is a 05/20 classifier gap, not a price bug. Unrecognised charge labels (labels outside the dictionary in §5) are currently dropped rather than preserved as `otherCharges` entries; this is tracked as ticket 20 for post-v1.

### Tier 2 — field-level precision / recall / F1

| Mode | Dataset · split | Field | TP | FP | FN | Precision | Recall | F1 | Gold cells | Gold left blank |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| parser-only | cord-v2 · dev | grandTotal | 77 | 7 | 19 | 0.917 | 0.802 | 0.856 | 96 | 0 |
| parser-only | cord-v2 · dev | subtotal | 44 | 4 | 21 | 0.917 | 0.677 | 0.779 | 65 | 0 |
| parser-only | cord-v2 · dev | serviceCharge | 9 | 2 | 3 | 0.818 | 0.750 | 0.783 | 12 | 0 |
| parser-only | cord-v2 · dev | discount | 1 | 3 | 4 | 0.250 | 0.200 | 0.222 | 5 | 0 |
| parser-only | cord-v2 · dev | taxTotal | 20 | 3 | 25 | 0.870 | 0.444 | 0.588 | 45 | 0 |
| parser-only | cord-v2 · dev | item.name | 53 | 192 | 201 | 0.216 | 0.209 | 0.212 | 254 | 0 |
| parser-only | cord-v2 · dev | item.qty | 37 | 111 | 161 | 0.250 | 0.187 | 0.214 | 198 | 56 |
| parser-only | cord-v2 · dev | item.unitPrice | 3 | 132 | 46 | 0.022 | 0.061 | 0.033 | 49 | 205 |
| parser-only | cord-v2 · dev | item.lineTotal | 133 | 111 | 89 | 0.545 | 0.599 | 0.571 | 222 | 32 |
| parser-only | sroie · dev | grandTotal | 90 | 39 | 59 | 0.698 | 0.604 | 0.647 | 149 | 0 |
| parser-only | cord-v2 · eval | grandTotal | 63 | 3 | 28 | 0.955 | 0.692 | 0.803 | 91 | 0 |
| parser-only | cord-v2 · eval | subtotal | 45 | 0 | 18 | 1.000 | 0.714 | 0.833 | 63 | 0 |
| parser-only | cord-v2 · eval | serviceCharge | 8 | 3 | 3 | 0.727 | 0.727 | 0.727 | 11 | 0 |
| parser-only | cord-v2 · eval | discount | 3 | 3 | 1 | 0.500 | 0.750 | 0.600 | 4 | 0 |
| parser-only | cord-v2 · eval | taxTotal | 18 | 1 | 22 | 0.947 | 0.450 | 0.610 | 40 | 0 |
| parser-only | cord-v2 · eval | item.name | 78 | 216 | 192 | 0.265 | 0.289 | 0.277 | 270 | 0 |
| parser-only | cord-v2 · eval | item.qty | 52 | 144 | 141 | 0.265 | 0.269 | 0.267 | 193 | 77 |
| parser-only | cord-v2 · eval | item.unitPrice | 7 | 173 | 56 | 0.039 | 0.111 | 0.058 | 63 | 207 |
| parser-only | cord-v2 · eval | item.lineTotal | 142 | 152 | 99 | 0.483 | 0.589 | 0.531 | 241 | 29 |
| parser-only | sroie · eval | grandTotal | 219 | 82 | 142 | 0.728 | 0.607 | 0.662 | 361 | 0 |
| end-to-end Tiny | cord-v2 · dev | grandTotal | 71 | 6 | 25 | 0.922 | 0.740 | 0.821 | 96 | 0 |
| end-to-end Tiny | cord-v2 · dev | subtotal | 43 | 6 | 22 | 0.878 | 0.662 | 0.754 | 65 | 0 |
| end-to-end Tiny | cord-v2 · dev | serviceCharge | 6 | 2 | 6 | 0.750 | 0.500 | 0.600 | 12 | 0 |
| end-to-end Tiny | cord-v2 · dev | discount | 1 | 5 | 4 | 0.167 | 0.200 | 0.182 | 5 | 0 |
| end-to-end Tiny | cord-v2 · dev | taxTotal | 18 | 4 | 27 | 0.818 | 0.400 | 0.537 | 45 | 0 |
| end-to-end Tiny | cord-v2 · dev | item.name | 42 | 193 | 212 | 0.179 | 0.165 | 0.172 | 254 | 0 |
| end-to-end Tiny | cord-v2 · dev | item.qty | 42 | 122 | 156 | 0.256 | 0.212 | 0.232 | 198 | 56 |
| end-to-end Tiny | cord-v2 · dev | item.unitPrice | 2 | 148 | 47 | 0.013 | 0.041 | 0.020 | 49 | 205 |
| end-to-end Tiny | cord-v2 · dev | item.lineTotal | 115 | 118 | 107 | 0.494 | 0.518 | 0.505 | 222 | 32 |
| end-to-end Tiny | sroie · dev | grandTotal | 86 | 49 | 63 | 0.637 | 0.577 | 0.606 | 149 | 0 |
| end-to-end Tiny | cord-v2 · eval | grandTotal | 51 | 7 | 40 | 0.879 | 0.560 | 0.685 | 91 | 0 |
| end-to-end Tiny | cord-v2 · eval | subtotal | 39 | 1 | 24 | 0.975 | 0.619 | 0.757 | 63 | 0 |
| end-to-end Tiny | cord-v2 · eval | serviceCharge | 8 | 3 | 3 | 0.727 | 0.727 | 0.727 | 11 | 0 |
| end-to-end Tiny | cord-v2 · eval | discount | 2 | 4 | 2 | 0.333 | 0.500 | 0.400 | 4 | 0 |
| end-to-end Tiny | cord-v2 · eval | taxTotal | 14 | 3 | 26 | 0.824 | 0.350 | 0.491 | 40 | 0 |
| end-to-end Tiny | cord-v2 · eval | item.name | 64 | 224 | 206 | 0.222 | 0.237 | 0.229 | 270 | 0 |
| end-to-end Tiny | cord-v2 · eval | item.qty | 58 | 163 | 135 | 0.262 | 0.301 | 0.280 | 193 | 77 |
| end-to-end Tiny | cord-v2 · eval | item.unitPrice | 3 | 206 | 60 | 0.014 | 0.048 | 0.022 | 63 | 207 |
| end-to-end Tiny | cord-v2 · eval | item.lineTotal | 118 | 169 | 123 | 0.411 | 0.490 | 0.447 | 241 | 29 |
| end-to-end Tiny | sroie · eval | grandTotal | 207 | 98 | 154 | 0.679 | 0.573 | 0.622 | 361 | 0 |
| end-to-end Small | cord-v2 · dev | grandTotal | 70 | 9 | 26 | 0.886 | 0.729 | 0.800 | 96 | 0 |
| end-to-end Small | cord-v2 · dev | subtotal | 44 | 5 | 21 | 0.898 | 0.677 | 0.772 | 65 | 0 |
| end-to-end Small | cord-v2 · dev | serviceCharge | 7 | 2 | 5 | 0.778 | 0.583 | 0.667 | 12 | 0 |
| end-to-end Small | cord-v2 · dev | discount | 1 | 4 | 4 | 0.200 | 0.200 | 0.200 | 5 | 0 |
| end-to-end Small | cord-v2 · dev | taxTotal | 18 | 4 | 27 | 0.818 | 0.400 | 0.537 | 45 | 0 |
| end-to-end Small | cord-v2 · dev | item.name | 48 | 184 | 206 | 0.207 | 0.189 | 0.198 | 254 | 0 |
| end-to-end Small | cord-v2 · dev | item.qty | 41 | 117 | 157 | 0.259 | 0.207 | 0.230 | 198 | 56 |
| end-to-end Small | cord-v2 · dev | item.unitPrice | 3 | 146 | 46 | 0.020 | 0.061 | 0.030 | 49 | 205 |
| end-to-end Small | cord-v2 · dev | item.lineTotal | 116 | 115 | 106 | 0.502 | 0.523 | 0.512 | 222 | 32 |
| end-to-end Small | sroie · dev | grandTotal | 95 | 44 | 54 | 0.683 | 0.638 | 0.660 | 149 | 0 |
| end-to-end Small | cord-v2 · eval | grandTotal | 62 | 7 | 29 | 0.899 | 0.681 | 0.775 | 91 | 0 |
| end-to-end Small | cord-v2 · eval | subtotal | 43 | 1 | 20 | 0.977 | 0.683 | 0.804 | 63 | 0 |
| end-to-end Small | cord-v2 · eval | serviceCharge | 8 | 3 | 3 | 0.727 | 0.727 | 0.727 | 11 | 0 |
| end-to-end Small | cord-v2 · eval | discount | 3 | 4 | 1 | 0.429 | 0.750 | 0.545 | 4 | 0 |
| end-to-end Small | cord-v2 · eval | taxTotal | 15 | 2 | 25 | 0.882 | 0.375 | 0.526 | 40 | 0 |
| end-to-end Small | cord-v2 · eval | item.name | 69 | 210 | 201 | 0.247 | 0.256 | 0.251 | 270 | 0 |
| end-to-end Small | cord-v2 · eval | item.qty | 57 | 152 | 136 | 0.273 | 0.295 | 0.284 | 193 | 77 |
| end-to-end Small | cord-v2 · eval | item.unitPrice | 6 | 190 | 57 | 0.031 | 0.095 | 0.046 | 63 | 207 |
| end-to-end Small | cord-v2 · eval | item.lineTotal | 127 | 150 | 114 | 0.458 | 0.527 | 0.490 | 241 | 29 |
| end-to-end Small | sroie · eval | grandTotal | 227 | 94 | 134 | 0.707 | 0.629 | 0.666 | 361 | 0 |

`Gold left blank` is the disclosure §8 demands for sparse fields: paired cells where the dataset printed no value but the parser asserted one count as **false positives** under the strict cell rule (`DECISIONS/0006`'s Option B correction), so `item.unitPrice` in particular is measured against a denominator the dataset itself did not fill in — CORD annotates a unit price on 49 of 254 dev gold items.

### Money, stated twice, because one of them hides the other

| Mode | Dataset · split | Matcher | Pairs | Gold unitPrice | Exact | Absent | **Wrong** | Line totals both present | Agree | Disagree |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| parser-only | cord-v2 · dev | `matchItems(τ=0.7, money_gate=on)` | 135 | 3 | 3 | 0 | **0** | 133 | 133 | **0** |
| parser-only | cord-v2 · dev | `matchItems(τ=0.7, money_gate=off)` | 139 | 5 | 3 | 0 | **2** | 137 | 135 | **2** |
| parser-only | cord-v2 · eval | `matchItems(τ=0.7, money_gate=on)` | 150 | 8 | 7 | 1 | **0** | 142 | 142 | **0** |
| parser-only | cord-v2 · eval | `matchItems(τ=0.7, money_gate=off)` | 161 | 11 | 7 | 1 | **3** | 153 | 145 | **8** |
| end-to-end Tiny | cord-v2 · dev | `matchItems(τ=0.7, money_gate=on)` | 117 | 2 | 2 | 0 | **0** | 115 | 115 | **0** |
| end-to-end Tiny | cord-v2 · dev | `matchItems(τ=0.7, money_gate=off)` | 123 | 4 | 2 | 0 | **2** | 121 | 117 | **4** |
| end-to-end Tiny | cord-v2 · eval | `matchItems(τ=0.7, money_gate=on)` | 124 | 3 | 3 | 0 | **0** | 118 | 118 | **0** |
| end-to-end Tiny | cord-v2 · eval | `matchItems(τ=0.7, money_gate=off)` | 132 | 6 | 3 | 0 | **3** | 126 | 120 | **6** |
| end-to-end Small | cord-v2 · dev | `matchItems(τ=0.7, money_gate=on)` | 118 | 3 | 3 | 0 | **0** | 116 | 116 | **0** |
| end-to-end Small | cord-v2 · dev | `matchItems(τ=0.7, money_gate=off)` | 126 | 5 | 3 | 0 | **2** | 124 | 118 | **6** |
| end-to-end Small | cord-v2 · eval | `matchItems(τ=0.7, money_gate=on)` | 135 | 7 | 6 | 1 | **0** | 127 | 127 | **0** |
| end-to-end Small | cord-v2 · eval | `matchItems(τ=0.7, money_gate=off)` | 140 | 9 | 6 | 1 | **2** | 132 | 128 | **4** |

SROIE is absent from this table on purpose: it annotates no item field, so it cannot produce an item-price number, and its money evidence is the receipt-level `grandTotal` row above. `DECISIONS/0008` requires both columns: the money gate is a *precondition* of pairing, so the `money_gate=on` census is structurally incapable of reporting a wrong price — the `off` column is where a wrong price is visible at all.

### Price provenance — why there is no single `detected` accuracy

| Mode | Dataset · split | Items | priceSource detected | — read off the row | — line total promoted on assumed qty 1 | unresolved | qty explicit | qty assumed | qty unresolved |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| parser-only | cord-v2 · dev | 245 | 135 | 43 | 92 | 110 | 56 | 92 | 97 |
| parser-only | sroie · dev | 273 | 196 | 58 | 138 | 77 | 90 | 139 | 44 |
| parser-only | cord-v2 · eval | 294 | 180 | 68 | 112 | 114 | 84 | 112 | 98 |
| parser-only | sroie · eval | 708 | 461 | 74 | 387 | 247 | 191 | 389 | 128 |
| end-to-end Tiny | cord-v2 · dev | 235 | 150 | 27 | 123 | 85 | 39 | 125 | 71 |
| end-to-end Tiny | sroie · dev | 345 | 243 | 50 | 193 | 102 | 79 | 209 | 57 |
| end-to-end Tiny | cord-v2 · eval | 288 | 209 | 37 | 172 | 79 | 48 | 173 | 67 |
| end-to-end Tiny | sroie · eval | 938 | 604 | 86 | 518 | 334 | 224 | 551 | 163 |
| end-to-end Small | cord-v2 · dev | 232 | 149 | 21 | 128 | 83 | 30 | 128 | 74 |
| end-to-end Small | sroie · dev | 359 | 251 | 63 | 188 | 108 | 110 | 195 | 54 |
| end-to-end Small | cord-v2 · eval | 279 | 196 | 41 | 155 | 83 | 52 | 157 | 70 |
| end-to-end Small | sroie · eval | 962 | 616 | 151 | 465 | 346 | 321 | 491 | 150 |

Ticket 06's rescue promotes a printed line total into a `detected` unit price whenever the quantity reads as 1 — including an *assumed* 1, which the receipt never printed. Those two populations are counted separately and are never averaged together (`DECISIONS/0014` M7.3).

### Why the strict floor is where it is — the criticals, attributed

| Mode | Dataset · split | Findings | Critical | Receipts with ≥1 critical | zero_items | arithmetic_total | arithmetic_item_sum | item_without_price | invalid_result_schema |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| parser-only | cord-v2 · dev | 609 | 52 | 38 | 14 | 16 | 21 | 1 | 0 |
| parser-only | sroie · dev | 1,172 | 54 | 48 | 28 | 18 | 6 | 1 | 1 |
| parser-only | cord-v2 · eval | 650 | 55 | 42 | 11 | 15 | 28 | 0 | 1 |
| parser-only | sroie · eval | 2,958 | 139 | 119 | 74 | 37 | 23 | 1 | 4 |
| end-to-end Tiny | cord-v2 · dev | 560 | 57 | 45 | 19 | 16 | 20 | 2 | 0 |
| end-to-end Tiny | sroie · dev | 1,515 | 55 | 46 | 11 | 16 | 10 | 13 | 1 |
| end-to-end Tiny | cord-v2 · eval | 600 | 58 | 44 | 12 | 17 | 26 | 1 | 1 |
| end-to-end Tiny | sroie · eval | 4,186 | 135 | 113 | 23 | 29 | 35 | 33 | 14 |
| end-to-end Small | cord-v2 · dev | 539 | 63 | 47 | 19 | 18 | 25 | 1 | 0 |
| end-to-end Small | sroie · dev | 1,458 | 41 | 34 | 7 | 17 | 10 | 5 | 2 |
| end-to-end Small | cord-v2 · eval | 575 | 60 | 44 | 12 | 18 | 27 | 2 | 1 |
| end-to-end Small | sroie · eval | 3,844 | 118 | 95 | 22 | 35 | 28 | 25 | 8 |

- **`zero_items` counts receipts where itemization could not be proven, not parser failures.** `validate()` cannot tell a single-total slip from a failed parse (`DECISIONS/0014` M7.1).
- **`arithmetic_item_sum` is not accuracy evidence.** Those criticals are charge and tender rows ticket 05 classified as items, so `readCharges` never saw them — a 05/20 classifier gap, not a price bug (`DECISIONS/0011`, ticket 20).
- **`arithmetic_total` and `item_without_price` are validation findings and data limits**, in that order: the parsed subtotal itself agrees with gold on every checkable dev receipt (`DECISIONS/0011`).

### Confidence — the floors run in one mode only

| Mode | Dataset · split | Words | Words scored | Lines | Lines scored | Items | Items scored | Below 0.50 | Below 0.70 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| parser-only | cord-v2 · dev | 2,186 | 0 | 1,219 | 0 | 245 | 0 | — | — |
| parser-only | sroie · dev | 8,238 | 0 | 4,385 | 0 | 273 | 0 | — | — |
| parser-only | cord-v2 · eval | 2,356 | 0 | 1,309 | 0 | 294 | 0 | — | — |
| parser-only | sroie · eval | 19,386 | 0 | 10,495 | 0 | 708 | 0 | — | — |
| end-to-end Tiny | cord-v2 · dev | 2,362 | 2,362 | 899 | 899 | 235 | 235 | 190 | 266 |
| end-to-end Tiny | sroie · dev | 15,352 | 15,352 | 4,487 | 4,487 | 345 | 345 | 312 | 632 |
| end-to-end Tiny | cord-v2 · eval | 2,528 | 2,528 | 936 | 936 | 288 | 288 | 179 | 260 |
| end-to-end Tiny | sroie · eval | 38,279 | 38,279 | 10,777 | 10,777 | 938 | 938 | 545 | 1,213 |
| end-to-end Small | cord-v2 · dev | 2,247 | 2,247 | 813 | 813 | 232 | 232 | 68 | 104 |
| end-to-end Small | sroie · dev | 16,030 | 16,030 | 4,449 | 4,449 | 359 | 359 | 99 | 231 |
| end-to-end Small | cord-v2 · eval | 2,472 | 2,472 | 901 | 901 | 279 | 279 | 75 | 121 |
| end-to-end Small | sroie · eval | 39,945 | 39,945 | 10,694 | 10,694 | 962 | 962 | 207 | 480 |

The headline mode scores **no** confidence at all: fixtures are dataset reference OCR and neither CORD nor SROIE annotates a recognition score (`DECISIONS/0003`), so every parser-only receipt takes `confidence_unavailable` and no floor comparison runs. The 0.50/0.70 floors are **declared defaults, not calibrated values** — exercised end-to-end where a score exists, calibrated nowhere, and §17's M1-exit calibration still needs a calibration-corpus decision that has not been made.

### The OCR gap, and the two tiers

| Tier | Comparison | Dataset · split | Field | Parser-only F1 | End-to-end F1 | Δ F1 |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Tiny | end-to-end vs headline | cord-v2 · dev | grandTotal | 0.856 | 0.821 | −0.035 |
| Tiny | end-to-end vs headline | cord-v2 · dev | subtotal | 0.779 | 0.754 | −0.024 |
| Tiny | end-to-end vs headline | cord-v2 · dev | serviceCharge | 0.783 | 0.600 | −0.183 |
| Tiny | end-to-end vs headline | cord-v2 · dev | discount | 0.222 | 0.182 | −0.040 |
| Tiny | end-to-end vs headline | cord-v2 · dev | taxTotal | 0.588 | 0.537 | −0.051 |
| Tiny | end-to-end vs headline | cord-v2 · dev | item.name | 0.212 | 0.172 | −0.041 |
| Tiny | end-to-end vs headline | cord-v2 · dev | item.qty | 0.214 | 0.232 | +0.018 |
| Tiny | end-to-end vs headline | cord-v2 · dev | item.unitPrice | 0.033 | 0.020 | −0.013 |
| Tiny | end-to-end vs headline | cord-v2 · dev | item.lineTotal | 0.571 | 0.505 | −0.065 |
| Tiny | end-to-end vs headline | sroie · dev | grandTotal | 0.647 | 0.606 | −0.042 |
| Tiny | end-to-end vs headline | cord-v2 · eval | grandTotal | 0.803 | 0.685 | −0.118 |
| Tiny | end-to-end vs headline | cord-v2 · eval | subtotal | 0.833 | 0.757 | −0.076 |
| Tiny | end-to-end vs headline | cord-v2 · eval | serviceCharge | 0.727 | 0.727 | +0.000 |
| Tiny | end-to-end vs headline | cord-v2 · eval | discount | 0.600 | 0.400 | −0.200 |
| Tiny | end-to-end vs headline | cord-v2 · eval | taxTotal | 0.610 | 0.491 | −0.119 |
| Tiny | end-to-end vs headline | cord-v2 · eval | item.name | 0.277 | 0.229 | −0.047 |
| Tiny | end-to-end vs headline | cord-v2 · eval | item.qty | 0.267 | 0.280 | +0.013 |
| Tiny | end-to-end vs headline | cord-v2 · eval | item.unitPrice | 0.058 | 0.022 | −0.036 |
| Tiny | end-to-end vs headline | cord-v2 · eval | item.lineTotal | 0.531 | 0.447 | −0.084 |
| Tiny | end-to-end vs headline | sroie · eval | grandTotal | 0.662 | 0.622 | −0.040 |
| Small | end-to-end vs headline | cord-v2 · dev | grandTotal | 0.856 | 0.800 | −0.056 |
| Small | end-to-end vs headline | cord-v2 · dev | subtotal | 0.779 | 0.772 | −0.007 |
| Small | end-to-end vs headline | cord-v2 · dev | serviceCharge | 0.783 | 0.667 | −0.116 |
| Small | end-to-end vs headline | cord-v2 · dev | discount | 0.222 | 0.200 | −0.022 |
| Small | end-to-end vs headline | cord-v2 · dev | taxTotal | 0.588 | 0.537 | −0.051 |
| Small | end-to-end vs headline | cord-v2 · dev | item.name | 0.212 | 0.198 | −0.015 |
| Small | end-to-end vs headline | cord-v2 · dev | item.qty | 0.214 | 0.230 | +0.016 |
| Small | end-to-end vs headline | cord-v2 · dev | item.unitPrice | 0.033 | 0.030 | −0.002 |
| Small | end-to-end vs headline | cord-v2 · dev | item.lineTotal | 0.571 | 0.512 | −0.059 |
| Small | end-to-end vs headline | sroie · dev | grandTotal | 0.647 | 0.660 | +0.012 |
| Small | end-to-end vs headline | cord-v2 · eval | grandTotal | 0.803 | 0.775 | −0.028 |
| Small | end-to-end vs headline | cord-v2 · eval | subtotal | 0.833 | 0.804 | −0.030 |
| Small | end-to-end vs headline | cord-v2 · eval | serviceCharge | 0.727 | 0.727 | +0.000 |
| Small | end-to-end vs headline | cord-v2 · eval | discount | 0.600 | 0.545 | −0.055 |
| Small | end-to-end vs headline | cord-v2 · eval | taxTotal | 0.610 | 0.526 | −0.084 |
| Small | end-to-end vs headline | cord-v2 · eval | item.name | 0.277 | 0.251 | −0.025 |
| Small | end-to-end vs headline | cord-v2 · eval | item.qty | 0.267 | 0.284 | +0.016 |
| Small | end-to-end vs headline | cord-v2 · eval | item.unitPrice | 0.058 | 0.046 | −0.011 |
| Small | end-to-end vs headline | cord-v2 · eval | item.lineTotal | 0.531 | 0.490 | −0.040 |
| Small | end-to-end vs headline | sroie · eval | grandTotal | 0.662 | 0.666 | +0.004 |

Model provenance of the end-to-end rows:

| Run | Model | Inference per receipt |
| --- | --- | --- |
| end-to-end Tiny · dev | PP-OCRv6 Tiny · `1.0.0-tiny+sha256.0179bb711e74` · manifest `0179bb711e74` · 6,277,292 B of model bytes | median 446 ms (min 135, max 1206, n=250) |
| end-to-end Tiny · eval | PP-OCRv6 Tiny · `1.0.0-tiny+sha256.0179bb711e74` · manifest `0179bb711e74` · 6,277,292 B of model bytes | median 494 ms (min 126, max 966, n=461) |
| end-to-end Small · dev | PP-OCRv6 Small · `1.0.0-small+sha256.b40e87d1af74` · manifest `b40e87d1af74` · 31,133,548 B of model bytes | median 1738 ms (min 382, max 5569, n=250) |
| end-to-end Small · eval | PP-OCRv6 Small · `1.0.0-small+sha256.b40e87d1af74` · manifest `b40e87d1af74` · 31,133,548 B of model bytes | median 1880 ms (min 401, max 4027, n=461) |

### What these numbers are not

- **Ceilings, twice over.** Fixtures are the datasets' own reference OCR, so no OCR error reaches the headline numbers; and development happens against `dev/`, so bugs a dev-driven fix would have caught on `eval/` are already gone (`DECISIONS/0004`).
- **Not an item-price claim from SROIE, and not an English claim from CORD.** SROIE annotates `total` only; CORD is Indonesian and is a layout-stress bucket that ADR-010 keeps out of the headline.
- **No row-classification gold-class split.** The pinned CORD snapshot contains only annotated financial lines, so it has no gold noise-header or continuation class to split `ambiguous` rows against, and the committed fixtures do not carry the per-line category. The 25.1%/16.5% ambiguous rates stay ticket 05's, with its caveat (`DECISIONS/0014` M7.5).
- **Not a name-recovery claim from substring containment.** `item.name` above is the matcher's field agreement under `matchItems(τ=0.7, money_gate=on)`; ticket 05's substring reachability figure measures a different thing and is not published here (`DECISIONS/0014` M5).

- **The low CORD `item.name` score is a measured parser defect, not Indonesian being hard.** Of 82 name misses among paired dev items, 80 have the gold tokens as a strict subset of the prediction and 70 of those surplus tokens are digits — the printed quantity folded into the name when continuation rows merge. The metric is flat across τ 0.50–0.90, so it is not a threshold effect. Diagnosed in `DECISIONS/0015` M-4, artifact `benchmarks/results/diagnostic-item-names-cord-v2-dev.json`; owned by tickets 05/06.
- **Neither mode is a strict ceiling on the other.** Reference OCR carries no recognition noise, which is why parser-only isolates the parser — but the two modes also differ in line grouping, so real OCR can occasionally group a receipt better than the reference fixtures do: measured on SROIE eval, 62.9% with Small against 60.7% parser-only (`DECISIONS/0014` M8).

Re-derive a row: `pnpm measure:accuracy -- --split dev` (parser-only, CI-runnable, no dataset download) or `pnpm run:end-to-end -- --tier tiny --split dev` (local, needs `benchmarks/datasets/raw/`), then `node benchmarks/scripts/render-accuracy-table.mjs --write`.

<!-- accuracy:end -->

<!-- footprint:begin -->
<!-- generated by benchmarks/scripts/render-footprint-table.mjs from benchmarks/results/footprint.json.
     Do not edit this block by hand. Regenerate with: node benchmarks/scripts/render-footprint-table.mjs --write -->

## Footprint, measured

Not claimed — measured. Every number below is generated from the committed results file
`benchmarks/results/footprint.json` (protocol `receipt-lens-footprint/2`, schema `1.0`, measured `2026-11-06` at `2782934`, 5 samples per phase per class).
CI regenerates this block and fails on drift. The old "~4.3 MB complete OCR pipeline" figure is withdrawn (ADR-002) and does not reappear here; what follows is this deployment's measurement.

**Measured deployment:** `packages/pwa/dist/app/index.html` — the built, installable PWA. Served by `scripts/serve-measure-app.mjs`,
the same origin the offline and capture specs run against.

**In one paragraph.** A cold visit — first load, models downloaded — moves **21,718,277 B**. A warm visit — a reload with the service worker controlling — moves **2,700 B**: 8,043.8x less than the cold visit in this same measurement, and 5,499.6x less than the pre-ticket-17 warm visit it replaced (14,848,852 B, `crossCheck.harnessWarmBytesOverTheWire`). The residual is the worker's deliberate model-manifest version
probe, not a cache miss. The caches hold 21,459,809 B at install. Latency, medians: cold 1,257 ms / warm 624 ms unthrottled, 3,818 ms / 2,375 ms at 4x CPU throttle. Measured on a
synthetic 4-line receipt — a real receipt with more lines costs more per line, so these are a
floor rather than a bound. Latency at 1 ORT thread (no COOP/COEP isolation, so the harness's 4-thread numbers do not carry over). Every figure above is derived from
`benchmarks/results/footprint.json` and `benchmarks/results/warm-bytes.json` by this generator, and `verify:footprint` re-derives it in CI.

### What a first visit downloads

| Component | Request | Bytes | MB | Held for the next visit | Bytes of record |
|---|---|---:|---:|---|---|
| **Model and dictionary** | | **6,279,992** | **6.28** | | |
| Model manifest | `/assets/models/manifest.json` | 2,700 | 0.00 | **no** — 2,700 B downloaded again (10/10 warm visits) | committed · assets/models/manifest.json |
| Detection model (PP-OCRv6 Tiny) | `/assets/models/PP-OCRv6_tiny_det.onnx` | 1,780,590 | 1.78 | yes — worker cache, never requested | committed · assets/models/PP-OCRv6_tiny_det.onnx |
| Recognition model (PP-OCRv6 Tiny) | `/assets/models/PP-OCRv6_tiny_rec.onnx` | 4,462,639 | 4.46 | yes — worker cache, never requested | committed · assets/models/PP-OCRv6_tiny_rec.onnx |
| Recognition dictionary | `/assets/models/PP-OCRv6_tiny_rec.txt` | 34,063 | 0.03 | yes — worker cache, never requested | committed · assets/models/PP-OCRv6_tiny_rec.txt |
| **Inference runtime (onnxruntime-web, WASM)** | | **14,923,174** | **14.92** | | |
| Inference runtime WASM | `/assets/ort-wasm-simd-threaded-qh98TCA_.wasm` | 14,848,852 | 14.85 | yes — worker cache, never requested | built · packages/pwa/dist/app/assets/ort-wasm-simd-threaded-qh98TCA_.wasm |
| Inference runtime JS loader | `/assets/ort.wasm.bundle.min-DEokbyO3.js` | 74,322 | 0.07 | yes — worker cache, never requested | built · packages/pwa/dist/app/assets/ort.wasm.bundle.min-DEokbyO3.js |
| **Application** | | **263,120** | **0.26** | | |
| Service worker module chunk | `/assets/cache-names-BCswqTtv.js` | 955 | 0.00 | yes — asked, told not modified, 0 B moved (10/10 warm visits) | built · packages/pwa/dist/app/assets/cache-names-BCswqTtv.js |
| Application entry script (shell + core + OCR glue) | `/assets/index-0itO_252.js` | 242,513 | 0.24 | yes — worker cache, never requested | built · packages/pwa/dist/app/assets/index-0itO_252.js |
| Application styles | `/assets/index-DSs-D2Tf.css` | 7,980 | 0.01 | yes — worker cache, never requested | built · packages/pwa/dist/app/assets/index-DSs-D2Tf.css |
| Bundle runtime | `/assets/rolldown-runtime-CEoa-xHZ.js` | 543 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/assets/rolldown-runtime-CEoa-xHZ.js |
| App shell served for a route navigation | `/capture` | 905 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/index.html |
| Launcher icon | `/icons/receipt-lens-192.png` | 562 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/icons/receipt-lens-192.png |
| Launcher icon | `/icons/receipt-lens-512-maskable.png` | 2,515 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/icons/receipt-lens-512-maskable.png |
| Launcher icon | `/icons/receipt-lens-512.png` | 2,642 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/icons/receipt-lens-512.png |
| App shell document (precached) | `/index.html` | 905 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/index.html |
| Web app manifest | `/manifest.webmanifest` | 728 | 0.00 | yes — worker cache, never requested | built · packages/pwa/dist/app/manifest.webmanifest |
| Service worker script | `/sw.js` | 2,872 | 0.00 | yes — asked, told not modified, 0 B moved (10/10 warm visits) | built · packages/pwa/dist/app/sw.js |
| **Initial download, empty cache** | 22 requests for 17 assets (5 repeat fetches inside the same visit) | **21,718,277** | **21.72** | | min 21,718,277 / max 21,718,277 |
| **Held for the next visit** | 14 of 17 assets | **21,459,809** | **21.46** | the service worker's Cache API, not the HTTP cache | derived: built precache manifest + verified model set |
| **Revalidated, not re-downloaded** | `/assets/cache-names-BCswqTtv.js` `/sw.js` | **0** | **0.00** | yes — `304`, no body moved | `/assets/cache-names-BCswqTtv.js` answered 304: the worker's module import — the defect ticket 17c closed: the repeat fetch now carries If-None-Match and answers 304 with no body (DECISIONS/0028 T7, DECISIONS/0029 P2); `/sw.js` answered 304: the browser's own byte-check of the worker script; a worker never intercepts the fetch of its own script |
| **Downloaded again on every visit** | `/assets/models/manifest.json` | **2,700** | **0.00** | no | W5 step 1's version probe, deliberately cache: "reload" (DECISIONS/0027 W6) — the app asking the origin what it serves, which is the point of the probe |
| **Second visit, over the network** | 3 requests | **2,700** | **0.00** | | `benchmarks/results/warm-bytes.json` measures the same quantity with a different driver |

| What the page itself observed | 10 cold / 11 warm document resources, of which 11 warm ones moved zero bytes | 3,395,287 cold / 0 B warm | | of which 1,950 B / 0 B are response headers | The page's own resource timings cover only the resources the *document* fetched. The worker's install precache, the WASM and the model downloads are not document resources and never appear here — that is why F5 counts bytes at the origin. So this pair is reported beside the totals and never added to them, and it is not the header cost of the whole visit. |

MB = 10⁶ bytes. The receipt image is not in this table on purpose: it is user data, never a network request.

**Reconciled to the three rows ticket 11 asks for.** These add to the initial download, and the fourth row
is why the first two do not: a cold visit is 22 requests for
17 assets, so some assets move more than once inside one visit.

| | Bytes | MB |
|---|---:|---:|
| App shell (document, entry script, styles, worker and its module, icons, web manifest) | 263,120 | 0.26 |
| Models + inference runtime (WASM and its JS loader) | 21,203,166 | 21.20 |
| Repeat fetches within the same visit | 251,991 | 0.25 |
| **Total, first visit, empty cache** | **21,718,277** | **21.72** |

**Initial download: 21.72 MB. Second visit: 2,700 B** — a warm visit moves 2,700 bytes over 3 requests, where the superseded scaffold measurement moved 14,848,852 (5500×), and the runtime WASM is not among them.
Two mechanisms do that work, and the headers say which is which. The worker's Cache API holds the bulk binaries: this origin still answers `cache-control: no-store` for the model weights, the recognition dictionary and the runtime WASM — precisely because Chromium's HTTP cache cannot
hold a 14.85 MB entity (ADR-002, `DECISIONS/0012` F10/F12) and a second copy beside the precache would be dead weight and a stale-weights path
around `DECISIONS/0027` W5. Code and app metadata instead carry a content `ETag` (`DECISIONS/0029` P1-P3), so a warm
visit asks whether its copy is current and is answered with a `304` that moves no body.

On this run's warm visit 14 asset(s) never reached the origin, 2 asked and were told not modified with 0 B moved, and 1 still downloaded a body: `/assets/models/manifest.json` — each structural, each named with its reason above.
Whether the `ETag` removed the worker's own module chunk is stated from this run rather than assumed: if the bytes still move, the finding
stays open with the reason the run showed and the fix belongs to `DECISIONS/0029` P5's other branch; if they do not, it closes against this
artifact. Durability of what the worker does hold is requested, not assumed: the Cache API is exempt from the per-entity limit but not from origin quota or
eviction (`DECISIONS/0027` W18), and `no-cache` is a promise to revalidate, not a promise of freshness without a round trip.


### Why this cold figure is larger than the one it replaced

The superseded measurement published 21,299,089 B for a first visit, in
`benchmarks/results/footprint-2026-11-04-16ae8de.json`. This deployment is `packages/pwa/dist/app/index.html`, and the
difference of **419,188 B** is a change in what ships, not a regression in what any one file
costs. It decomposes exactly, and `verify:footprint` re-checks that arithmetic on every run:

| | Bytes | What it is |
|---|---:|---|
| Models and dictionary | 0 | unchanged — the same committed 6,279,992 B set, verified against the same manifest |
| Inference runtime | +49,584 | the WASM is byte-identical at 14,848,852 B; the runtime's JS loader grew, because the build emits it into the app's asset graph instead of mounting it from a dependency directory |
| Application | +117,613 | the Svelte shell, its stylesheet, the worker and its module chunk, three launcher icons, the route document and the web app manifest, less the scaffold's single application bundle |
| Repeat fetches inside one visit | +251,991 | the worker precaches with `cache: "reload"`, so it asks again for bytes the document just downloaded: `/assets/index-0itO_252.js` alone accounts for 242,513 B of it, fetched 2 times, across 4 assets that move more than once; 1 of those repeat fetches is now answered with a `304` carrying no body (`/assets/cache-names-BCswqTtv.js`), which is ticket 17c's validator and is why this figure is smaller than it was before 17c |
| **Total** | **+419,188** | 21,299,089 B became 21,718,277 B |

Read the last row twice: a cold visit fetches the shell more than once, and that is a property of a worker
refusing to trust a cached copy of its own shell, not of a larger bundle. The same mechanism is why the warm
visit is cheap. Ticket 17c put a content `ETag` on code assets, which converts the repeat
fetches into `304` revalidations where the browser already holds a copy — it removes bytes, not requests,
and the requests themselves are `DECISIONS/0029` P4's other branch, owned by 17e.

### How long it takes

| Class | Phase | App ready | OCR ready | First result | Model load | Inference | Download |
|---|---|---:|---:|---:|---:|---:|---:|
| desktop-chromium-unthrottled | cold | 39 ms | *not separable* | **1257 ms** | *not separable* | *not separable* | 21.72 MB |
| desktop-chromium-unthrottled | warm | 21 ms | *not separable* | **624 ms** | *not separable* | *not separable* | 0.00 MB |
| desktop-chromium-unthrottled | Re-run OCR (same image, no navigation) *(supplementary)* | — | *not separable* | **434 ms** | *not separable* | *not separable* | 0.00 MB |
| desktop-chromium-cpu4x | cold | 118 ms | *not separable* | **3818 ms** | *not separable* | *not separable* | 21.72 MB |
| desktop-chromium-cpu4x | warm | 42 ms | *not separable* | **2375 ms** | *not separable* | *not separable* | 0.00 MB |
| desktop-chromium-cpu4x | Re-run OCR (same image, no navigation) *(supplementary)* | — | *not separable* | **1687 ms** | *not separable* | *not separable* | 0.00 MB |

**What the latency numbers are measured on.** The receipt is synthetic and deliberately small:
900×1200, 4 declared text lines (`RECEIPT`, `COFFEE 4.50`, `TOTAL 100.00`, `CASH 100.00`),
parsed to 1 item rows / 0 charge rows rendered from the declared image, zero-items state false. It is the identical fixture that
`playwright/capture.spec.ts` and `playwright/offline-reload.spec.ts` draw, and it is drawn in the page rather than
loaded from a dataset so that the input to a published latency number is committed code with a hash, not a
2.7 GB snapshot only one machine has. **So these numbers answer “how long does a user wait for a first
result on a small receipt” — they are not a bound on larger ones.** A faded thermal receipt with 20+ lines,
tighter leading or perspective distortion produces more detection boxes, more recognition passes and more
reviewable rows, and the pipeline's cost is per line, so the figures above are a floor rather than a ceiling.
The superseded scaffold run measured a different image as well (a 463×1013 dataset photograph), so pre-17 and
post-17 latency are not comparable on image size as well as on thread count.

*App ready* is this deployment's `load` event: the shell document, its entry chunk and its styles are parsed and the capture
view can accept a file. *First result* is navigation start to the DOM state `playwright/capture.spec.ts` already treats as
proof a draft was produced, so on a cold device it includes downloading and verifying the model set — that is the honest
cold number, not the "models already fetched" one, because navigation to `/capture` is what triggers the download
(`DECISIONS/0027` W2.1). Medians above; spread per class:

- `desktop-chromium-unthrottled`: cold 1229–1310 ms, n=5, warm 579–662 ms, n=5
- `desktop-chromium-cpu4x`: cold 3588–4163 ms, n=5, warm 2255–2411 ms, n=5

*OCR ready*, *model load* and *inference* are **not separable** in this deployment, and are not published as leftovers
from the superseded one. The shipped bundle carries no timing hook — `DECISIONS/0027` W15, following
`DECISIONS/0023` S1, refuses a test-only hook in what users receive — and the app surfaces no OCR duration to the DOM,
so the instant a verified model set became usable, and the split between model load and inference, cannot be observed
from outside. The reason recorded on each field in the artifact:

> no test-only timing hook ships in the bundle (DECISIONS/0027 W15 following DECISIONS/0023 S1), and the app surfaces no OCR duration to the DOM at all — verified by grep of packages/pwa/src

### How this run's latency compares to the one it replaced

Both runs are this machine, this browser and this receipt, 4.0 h apart, at revisions `6b3ca50` and `2782934`; what changed between them is the header policy `DECISIONS/0029` P2 records, not anything the app executes. Medians, with each run's own range:

| Cell | 6b3ca50 | 2782934 | Δ median | ranges overlap |
|---|---:|---:|---:|---|
| desktop-chromium-unthrottled · cold | 1,206.0 (1,186.7–1,226.1) ms | 1,256.7 (1,228.6–1,310.0) ms | +50.7 ms (+4.2%) | **no** |
| desktop-chromium-unthrottled · warm | 618.7 (590.3–629.0) ms | 623.5 (579.3–661.5) ms | +4.8 ms (+0.8%) | yes |
| desktop-chromium-unthrottled · repeat | 426.2 (414.9–438.1) ms | 434.3 (420.6–443.3) ms | +8.1 ms (+1.9%) | yes |
| desktop-chromium-cpu4x · cold | 3,670.8 (3,425.4–3,692.6) ms | 3,817.6 (3,588.1–4,162.5) ms | +146.8 ms (+4.0%) | yes |
| desktop-chromium-cpu4x · warm | 2,308.8 (2,205.1–2,321.5) ms | 2,375.2 (2,255.1–2,411.3) ms | +66.4 ms (+2.9%) | yes |
| desktop-chromium-cpu4x · repeat | 1,566.3 (1,526.7–1,573.2) ms | 1,686.5 (1,569.8–2,039.2) ms | +120.2 ms (+7.7%) | yes |

**One cell does not overlap: desktop-chromium-unthrottled · cold.** `DECISIONS/0029` P8 said to report a latency move beyond the run's own spread rather than absorb it, and that is what happened — the number is **published as measured, not re-rolled**. Re-running until a cell lands inside the previous range would be fitting a measurement to an expectation, which is the act ADR-002 and `DECISIONS/0012` F10 exist to forbid.

What the artifact says against that cell: the mechanism this ticket supplies is one conditional round trip over loopback per revalidated asset — microseconds — against a 51 ms gap, and the two runs' within-run spreads (39.4 ms then, 81.4 ms now) are of the same order as the difference itself. In run order this run's cold samples are 1,310.0, 1,228.6, 1,229.5, 1,256.7, 1,276.3, which puts its maximum first: an initial-check-in shape, not a drift shape.

**Read the columns as ranges, not as point estimates.** Five samples per cell on one desktop cannot resolve a 4% difference: across both runs, a cold first result on this deployment is 1.19–1.31 s unthrottled and 3.43–4.16 s at 4×, and a *comparison* between tickets needs interleaved A/B runs in one process (`DECISIONS/0029`'s checkpoint-3 finding). Bytes are the opposite case — they are deterministic at this origin, which is why `verify:warm-bytes` can hold them to ±0 while latency has no such gate.

### Declared conditions

| | |
|---|---|
| Browser | chromium 156.0.8078.4 (headless true), Playwright 1.64.1 |
| Machine | AMD Ryzen 5 5600H with Radeon Graphics, 12 logical cores, 15 GB RAM, linux x64, kernel 7.3.1-1-cachyos |
| Node | v26.13.0 |
| Runtime | onnxruntime-web 1.31.1, `wasm`, 1 WASM thread, crossOriginIsolated false |
| Threads | Latency measured at 1 ORT thread (serve-app.mjs sends no COOP/COEP; the harness's 4-thread measurement is superseded). If isolation headers are added, latency improves and the footprint table regenerates. |
| Under test | @receipt-lens/pwa 0.0.0, provider `pp-ocrv6` version `1.0.0`, preset `tiny` (model 1.0.0, Apache-2.0; 1 item rows / 0 charge rows rendered from the declared image, zero-items state false) |
| Image | 900×1200 receipt drawn in the page, 50,956 B, sha256 `4848c0628cdd0ead…` |
| Bytes counted by | summed from the origin's own request log (scripts/serve-measure-app.mjs), which sees the worker's install precache, the WASM and the model downloads that page resource timings do not; HTTP header bytes are excluded |
| Timing anchor | performance.timeOrigin of the measured document. appReadyMs is the navigation's load event; firstResultMs is the instant a page-side poll observed the inference finish (busy-state gone) with the draft rendered. No Playwright round-trip is inside either number. |
| Central value | median, with min and max published beside it. With n=5 no percentile is claimed (DECISIONS/0012 F2). |
| Latency basis | cold and warm are timed from their own navigation. The repeat phase has no navigation, so its firstResultMs is the duration from handover to result. appReadyMs is published for cold and warm only. |
| Warm cross-check | this artifact measured 2,700 B; `benchmarks/results/warm-bytes.json` measures 2,700 B; tolerance ±0 B |

### Classes

- **Desktop Chromium (headless), this machine at native speed** — physical desktop machine, loopback origin, no bandwidth throttling, no network emulation
- **Desktop Chromium (headless), 4x emulated CPU throttle** — the same physical machine with Chromium's Emulation.setCPUThrottlingRate at 4x (the Lighthouse slow-4x convention). Emulation, not a device: it slows script, WASM compile and inference, and says nothing about a phone's memory, GPU or network stack.

> **Emulation caveat.** Slow class is 4× Emulation.setCPUThrottlingRate on the same machine (Lighthouse slow-4× convention). This is a declared emulation, not a representative phone measurement. Mobile hardware latency will be higher.

### Serving mode of this measurement

- Scope: PWA — discharged here: DECISIONS/0012 F11 trigger 1 (the PWA exists) was this ticket, and this measurement is the discharge
- Entry: packages/pwa/dist/app/index.html
- Server: scripts/serve-measure-app.mjs — one same-origin HTTP/1.1 origin on 127.0.0.1, no reverse proxy, the request log F5 counts bytes from
- Cache: two policies, one module (DECISIONS/0029 P2): code and app metadata answer `cache-control: no-cache` with a content `ETag` and reply `304` to a matching `If-None-Match`; model weights, the recognition dictionary and the runtime WASM keep `no-store` and advertise no validator, because the worker's Cache API owns them and a second copy in the HTTP cache would be dead weight and a staleness path. Warm liveness is proven by *no body served over the origin* for anything the caches hold — and after ticket 17c a `304` is evidence for that claim rather than a violation of it.
- Encoding: identity — nothing is compressed, so wire bytes equal file bytes
- Precached at install: 11 entries; worker script 2,872 B

### Not in this table

- excluded: the receipt image itself — user data, and never a network request
- excluded: HTTP request/response header bytes (a few hundred bytes per asset per visit)
- not measured: any real phone, tablet or low-end laptop — the 4x class is an emulated CPU rate, not a device
- not measured: network latency and bandwidth beyond loopback; bytes are published per asset so a reader can apply RTT
- not measured: peak memory: the WASM heap, the decoded image buffers and both inference graphs are resident after load and are not sized here
- not measured: parse() and validate() separately: they run inside firstResultMs and cannot be split without a hook the shipped bundle does not have
- not measured: PP-OCRv6 Small, quantized builds, or a lazy/deferred model load (1E.3, ticket 09b, R2 contingencies)

Re-derive it: `node benchmarks/scripts/measure-footprint.mjs && node benchmarks/scripts/render-footprint-table.mjs --write`.
<!-- footprint:end -->

<!-- privacy:begin -->
<!-- generated by scripts/render-privacy-table.mjs from playwright/privacy.spec.ts,
     .github/workflows/privacy.yml and DECISIONS/0030. Do not edit this block by hand.
     Regenerate with: pnpm render:privacy -->

## Privacy, audited

**What the app does with your receipt.** Receipt OCR, parsing, and bill calculations run locally in the browser. After required app/model assets are available, the tested inference workflow works without outbound network access — a full-workflow privacy audit passes in CI, intercepting every request across capture, edit, lock, and share. The audit runs on every PR and fails the job on unexpected egress; on the current private-repository plan, GitHub does not permit branch protection rules that make this failure merge-blocking, so the audit's result is visible on every PR but a human must not merge a red PR. Merge-blocking enforcement activates when the repository becomes public, which is planned at v1's npm publish. Deliberate bill sharing is a separate user-initiated action: the URL fragment carries selected parsed bill data, never the receipt image or raw OCR text. Full audit results and limitations in `DECISIONS/0030`.

**How that is measured.** `playwright/privacy.spec.ts` drives one workflow through the shipped UI — capture, OCR, parse, review, edit, roster, assign, exclude, lock, mint share links, a participant opens one, settle — with three witnesses: the context request log (which asserts), the routing layer (which enforces), and the origin's own request log (which checks that the browser-side log is not blind). Six split tests read that one log. Requests are classified by scheme: `http:`/`https:` are network requests subject to every assertion, while `blob:`/`data:` are local object URLs, recorded but never counted as egress — and the image assertion still proves the receipt bytes appear in no `http(s)` body, URL, query or header. Deliberate share actions are aborted in CI and printed as excluded, not exempt, and each minted fragment and WhatsApp message body is content-scanned as an artifact. No request body or header value is written to the log.

### Limits — read these as part of the claim

- **An empirical demonstration, not a proof.** The audit shows that this flow, on this browser, on this deployment produced no unexpected egress. It cannot show that an untested code path would not.
- **One browser, and one measured blind spot.** Playwright's interception of service-worker traffic is browser-dependent; this is measured on Desktop Chrome only. Measured: a cross-origin GET issued from a page the service worker controls was not observed by the audit's request log, while a cross-origin POST from the same page was — so a worker-mediated GET leak would not be caught by this audit, and the claim above is about the egress it observes rather than every request a browser could make (`DECISIONS/0030` P3, P12).
- **The install path is half-tested.** The app's install-offering half is automated — a fabricated `beforeinstallprompt` event drives the banner. The browser's install-prompt half does not fire in headless Chromium; manual install verification is documented as a not-yet-run check.
- **Merge-blocking is a repository setting, not a code property.** The job fails red on every PR; what the current plan permits in branch protection is stated in the paragraph above.
- **The static scan is a supplement, never proof.** `pnpm scan:egress` catches a code path this flow never reaches; the runtime audit is what measures egress.

Re-derive it: `pnpm exec playwright test --config playwright/playwright.config.ts privacy.spec.ts`, then `pnpm verify:privacy-table` to re-render this block from the spec, the workflow and `DECISIONS/0030`.
<!-- privacy:end -->

## Entry points

`@receipt-lens/core` resolves to an ES module of isomorphic code. Only the OCR provider is
browser-runtime-specific; `parse()`, `validate()` and the split math run unchanged under Node, which is
how the benchmark harness exercises them.
