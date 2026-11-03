# DECISIONS/0007 — OCR worker deferral, and the two geometry tolerances

Date: 2026-11-03 · Ticket 04.

## Decision: defer `ocr/worker.ts`

`PROJECT(1).md` §3 sketches `ocr/worker.ts` in the repository structure (line 65, "detection +
recognition in a worker") and §3 line 118 adds that the worker "receives transferable `ImageBitmap`
input where available" and that **"Worker requests must be included in the privacy audit."**

Ticket 04 does **not** build it. The provider ships OCR on the main thread, and the pipeline underneath
it — `packages/core/src/ocr/pp-ocrv6.ts` over `ocr/pp-ocrv6/{image,detect,recognize,lines}.ts` — is
deliberately pure functions with the two runtime dependencies injected as seams (the ORT runtime and
the canvas environment, `pp-ocrv6.ts:63-66`), so a worker can wrap it later without reshaping it.

**What it would have cost to do here.** Moving OCR into a worker is not the ~30 lines of a `postMessage`
pair: the calling side needs a `transferable` `ImageBitmap` (or a structured-clone fallback for hosts
without it), a lifecycle for the model sessions that today live on the main-thread provider, error
propagation that preserves the typed failure taxonomy (`IMAGE_UNREADABLE` / `MODEL_LOAD_FAILED` /
`RECOGNIZE_FAILED`) across the boundary, and a bundler setup that emits a worker chunk with the WASM
artifacts still resolving same-origin. Nothing in ticket 04's acceptance gate needs any of that, and
§9 M1 asks only for "a minimal harness page that invokes the core OCR/parser pipeline".

**Follow-up trigger — stated so it is not re-litigated per ticket.**

- **Ticket 09a (M1 offline/egress proof)** is the earliest owner of the worker, because §3 line 118
  makes worker traffic part of the audit: the moment requests can originate from a worker context, an
  audit that only watches the page misses them. If 09a's harness cannot otherwise prove that a worker
  makes no cross-origin request, build the worker there — in the same change that extends the egress
  assertions to cover it. Landing the worker *without* extending the audit would be the wrong order.
- **Ticket 10 (capture)** is the hard trigger: a camera stream and full-resolution inference on the
  main thread is where responsiveness, not privacy, forces the move.

If neither bites, the worker stays deferred; that is a live choice, not an oversight. When it lands it
must reuse the exact function signatures the provider already exposes.

## The two tolerances are different numbers for different jobs

Three constants in this area are easy to conflate, and the two that are geometry are not the same
number — this was conflated in an earlier draft of this record and is corrected here.

| Constant | Where | What it does | Owner |
|---|---|---|---|
| **0.5 × median word height** | `manifest.readingOrder.toleranceRatio`, read at `pp-ocrv6.ts:328` into `groupWordsIntoLines` (`lines.ts:34-39`) | bands words into the **reading-order `OcrResult.lines[]` view** the provider publishes | ticket 04 |
| **40% × receipt-wide median word height** | §5 line 335 | **parser y-band clustering**, the geometry that decides rows | ticket 05 |
| `criticalOcrConfidenceFloor = 0.50` (with `warningOcrConfidenceFloor = 0.70`) | §4 lines 135/141, §6 line 405 | a **confidence** floor, not a geometric multiple; not implemented in ticket 04 — validation is ticket 07 | ticket 07 |

They must not be collapsed, for two concrete reasons:

1. **They are different computations, not just different values.** The provider's banding uses an
   unweighted median of word heights (`lines.ts:37-38`: sort, take index `floor(n/2)`) and compares a
   word's centre against the **running mean centre of the band**. §5 specifies a
   **word-count-weighted** median. Editing the provider's `0.5` to `0.4` would not produce §5's
   clustering; it would only change a presentation constant and invalidate every cached `OcrResult`
   fixture that §3 line 117 keys by provider version and model hash.
2. **The provider's bands are explicitly not a parsing decision.** `lines.ts:31-32`: "The deterministic
   parser re-clusters words itself (§5), so this only has to be a faithful reading-order view of the
   page, never a parsing decision." The provider's value is carried over from the upstream browser
   manifest; §5's is an initial heuristic "to be tuned on development data". Tuning belongs to the one
   that is measured by the scorers.

**There is no blank/no-text threshold.** An earlier draft described the provider's 0.5 as gating blank
images; it does not. A blank image yields no detection boxes and therefore a valid zero-word result
(§4: not an error), which `pp-ocrv6.test.ts` pins. Detection postprocessing thresholds are `0.2` and
`boxThreshold 0.45` in the manifest. Provider confidence is likewise never thresholded:
`OcrLine.confidence` is the mean of its non-null word confidences and `null` when there are none
(`lines.ts:61-66`).

## What this record does not decide

- Whether OCR *ultimately* runs in a worker is still open until 09a/10 force it; only the ordering is
  fixed here — the worker and the audit extension land together.
- §5's 0.4 value and its weighted median are ticket 05's to tune on dev data. Nothing in this record
  pre-approves a change to the provider's 0.5 as part of that work.
- The two §6 confidence floors stay unpinned at their defaults; §17 requires pinning them at M1 exit,
  and `DECISIONS/0006` already notes they are not its own to set.
