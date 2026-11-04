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

## Decision

All six pins (P1–P6) are decisions, committed above. The capture UI must implement exactly these
constraints — no deviations that would change the pinned predicate, and no features the pins exclude.
`packages/pwa/tests/capture/pins.test.ts` must pass on every commit that changes capture logic; if it
fails, the changed constant is the thing that moved, not the test.
