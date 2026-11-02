Status: ready-for-agent
Feature: receipt-lens v1 (consolidated v0.4 spec, M1 + M3; LLM-fallback decision deferred to M2)
Source of truth: `PROJECT(1).md` — where this document and that file disagree, that file wins.

# receipt-lens — Privacy-first in-browser receipt parser and bill splitter

## Problem Statement

People splitting a restaurant receipt do the extraction and arithmetic by hand. Photographing a receipt into a cloud OCR service uploads personal documents; rounding the split loses track of exact amounts; one person pays, and everyone who paid less has to remember or trust the breakdown. There is no tool that (1) reads an Indian restaurant receipt entirely on the user's device, (2) keeps every calculated share exact rather than rounded, (3) lets participants see their own share without any backend holding bill data, and (4) is honest about its accuracy and footprint instead of quoting unverifiable numbers.

## Solution

`receipt-lens` is a pnpm monorepo shipping two deliverables:

- **`@receipt-lens/core`** — an npm library that turns a receipt image into structured JSON (items with quantity/price provenance, charges including Indian tax + round-off semantics, validation findings) in the browser, via staged APIs: OCR with a swappable PP-OCRv6 provider, deterministic parsing of normalized OCR, conditional validation, and a one-call convenience extraction.
- **A bill-splitting PWA** — capture or select a receipt image, review/correct parsed drafts, assign per-unit item ownership, and lock the bill. The PWA computes exact rational per-participant shares in integer paise, never rounding shares; only the final UPI transfer amount is converted to whole paise by a deterministic allocation. Bills are shared as encrypted, DEFLATE-compressed, URL-fragment snapshots — no bill-data backend in v1.

Supporting deliverables: a dataset-scoped benchmark harness (CORD layout stress bucket, SROIE grand-total-only) runnable from cached OCR fixtures in CI, a measured-footprint report, and Playwright privacy checks proving receipt inference runs with outbound network blocked after assets are cached.

## User Stories

Core library (developer persona)

1. As an application developer, I want to `extract()` structured JSON from a receipt image in the browser, so that I get items, charges, and validation results in one call without wiring OCR plumbing myself.
2. As a library consumer, I want the staged APIs — OCR, then parsing, then validation — so that I can inspect and intervene between stages during development.
3. As a library consumer, I want the OCR engine behind an `OcrProvider` interface, so that I can swap PP-OCRv6 Tiny for another provider without touching my parsing code.
4. As a library consumer, I want a locally hosted model set (no third-party CDN required), so that my deployment is not dependent on external asset availability.
5. As a library consumer, I want operational failures surfaced as typed errors for unreadable images, model load failure, and recognition failure, so that I can distinguish them from valid-but-empty results.
6. As a library consumer, I want a blank or unparseable receipt to return zero items plus a critical zero-items finding rather than silence or fabricated data, so that my app can show "we saw nothing" honestly.
7. As a library consumer, I want confidence to be `null` when the provider supplies no meaningful score, so that my UI never displays an invented number.
8. As a library consumer, I want parse() to be pure and deterministic, so that I can feed cached OCR fixtures in tests without running OCR.

Parsing and provenance (creator persona, no direct user; ends as corrected bills)

9. As a bill creator, I want item rows read with names, quantities, and prices, so that I don't transcribe them by hand.
10. As a bill creator, I want price-less rows below an item to join that item as a continuation, so that wrapped item names don't become phantom rows or items.
11. As a bill creator, I want header/noise lines (tables, GSTIN, column labels) ignored, so that they never become items that I then have to delete.
12. As a bill creator, I want unclassifiable lines preserved in an "ambiguous rows" list with their original text and position, so that nothing silently disappears from the receipt.
13. As a bill creator, I want a missing printed quantity to tentatively default to 1 with a visible "assumed" badge, so that I review it before the bill locks rather than ship a silent guess.
14. As a bill creator, I want ambiguous quantities to be marked unresolved and block unit creation and locking, so that guessing in either direction cannot be locked in.
15. As a bill creator, I want the label dictionary to recognize CGST/SGST/IGST/cess/VAT, service charge, tip, discount, round off, and similar labels longest-first, so that GST never fragments into a phantom item or misclassified charge.
16. As a bill creator, I want unclassified labeled charges preserved with their amounts and a warning, so that I decide what they are instead of the parser inventing meaning.
17. As a bill creator, I want quantities, unit prices, line totals, subtotal, and grand total each to carry provenance — detected, assumed, unresolved, or user-confirmed — so that I always know which values came from the print and which from me.
18. As a bill creator, I want manual edits to permanently set provenance to user-confirmed and never be overwritten by later parsing, so that my corrections stick.
19. As a bill creator, I want amounts stored as integer paise and shares computed in exact rational arithmetic, so that no IEEE-754 float ever silently corrupts money.

Validation (creator persona)

20. As a bill creator, I want arithmetic checked conditionally (only when present operands semantically reconcile), so that a receipt without a printed subtotal isn't falsely flagged as contradictory.
21. As a bill creator, I want the signed printed round-off honored within a small band and treated as a charge, so that legitimate ₹0.43 round-off doesn't fail the total, while a large mismatch stays critical.
22. As a bill creator, I want low-confidence names/prices flagged with two tiers (critical and warning floors) so that review effort lands only where it matters.
23. As a bill creator, I want extraction findings to be structured codes attached to their item/row/charge, so that my UI shows exactly what to review instead of asking me to eyeball everything.
24. As a bill creator, I want an optional relaxed mode where arithmetic findings become advisory, so that clearly-broken prints can still be split with visible disclaimers.

PWA capture and review (creator persona)

25. As a bill creator, I want camera capture and ordinary file selection both available, so that permission denial doesn't block me and non-camera devices still work.
26. As a bill creator, I want to preview and adjust my image (rotate, optional crop, optional conservative deskew/contrast) before OCR runs, so that I can give the parser its best shot without destructive edits.
27. As a bill creator, I want to recrop and re-run OCR with the previous parse still available until I accept the new one, so that a bad reprocess is reversible.
28. As a bill creator, I want my receipt images not persisted by default, and local retention strictly opt-in with a delete action, so that my photos never outlive my intent.

PWA editing and bill accounting (creator persona)

29. As a bill creator, I want unresolved imports held as drafts that cannot finalize or lock, so that tentative OCR output cannot silently become final billing facts.
30. As a bill creator, I want to add items and charges manually with the same editing and validation rules as parsed ones, so that a partial or missing print doesn't block a complete bill.
31. As a bill creator, I want every add/edit/delete transactional — persist, recompute derived totals and shares, re-run validation, then update findings — so that the displayed numbers always reflect the data just written.
32. As a bill creator, I want my printed/confirmed grand total preserved on deletion and item edits, so that the difference between what the print said and what the items say stays visible instead of being overwritten.
33. As a bill creator, I want per-unit assignment — buying half of a shared dish is one unit to each person, and a solo dish with quantity 3 can be split two ways and one unassigned — so that line-item ownership matches reality.
34. As a bill creator, I want quantity changes to update units and assignments transactionally, with explicit warning about removed assignments, so that no stale ownership record survives a quantity edit.
35. As a bill creator, I want to acknowledge each remaining unassigned unit at lock time, its full cost visibly added to my payable share as an explicit adjustment line, so that no unaccounted cost hides anywhere.
36. As a bill creator, I want per-charge semantics confirmed as included-in-prices or charged-separately, only from an explicit receipt cue, so that an included tax is never charged again.
37. As a bill creator, I want a structured lock checklist (drafts resolved, units assigned or acknowledged, assumed quantities reviewed, payer and total present, no negative shares) so that I see exactly what prevents locking.
38. As a bill creator, I want to unlock a locked bill with an explicit warning, freshly regenerated links, and stale links marked as such, so that edited bills can't silently contradict links I already sent.

Splitting and settlement (creator and participant personas)

39. As a bill creator, I want bill-level charges (including round-off) split equally among all participants — including participants with nothing ordered — with fractional paise preserved exactly, so that split math is truthful rather than rounded.
40. As a bill creator, I want discount-driven negative shares to block locking rather than trigger an invented redistribution, so that bad data forces review.
41. As a participant, I want to see my exact share as a fraction when it is a repeating decimal, and a separate labeled whole-paise UPI payment amount, so that I know nobody's display rounded my real share.
42. As a participant, I want one click that opens a UPI deep link prefilled with the payee, amount, and note, so that paying is quick.
43. As a participant with a zero exact share, I want no payment link and a "nothing to pay" indication, so that I don't fire an empty transfer.
44. As a bill creator, I want payment confirmation to be manual only, so that the app never claims a bank settled something it hasn't verified.

Sharing (participant persona)

45. As a bill participant, I want a share link that opens without any login or backend, carrying an encrypted compressed snapshot in its URL fragment, so that the bill works offline and leaves no server records.
46. As a bill participant, I want the link's integrity validated (version, component count, charset, authentication tag, decompressed size, schema) with malformed links failing closed with a readable error, so that I never see a corrupted half-bill.
47. As a bill participant, I want the claim "show only my share" correctly framed as a view default, not access control, so that the app's security story matches reality.
48. As a bill creator, I want share payloads to include only resolved bill data and never the receipt image or raw OCR text, so that my photo cannot leak through the link.

Persistence and product honesty (creator / maintainer personas)

49. As a returning creator, I want my past bills and my payee profile stored locally, with sequential lossless migrations and a pre-migration JSON export, so that future schema changes cannot wipe my data.
50. As a maintainer, I want the benchmark harness to run on pinned dataset snapshots from cached OCR fixtures in CI, using deterministic order-respecting one-to-one item matching, so that parser regressions are caught without browser OCR noise.
51. As a maintainer, I want a null-parser bootstrap test asserting zero scores against non-empty annotated data, so that scoring bugs can never masquerade as accuracy.
52. As a maintainer, I want a strict exact-match tier plus field-level precision/recall/F1 published per dataset with label-coverage caveats, so that reader knows SROIE is grand-total-only and CORD is an out-of-language layout bucket.
53. As a maintainer, I want a measured footprint table (models, dictionary, runtime/WASM, app JS, download/cache size, cold/warm latency), so that the README quotes our deployment, not folklore.
54. As a maintainer, I want CI to block merges when the core inference workflow shows unexpected network egress, and to succeed with egress blocked once assets are cached, so that the local-processing claim stays testable not rhetorical.
55. As a maintainer, I want model-cache invalidation keyed on provider version plus manifest hash with verified new-asset activation, so that an offline device never silently runs against a broken model mix.

## Implementation Decisions

All decisions below are locked by the source specification; section numbers point into `PROJECT(1).md`.

Repository and delivery

- Ship a pnpm monorepo with two product packages (isomorphic core library; bill-splitting PWA), a benchmark harness, and Playwright privacy workflows, per §3. Only the OCR provider and the PWA UI are browser-runtime-specific; parsing, validation, and split math are pure and isomorphic.
- Register the `@receipt-lens` scope; the core package declares stable `exports` with browser-specific entry metadata.

Public API (§4)

- Staged API: `ocr()`, provider-independent pure `parse()` (accepts normalized `OcrResult` only), core `validate(ParseResult, options)` returning `ParseValidationResult`, and a convenience `extract()`.
- `ocr()` throws only typed operational errors (`IMAGE_UNREADABLE`, `MODEL_LOAD_FAILED`, `RECOGNIZE_FAILED`); blank OCR is a valid zero-word result flowing through to a critical `zero_items` finding when the input should be itemized.
- Two separate confidence options (`criticalOcrConfidenceFloor` initial 0.50, `warningOcrConfidenceFloor` initial 0.70, critical ≤ warning) replace any single threshold; defaults are evaluated and pinned at M1 exit. `strictArithmetic: false` keeps checks running but marks arithmetic findings advisory.
- Canonical warning codes include `name_confidence_low`/`price_confidence_low`; legacy spellings are mapped at the boundary, never emitted.
- Public charge schema per DQ-03/ADR-008: keep separate `taxes[]`, `serviceCharge`, `tip`, `discount` fields plus `roundOff` (signed integer paise) and `otherCharges[]`. The public shape stays; the PWA maps into an internal normalized `BillCharge[]` with a `type` discriminator.

Parser (§5)

- Deterministic pipeline: y-band clustering (initial tolerance 40% of median word height, count-weighted) and a right-aligned price-column model (initial 5% image width tolerance), published after tuning; all money parsing uses explicit locale profiles (`id-ID`, `en`, `en-IN` with lakh grouping) and integer-paise boundaries.
- Rows classified before content parsing as item / continuation / noise-header / ambiguous; ambiguous rows are preserved with text, box, and source-line references in `unclassifiedRows`, not discarded or forced into items. Continuation requires all four stated conditions (indentation, not a charge/header, length cap, not all-caps standalone).
- Quantity column inference (integer ≤ 20 majority rule), then provenance: `explicit`, `assumed` (tentative 1 with warning, review required), `unresolved` (null, blocks actions). The parser emits only those three; the PWA sets `user_confirmed`.
- Longest-first label dictionary for English/Indian-English plus Indonesian labels confined to CORD benchmark parsing (DQ-04/ADR-010: English-only product).

Validation (§6)

- Conditional scoped checks: compute `base_computed_total` from subtotal and non-included charges, compare against a reliable printed grand total; item-sum criticals require full line-total coverage and emit `items_may_be_missing` otherwise. Round-off validity band is ₹0.02 match within a ₹1.00 magnitude (initial defaults, pinned at M1 exit).
- Two-tier confidence floors with null skipped throughout (`confidence_unavailable` minor when all null); affected item confidence capped at 0.5 by any non-advisory critical.
- Ownership boundary: core `validate()` checks extraction data only; the PWA's `validateWorkingBill(WorkingBill)` owns bill-state findings and `LockBlocker[]` computed from complete current state — never stale parse arithmetic, never message-text parsing, blocker codes only (§6, §10).

PWA state model and edit flow (§10; ADR-005, ADR-009)

- Draft/finalized split: `DraftItem`/`DraftCharge` (nullable, may be unresolved) versus resolved `Item`/`BillCharge` (integer paise, no nulls). Finalization requires resolved fields; unit materialization happens only after finalization; `count(ItemUnit) = Item.qty` enforced transactionally.
- Normalized ownership per ADR-005: `ItemUnit` with `confirmedUnassigned` plus `(itemUnitId, participantId)` assignment pairs, uniqueness enforced, duplicates rejected. Shared units divide their integer-paise price exactly across assignees.
- Every add/edit/delete: atomic persist → recompute derived exact totals/shares → core validate where applicable → PWA validate → update findings/blockers; rollback on failure. Manual values outrank parser values; printed/confirmed grand total never auto-rewritten; `detectedLineTotal` preserved separately from computed line total.
- Charge inclusion per-charge, detected only from explicit receipt cues; ambiguous inclusion stays unresolved and is resolved by the creator before lock; the receipt-level `taxIncluded` field is a summary hint only.
- Locking gated only by structured blocker codes (drafts unresolved, charges/inclusion unresolved, unassigned units, assumed quantities unreviewed, grand total/payer missing, unclassified rows unreviewed, negative share after discount). v1 payer rule: creator and payer are participants; payer defaults to creator.
- Lifecycle: Draft → Review required → Ready to lock → Locked → Settled; unlock requires explicit action, regenerates links, old links remain stale snapshots.

Splitting and settlement (§11, §12; ADR-001)

- Exact rational arithmetic only: integer paise inputs, shares as reduced rationals (`ExactMoney` numerator/denominator strings), no paise or whole-rupee rounding in calculated shares, no residual distribution; a one-calculation-mode v1 with no rounding mode.
- Non-included applicable bill-level charges (taxes, service charge, tip, discount subtracted, signed round-off) divided exactly and equally among all participants including zero-item participants; `included: true` charges are display-only (ADR-001 amendment).
- Unassigned acknowledged units route their full cost into the creator's share via the one v1 adjustment reason, `AdjustmentLine{reason: "unassigned"}`, rendered separately from charge allocations — not a rounding bucket.
- UPI boundary (§12): only at transfer time, integer-paise shares derived by largest-remainder (floors first, then remaining paise one each by descending fractional remainder, ties by stable participant ID) targeting the confirmed grand total; both "Exact share" and "UPI payment amount" displayed where they differ; creator/payer gets no self-payment link; deep links URL-encoded with enforced `am` (two decimals), `pn` (≤ 40), `tn` (≤ 50, truncate note) and an optional deterministic `tr` (≤ 35 alphanumeric). NPCI limits verified against the primary specification before constants lock (open loop).
- The golden ₹664.00 five-participant table in §11 — including a unit shared by three participants, an explicitly confirmed-unassigned unit, a zero-item participant, and the exact rational final shares — must be reproduced exactly in CI.

Sharing (ADR-007, DQ-01)

- URL-fragment snapshot only: versioned prefix, token, nonce, ciphertext-and-tag; compact JSON → DEFLATE via a pinned, bundled `fflate` release (not runtime streams) → AES-256-GCM → base64url; whole fragment ≤ 8 KB with visible budget usage and no silent truncation; HKDF key derived from link token and disclosed as such (the link is a bearer secret, not against-link confidentiality); malformed input fails closed; no secure expiry or revocation; clients hold the full included snapshot.
- WhatsApp sharing is a deliberate external action via click-to-chat with the participant's exact share, settlement amount, and link; payment confirmation manual-only; no bank reconciliation.

Storage and delivery (§9, §10)

- One named local database with monotonic schema version, sequential in-transaction migrations from every supported prior version, abort-with-recovery on failure, no premature store deletion, migration tests per schema, and a JSON export before any non-lossless migration.
- Model assets self-hosted with content-hashed names and a manifest; service-worker model cache keyed by provider version plus manifest hash; full-download-then-verify activation — old cache retained until a smoke inference succeeds against the new set; visible "model update pending" on failure; obsolescence cleanup after verified activation.
- Receipt images are not persisted by default; explicit opt-in retention only, stored locally with a delete action.

Benchmarks (§8, ADR-003)

- Two-tier dataset-scoped scoring on pinned snapshots with recorded licenses/hashes and per-loader label-coverage metadata: strict exact match plus field-level one-to-one matched precision/recall/F1; deterministic order-respecting LCS-style matching maximizing pair count then name similarity; integer-paise monetary equality; null semantics explicit and disclosed; locale normalization with the same profile as predictions; permanent null-parser bootstrap; README numbers generated from committed machine-readable CI results.
- Per-commit CI runs on cached `OcrResult` fixtures (Node); full image-to-extract benchmarking on demand in a headless browser, reported separately with a declared headline mode. τ values and round-off band pinned in benchmark config at M1 exit.
- Milestone structure per §16: M1 (parser + benchmarks + measured Tiny-vs-Small evidence + core offline/egress checks), M2 (LLM-fallback decision from M1 data, no fine-tuning), M3 (PWA, sharing, UPI, end-to-end privacy audit). Exit criteria as listed in §16.

Privacy audits (§9)

- M1: minimal core harness — assets self-hosted and precached, inference verified with outbound network blocked, attempted requests recorded, unexpected dependencies fail.
- M3: full workflow Playwright audit — no cross-origin request anywhere in the app flow incl. first load; no receipt-image bytes or OCR text in any request URL/headers/body (GET/URL exfiltration included); service-worker traffic handled at the browser-context level with documented Chromium-specific limits; first-party static scanning as a supplement not a proof; receipt-processing claim excludes deliberate sharing actions.
- The README claim is the scoped one from §9 (local inference after assets load, CI-checked against unexpected egress and uploads; sharing separate and image/OCR-free), never a universal zero-network or security-proof claim.

## Testing Decisions

Good tests here assert external behavior — typed results, findings, blockers, exact shares, produced links — and never implementation details like geometry internals or store wiring.

Five seams, everything tested through them (confirmed with the owner):

1. **Core parser seam** — `parse()` and `validate()` over fixture `OcrResult`s (cached JSON; no OCR run) in Node or headless-browser. Covers geometry/classification outputs via their results: row classes, provenance, locale parsing, warning and finding codes, confidence mechanics, arithmetic and round-off bands, tax-included cases, advisory mode, typed error contract.
2. **PWA bill-state seam** — construct a whole `WorkingBill`, apply a deterministic add/edit/delete/finalize/assign/acknowledge transaction, assert the full observable state delta: recomputed exact totals, findings, and structured blockers, including rollback on failure. Also every lock-blocker's clear condition and the draft→final→lock→unlock lifecycle.
3. **Split-engine and UPI boundary seam** — complete `WorkingBill` to per-participant exact rational shares plus settlement-paise allocation. Asserts the §11 golden table exactly (rational equality incl. the three-way shared unit, confirmed-unassigned adjustment, zero-item participant, sum equals exactly ₹664.00), discount-negative blocking, included-charge non-allocation, and deep-link parameter invariants (encoding, lengths, decimal format, zero/creator self-payment behavior).
4. **Fragment codec seam** — snapshot encode/decode round-trip: 8 KB budget enforcement and failure, compression/encryption/authentication ordering (pinned codec), every malformed-input validation failing closed, stale-snapshot flagging, and excluded-content guarantees (no receipt image, no raw OCR text).
5. **Browser seam (Playwright only)** — the only place OCR runs and the only place network behavior lives: M1 minimal-harness offline inference and zero-egress; M3 full workflow audit (context-level service-worker handling, no receipt data in any request, static-scan supplement); plus migration/upgrade and model-cache invalidation scenarios exercised in a real browser.

Direct unit tests exist only for genuinely independent pure logic (GCD-reduced rational arithmetic, locale number parsing, regex matchers, label dictionary) — all other behavior goes through the seams. Prior art: none — this repo has no tests yet, so these become the foundation; the golden table and null-parser bootstrap are the two non-negotiable regression standards from day one. Every persistent schema change ships migration tests for all supported prior versions; every publishable metric must be reproducible from pinned fixtures in CI.

## Out of Scope

- Custom OCR model training/fine-tuning in v1 (an M2 decision from measured data; no fine-tuning committed).
- Any bill-data backend, peer-to-peer hosting, or server-side bill storage.
- Receipt images or raw OCR text in share links or any remote endpoint.
- Product/UI language beyond English (Indonesian vocabulary exists solely for the CORD benchmark bucket).
- Native mobile apps; multi-currency bills.
- Automatic bank reconciliation or payment verification (manual confirmation only).
- A share rounding mode: whole-rupee rounding / rounding adjustments in bill accounting (exact rational shares; integer paise only at the UPI transfer boundary).
- Non-participant payer/creator accounting (creator and payer must be participants in v1).
- Server-enforced share expiry/revocation, per-participant access control, or private "only-my-share" authorization — the link is a bearer secret carrying the full included snapshot; confidence calibration of scores remains out of scope (heuristic only).

## Further Notes

- Locks and owner decisions DQ-01 through DQ-04 are resolved (§18); the ADRs referenced above (ADR-001 through ADR-010) are currently specified in the source document — use `/domain-modeling` to seed `docs/adr/` from them as implementation begins, and seed `GLOSSARY.md` from the §15 living glossary, which defines the exact vocabulary this spec deliberately reuses (e.g. `LockBlocker`, `confirmedUnassigned`, `ItemUnit`, `ambiguous_row`, exact share, zero-item participant).
- Open loops to resolve before the relevant milestone (§17): PWA framework choice before M3 (Svelte 5 implied, not locked); NPCI `pn`/`tn`/`tr` limit verification against the primary specification; Tiny-vs-Small measurement; dataset snapshot/hash/license pinning; τ and threshold pinning at M1 exit; third-party footprint-figure review; business-document update for normalized units.
- Milestone order matters: benchmarks and harness precede the parser (M1 items 1–2); the privacy/evidence requirements gate every published claim (footprint table, accuracy tables, egress audit all carry documentation requirements, not just implementation).
- Definition of Done is §20 (eleven measurable criteria); the golden table, null-parser bootstrap, measured footprint, and 8 KB fragment budget are the CI-enforced ones.
