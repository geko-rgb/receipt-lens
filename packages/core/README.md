# @receipt-lens/core

Receipt parsing that runs entirely in the browser: OCR on-device, a deterministic parser, and a
validator that only checks what the receipt actually printed.

No image, OCR text, or parsed field ever leaves the device. Inference runs locally through
`onnxruntime-web` against self-hosted, content-hashed model assets — there is no third-party endpoint
in the request path, and the pipeline contains no network call other than fetching those assets from
the app's own origin.

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

Assets — detection model, recognition model, dictionary — are served from your own origin under
content-hashed names listed in a manifest. Model binaries are not shipped inside this package.

## Entry points

`@receipt-lens/core` resolves to an ES module of isomorphic code. Only the OCR provider is
browser-runtime-specific; `parse()`, `validate()` and the split math run unchanged under Node, which is
how the benchmark harness exercises them.
