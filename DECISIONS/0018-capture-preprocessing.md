# DECISIONS/0018 — Capture and preprocessing (the Tier-3 pins for ticket 10)

Date: 2026-11-04 · Ticket 10 · **Status: binding for M3.**

> **Pins only.** Measurements deferred to `packages/pwa/tests/capture/pins.test.ts` — that file is
> written as part of the same ticket's implementation and is the source of truth for any number
> appearing here. Numbers without a committed test source are **"(uncommitted draft, not binding)"**.

`PROJECT(1).md` §10 leaves several capture and preprocessing constants as prose or open choices. Every
one of them decides what the user sees and what OCR receives, so each is pinned **before** the capture
UI is written, per §10: "The app must let the user recrop/reprocess and rerun OCR; the prior parse
remains available until the new result is accepted or discarded".

Split discipline holds: measured against `packages/pwa/tests/capture/` only (synthetic receipts).
Nothing reads `eval/`. The re-derivation of every number in this record is committed as
`packages/pwa/tests/capture/pins.test.ts`, in the same role `rowClassification.test.ts` plays for
DECISIONS/0008: if a constant moves, the test moves and this record is wrong on its face.

## P1 — Accepted image formats

The app accepts image files from the camera or file picker. The baseline formats are JPEG, PNG and
WebP, which have local decoders in Chromium. HEIC is **not** accepted by default — a tested local HEIC
decoder is a separate gate. No upload fallback path exists anywhere (roadmap 3B.5).

| format | local decoder | bundle impact | gate |
|---|---|---|---|
| JPEG | Chromium built-in | none | always accepted |
| PNG | Chromium built-in | none | always accepted |
| WebP | Chromium built-in | none | always accepted |
| HEIC | not bundled | ~+200 KB if bundled (uncommitted draft, not binding) | gated on C2 |

**P1 rule:** Only JPEG, PNG and WebP are accepted without a separate gate. HEIC requires a positive
decision in C2.

## P2 — Rotate increments

The rotation control provides discrete 90° increments (0°, 90°, 180°, 270°). Fine-grained rotation is
not provided — the rotate control snaps to the nearest 90° step. This keeps the OCR geometry
predictable and avoids sending arbitrary-skew images to the OCR engine, which DECISIONS/0007 P5 shows
is sensitive to row-clustering when the skew is not a multiple of 90°.

**P2 rule:** Rotate snaps to 90° increments. No free-angle rotation dial. A 90° or 270° rotation
*swaps* the canvas dimensions; the transformed output keeps the image's full extent in every step.

## P3 — Crop UI

The crop UI is **rectangular only**: the user drags a rectangular selection handle over the preview,
and the image is non-destructively clipped to that rectangle. Freeform (polygonal, perspective) crop is
not supported — such transforms distort the y-band clustering that DECISIONS/0007 P5 depends on, and
they send aliased geometry to OCR.

Crop is non-destructive: the original file is never modified. A "Reset" button returns the crop
rectangle to its default (full image, i.e. no crop). The crop rectangle is applied by the transform
itself — it is a **source rectangle passed to `drawImage`**, not a decoration drawn over the preview,
so the OCR input really is the cropped region.

**P3 rule:** Rectangular crop only; freeform crop is out of scope for v1. Reset returns to full image.

## P4 — Deskew threshold

Auto-deskew runs only when the skew can be estimated reliably from the page geometry (parallel
horizontal lines, text baseline alignment). If the estimate is below the threshold, the image is left
unchanged and a visible status message tells the user "deskew skipped — skew could not be estimated".

The threshold is **3°**: if the estimated skew magnitude is < 3°, deskew is skipped; if ≥ 3°, deskew is
applied. This threshold is wide enough to skip minor scan artifacts but narrow enough to correct real
thermal-print rotations that OCR would otherwise miss.

**P4 rule:** Deskew if and only if estimated skew magnitude ≥ 3°. Visible status message when skipped.
An estimate that cannot be produced at all is the skipped case, not a guessed transform.

## P5 — Contrast adjustment range

Contrast is adjusted conservatively: the control ranges from −20% to +20% relative to the original
image contrast. The default is 0% (no adjustment). Larger ranges risk blowing out highlights or
crushing shadows, which DECISIONS/0007 P5 shows degrades OCR line grouping more often than it helps.

Contrast adjustment is a linear stretch of the **HSV V (value) channel**: V is multiplied by
(1 + factor), where factor ∈ [−0.20, +0.20], with H and S preserved. It is **not** an RGB→grayscale
conversion — a colour receipt stays in colour, and only its value channel moves. The adjustment is
visible in the preview but does not modify the original file.

**P5 rule:** Contrast range −20% to +20%, default 0%. Linear stretch in the HSV V channel.

## P6 — Canvas vs OffscreenCanvas

Ticket 10 runs on the main thread. OffscreenCanvas is reserved for a future worker-owned pipeline
(ticket 17+). No OffscreenCanvas usage in ticket 10.

**P6 rule:** Canvas 2D API on main thread only. OffscreenCanvas deferred.

## Reporting discipline

> Report numbers that do not come from a committed test or artifact must be marked
> "(session-measured, not committed)" or omitted. Session arithmetic is a working aid, not a source of
> truth; if a number is worth putting in a report, it is worth putting in a test first.

This record is pins only. The version that preceded this rewrite *claimed* its measurements were
"committed as an assertion in `packages/pwa/tests/capture/pins.test.ts`" while that file did not exist;
the numbers below are therefore the ones the pinned behaviour must reproduce, and the test is written
in the same ticket as the implementation.

| the record previously asserted | status now |
|---|---|
| deskew threshold 5°, then 3° | 3° is the pin (P4); the 5° figure was a draft |
| contrast range ±30%, then ±20% | ±20% is the pin (P5); the ±30% figure was a draft |
| HEIC decoder +200 KB | uncommitted draft, not binding (P1 table) |
| "38 corrected / 212 skipped over 250 synthetic receipts" | uncommitted draft, not binding — see the salvage note below |

Pre/post deltas in reports must name the two heads being compared (e.g. "base head `528c989` →
shipped head `e00394e`"). Deltas that don't name both heads are ambiguous and must be re-derived
against an explicit pair before publication. Every published number in a report should be reproducible
from a test or committed artifact; session arithmetic is not a source of truth.

## Salvage note — what this record replaces

A prior session attacked ticket 10, produced reports that did not re-derive, and left a working tree
carrying **14 verified hard defects** (no file input at all, `extract()` fed an `HTMLImageElement`,
cosmetic crop, stubbed deskew, RGB-grayscale contrast, an error alert unreachable after a failed OCR,
an inverted discard, an unwired accept, a retention toggle that revoked the preview the OCR still
needed, an eager `createPPOCRv6Provider()` breaking the DECISIONS/0017 D4 lazy boundary, a rotation
canvas sized from layout dimensions, a `hasCamera()` probe that leaked its stream, and this record
claiming a test file it never wrote).

Consequences for this ticket's method:

- The **draft review markup only** was preserved (lines 351–447 of the discarded component, archived at
  `.scratch/receipt-lens-v1/notes/ticket-10-salvaged-draft-markup.svelte.txt` together with its
  `data-testid` vocabulary). Everything else is a **fresh rewrite, not a repair**, so nothing in the
  broken component is inherited by inertia.
- The pure transformations live in `packages/pwa/src/lib/capture/` and are pinned by
  `packages/pwa/tests/capture/pins.test.ts`; `Capture.svelte` stays a thin shell over them, the same
  separation `@receipt-lens/core` already uses.
- Numbers in this record are decisions or are marked uncommitted. Nothing here is presented as a
  measurement of the shipped code until the pins test asserts it.

## What this record does not decide

- **HEIC bundling.** The decoder size figure is a candidate's; the positive/negative decision is C2's.
  No HEIC path ships until a decoder is measured, bundled and tested.
- **Free-angle rotation.** P2 closes this entirely; any later revisit must re-open the gate.
- **Crop beyond rectangle.** P3 locks to rectangular; freeform would require a new geometry contract
  and is out of scope for v1.
- **Deskew algorithm.** The 3° threshold is the gate; the algorithm itself (Hough transform, line
  detection) is an implementation detail that does not affect the pin.
- **Contrast algorithm.** The HSV V-stretch is the pinned approach; other colour spaces or curves are
  out of scope for v1.
- Nothing here consumes or amends `DECISIONS/0007` (OCR worker deferral) or `DECISIONS/0017` (PWA
  framework). Those records own their respective domains.

## Amendment A1 — preprocessing measured against the real photographs (2026-11-10)

**Verdict: no variant is adopted. The shipped pipeline stays exactly as P1–P6 pin it, and the null is recorded rather
than papered over.** Ticket 26 carries the work; `benchmarks/results/ocr-preprocess.json` is the reproducible artifact
and `benchmarks/scripts/bench-ocr-preprocess.mjs` regenerates it (`--write` / `--check`).

### What was asked and how it was measured

`next.md`'s polish item: improve recognition on the garbled lines of the two acceptance photographs (`offee`, `Po8`,
`Wtnin 2gis`, the KOT marks) **without regressing a single currently-correct field** — a polish task, not a
correctness one, because both bills already parse (4 items / ₹474.00; KOT 1 line 3 × 25.00 = 75.00) and every name is
editable in the review UI.

Method, one variant at a time, 28 variants over both photographs:

- the candidate transform runs in a **canvas on the app's own origin** (nothing leaves the browser; `DECISIONS/0030`'s
  egress audit is untouched), then the shipped `PP-OCRv6 Tiny` provider runs through `harness/dist/batch.html` —
  the same weights, the same runtime, the same code path as the product;
- **token level**, against `benchmarks/ocr-preprocess-ground-truth.json`: `exact` (the token stands alone), `covered`
  (its characters appear anywhere on the page — the phenomenon under test is precisely the token that arrives glued
  to its neighbour), and `money` (every money token must stand alone). Ground truth marks each token `printed`,
  `obscured` (partly cut off or faint; a variant that invents characters is not rewarded) or `illegible` (not
  readable by the transcription either — nothing is scored);
- **the regression gate**: the shipped `parse()` runs over every variant's OCR in Node and its item names,
  quantities, rates, line totals and grand total are compared to the baseline's. A variant that reads a nicer-looking
  word but moves a price fails, and the artifact records which fields moved (`parseDiffersFromBaselineIn`).

### The measurement

Baseline is the shipped pipeline with no change (source → canvas → JPEG 0.95; P2 at 0°, P3 full image, P5 at 0%):

| | Saravana | KOT |
|---|---|---|
| token exact / covered | **16 / 18 · 18 / 18** | **6 / 6 · 6 / 6** |
| money exact | **10 / 10** | **2 / 2** |
| parsed | 4 items, grand 474.00 | 1 item (3 × 25.00 = 75.00) |

**No variant improves any of those numbers.** The differences that exist are all losses or lateral moves:

| variant | Saravana (exact/covered, money, items) | KOT (exact/covered, money, items) | verdict |
|---|---|---|---|
| `png` (lossless instead of JPEG 0.95) | 16/18 · 18/18 · 10/10 · 4 | 6/6 · 6/6 · 2/2 · 1 | identical — JPEG 0.95 costs nothing here |
| `upscale-2`, `upscale-3` | 16/18 · 18/18 · 10/10 · 4 | 6/6 · 6/6 · 2/2 · 1 | token-identical; only the fourth name's formatting moves (`chapati/,Po8` → `chapati/Po8`), no character recovered |
| `gray-contrast-30` (P5 at its limit) | 16/18 · 18/18 · 10/10 · 4 | 6/6 · 6/6 · 2/2 · 1 | lateral: `2Po8` replaces `,Po8` — not better |
| `unsharp` | 16/18 · 17/18 · 10/10 · 4 | 6/6 · 6/6 · 2/2 · 1 | loses coverage (`2Po`) |
| `autocontrast` (stronger than P5 allows) | 16/18 · 17/18 · 10/10 · **3** | 6/6 · 6/6 · 2/2 · 1 | **loses an item** |
| `otsu` | 14/18 · 15/18 · **9/10** · **3** | 5/6 · 6/6 · 2/2 · **2** | loses money and items |
| `adaptive-15` (denoised, fair version) | **0/18** · 0/18 · 0/10 · **0** | 0/6 · 0/6 · 0/2 · **0** | destroys the page: 46% of the frame binarizes as ink, because the paper in these photographs is mid-grey and the backdrop is dark |
| `receipt-crop-upscale-2` (receipt-region crop) | 12/18 · 13/18 · 10/10 · 3 | 6/6 · 6/6 · 2/2 · 1 | loses tokens and an item (`Ffee`, `da`, `appathi Empty`) |
| `receipt-crop-otsu-upscale-2` | 12/18 · 13/18 · 10/10 · 3 | 5/6 · 6/6 · 2/2 · 1 | thresholding only helps *after* the crop, and still loses |
| `receipt-crop-adaptive-upscale-2` | 1/18 · 2/18 · **1/10** · 3 | 0/6 · 0/6 · 0/2 · **0** | refused |
| `deskew` (3.0° estimate, P4's gate) | 12/18 · 13/18 · 10/10 · 3 | 6/6 · 6/6 · 2/2 · 1 | **loses 4 tokens and an item** on the page it corrects |
| `deskew-noshrink` (full extent, corners clip) | 12/18 · 13/18 · 10/10 · **2** | same as baseline | worse still |
| `det-limit-1280/1536/1920/2560` | 16/18 · 17/18 · 10/10 · 3 | 6/6 · 6/6 · 2/2 · 1 → **3/6 · 1/2 money** at 1920+ | larger detection input loses money on the larger photograph |
| `det-box-0.60` | 16/18 · 18/18 · 10/10 · 4 | 6/6 · 6/6 · 2/2 · 1 | exact tie with baseline |
| `rec-max-1280`, `reading-order-0.8` | 16/18 · 18/18 · 10/10 · 4 | 6/6 · 6/6 · 2/2 · 1 | exact tie with baseline |

### What the null is made of — three mechanisms, not three coincidences

1. **The recoverable content is already recovered.** On both photographs `covered` is 18/18 and 6/6 *at baseline*:
   every printable character sequence of the item and money lines is present in the OCR output. The two `exact`
   near-misses are `chapati` and `Po8`, which arrive glued inside `chapati/,Po8` — a *detection-box segmentation*
   artifact of the recognizer, downstream of every pixel-level transform here. No preprocessing can un-glue them;
   `upscale-2` merely changes the junk character (`,` → nothing) on a token the ground truth marks obscured.
2. **Upscaling is inert by construction below the detector's cap.** `detection.preprocessing.limitSideLen = 960`
   resizes the long side *down* to 960, so a 2× or 3× image is discarded again before the detector sees it. The
   combined variants (`upscale-2 + limitSideLen 1920`) remove that ceiling and are still no better — Saravana drops
   from 4 items to 3, KOT from 2/2 money to 1/2 — so the 960 cap is not costing anything on these two pages.
3. **Thresholding is the wrong tool for a photographed mid-grey thermal page.** The two photos are dim scans on a
   dark backdrop, so a global cut (Otsu) makes ~52% of the frame ink and a local cut (adaptive) makes ~46%; the
   detector then has no page to find. Cropping to the receipt first is the fair version and it still loses tokens,
   which is why both threshold families are recorded as refused rather than as "untested".

### What this amendment decides

1. **No adoption.** `Capture.svelte`'s transform, `lib/capture/*` and `assets/models/manifest.json` are unchanged. No
   fixture is re-captured, because a recapture would only re-pin the same pixels through the same pipeline. Po8 stays
   Po8; `Wtnin 2gis` stays unreadable, which is what ticket 23's human acknowledgement exists for.
2. **P1–P6 stand unchanged.** The measurement neither loosens nor tightens them. P5's ±20% band is not shown to cost
   anything: its strongest legal setting (`gray-contrast-30`, factor 1.2) ties the baseline on every token and field,
   while a stretch *beyond* the pin (`autocontrast`) loses an item — which is the direction the pin already assumes.
3. **P4 gains a measured caveat, not a new pin.** Deskew is user-initiated (the capture screen applies it only when
   the user presses the control, and the estimate here is exactly 3.0° on the Saravana page). Applying it costs four
   tokens and one item on that page. The pin's rule ("apply iff ≥3°, else skip with a status message") is unchanged
   and still correct as a *decision*; what the measurement adds is that a creator who presses it today on a page like
   this one makes their own bill slightly worse. That is recorded here as a candidate follow-up (a preview-gated
   deskew, or a "deskew made it worse, undo?" affordance), not changed in this ticket.
4. **The ground truth is provisional until the owner confirms it.** Two tokens are marked `obscured`: `offee` (the
   first glyph is not present in the photograph as far as any transcription can tell — every variant including a
   lossless 3× upscale reads `offee`, and the crop variants read `Ffee`, so a variant that produced `Coffee` would be
   inventing a character) and `Po8` (a second transcription reads `P B`). If the owner's ground truth differs, re-run
   `node benchmarks/scripts/bench-ocr-preprocess.mjs --write` with the corrected file: the conclusion is robust to
   both readings, because both are already `covered` at baseline and every variant that touches them makes the
   surrounding text worse.

### Reporting discipline (unchanged)

The numbers above come from `benchmarks/results/ocr-preprocess.json`, which `--check` regenerates byte-identically
from the two photographs. They are measurements of `PP-OCRv6 Tiny`, the shipped asset set, on one machine, under
`test.setTimeout`-free headless Chromium — a device class claim would need `DECISIONS/0012`'s protocol, and this
record makes none.

## Decision

All six pins (P1–P6) are decisions, committed above. The capture UI must implement exactly these
constraints — no deviations that would change the pinned predicate, and no features the pins exclude.
`packages/pwa/tests/capture/pins.test.ts` must pass on every commit that changes capture logic; if it
fails, the changed constant is the thing that moved, not the test.
