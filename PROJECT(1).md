**Specification version:** Consolidated v0.4 implementation specification.  
**Source of truth:** this file. Explicit owner decisions DQ-01–DQ-04 take precedence; compatible adopted v0.2 patches are merged into the existing requirements. Duplicate/pasted ADR numbers are not copied as new records.

# receipt-lens

> A privacy-first, fully in-browser receipt parser and bill splitter.  
> Existing pretrained OCR model. No custom model training in v1. Receipt inference stays local; bills are shared as URL-fragment snapshots.

---

## 1. Destination

Ship **`receipt-lens`** as a pnpm monorepo containing:

- **`packages/core`** — a reusable npm library that turns a receipt image into structured JSON in the browser.
- **`benchmarks/`** — a reproducible, dataset-aware evaluation harness for CORD and SROIE.
- **`playwright/`** — CI checks for offline inference and unexpected network egress.
- **`packages/pwa`** — a demo bill-splitting PWA with UPI links and user-confirmed settlement.

### Project claims

1. **Verifiable local processing** — OCR, parsing, validation, and split calculations run on the user's device. CI tests the inference workflow for unexpected network activity.
2. **Honest accuracy** — report dataset-scoped strict exact match and field-level precision/recall/F1, with each dataset's annotation limits clearly stated.
3. **Measured footprint** — report the actual model artifacts, runtime assets, initial download size, and cold/warm latency. Do not claim the complete OCR pipeline is ~4.3 MB until the shipped artifacts have been measured.

**Privacy scope:** receipt images and OCR text are processed locally and never uploaded for inference. v1 sharing is intentionally serverless: a share link carries a limited parsed-bill snapshot in its URL fragment. App/model asset loading and deliberate sharing are separate from inference; do not claim the entire app has literally zero network activity.

---

## 2. Locked Facts

- **No custom model training for v1.** Fine-tuning FLAN-T5-small remains a possible later experiment, not a commitment.
- **OCR engine for v1:** PP-OCRv6 Tiny via `onnxruntime-web`, behind a swappable `OcrProvider` interface. Tiny is the starting default, not a proven receipt-accuracy winner; compare Tiny and Small during M1 and retain reversibility.
- **No unmeasured model-size promise.** Report model files, dictionary, runtime/WASM assets, app JS, initial download, cache behavior, and cold/warm latency. Withdraw the prior “~4.3 MB total pipeline” claim.
- **Receipt inference is local.** No cloud OCR or server-side inference. Required models are self-hosted on the app origin; no third-party CDN fetch is required.
- **Manual edits override parsed values.** Preserve the provenance of manually supplied values. Recalculate derived amounts and re-run validation after every add, edit, or delete.
- **Staged API:** `ocr()`, provider-independent `parse()`, `validate()`, and convenience `extract()`.
- **OCR contract:** normalized lines and words, bounding boxes, nullable confidence where supplied, image dimensions, and provider/model provenance. Never fabricate confidence values.
- **Undetected values are `null`, never silently guessed.** Grand total and optional charges remain null if not detected. A normal item row may tentatively default to quantity 1 only with `quantitySource: "assumed"` and `qty_assumed`; ambiguous quantity remains null/unresolved.
- **Unresolved quantity or price blocks finalization as applicable.** An unresolved quantity blocks unit creation/assignment and bill locking. No unresolved amount may enter finalized bill/charge records.
- **Confidence is a review heuristic, not a calibrated probability.** Missing OCR confidence remains null and is skipped by confidence-threshold comparisons.
- **Receipt amounts are stored as integer paise; calculated participant shares use exact rational arithmetic.** Never use IEEE-754 binary floats for monetary calculations. Do not round calculated shares to paise or whole rupees. A share can contain a fractional paise when an item or bill-level charge is divided among people; preserve it exactly as a reduced rational number. Decimal display must not claim a rounded value is exact. UPI transfer amounts are a separate boundary conversion to whole paise, documented in §12.
- **Bill splitting:** preserve item quantity and assign at `ItemUnit` granularity through `ItemUnitAssignment`.
- **Public charge schema decision (DQ-03 = B):** keep `taxes[]`, `serviceCharge`, `tip`, and `discount` as separate public `ParseResult` fields. Add explicit `roundOff` and `otherCharges[]` fields needed for Indian receipt semantics. The PWA maps these into one normalized internal `BillCharge[]` representation; do not replace the chosen public API with a single public `charges[]` array.
- **Charge handling:** tax, service charge, tip, discount, round-off, and other labeled charges are modeled explicitly. Bill-level applicable charges are shared equally among all participants, including participants with no assigned items. A charge marked included is not added/split again.
- **Unassigned units:** a bill may lock only after the creator acknowledges each unassigned unit; the creator absorbs the cost through a visible `AdjustmentLine{reason: "unassigned"}`. It is not mixed with the printed signed `roundOff` charge or the separate UPI transfer-boundary conversion.
- **v1 payer rule:** creator and payer must be participants on the bill; `payerId` is required and defaults to the creator. This avoids non-participant-payer states that the v1 adjustment model cannot represent.
- **No participant-share rounding mode in v1.** Calculated shares remain exact rational values and sum exactly to the confirmed payable total. Do not round shares to paise or whole rupees for calculation/display. Only the final UPI transfer amount is converted to integer paise using the deterministic allocation in §12; show that transfer amount separately from the exact share.
- **Settlement is manual.** No bank reconciliation or automatic payment verification.

All DQ-01 through DQ-04 choices remain locked. Implementation details below make those choices executable without creating duplicate or conflicting ADR identifiers.

## 3. Repository Structure

Ship `receipt-lens` as a pnpm monorepo. `parse()` and core `validate(ParseResult)` are pure/isomorphic modules; the PWA separately owns `validateWorkingBill(WorkingBill): BillValidationResult` for bill-state and lock-blocker checks. Only the OCR provider is browser-runtime-specific.

```text
receipt-lens/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── ocr/
│   │   │   │   ├── provider.ts       # OcrProvider interface
│   │   │   │   ├── types.ts          # normalized OCR types
│   │   │   │   ├── worker.ts         # detection + recognition in a worker
│   │   │   │   └── pp-ocrv6.ts       # swappable default provider
│   │   │   ├── parse/
│   │   │   │   ├── index.ts          # parse(OcrResult): ParseResult
│   │   │   │   ├── geometry.ts       # y-band clustering + column model
│   │   │   │   └── regex.ts          # money/quantity matchers
│   │   │   ├── validate/
│       │   │   │   ├── index.ts          # validate(ParseResult): ParseValidationResult
│   │   │   │   ├── arithmetic.ts    # conditional arithmetic checks
│   │   │   │   └── confidence.ts    # scoped confidence thresholds/caps
│   │   │   ├── extract.ts            # OCR + parse + validate convenience API
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── package.json              # exports + browser entry where appropriate
│   │   └── tsconfig.json
│   └── pwa/
│       ├── src/
│       │   ├── routes/
│       │   ├── components/
│       │   ├── stores/               # bill state and versioned IndexedDB persistence
│       │   ├── lib/
│       │   │   ├── mapping.ts        # public ParseResult → internal bill entities
│       │   │   ├── editing.ts        # deterministic add/edit/delete flow
│       │   │   ├── validate-bill.ts   # PWA bill-state validation and lock blockers
│       │   │   ├── splitting.ts      # exact rational split engine; paise only at payment boundary
│       │   │   └── upi.ts            # deep-link generation
│       │   └── main.tsx
│       └── package.json
├── benchmarks/
│   ├── datasets/                     # downloaded/pinned, git-ignored source data
│   ├── fixtures/                     # versioned cached OcrResult JSON
│   ├── loaders/                      # CORD/SROIE dataset adapters
│   ├── scorers/                      # dataset-scoped strict + field metrics
│   ├── matching.ts                   # deterministic one-to-one matching
│   ├── benchmark.config.ts            # pinned τ and normalization constants
│   ├── run.ts
│   └── package.json
├── playwright/
│   ├── zero-egress.spec.ts
│   └── playwright.config.ts
├── .github/workflows/
│   ├── ci.yml
│   ├── privacy.yml
│   └── benchmark.yml
├── pnpm-workspace.yaml
├── package.json
└── PROJECT.md
```

Repository requirements:

- Register the `@receipt-lens` package scope before publishing; `packages/core` declares stable `exports` and browser-specific entry metadata.
- The benchmark CI uses cached `OcrResult` fixtures keyed by dataset snapshot, provider version, and model hash. Full OCR end-to-end runs are on-demand in a headless browser.
- The OCR worker receives transferable `ImageBitmap` input where available. Worker requests must be included in the privacy audit.
- PWA framework is still an open implementation choice (Svelte 5 is implied by the current structure but is not locked); choose it before M3, with its service-worker precache and IndexedDB design documented.

## 4. Public API

### Staged API

```ts
import {
  ocr, parse, validate, extract,
  type OcrProvider, type OcrResult, type ParseResult,
  type ParseValidationResult, type ReceiptLensResult,
} from "@receipt-lens/core";

const ocrResult: OcrResult = await ocr(image, { provider });
const parseResult: ParseResult = parse(ocrResult);
const validation: ParseValidationResult = validate(parseResult, {
  criticalOcrConfidenceFloor: 0.50,
  warningOcrConfidenceFloor: 0.70,
  strictArithmetic: true,
});
const result: ReceiptLensResult = await extract(image, {
  provider: "pp-ocrv6", // or a custom OcrProvider
  criticalOcrConfidenceFloor: 0.50,
  warningOcrConfidenceFloor: 0.70,
  strictArithmetic: true,
});
```

The shown thresholds are initial defaults to be evaluated and pinned at M1 exit; `criticalOcrConfidenceFloor` must not exceed `warningOcrConfidenceFloor`. The two options replace the ambiguous single `ocrConfidenceFloor`. `validate(parseResult, options)` is the core extraction validator and returns `ParseValidationResult`; bill-state lock blockers are computed only by the PWA function `validateWorkingBill(workingBill): BillValidationResult` in `packages/pwa/src/lib/validate-bill.ts`. Exact option/default-provider behavior requires API tests. `parse()` accepts normalized `OcrResult` only; it does not accept an image or provider-specific raw output.

### Public types

```ts
export interface OcrBox { x: number; y: number; width: number; height: number }

export interface OcrWord {
  text: string;
  box: OcrBox;
  confidence: number | null; // normalized 0..1 when provider supplies a meaningful score
}

export interface OcrLine {
  id: string;
  text: string;                 // normalized, space-joined text
  box: OcrBox;                  // union of word boxes
  confidence: number | null;   // mean of available meaningful word scores, otherwise null
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLine[];
  imageSize: { width: number; height: number };
  provider: string;
  version: string;              // provider/version plus model hash prefix where available
}

export interface OcrProvider {
  name: string;
  version: string;
  recognize(image: ImageBitmap | Blob | File): Promise<OcrResult>;
}

export type QuantitySource = "explicit" | "assumed" | "unresolved" | "user_confirmed";
export type FinalQuantitySource = "explicit" | "assumed" | "user_confirmed";
export type PriceSource = "detected" | "unresolved" | "user_confirmed";
export type FinalPriceSource = "detected" | "user_confirmed";
export type ValueSource = "detected" | "unresolved" | "user_confirmed";
export type ParticipantId = string;

export interface ParsedItem {
  id: string;                   // stable within this ParseResult
  name: string;
  qty: number | null;
  quantitySource: QuantitySource;
  unitPrice: number | null;     // integer paise
  priceSource: PriceSource;
  lineTotal: number | null;     // integer paise; detected row total when present
  confidence: number | null;   // heuristic, not a probability
  sourceLineIds: string[];
  warnings: ParseWarning[];
}

export type ParseWarningCode =
  | "qty_assumed"
  | "qty_unresolved"
  | "name_confidence_low"
  | "price_confidence_low"
  | "ocr_confidence_low"
  | "confidence_unavailable"
  | "ambiguous_price_separator"
  | "ambiguous_row"
  | "name_length_outlier"
  | "price_not_resolved"
  | "unclassified_charge"
  | "items_may_be_missing"
  | "round_off_adjusted"
  | "missing_optional_field";

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  itemRef?: string;
  sourceLineIds?: string[];
  sourceText?: string;
  sourceBox?: OcrBox;
}

export interface UnclassifiedRow {
  id: string;
  text: string;
  box: OcrBox;
  sourceLineIds: string[];
  reason: "ambiguous";
  warningCode: "ambiguous_row";
}

// Public v1 charge shape is deliberately kept as the owner's DQ-03 choice.
// All amounts are integer paise; null means unresolved during parsing.
export interface ParsedTax {
  label: string;
  amount: number | null;        // positive magnitude; arithmetic adds if not included
  rate?: number | null;         // display-only, parsed from a printed percentage
  included?: boolean;           // display-only; never add/split this charge again
  source: "detected" | "user_confirmed";
}

export interface ParsedOtherCharge {
  label: string;
  amount: number | null;        // positive magnitude; null while unresolved
  type: "other";
  sign: "add" | "subtract" | "unknown"; // unknown is excluded from arithmetic until reviewed
  included?: boolean;
  source: "detected" | "user_confirmed";
}

export interface ParseResult {
  items: ParsedItem[];
  unclassifiedRows: UnclassifiedRow[];
  taxes: ParsedTax[];
  serviceCharge: number | null; // positive magnitude in paise
  tip: number | null;           // positive magnitude in paise
  discount: number | null;      // positive magnitude in paise; arithmetic subtracts it
  roundOff: number | null;      // signed integer paise, preserving the printed +/- sign
  otherCharges: ParsedOtherCharge[];
  subtotal: number | null;
  subtotalSource: ValueSource;
  grandTotal: number | null;
  grandTotalSource: ValueSource;
  warnings: ParseWarning[];
}

export type ValidationSeverity = "critical" | "minor";
export type ValidationScope = "receipt" | "item" | "row" | "charge";

export interface ValidationFinding {
  severity: ValidationSeverity;
  code: string;
  scope: ValidationScope;
  message: string;
  itemRefs?: string[];
  rowRefs?: string[];
  chargeRefs?: string[];
  advisory?: boolean;
}

export interface ValidateOptions {
  criticalOcrConfidenceFloor: number;
  warningOcrConfidenceFloor: number;
  strictArithmetic: boolean;
}

export interface ParseValidationResult {
  uncertain: boolean;                 // true when a non-advisory critical parse finding exists
  findings: ValidationFinding[];      // parse/extraction/arithmetic findings only
  items: ParsedItem[];                // canonical validated items, with confidence caps applied
}

export interface ReceiptLensResult {
  parse: ParseResult;
  validation: ParseValidationResult;
  ocr: OcrResult;
}

// Internal PWA normalization; not the public ParseResult schema.
export type ChargeType = "tax" | "service_charge" | "tip" | "discount" | "round_off" | "other";
export interface BillCharge {
  id: string;
  billId: string;
  type: ChargeType;
  label: string;
  amount: number;                   // resolved integer paise; round_off is signed
  rate?: number | null;
  included: boolean;                // finalized charge: inclusion confirmed
  otherSign?: "add" | "subtract" | "unknown"; // used only when type = "other"
  source: "detected" | "user_confirmed";
}
```

### API and error contract

- `parse()` is pure: normalized `OcrResult` in, new `ParseResult` out; it never mutates inputs or shares mutable nested references.
- The parser emits `quantitySource` only as `explicit`, `assumed`, or `unresolved`. The PWA sets `user_confirmed` when the user supplies or changes a quantity.
- The parser emits `priceSource` as `detected` or `unresolved`. The PWA sets `user_confirmed` whenever the user supplies or changes a price.
- `ocr()` throws a typed `ReceiptLensError` only for operational failures: `IMAGE_UNREADABLE`, `MODEL_LOAD_FAILED`, or `RECOGNIZE_FAILED`. Blank OCR is a valid zero-word result; `parse()` returns zero items and `validate(parseResult)` emits critical `zero_items` for an input expected to be an itemized receipt.
- `extract({ strictArithmetic: false })` still runs arithmetic checks, but arithmetic findings are marked `advisory: true`: they display, do not cap confidence, do not set `uncertain`, and do not block workflow actions.
- `validate(parseResult, options)` is the core API and checks the `ParseResult` only; it re-emits parser warnings as structured findings and returns `validation.items` as the canonical validated item list. It cannot determine whether bill units are assigned, the payer exists, drafts are resolved, or the bill can lock. The PWA exposes `validateWorkingBill(workingBill): BillValidationResult` from `packages/pwa/src/lib/validate-bill.ts`; that function consumes the whole editable bill state, recalculates current bill-level arithmetic from edited entities, combines relevant extraction findings, and computes bill-state blockers. It must not use stale parser arithmetic to validate fields the user has changed. Edit operations call it after recomputation. `LockBlocker` is PWA-owned, not part of the public core result.
- Confidence is `null` if the provider does not supply a meaningful score. The contract never invents, imputes, or defaults confidence. If all scores are null, skip confidence comparisons and emit minor `confidence_unavailable`.

### Warning-code migration

The canonical names are `name_confidence_low` and `price_confidence_low`. Legacy spellings `low_name_confidence` and `low_price_confidence` must not be emitted by new code. During migration, map those legacy values to canonical names at the API boundary; do not maintain two meanings for equivalent codes.

## 5. Parser Geometry Contract

The deterministic parser combines y-band clustering and column inference:

1. **Y-band clustering:** group `OcrWord`s whose vertical centers overlap within a tolerance initially set to 40% of the receipt-wide median word height. The median is word-count-weighted; this is an initial heuristic to be tuned on development data.
2. **Price-column model:** infer a potential right-aligned price column from numeric words whose right edges align within an initial tolerance of 5% of image width. Publish the selected constants after tuning.

### Row classification

Classify rows before parsing their contents as `item | continuation | noise_header | ambiguous`.

- `noise_header` includes rows above the first item; label-dictionary matches; known header/noise patterns such as `QTY ITEM PRICE`, `TABLE 4`, and `GSTIN: …`; and rows with no price-column entry and no plausible continuation context.
- `ambiguous` rows do not become items. Preserve their text, box, and source-line references in `ParseResult.unclassifiedRows`, and emit a minor `ambiguous_row` warning/finding. Do not silently discard ambiguous lines or force them into items.
- Header/noise rows do not create phantom items and never trigger `item_without_price`.
- A row with multiple plausible price candidates emits `ambiguous_price_separator`; do not choose an arbitrary price.

### Continuation rule

A price-less row becomes a continuation of the previous item only when all conditions hold:

- indentation is within tolerance of the previous item's name column;
- it does not match a charge label or header pattern;
- its length is no more than twice the median item-name length seen so far; and
- it is not a standalone all-caps line.

Otherwise classify it as `noise_header` or `ambiguous`. Measure continuation precision/recall as a separate benchmark bucket.

### Quantity rules

- Parse quantity from a leading `N x`/`N×` pattern or a detected quantity column.
- A column qualifies as a quantity column when at least 60% of its rows contain integers ≤ 20, aligned left or right.
- If quantity is confidently absent on a normal item row, use `qty: 1`, `quantitySource: "assumed"`, and `qty_assumed`.
- If quantity is ambiguous, use `qty: null`, `quantitySource: "unresolved"`, and `qty_unresolved`. Unresolved quantities block unit creation and assignment.

### Number format contract

The parser and benchmark loader use an explicit locale profile; the app uses `en-IN`.

| Profile | Thousands separator | Decimal separator | Currency tokens | Example |
|---|---|---|---|---|
| `id-ID` (CORD loader) | `.` | `,` | `Rp` | `12.500` = 12500; `12,5` = 12.5 |
| `en` (SROIE loader) | `,` | `.` | none required | standard grouping |
| `en-IN` (PWA) | `,` including lakh grouping | `.` | `₹`, `Rs`, `INR` | `1,23,456.78` = 123456.78 |

Strip currency tokens first. A separator is structural only when its position matches the selected profile's grouping pattern. Ungrouped decimals use the profile's decimal separator. Normalize benchmark ground truth with the same profile as predictions. All parsed money is converted to integer paise at the boundary.

### Label dictionary

Match the longest label first so `SUBTOTAL` never matches `TOTAL` prematurely.

- English/Indian-English: `cgst`, `sgst`, `igst`, `cess`, `vat`, `gst`, `tax`, `service charge`, `sc`, `svc chg`, `service`, `tip`, `discount`, `subtotal`, `sub total`, `grand total`, `net amount`, `bill amount`, `total`, `round off`, `round`.
- Indonesian CORD layout bucket: `pajak`, `servis`, `diskon`, `subtotal`, `total`, `jumlah`.
- `round off` maps to the dedicated `roundOff` public field and internal `round_off` charge. Labeled charge lines without a known type are preserved in `otherCharges` and emit `unclassified_charge` where their arithmetic sign/meaning is not determinate.

### Safeguards

- Charge labels are matched before numeric rows are classified as products.
- Preserve word boxes and provider confidence; parsing must be deterministic and debuggable.
- `parse()` is provider-independent and model-free, so parser tests use fixture `OcrResult`s without running OCR.
- Money parsing must not use binary floating-point equality.

## 6. Validation Rules

Validation is conditional (check only present, semantically compatible operands) and scoped (apply findings to the words/items/rows/charges that caused them). Severity and workflow blocking are separate: a minor extraction warning can still block a specific action.

### Validation ownership and signatures

- Core package: `validate(parseResult: ParseResult, options?: ValidateOptions): ParseValidationResult`. It checks OCR-derived/parsed item, row, charge, subtotal, and grand-total data only. It does not know about persisted participants, `ItemUnitAssignment`s, drafts, payer IDs, or lock state.
- PWA package: `validateWorkingBill(workingBill: WorkingBill): BillValidationResult`, implemented in `packages/pwa/src/lib/validate-bill.ts`. It recalculates current working-bill item totals, applicable charges, exact shares, and reconciliation against the preserved printed/confirmed subtotal and grand total; it must not rely on stale `ParseResult` arithmetic for edited fields. It returns bill-level findings plus `LockBlocker[]`, including unresolved drafts, assumed quantities awaiting review, unassigned units, unresolved inclusion semantics, missing grand total/payer, and invalid participant shares.
- Every add/edit/delete transaction follows this order: persist the changed working state atomically → recalculate derived exact totals/shares → run core `validate()` for current parse-derived findings where applicable → run `validateWorkingBill()` → update UI findings/blockers. If the transaction fails, roll back the data change and do not display derived state from the failed mutation.
- `LockBlocker` is owned by the PWA and is not nested inside core `ParseValidationResult`. The UI uses codes, never message text, to determine whether an action is blocked.

### Confidence thresholds

- Initial defaults: `criticalOcrConfidenceFloor = 0.50`; `warningOcrConfidenceFloor = 0.70`. These are baseline values, not calibrated probabilities; evaluate and pin them at M1 exit. Require `critical <= warning`.
- Item-scoped findings use only meaningful scores for words contributing to the item's name or price. Below the critical floor emits critical `ocr_critical_field_confidence`; below the warning floor but not the critical floor emits minor `name_confidence_low` or `price_confidence_low`. These checks affect only the relevant item.
- Receipt-wide `ocr_confidence_low` is a minor diagnostic calculated as a word-count-weighted mean of non-null word scores. It is never the sole reason to reject a receipt. If all confidence values are null, skip comparisons and emit minor `confidence_unavailable`.
- Item confidence is a heuristic: average the available meaningful confidence values for essential name/price words when the required contributor scores exist; if unavailable, use null. Cap an item's confidence at 0.5 when a non-advisory critical finding affects it. Receipt-level criticals affect all items; item-level criticals affect only that item.

### Critical findings

| Code | Condition | Scope/effect |
|---|---|---|
| `ocr_critical_field_confidence` | Essential item name or price is below the critical OCR threshold | Affected item; review required |
| `arithmetic_item_sum` | Resolved item line totals contradict a compatible, reliably detected subtotal and coverage is sufficient | Receipt; critical |
| `arithmetic_total` | Compatible subtotal/charges/round-off do not reconcile with a reliable grand total | Receipt; critical |
| `item_without_price` | Candidate item has no resolvable price and is not a confirmed continuation | Item; blocks finalization |
| `zero_items` | No items extracted from input expected to be itemized | Receipt; critical |
| `invalid_result_schema` | Output violates required types/ranges or contains invalid numeric values | Receipt/item as applicable |

### Minor findings and row/charge diagnostics

| Code | Condition | Workflow effect |
|---|---|---|
| `qty_assumed` | Parser tentatively used quantity 1 | Must be reviewed before lock (`assumedQtyReviewed`) |
| `qty_unresolved` | Quantity is null/ambiguous | Blocks unit creation, assignment, finalization, and locking until resolved |
| `name_confidence_low` | Name score below warning floor but not critical floor | Review affected item |
| `price_confidence_low` | Price score below warning floor but not critical floor | Review affected item |
| `ocr_confidence_low` | Receipt-wide confidence diagnostic is low | Warning only; never sole rejection basis |
| `confidence_unavailable` | No meaningful confidence scores were supplied | Warning only |
| `ambiguous_price_separator` | Multiple plausible prices occur on a row | Does not create an item until resolved |
| `ambiguous_row` | A line cannot reliably be classified | Preserve row and require review before lock |
| `name_length_outlier` | Name length is an outlier; only evaluate with at least 5 items, using population standard deviation | Warning only, not proof of an error |
| `price_not_resolved` | Price could not be established | Blocks finalization/locking until corrected |
| `unclassified_charge` | Charge label/type/sign is not classified reliably | User must classify or explicitly exclude it before lock if it affects arithmetic |
| `items_may_be_missing` | Item-sum check lacks sufficient line-total/row coverage | Warning; do not mislabel missing rows as arithmetic contradiction |
| `round_off_adjusted` | A valid printed round-off reconciles the total within the specified band | Minor information finding |
| `missing_optional_field` | Emit only when a strong receipt cue indicates a value should exist, e.g. printed TOTAL label with unreadable amount | Review only |

### Arithmetic validator

Use integer paise for all receipt amounts and exact rational arithmetic for split shares.

```text
base_computed_total = subtotal
  + sum(non-included taxes)
  + sum(non-included service charges)
  + sum(non-included tips)
  + sum(non-included other charges with sign="add")
  - sum(non-included other charges with sign="subtract")
  - sum(non-included discounts)

expected_round_off = grandTotal - base_computed_total
```

- Charges marked `included: true` are already inside the relevant item/subtotal prices and are never added again. They also are not split as separate charge amounts.
- If no round-off is present, compare `base_computed_total` with `grandTotal` when all required operands and their semantics are known; a material mismatch is critical.
- Initial round-off defaults (to be evaluated and pinned at M1 exit): the signed `roundOff` amount must match `expected_round_off` within ₹0.02 and have magnitude no more than ₹1.00 for the standard round-off exception. A valid match passes with minor `round_off_adjusted`. A larger/mismatched adjustment is a critical contradiction, not a blanket tolerance.
- `arithmetic_item_sum` is critical only when every relevant parsed item has a line total and the row count/coverage is plausible. Otherwise emit minor `items_may_be_missing`; absent rows suggest extraction incompleteness, not a contradiction that per-item edits can automatically resolve.
- Ambiguous/noise/header rows do not create items. An `ambiguous_price_separator` row does not produce a finalized item; preserve its words/row as review candidates.
- An `other` charge with `sign: "unknown"` is excluded from arithmetic and emits `unclassified_charge`; it must be classified or explicitly excluded before lock if it can affect reconciliation.
- With `strictArithmetic: false`, still run the checks but mark every arithmetic finding `advisory: true`; advisory findings display but do not cap confidence, set `uncertain`, or block actions.

### Findings versus blockers

`ParseValidationResult` exposes core extraction findings and canonical validated items only. `BillValidationResult` exposes PWA bill-state findings and action blockers. The UI must never parse warning-message text to decide whether an action is blocked. Core `validate(parseResult)` re-emits parse warnings and returns `validation.items`; PWA `validateWorkingBill(workingBill)` computes lock blockers from the complete working state.

- `qty: null` or `quantitySource: "unresolved"` blocks unit creation, assignment, and lock.
- Missing required price/quantity/charge values block finalization and lock.
- Assumed quantities must be explicitly reviewed before lock.
- Ambiguous rows that could affect the total must be reviewed/classified or explicitly excluded before lock.
- Manual corrections replace current draft values and trigger recomputation plus validation; warnings are not allowed to silently modify values.

## 7. Quantity and Price Provenance

### Quantity provenance

| Situation | `qty` | `quantitySource` | Warning/workflow effect |
|---|---:|---|---|
| Quantity printed and parsed | Printed value | `explicit` | Units may materialize after required review |
| Normal item row with no printed quantity | `1` | `assumed` | Emit `qty_assumed`; show tentative-1 badge; review before lock |
| Ambiguous quantity | `null` | `unresolved` | Emit `qty_unresolved`; block unit creation/assignment/lock |
| Creator enters/changes quantity | User value | `user_confirmed` | Store as user correction, not receipt evidence |

The parser emits only `explicit`, `assumed`, or `unresolved`. The PWA sets `user_confirmed` whenever the creator supplies or edits a quantity. Finalized `Item` uses `FinalQuantitySource`, so it cannot retain unresolved quantity. A finalized quantity must be finite and positive; reject zero, negative, NaN, or infinity.

### Price provenance

`priceSource` records where the current unit price came from. It is provenance metadata, not a confidence score.

| Situation | `unitPrice` | `priceSource` | Workflow effect |
|---|---:|---|---|
| Parser resolved price from OCR/receipt text | Parsed integer paise | `detected` | Review may still be required based on confidence/validation |
| Price is missing or ambiguous | `null` | `unresolved` | Remain draft; cannot finalize or lock |
| Creator enters or changes price | User-supplied integer paise | `user_confirmed` | Manual value is authoritative until edited again |

The parser emits only `detected` or `unresolved`; `user_confirmed` is set by the PWA after user entry/edit. Finalized `Item` uses `FinalPriceSource`, so it cannot retain an unresolved price. Never replace a user-confirmed price with a later parser result without an explicit user action. User confirmation records origin, not guaranteed correctness.

## 8. Benchmark Protocol

### Datasets and annotation scope

| Dataset | Purpose and coverage | Benchmark mode |
|---|---|---|
| **CORD** (`cord-v2`, Indonesian receipts) | Detailed item annotations and layout/structure stress testing; report separately as out-of-language for the English-only product | Cached `OcrResult` fixtures for parser regressions; end-to-end OCR optional/on-demand |
| **SROIE** (English receipts) | Standard company/date/address/total labels; this parser scores **grand total only**, because it does not extract company/date/address | Gold OCR/text mode from dataset annotations |

Pin dataset snapshots and hashes, document licenses, and record which labels each loader actually supplies. Unannotated fields are excluded, never treated as false negatives or as null ground truth. CORD is a layout stress-test bucket and must not be mixed into the headline English accuracy claim.

### Scored fields and metrics

- CORD: supported item fields `name`, `qty`, `unitPrice`, `lineTotal`, plus `subtotal`/`grandTotal` when annotated.
- SROIE: map its `total` label to `grandTotal` only when semantics support the mapping; report a **grand-total score**, never “whole-receipt exact match” or item-level F1.
- **Tier 1 strict:** a receipt scores 1 only when every field supported by that dataset's scoring contract matches under predeclared normalization; otherwise 0. Report mean and count.
- **Tier 2 relaxed diagnostics:** field-level precision/recall/F1 using deterministic one-to-one matching. Unmatched predictions are false positives; unmatched ground-truth items are false negatives. Publish per-field scores and label macro/aggregate averaging.
- Null semantics are explicit: null-vs-null counts as a correct abstention only when the dataset explicitly marks missing values; disclose that this choice can inflate scores for sparse fields. Null-vs-populated counts as an error for the applicable field.

### Matching and normalization

1. Normalize names using Unicode NFC, casefold, punctuation stripping, and whitespace collapse. Do not discard meaningful words or digits.
2. Build candidate pairs where normalized-name similarity is at least `τ_name` and compatible monetary fields are equal to the integer-paise level.
3. Use deterministic order-respecting one-to-one dynamic programming (LCS-style), maximizing matched pair count and then total name similarity with fixed iteration order. Do not use order-sensitive greedy matching.
4. Unmatched predicted items are false positives; unmatched ground-truth items are false negatives.
5. Money comparison uses integer-paise equality. Relaxation applies to name matching, not to prices, unless a separately declared tolerance is used for a distinct diagnostic.
6. Locale-normalize ground truth using the same profile as predictions (`id-ID` for CORD, `en` for SROIE, `en-IN` for PWA). Pin `τ_name` and round-off band in `benchmark.config` before reporting results; finalize values at M1 exit.

### Separate parser quality from full-pipeline quality

- **Parser-only:** feed normalized/reference OCR text and boxes to `parse()` to isolate parsing errors.
- **End-to-end:** run OCR on receipt images, then parse, to include OCR errors. Report separately; README headline must say which number it uses.
- The permanent null-parser bootstrap returns zero items; strict itemized score and item-field recall/F1 must be zero for non-empty annotated examples. Test empty datasets and datasets with no applicable fields to prevent NaN or misleading non-zero scores.

### Benchmark runtime and reproducibility

- Primary per-commit CI mode uses cached `OcrResult` JSON fixtures in `benchmarks/fixtures/`, keyed by dataset snapshot, provider/version, and model hash. This runs in Node, is deterministic, and isolates parser regressions from OCR noise.
- Full image-to-extract tests run on demand in a headless browser and are reported separately, not as a per-commit CI requirement.
- `benchmark.yml` commits machine-readable results JSON; README tables are generated from it. Every published result pins dataset snapshot/hash, license, provider/model hash, scorer version, normalization, `τ` values, test count, and averaging method.

## 9. Privacy Proof and Network-Egress Audit

The claim is scoped and testable: receipt images and OCR text are processed locally, and the tested inference workflow succeeds after the app/model assets are available without an inference service. This is not a mathematical proof that no conceivable exfiltration is possible.

### M1 — core inference harness

1. Load a minimal harness page that invokes the core OCR/parser pipeline.
2. Self-host app/model assets on the application origin; do not use a third-party model CDN.
3. Precache/download required assets, then block outbound network during processing and verify inference still succeeds.
4. Record attempted requests and fail on unexpected dependencies. Test offline operation with the required assets cached.
5. Keep this test independent of the not-yet-built PWA flow.

### M3 — full PWA audit

1. Exercise upload → OCR → parse → review/correct → add/edit/delete → assign units → calculate split → lock/share.
2. Assert no cross-origin request occurs at any time in the tested app flow, including first load; same-origin requests during receipt processing must resolve to known app/model assets.
3. Assert no request URL, query, headers, or body contains receipt-image bytes or extracted OCR text. Include GET/URL-based exfiltration checks.
4. Handle service workers at the `BrowserContext` level (for example, `serviceWorkers: 'block'` or context-level routes/events); `page.route()` alone does not observe all service-worker traffic. Document that Playwright service-worker interception coverage is browser-dependent/Chromium-specific where applicable.
5. Static-scan first-party code for `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`, `new Image().src`, `form.action`, and dynamic imports of remote URLs. Use this as a supplement to runtime assertions, not a standalone proof.
6. Keep deliberate external actions (such as opening WhatsApp or sharing a bill) outside the receipt-inference egress claim. The share link intentionally contains selected parsed bill data; the receipt image and raw OCR text are excluded.

`.github/workflows/privacy.yml` runs relevant checks on each pull request and blocks merges on failure. Document browser configuration, service-worker treatment, allowed same-origin assets, and limitations alongside reported results.

### Model and service-worker cache invalidation

- Serve model files from the app origin with content-hashed filenames. A generated model manifest records provider name/version, each model/dictionary asset URL, byte size, and SHA-256 hash. The app code and model manifest must refer to the same provider/model version.
- The service-worker model cache key includes provider version and model-manifest hash (for example, `receipt-lens-models:<providerVersion>:<manifestHash>`); never reuse a cache solely because a filename or generic URL matches.
- On update, download and verify the complete new model set into a new versioned cache before making it active. Do not delete the previously working cache until the new manifest is verified and a smoke inference succeeds. If the update fails or the device is offline, retain and use the last verified cache with a visible “model update pending” state.
- Remove obsolete model caches only after activation of the verified new version. Include tests for provider-version bumps, hash mismatch, partial download, offline startup, and ensuring that new code never runs against incompatible old model assets.
- The privacy test records model asset requests and verifies they are same-origin precached assets; model downloads happen during installation/preparation, not as an undisclosed remote inference dependency.

### README claim

> Receipt OCR, parsing, and bill calculations run locally in the browser. After required app/model assets are available, the tested inference workflow works without outbound network access. CI checks for unexpected network dependencies and receipt-data uploads. Deliberate bill sharing is a separate user-initiated action: the URL fragment carries selected parsed bill data, never the receipt image or raw OCR text.

## 10. PWA Data Model and Edit Flow

The PWA uses normalized unit ownership. This supersedes the original business document's `Item.assigned_to` array (ADR-005); update that document before implementation.

### Entities

```ts
type ChargeType = "tax" | "service_charge" | "tip" | "discount" | "round_off" | "other";

// Exact rational amount in paise. numeratorPaise/denominator is reduced; denominator > 0.
// Decimal strings keep this representation lossless in JSON/IndexedDB/share snapshots.
type ExactMoney = { numeratorPaise: string; denominator: string };
type PriceSource = "detected" | "unresolved" | "user_confirmed";

interface Bill {
  id: string;
  title: string;
  creatorId: ParticipantId;
  payerId: ParticipantId;       // required, defaults to creator
  createdAt: string;
  isLocked: boolean;
  taxIncluded: boolean | null; // summary hint; null until inclusion semantics are known
  taxIncludedSource: ValueSource; // detected/user_confirmed/unresolved
  grandTotal: number | null;     // integer paise; preserve parsed/confirmed receipt total
  grandTotalSource: ValueSource;  // detected/unresolved/user_confirmed; never auto-overwrite
  adjustmentLines: AdjustmentLine[];
}

interface CreatorProfile {
  displayName: string;
  upiId: string;
}

interface DraftItem {
  id: string;
  parsedRef?: string;
  name: string;
  qty: number | null;
  quantitySource: QuantitySource;
  unitPrice: number | null;     // integer paise
  priceSource: PriceSource;
  lineTotal: number | null;     // detected row total or derived total, documented by source metadata
  confidence: number | null;
  warnings: ParseWarning[];
  assumedQtyReviewed: boolean;
  manuallyAdded: boolean;
}

interface Item {
  id: string;
  billId: string;
  name: string;
  qty: number;                  // positive and resolved
  quantitySource: FinalQuantitySource;
  unitPrice: number;             // resolved integer paise
  priceSource: FinalPriceSource;
  lineTotal: number;              // current calculated line amount in integer paise
  detectedLineTotal: number | null; // immutable imported receipt value when present, for comparison
  confidence: number | null;
  assumedQtyReviewed: boolean;
}

interface ItemUnit {
  id: string;
  itemId: string;
  unitIndex: number;              // 0..qty-1; unique per item
  confirmedUnassigned: boolean;   // true only after explicit creator acknowledgement
}

interface ItemUnitAssignment {
  itemUnitId: string;
  participantId: ParticipantId;
}

interface BillCharge {
  id: string;
  billId: string;
  type: ChargeType;
  label: string;
  amount: number;                 // integer paise; round_off is signed, others use a magnitude
  rate?: number | null;
  included: boolean;                // finalized charge: inclusion confirmed
  otherSign?: "add" | "subtract" | "unknown"; // used only when type = "other"
  source: "detected" | "user_confirmed";
}

interface DraftCharge {
  id: string;
  parsedRef?: string;
  type: ChargeType | null;
  label: string;
  amount: number | null;           // integer paise or null while unresolved
  rate?: number | null;
  included: boolean | null;        // null until inclusion semantics are known
  otherSign?: "add" | "subtract" | "unknown" | null;
  source: "detected" | "user_confirmed";
  manuallyAdded: boolean;
}

// PWA-only validation model; these types do not belong to @receipt-lens/core.
type LockBlockerCode = "draft_items_unresolved" | "draft_charges_unresolved"
  | "units_unassigned" | "assumed_qty_unreviewed" | "grand_total_missing"
  | "payer_missing" | "unclassified_rows_unreviewed"
  | "negative_share_after_discount" | "tax_inclusion_unresolved";
interface LockBlocker { code: LockBlockerCode; refs?: string[] }
interface WorkingBill {
  bill: Bill;
  draftItems: DraftItem[];
  items: Item[];
  draftCharges: DraftCharge[];
  charges: BillCharge[];
  participants: Participant[];
  itemUnits: ItemUnit[];
  assignments: ItemUnitAssignment[];
  unclassifiedRows: UnclassifiedRow[];
  parseResult: ParseResult | null;
  parseValidation: ParseValidationResult | null;
}
interface BillValidationResult {
  findings: ValidationFinding[];
  blockers: {
    unitCreation: string[];
    assignment: string[];
    finalization: string[];
    locking: LockBlocker[];
  };
}

interface AdjustmentLine {
  id: string;
  billId: string;
  reason: "unassigned";
  amount: number;                  // integer paise, added to creator payable share
  assignedToParticipantId: ParticipantId; // v1 assigns this to creator
}

interface Participant {
  id: string;
  billId: string;
  name: string;
  paid: boolean;                   // manual creator confirmation only
  token: string;                   // share-link material; not identity verification
  tokenExpiresAt: string;          // client-enforced UX only; not secure expiry
}

interface BillShareSnapshot {
  snapshotVersion: 1;
  snapshotCreatedAt: string;
  bill: {
    id: string;
    title: string;
    creatorId: ParticipantId;
    payerId: ParticipantId;
    createdAt: string;
    grandTotal: number;             // resolved integer paise
    taxIncluded: boolean | null;
    taxIncludedSource: ValueSource;
  };
  participants: Array<{ id: ParticipantId; name: string; tokenExpiresAt: string }>;
  items: Array<{
    id: string; name: string; qty: number; unitPrice: number;
    unitAssignments: Array<{ unitIndex: number; participantIds: ParticipantId[]; confirmedUnassigned: boolean }>;
  }>;
  charges: Array<{ type: ChargeType; label: string; amount: number; included: boolean; rate?: number | null; otherSign?: "add" | "subtract" }>;
  adjustmentLines: Array<{ reason: "unassigned"; amount: number; assignedToParticipantId: ParticipantId }>;
  computedShares: Array<{ participantId: ParticipantId; exactAmount: ExactMoney; settlementSharePaise: number | null }>; // cache only; recipient recomputes and does not trust it
}
```

Receipt/input amounts and persisted item/charge amounts are integer paise. Calculated participant shares are exact rational paise represented as `ExactMoney = { numeratorPaise: string; denominator: string }`; use `BigInt` or an exact rational/decimal implementation internally, never IEEE-754 float. Reduce the fraction by GCD after arithmetic, with a positive denominator. Derived selectors include `calculatedItemsTotal`, `calculatedSubtotal`, and exact participant shares; they are not the printed `subtotal`/`grandTotal` fields. Shares are recomputed on load and never trusted from a cache. For terminating decimal shares, display the full exact decimal; for repeating decimals, display a non-rounded decimal with an ellipsis and provide the exact fraction in details/copy output. Never label a truncated decimal as exact. When the user explicitly corrects the printed grand total, set `grandTotalSource = "user_confirmed"`; item edits never change it implicitly.

### IndexedDB versioning and migrations

- Use one named database (`receipt-lens`) and a monotonic `DB_SCHEMA_VERSION`, starting at 1. Every persistent schema change increments the version and adds a sequential `onupgradeneeded` migration from each supported prior version; never edit an already-released migration in place.
- Run each upgrade in the IndexedDB version-change transaction. If a migration fails, abort the upgrade and show a recoverable error; never silently clear the user's bills or replace failed data with an empty database. Do not delete obsolete stores until their data has been migrated successfully.
- Keep application DB schema version separate from `BillShareSnapshot.snapshotVersion` and the share-link format version. They solve different compatibility problems.
- Add migration tests for every supported prior schema, including bills with drafts, participant assignments, exact-share cache fields, and unassigned-unit acknowledgements. Test rollback/abort behavior. Provide a local JSON export before any future migration that cannot be made lossless.

`Bill.taxIncluded` is a receipt-level summary only. `BillCharge.included` is authoritative per charge. Set inclusion to detected only from an explicit receipt cue (for example, “inclusive of GST” or a clearly labeled included-tax line); do not infer inclusion solely because the arithmetic happens to match. If the receipt is ambiguous, keep the relevant draft-charge inclusion unresolved and require the creator to choose “included in item prices” or “charged separately” before locking. A user selection sets the affected charge(s) to `included = true/false`, marks their source `user_confirmed`, and updates the summary field/source. If no tax/charge is present, no inclusion decision is required.

### Capture and preprocessing UX

- The import screen offers both camera capture on supported devices and ordinary image-file selection. Camera permission is optional; if denied or unavailable, file selection remains fully usable. Accept common browser-supported JPEG/PNG/WebP inputs and handle HEIC only if a tested local decoder is bundled; otherwise explain the unsupported format and request a local conversion rather than uploading it.
- After capture/import, show a preview before OCR. The user can rotate the image and adjust a crop rectangle; cropping is optional and can be reset. Preserve the original image in memory until the user accepts the working image so edits are reversible.
- Provide optional local deskew and contrast/brightness enhancement. These operations create a working copy; never overwrite the source destructively. Start with conservative defaults and make preprocessing status visible. If auto-deskew cannot estimate skew reliably, leave the image unchanged and offer manual rotation/crop rather than applying a guessed transform.
- OCR runs on the confirmed working copy. The app must let the user recrop/reprocess and rerun OCR; the prior parse remains available until the new result is accepted or discarded. All capture/preprocessing/OCR runs on-device. Do not persist receipt images by default after the session; if the user explicitly enables local retention, store them only in local browser storage and provide a delete action.
- Test straight, skewed, rotated, low-contrast, shadowed, cropped, and high-resolution receipts. Report whether preprocessing improves or harms extraction on the held-out evaluation set; do not claim an accuracy gain without measurements.

### Import-stage drafts and finalization

- Preserve unresolved parser output as `DraftItem`/draft charge data in IndexedDB. Drafts may contain null price/quantity/amount; finalized `Item` and `BillCharge` records may not.
- A draft item can be finalized only when its name is non-empty, quantity is resolved and valid, unit price is resolved and non-negative under the applicable item policy, and required review blockers are cleared. Unit materialization occurs after finalization.
- Draft charges remain drafts until amount, type/sign semantics, and whether each charge is included in item prices are resolved whenever that distinction affects arithmetic. Finalized internal charge amounts are integer paise and `included` is a confirmed boolean.
- `ItemUnit` count must equal the item's quantity. Enforce `count(ItemUnit where itemId = X) = Item.qty` transactionally whenever quantity changes.
- Assignment records must reference participants on the same bill; reject duplicate `(itemUnitId, participantId)` pairs.
- Each unit may be assigned to one or more participants. Zero assignment rows means unassigned; before locking, each such unit must have `confirmedUnassigned = true`. A confirmed-unassigned unit must have no participant assignments; assigning it to anyone clears `confirmedUnassigned` in the same transaction. Its cost is then assigned to the creator through an explicit `AdjustmentLine{reason: "unassigned"}`.

### Edit flow (mechanics; the edit principle is implemented here, not as a duplicate ADR)

All add/edit/delete operations are transactional and trigger recalculation of derived exact values, then core `validate(parseResult)` when parse-derived findings apply, followed by PWA `validateWorkingBill(workingBill)` over the complete updated state. Manual input always takes precedence over extracted values.

**Add an item**

1. A user-added item starts as a `DraftItem` with `manuallyAdded: true`. Values entered by the user use `quantitySource: "user_confirmed"` and/or `priceSource: "user_confirmed"`.
2. Once required fields are valid and blockers clear, the user can finalize it; at lock attempt, resolved drafts may be finalized in bulk. Do not materialize units from unresolved quantities.
3. Recompute item/subtotal candidates and participant shares. Preserve `Bill.grandTotal` as the printed/confirmed receipt total; do not silently overwrite it.

**Edit an item or price**

1. Save the entered value as the current authoritative value and set its provenance to `user_confirmed`. Never overwrite it with a parser result without explicit user action.
2. Recompute the item's current calculated `lineTotal` from `qty × unitPrice` when those are resolved. Preserve `detectedLineTotal` separately when OCR captured a printed line total; validation compares them instead of silently replacing the printed fact.
3. If quantity changes and units already exist, update units and assignments transactionally. If units are removed, the UI must clearly identify assignments that will be removed; new units start unassigned.
4. Recompute derived totals and exact participant shares, run core `validate(parseResult)` where applicable, and run `validateWorkingBill(workingBill)` again. Show discrepancies; do not rewrite the printed grand total automatically.

**Delete an item**

1. Remove the item and its units/assignments in one transaction; no assignment to a deleted unit may survive.
2. Recalculate derived item totals and participant shares immediately. A deleted false ₹4 item therefore reduces the calculated items total by ₹4.
3. Keep the printed/confirmed receipt `grandTotal` unchanged unless the user explicitly edits it. Re-run validation so the difference between calculated and printed totals is visible.

**Locking**

A bill cannot lock until every blocker is cleared. The UI renders structured blocker codes; it never infers blockers by parsing warning text.

| Blocker code | Clears when |
|---|---|
| `draft_items_unresolved` | Every draft item has required name, resolved valid quantity, and price |
| `draft_charges_unresolved` | Every draft charge has a resolved amount and known type/sign behavior |
| `tax_inclusion_unresolved` | Every charge that could affect totals has confirmed included/separate semantics |
| `units_unassigned` | Every unit is assigned or explicitly marked `confirmedUnassigned` |
| `assumed_qty_unreviewed` | Every `quantitySource: "assumed"` item has `assumedQtyReviewed = true` |
| `grand_total_missing` | Grand total is resolved for settlement |
| `payer_missing` | `payerId` points to a participant on the bill |
| `unclassified_rows_unreviewed` | Every ambiguous row affecting receipt interpretation is classified or explicitly excluded |
| `negative_share_after_discount` | No participant would have an invalid negative payable share; resolve discount allocation before lock |

### Share-link model

The participant receives a compact `BillShareSnapshot` of resolved bill information only: title, participants, items/units/assignments, charges, adjustments, payer, creation time, expiry hint, and snapshot version. `computedShares` is a cache only; exact shares are serialized losslessly as numerator/denominator strings and recomputed/verified on load. Never include the receipt image, raw OCR result, drafts, or extraction confidence data. All participants hold the complete included snapshot locally; “show only my share” is a view default, not access control. Links are snapshots; editing requires regenerating/re-sharing, and old links remain stale and cannot be securely revoked.

## 11. Bill Splitting Math

### Split engine rules

1. Store receipt prices and charges as integer paise. Compute shares as exact rational values of paise; never use IEEE-754 float and never round computed shares to paise or whole rupees.
2. Each `ItemUnit` is assigned through normalized `ItemUnitAssignment` records. `count(ItemUnit) = Item.qty` is enforced transactionally.
3. Divide a unit's integer-paise price exactly by the number of participants assigned to that unit. Preserve any fractional-paise result as a rational; do not distribute residual paise among participants in the calculated share.
4. A unit with no assignments is unassigned. The creator must acknowledge it; its full unit cost is added to the creator through a visible `AdjustmentLine{reason: "unassigned"}`.
5. Divide each applicable non-included bill-level charge exactly and equally among all participants, including zero-item participants. Fractions of a paise remain exact rational shares.
6. Charges with `included = true` are display-only and never added or allocated again. This prevents double-charging tax already included in item prices (ADR-001 amendment).
7. Discounts are stored as positive integer-paise magnitudes and subtracted equally using exact rational arithmetic. If any final share is negative, block lock with `negative_share_after_discount`; do not invent a redistribution policy.
8. `round_off` stores the printed signed integer-paise amount and, when non-included, is shared equally like other applicable bill-level charges. Other known charge types store positive magnitudes; arithmetic adds taxes/service/tip/other charges, subtracts discounts, and adds signed round-off.
9. v1 has one calculation mode: exact shares only. Whole-rupee rounding and rounding adjustments are not part of v1 bill accounting. The `unassigned` adjustment is the only v1 `AdjustmentLine` reason.
10. v1 requires creator and payer to be participants. `payerId` defaults to creator and must resolve to a participant. No non-participant-payer exception is supported in v1.
11. Participants whose exact final share is zero receive no payment link; display “nothing to pay”.
12. Exact share fractions must sum algebraically to the confirmed payable total when all included/excluded charge semantics and assignments are resolved. Fraction formatting is lossless; no rounded display may be labeled exact.

### Share computation

```text
For each participant P, use reduced exact rational arithmetic:
  P.item_total = sum(unitPricePaise / assignmentCount(unit)) over units assigned to P
  P.charge_total = sum(chargeAmountPaise / participantCount) for applicable non-included charges
  P.share_exact = P.item_total + P.charge_total + sum(exact adjustments assigned to P)

No share rounding is applied. The sum of all `share_exact` values must equal the confirmed
payable grand total exactly. The `round_off` receipt charge is apportioned like other applicable
charges; it is not a computational rounding adjustment. Only acknowledged unassigned-item
costs use `AdjustmentLine{reason: "unassigned"}`.
```

### Golden example (must be reproduced exactly in CI)

Setup: 5 participants P1–P5; P1 is creator and payer. Inclusion is explicitly confirmed as `false` for the separate charges in this fixture. This fixture also exercises a unit assigned to multiple participants.

Items:

| Item | Line total | Qty | Unit price |
|---|---:|---:|---:|
| A Paneer Tikka | ₹320.50 | 2 | ₹160.25 |
| B Naan | ₹60.00 | 3 | ₹20.00 |
| C Biryani | ₹240.00 | 1 | ₹240.00 |

Assignments: A.u1 (₹160.25) → P1, P2, and P3 jointly; A.u2 → P2; B.u1 → P2; B.u2 → P3; B.u3 is explicitly `confirmedUnassigned`; C.u1 → P5. P4 has no item units. The shared A.u1 is divided exactly as ₹160.25/3 per assignee—no paise remainder is assigned to one person.

Charges: Service Charge ₹62.05; CGST ₹15.51; SGST ₹15.51; Discount ₹50.00; Round Off +₹0.43; printed grand total ₹664.00. All five charges are non-included. The per-person exact charge allocation is (₹62.05 + ₹15.51 + ₹15.51 − ₹50.00 + ₹0.43)/5 = ₹43.50/5 = ₹8.70.

Arithmetic: item/quantity line totals = ₹620.50. Separate charges net to ₹43.50. The final receipt total is exactly ₹664.00. The signed ₹0.43 round-off is part of the shared charge allocation; it is not assigned solely to P1 as an artificial rounding adjustment.

| Participant | Exact item allocation | Exact shared charges | Unassigned adjustment | Exact final share in INR |
|---|---|---:|---:|---:|
| P1 (creator) | ₹160.25/3 = ₹53.416666… | ₹8.70 | +₹20.00 | ₹4927/60 = ₹82.116666… |
| P2 | ₹160.25/3 + ₹160.25 + ₹20.00 = ₹233.666666… | ₹8.70 | — | ₹7271/30 = ₹242.366666… |
| P3 | ₹160.25/3 + ₹20.00 = ₹73.416666… | ₹8.70 | — | ₹4927/60 = ₹82.116666… |
| P4 | ₹0.00 | ₹8.70 | — | ₹87/10 = ₹8.70 |
| P5 | ₹240.00 | ₹8.70 | — | ₹2487/10 = ₹248.70 |

The exact shares sum algebraically to ₹664.00. Ellipses indicate repeating decimal expansions, not rounded values; the fraction is the exact share. CI must assert rational equality, including the shared-unit division, equal charge allocation, the creator's unassigned-item adjustment, and the final total. Do not add a whole-rupee rounding expected result or a `rounding` bill adjustment.

At the UPI boundary only, shares that contain fractional paise must be converted into integer-paise transfer amounts using the §12 deterministic largest-remainder settlement allocation. This changes only the transfer amounts, not the exact calculated shares shown above, and the UI must label those as payment amounts rather than exact theoretical shares.

For this golden fixture, the exact values in paise are P1 = 24635/3, P2 = 72710/3, P3 = 24635/3, P4 = 870, and P5 = 24870; their sum is exactly 66400 paise. The boundary allocation gives internal payment-share amounts P1 = ₹82.12, P2 = ₹242.37, P3 = ₹82.11, P4 = ₹8.70, and P5 = ₹248.70, which total ₹664.00. P1 is the creator/payer, so P1 receives no self-payment link; only the other participants are asked to pay their allocated transfer amount. These values are settlement amounts, not rounded replacements for the exact shares.

## 12. Settlement & UPI

### UPI deep link

```text
upi://pay?pa={creator_upi}&pn={creator_name}&am={share}&cu=INR&tn={note}&tr={ref}
```

- URL-encode all values; do not concatenate raw user-provided names/title. `am` always uses two decimal places because a UPI transfer amount is expressed in whole paise. The exact calculated share remains separately available and must not be overwritten by this transfer conversion.
- `tr` is optional, ≤ 35 characters, and restricted to `[A-Za-z0-9]`. Derive deterministically, e.g. the first 16 hex characters of HMAC over a bill/participant reference using the share token as key material. If it would violate the limit, omit `tr` instead of emitting a malformed intent.
- `pn` is limited to 40 characters and `tn` to 50 characters in the current tentative contract; truncate the note, not the payee name. `pn` comes from `CreatorProfile`.
- A calculated exact share may contain fractional paise and therefore cannot be copied directly into a UPI `am` field. Derive `settlementSharePaise` for all participants together: take the integer-paise floor of each non-negative exact share, then distribute the remaining paise one each by descending fractional-paise remainder, ties broken by stable participant ID. The target is the bill's confirmed grand total in integer paise. This is a transfer-boundary allocation only; it must not mutate or replace `share_exact`. Display both values where they differ, with labels “Exact share” and “UPI payment amount”. Never claim the payment amount is the unrounded exact share.
- The creator/payer does not receive a UPI link to pay themselves; their exact share represents their own net cost after collecting from other participants. A non-creator participant with zero settlement amount receives no payment link; show “nothing to pay”.
- Manual payment confirmation is in scope: a UPI link initiates a payment flow but never proves a payment succeeded. The creator marks paid manually.
- CI tests generated parameter-level invariants for GPay/PhonePe/BHIM-shaped intents: encoding, charset, lengths, decimal formatting, and zero-share behavior.
- **Open verification:** confirm `pn`/`tn`/`tr` numeric limits against the current primary NPCI linking specification before locking constants; current secondary-source corroboration is not final authority.

### WhatsApp sharing

Use a `wa.me` click-to-chat link with a prefilled message showing the participant's exact calculated share, the separate whole-paise UPI settlement amount, and their participant link. Opening WhatsApp is an intentional external action and separate from local inference. The participant link is a versioned URL-fragment snapshot (ADR-007).

### Payment confirmation

Manual only. There is no bank reconciliation or automatic payment verification.

## 13. Lifecycle & Roles

### States

- **Draft:** editable. Imported values are tentative; the creator may add, edit, or delete draft items and charges.
- **Review required:** unresolved prices/quantities/charges, ambiguous rows that affect interpretation, assumed quantities awaiting acknowledgement, or blocking findings must be resolved before their dependent actions.
- **Ready to lock:** all required fields are resolved; all units are assigned or explicitly acknowledged unassigned; payer and grand total exist; no lock blockers remain.
- **Locked:** the bill snapshot is frozen and participant links can be generated. Unlocking requires explicit creator action and a warning that previous links may show stale amounts.
- **Settled:** all relevant participants are manually marked paid by the creator.

Every add/edit/delete operation recalculates derived exact totals/shares and re-runs the applicable core and PWA validation surfaces. The parsed/confirmed receipt grand total is not silently rewritten; discrepancies remain visible until the user explicitly resolves them. Editing a locked bill requires unlock, revision, and newly generated links. Existing links remain stale snapshots and cannot be reliably revoked.

### Roles

**Creator**
- Full edit rights while the bill is draft/unlocked.
- Required to be a participant in v1 and is the default payer.
- Receives the explicit unassigned-item adjustment.
- Sole access to the creator-only local ledger of past bills.
- May store `CreatorProfile` (`displayName`, `upiId`) locally for reuse.

**Participant**
- Opens a URL-fragment snapshot link. The full link acts as a bearer secret, not identity verification.
- Default view shows the participant's share and UPI link.
- May toggle to see the full bill if the snapshot includes it. This is a display preference, not access control: recipients possess the full included bill snapshot locally.
- Client-side expiry may hide/disable a snapshot in the PWA but is not secure expiry; copied links cannot be reliably revoked and may remain usable/decodable.

## 14. Architecture Decision Records

ADR numbers are unique within this consolidated specification. Material from review/update documents is merged into the relevant existing ADR or requirement; duplicate/pasted ADR numbering is not imported as additional records. Edit mechanics live in §10 rather than creating a second conflicting “ADR-018”.

### ADR-001: Equal split of bill-level charges — LOCKED

- **Decision:** applicable non-included tax, service charge, tip, discount, signed round-off, and other bill-level charges are allocated equally among all participants, including participants with no assigned items. Each allocation is an exact rational amount; no paise or whole-rupee rounding is applied to calculated shares.
- **Amendment:** any charge marked `included: true` is display-only and is not split or added to the total again. The split engine and arithmetic validator both respect this flag.
- **Trade-off:** participants who order less may subsidize those who order more. Proportional charge allocation is out of scope for v1.

### ADR-002: PP-OCRv6 Tiny default with swappable provider — LOCKED DEFAULT, REVERSIBLE

- **Decision:** PP-OCRv6 Tiny is the v1 starting default behind `OcrProvider` and `onnxruntime-web`. Compare Tiny and Small in M1; keep the tier swappable and retain Tiny unless benchmark evidence justifies changing it.
- **Footprint:** the former “~4.3 MB complete OCR pipeline” claim is withdrawn. Report measured detection/recognition models, dictionary, runtime/WASM assets, app JS, initial download/cache size, and cold/warm latency for this deployment. Public component references suggest Tiny detection ~1.9 MB and recognition ~4.4 MB, before full runtime/app assets; our published claim must use our measurement.
- **Accuracy:** published Tiny recognition accuracy from a non-receipt-specific vendor benchmark is not a promise of accuracy on price-critical receipts. Publish our measured results and limitations.
- **Reversibility:** switching to PP-OCRv6 Small or another provider must not change `parse()` or the normalized OCR contract.

### ADR-003: Two-tier, dataset-scoped benchmark — LOCKED

- **Decision:** publish strict exact-match metrics alongside field-level precision/recall/F1 diagnostics; annotate dataset coverage and do not score fields a dataset does not provide.
- **Requirement:** deterministic one-to-one item matching, pinned normalization/tolerance, permanent null-parser bootstrap, generated README numbers from CI results.

### ADR-004: Preserve quantity and assign at unit granularity — LOCKED

- **Decision:** preserve `Item.qty`; ownership is assigned per `ItemUnit`, not by duplicating receipt lines into separate item rows. Unresolved quantity blocks unit creation, assignment, and locking.

### ADR-005: Normalized unit assignment — LOCKED

- **Decision:** `ItemUnit { id, itemId, unitIndex, confirmedUnassigned }` and `ItemUnitAssignment { itemUnitId, participantId }` form normalized assignment data. `(itemId, unitIndex)` and `(itemUnitId, participantId)` uniqueness/integrity are enforced, and `count(ItemUnit) = Item.qty` is checked transactionally.
- **Supersedes:** original business-doc `Item.assigned_to` array. Update that source document before implementation.

### ADR-006: Quantity provenance — LOCKED

- **Decision:** distinguish `explicit`, `assumed`, `unresolved`, and `user_confirmed`. Parser emits the first three; the PWA records `user_confirmed` for user-supplied or edited quantity.
- **Rule:** assumed quantity is visibly tentative and requires review before lock; unresolved quantity blocks unit creation/assignment/finalization/lock as applicable.

### ADR-007: URL-fragment snapshot sharing — LOCKED (DQ-01 = A)

- **Decision:** v1 has no bill-data backend or peer-to-peer hosting. Share a compact resolved bill snapshot in the URL fragment, never query parameters. Raw receipt image and OCR text are never included.
- **Fragment format:** `#v1.<token>.<nonce>.<ciphertextAndTag>`. `v1` fixes the complete v1 codec: JSON compact serialization → DEFLATE compression using the self-hosted `fflate` implementation bundled into the app → AES-256-GCM encryption → base64url encoding of token, nonce, and ciphertext-plus-tag. Pin the exact `fflate` package release in `pnpm-lock.yaml`; do not depend on `CompressionStream`/`DecompressionStream` being present in every browser. The nonce is freshly random per encryption. Validate version, component count/size/charset, authentication tag, decompressed size limit, and snapshot schema before rendering; malformed input must fail closed with a user-readable error.
- **Budget:** the entire fragment after `#`, including version, separators, token, nonce, ciphertext and tag, must be at most 8 KB when encoded. Show budget usage; never silently truncate. If over budget, ask the creator to shorten/remove nonessential bill labels or refuse sharing with a clear message.
- **Security disclosure:** the key is derived from token material carried in the same link (`HKDF` with context `receipt-lens-share-v1`). Therefore encryption is not confidentiality against anyone possessing the full link; anyone with the link can derive the key and inspect the full snapshot. GCM can detect corruption by parties without the key, but it does not protect against a malicious link-holder who can derive the key and create a valid tag. Treat the complete link as a bearer secret; “only my share” is not access control.
- **Privacy/transport:** browsers exclude URL fragments from the HTTP request that loads the page, so ordinary server access logs do not receive the fragment. This does not protect it from browser history, clipboard/sync, device access, or JavaScript-capable preview tooling that reads `location.hash`.
- **Snapshot semantics:** all participants hold the included bill snapshot locally. Client-only expiry is a UX restriction, not secure expiry. There is no reliable revocation. Unlock + edit requires generating and re-sharing links; old links continue to display stale snapshots behind a “bill updated on {date}” banner where possible.
- **Reversibility:** a future backend can reuse the snapshot data model, but it is outside v1.

### ADR-008: Keep the selected public charge output schema — LOCKED (DQ-03 = B)

- **Decision:** keep the public `ParseResult` fields `taxes[]`, `serviceCharge`, `tip`, and `discount` separate. Add explicit `roundOff` and `otherCharges[]` fields so Indian round-off/unclassified charges are representable without replacing the owner's selected public shape.
- **Internal model:** the PWA maps public parsed fields into one `BillCharge[]` with a `type` discriminator (`tax`, `service_charge`, `tip`, `discount`, `round_off`, `other`). This internal unification is not a public API shape change.
- **Draft rule:** unresolved null amounts exist only in draft/import entities; finalized `BillCharge.amount` must be a resolved integer-paise value.

### ADR-009: Unassigned units at lock — LOCKED (DQ-02 = B, refined accounting)

- **Decision:** locking may proceed with a unit that remains unassigned only after the creator explicitly acknowledges that unit. The creator absorbs its full unit cost through a visible `AdjustmentLine{reason: "unassigned"}`.
- **Invariant:** no unassigned cost disappears. The explicit unassigned adjustment is stored and rendered separately from charge allocations and exact participant shares; it is the only v1 bill-adjustment reason.
- **v1 simplification:** creator and payer must be participants, and the creator is the default payer. Non-participant payer/creator settlement is not supported in v1.

### ADR-010: English-only v1; CORD is an out-of-language layout bucket — LOCKED (DQ-04 = A)

- **Decision:** UI/product language support is English-only. Parser label dictionaries include English/Indian-English for the product and Indonesian labels only for CORD benchmarking/layout stress testing. Do not mix CORD scores into headline English accuracy. SROIE is scored only for the fields actually annotated and supported by this parser.

## 15. Living Glossary

| Term | Definition — what it is and is NOT |
|---|---|
| `OcrResult` | Normalized OCR lines/words with boxes, nullable confidence, image size, provider and version. Not raw provider-specific output. |
| `OcrProvider` | Adapter interface for an OCR engine. Not the engine itself. |
| `parse()` | Deterministic transformation of normalized OCR into structured candidates, warnings and unclassified rows. Does not mutate input. |
| `validate(parseResult)` | Core checks over extraction/parse data only; returns `ParseValidationResult`. It cannot calculate bill-state lock blockers. |
| `validateWorkingBill(workingBill)` | PWA-only checks over the whole mutable bill state; returns `BillValidationResult` and coded blockers for finalization/locking. |
| `priceSource` | Provenance: `detected`, `unresolved`, or `user_confirmed`. Not a confidence score or correctness guarantee. |
| `quantitySource` | Provenance: `explicit`, `assumed`, `unresolved`, or `user_confirmed`. Not just the numeric quantity. |
| Critical finding | High-concern extraction/data contradiction. May set `uncertain` and cap affected item confidence. |
| Minor finding | Warning/diagnostic that does not by itself set `uncertain`; a separate blocker may still prevent an action. |
| `LockBlocker` | Structured, machine-readable reason a bill cannot lock. Not inferred from human-readable warning text. |
| `DraftItem` / draft charge | Import/edit-stage entity that may contain unresolved null values. Not a finalized billing entity. |
| `BillCharge` | Internal normalized charge entity; not the public `ParseResult` schema. |
| `round_off` | Charge carrying its printed signed amount. Not silently dropped or treated as a positive magnitude regardless of sign. |
| `AdjustmentLine` | Visible unassigned-item amount attached to the creator's exact share. Not a rounding bucket or hidden balancing arithmetic. |
| `confirmedUnassigned` | State proving creator explicitly acknowledged a unit as unassigned. Not merely missing assignment rows. |
| `ItemUnit` | One countable unit of an item. `qty` units exist per resolved item. Not a receipt row. |
| `ItemUnitAssignment` | Link between a unit and a participant. Zero assignment rows means unassigned until explicitly acknowledged. |
| `ambiguous_row` | A preserved source line whose classification could not be established. Not an item and not silently discarded. |
| Strict score | Dataset-scoped exact match across supported annotated fields. SROIE result is grand-total-only, not whole-receipt itemized accuracy. |
| Field-level F1 | Diagnostic P/R/F1 using deterministic one-to-one item matching. |
| Local inference | Receipt image/text processing runs on-device after required assets are available. Not a claim that app loading or intentional sharing makes no requests. |
| Sharing link | URL-fragment snapshot and bearer secret. Fragment is not sent in the initial HTTP request, but anyone with the full link can access its included bill data. No secure expiry/revocation in v1. |
| Zero-item participant | Participant with no assigned items. Still pays equal shares of applicable non-included bill-level charges. |

## 16. Milestones

### Milestone 1 — Core parser, benchmarks, OCR footprint, and core privacy checks

1. Scaffold the pnpm monorepo and package exports. Stub `OcrProvider`, normalized `OcrResult`, and `ocr()`, `parse()`, `validate()`, `extract()`.
2. Build the null-parser benchmark harness first; require zero item recall/F1 and zero strict itemized match on non-empty annotated examples.
3. Pin initial CORD/SROIE snapshots, licenses, and hashes; implement locale-specific loaders and label-coverage metadata.
4. Cache/version `OcrResult` fixtures for deterministic Node parser regression benchmarks.
5. Implement parser row classes, y-band/column geometry, quantity provenance, price provenance, locale parsing, long-label matching, ambiguous-row preservation, and warnings.
6. Implement conditional arithmetic validation, the two confidence thresholds, structured findings/blockers, and unit tests for tax-included/round-off edge cases.
7. Wire PP-OCRv6 Tiny through `onnxruntime-web`; measure model/dictionary/runtime/app size and cold/warm latency. Compare Tiny and Small on the chosen dataset protocol.
8. Add M1 core offline/egress tests against a minimal harness, with model assets self-hosted and required assets cached before the offline phase.
9. Publish results only when test set, label coverage, locale normalization, thresholds/τ values, and averaging method are documented.

**M1 exit criteria:** importable `packages/core`; tests pass; deterministic parser metrics; measured footprint table; tiny-vs-small evidence; zero-parser bootstrap in CI; core inference succeeds after assets are cached with outbound network blocked; benchmark snapshots/hashes and thresholds are pinned.

### Milestone 2 — Decide whether an LLM fallback is necessary

- Analyze the uncertain subset from M1: failure types, prevalence, and which errors are likely fixable by an LLM.
- Test an existing pretrained small model on the same held-out examples, initially without fine-tuning.
- Fine-tuning remains out of scope unless the owner explicitly revises v1 and measured results justify the added size/complexity.

**M2 exit criteria:** written decision supported by accuracy, correction rate, download size, cold/warm latency, and browser compatibility numbers.

### Milestone 3 — PWA editing, splitting, sharing, UPI and end-to-end privacy

- Choose and document the PWA framework before implementation; implement the IndexedDB migration contract from §10 and service-worker/model-cache versioning from §9.
- Implement camera/file capture, reversible local crop/rotate/deskew/contrast workflow, draft/finalized entities, the §10 add/edit/delete mechanics, `priceSource`, quantity provenance, and lock checklist.
- Implement split math in §11 and make the golden table a CI-locked test.
- Implement creator/participant views, confirmed-unassigned acknowledgement and visible creator adjustments.
- Persist creator bills in versioned IndexedDB with sequential, tested migrations. Implement model-cache invalidation alongside service-worker activation. Implement and test the versioned fragment format, fixed DEFLATE codec, ≤8 KB cap, schema validation, stale-snapshot behavior, and honest security disclosure.
- Add UPI links, parameter invariant tests, WhatsApp sharing, and manual settlement states.
- Run full Playwright workflow and end-to-end privacy audit, including service-worker/cache behavior and no third-party requests.

**M3 exit criteria:** working PWA; deterministic split outputs; complete add/edit/delete/validate workflow; golden table passes; sharing format and size checks pass; UPI link test matrix passes; documented end-to-end privacy audit and limitations.

## 17. Open Loops and Explicitly Deferred Work

These are tasks/measurements, not unresolved owner decisions about the architecture already locked above.

- [ ] Name and commit to the PWA framework (Svelte 5 is implied but not confirmed) before M3.
- [ ] Verify UPI `pn`/`tn`/`tr` constraints against the current primary NPCI linking specification before locking constants.
- [ ] Measure PP-OCRv6 Tiny and Small on the agreed protocol; Tiny remains default unless M1 evidence supports a change.
- [ ] Pin dataset snapshots/hashes and record license terms/hashes for CORD and the selected SROIE source.
- [ ] Pin `τ_name` and the two OCR confidence thresholds at M1 exit; the §6 round-off limits are explicit initial defaults and are evaluated/pinned at M1 exit as part of the same benchmark configuration.
- [ ] Verify the cited third-party “~31 MB” reference deployment figure before mentioning it. This does not affect the requirement to report our own measured deployment size.
- [ ] Update the original business document from `Item.assigned_to` to normalized `ItemUnit`/assignment records.
- [ ] Decide the LLM fallback only after M1 measurements; no fine-tuning is committed in v1.
- [ ] Complete external browser/UPI compatibility testing and document limitations.

Resolved and no longer open: participant-link transport (ADR-007); unassigned-unit policy (ADR-009); public charge schema choice (ADR-008); CORD language/reporting scope (ADR-010).

## 18. Owner Decisions — Resolved

These are the owner's v1 choices. They are locked unless changed through an explicit future revision.

### DQ-01 — Sharing architecture: A — URL-fragment snapshot

- Share the compact bill/participant snapshot in the URL fragment after `#`; no bill-data backend or peer-to-peer hosting in v1.
- Fragment format, encoding, size budget and limits are defined in ADR-007.
- Only selected parsed bill data is shared; receipt images and raw OCR text are never included.
- Links are snapshots; edits require new links. Expiry is client-side UX only and cannot securely revoke copied links.

### DQ-02 — Unassigned units at lock: B — allow with explicit acknowledgement

- A bill may lock with an unassigned unit only after creator acknowledgement for each unit.
- The creator absorbs the full unit cost as a visible `AdjustmentLine{reason: "unassigned"}`; no rounding adjustment exists in v1 bill accounting.

### DQ-03 — Public charge schema: B — keep separate public fields

- Keep public `taxes[]`, `serviceCharge`, `tip`, and `discount` fields. Add `roundOff` and `otherCharges[]` for the target receipt semantics.
- Map all public fields into internal `BillCharge[]`; do not replace the public API with one `charges[]` property.

### DQ-04 — CORD/language scope: A — English-only v1

- Product/UI support remains English-only.
- CORD Indonesian receipts are reported separately as an out-of-language layout/structure stress-test bucket.
- SROIE is scored only for grand total in the current parser scope; never claim item-level accuracy on labels the dataset does not provide.

No owner choice is pending for DQ-01 through DQ-04.

## 19. Out of Scope

- Custom OCR model training or fine-tuning in v1.
- A bill-data backend or peer-to-peer hosting in v1; sharing uses URL-fragment snapshots.
- Receipt images or raw OCR text in share links or any remote inference endpoint.
- UI/product language support beyond English in v1. Indonesian labels exist only for the CORD layout/structure benchmark bucket; no multi-language product support is claimed.
- Native mobile app.
- Automatic bank reconciliation or automatic payment verification.
- Multi-currency bills.
- Nearest-rupee rounding mode for participant shares; v1 computes exact rational shares and converts to integer paise only when creating actual UPI transfer amounts.
- Non-participant payer/creator accounting in v1; creator and payer must be participants.
- Secure server-enforced share expiry/revocation, per-participant access control, or private “only-my-share” authorization. The share link is a bearer secret and carries the full included snapshot.
- Fractional/weight-based quantities (1.5 kg, 500 g) are not representable in the v1 unit model; the editor rejects them as `invalid_quantity`. Users must enter weight-based items as whole units at full price.

## 20. Definition of Done

`receipt-lens` is done when:

1. A developer can install `@receipt-lens/core`, pass a receipt image, and receive structured JSON in the browser through `extract()`.
2. The public API is covered by tests: nullable OCR confidence, `priceSource`, quantity provenance, separate selected public charge fields, preserved ambiguous rows, canonical warning codes, typed operational errors, stable option semantics, and core/PWA validation boundary.
3. Add/edit/delete are deterministic: each operation updates derived totals and exact rational shares, runs core `validate(ParseResult)` where applicable and PWA `validateWorkingBill(WorkingBill)`, preserves the printed/confirmed grand total unless explicitly edited, records manual provenance, and removes dependent unit assignments transactionally on deletion.
4. Unresolved drafts cannot be finalized/locked; blocker codes are structured and never inferred from warning text. A creator must review assumed quantities and acknowledge unassigned units.
5. The split engine stores inputs in integer paise and computes exact rational participant shares without rounding; it handles included taxes and signed round-off, applies unassigned adjustments visibly, derives whole-paise UPI transfer amounts separately, and reproduces the exact golden table in CI.
6. The README reports dataset-specific strict and field-level metrics with label coverage, normalizations, thresholds, hashes and averaging method. CORD is reported as the Indonesian layout bucket; SROIE is disclosed as grand-total-only.
7. The README contains a measured footprint table (model, dictionary, runtime/WASM, app JS, download/cache and cold/warm latency), not an unverified “~4.3 MB” whole-pipeline claim.
8. Core offline-inference/network-egress tests pass in CI. Full PWA flow is tested after it exists. Model cache invalidation and IndexedDB migrations are tested. The report states service-worker and browser coverage limitations and makes no universal security-proof claim.
9. Versioned URL-fragment sharing follows ADR-007, respects the 8 KB full-fragment cap, uses the pinned bundled DEFLATE codec, excludes receipt images/raw OCR, validates/decrypts/parses safely, describes bearer-link limitations honestly, and shows stale-snapshot status after edits.
10. UPI links pass parameter-format/length tests, the current primary-spec numeric limits are verified before constants lock, and settlement remains manually confirmed.
11. The decision about any LLM fallback is recorded with measured data.



## Appendix A. Review remediation traceability

This table preserves the original review's major findings and points to their merged resolution. It is traceability, not a second source of requirements.

| Review finding | Resolution in this consolidated specification |
|---|---|
| B1 — assumed quantity contradicted “never guess” | §2 and §7 distinguish an explicitly marked `assumed` quantity from a silent guess. |
| B2 — unassigned-unit lock policy and payer were ambiguous | §2, §10, §11, ADR-009 and §18 require explicit acknowledgement and a visible creator `unassigned` adjustment. v1 creator/payer must be a participant; exact rational shares have no bill-accounting rounding adjustment. |
| B3 — serverless participant link had no transport contract | §10 and ADR-007 define the fragment snapshot format, payload contents, size budget, snapshot/staleness behavior, and realistic security limitations. |
| B4 — Node benchmark conflicted with browser OCR runtime | §3, §8 and §16 use cached `OcrResult` fixtures for per-commit Node parser benchmarks; full image-to-extract runs are separate/on-demand. |
| B5 — Indonesian/Indian locale number formats were unspecified | §5 and §8 define `id-ID`, `en`, and `en-IN` profiles and require ground-truth normalization to match. |
| M1 — OCR size and Tiny-tier accuracy claims unsupported | §2, ADR-002, §16 and §20 require measured footprint and Tiny/Small evidence; the old whole-pipeline size promise is withdrawn. |
| M2 — Indian tax labels and round-off semantics missing | §5, §6, §11 and ADR-008 cover CGST/SGST/IGST/cess, longest-first labels, signed `round_off`, and tax-inclusive arithmetic. |
| M3 — network-egress test gaps | §9 defines BrowserContext-level/service-worker handling, structural runtime assertions, first-party static scanning, self-hosted model assets, and claim limitations. |
| M4 — noise rows, subtotal/total and arithmetic false positives | §5–§6 preserve ambiguous rows, guard continuation rules, and require sufficient row/line-total coverage for arithmetic criticals. |
| M5 — incomplete benchmark matching/scoring | §8 defines deterministic one-to-one matching, null semantics, dataset-scoped metrics, and generated results. |
| M6 — UPI transaction reference could exceed supported limits | §12 limits `tr` and makes it optional; current numeric limits remain open for primary-spec verification in §17. |
| N1–N3 — warning taxonomy, entity gaps, float money | §§4, 6, 10 and 11 define canonical warnings, explicit entities, integer-paise source amounts, and exact rational participant shares. |
| N4 — OCR worker requests and Node/browser split | §3 and §9 include the worker in architecture and the privacy audit. |
| N5–N6 — operational errors and option behavior | §4 defines typed OCR errors, blank-OCR behavior and `strictArithmetic` semantics. |
| N7 — English-only claim conflicted with CORD | §§5, 8, 14 and 19 describe Indonesian labels only as a separate benchmark bucket. |
| N8 — framework not selected | §3 and §17 keep the framework choice explicitly open until before M3. |
| N9–N10 — results reproducibility and packaging | §§3, 8, 16 and 20 specify package exports, pinned benchmark metadata, generated results, and measured claims. |
| Edit-flow gap discussed after v0.2 | §4, §10, §13 and §20 define `priceSource`, add/edit/delete behavior, dependent assignment cleanup, recomputation, and validation. |
| P1 — `ambiguous_row` lacked a preserved data contract | §§4–§6 define the warning code and `ParseResult.unclassifiedRows` with source context. |
| P2 — confidence threshold option/codes were inconsistent | §§4 and 6 define separate critical/warning thresholds and canonical warning names plus migration mapping. |
| P3 — non-participant payer could not be represented by adjustment model | §§2, 10–11 and ADR-009 require v1 creator/payer to be participants. |
| P4 — round-off sign convention conflicted | §§4, 6 and 11 specify signed `roundOff`/`round_off`; other charge magnitudes are positive and signed by type in arithmetic. |
| P5 — fragment structure/size/security claims incomplete | ADR-007 defines `#v1.<token>.<nonce>.<ciphertextAndTag>`, whole-fragment 8 KB cap and the limitation that the full-link holder can derive the key. |

## Appendix B. Verification notes and source record

The following figures were recorded in `SPEC-UPDATE-v0.2.md` on 2026-10-23. They are contextual references, not substitutes for measuring the actual deployed app:

- PP-OCRv6 Tiny component references reported approximately 1.9 MB detection and 4.4 MB recognition model weights. These are model components, not the full browser deployment size.
- The update cited: [PaddleOCR self-hosting guide](https://nexgpu.net/en/models/paddleocr), [PP-OCRv6 Tiny browser walkthrough](https://blog.csdn.net/n6308/article/details/163429452), and [browser OCR tool FAQ](https://ai-toolbox.ai/tools/extract-text-from-image).
- Tier/accuracy references cited in the review/update: [PaddleOCR PP-OCRv6 announcement](https://huggingface.co/blog/PaddlePaddle/pp-ocrv6) and [the cited arXiv paper](https://arxiv.org/html/2606.13108v1). Model accuracy values from vendor/in-house benchmarks are not treated as receipt-specific performance guarantees.
- A third-party reference deployment figure of approximately 31 MB was not independently verified in the update; see O6 in §17. It must not be repeated as the size of this project's deployment without verification.
- External UPI parameter-length guidance in the update relied on secondary sources; verify the current primary NPCI specification before locking the constants in §12.
