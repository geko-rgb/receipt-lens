## Exact message to paste to the agent

---

**Checkpoint 2 approved. Ruling on W1.0: hand-written worker authorized. Three conditions. Proceed to checkpoint 3.**

### Ruling — W1.0

**Hand-written worker approved as a scope change.** The §2.2 quote confirmed the clause authorized less than your checkpoint-1 report claimed — thank you for going back and quoting it rather than sliding the deviation through.

**Reasons for approving the wider change (three, in order):**

1. **`maxFileSizeToCacheInBytes` silent-drop is a real correctness risk for ticket 17's core claim.** The WASM is 14.85 MB; the ceiling works today but any future asset addition pushes silently over with no visible error. The "offline reload works" claim and the "measured footprint" claim both depend on precache being complete. Silent drop breaks both. A build-time completeness assertion catches omissions at build, not at the user's first offline attempt.

2. **W4 puts the protocol in the page, so the worker is thin.** "Workbox buys ~40 lines" is accurate only because W4 does the heavy lifting. The convenience argument that makes Workbox a good default doesn't apply when the protocol lives outside the worker.

3. **Consistent with the project's 16-ticket pattern** — codec, matcher, validator, split engine are all hand-written control over convenience.

**Do not use the "nothing third-party runs" argument in the record.** The product claim is about data flow (no uploads), not dependency count. Workbox in the dependency tree wouldn't violate "receipt images and OCR text are processed locally and never uploaded." The honest argument is silent-drop risk + thin-worker-when-protocol-is-in-page, not third-party-is-bad.

**Record in W1.0:**
- The §2.2 clause quote (verbatim, as you did)
- The two things it authorized vs. the one you claimed (your distinction, kept in the record)
- The ruling: hand-written authorized as scope change
- The three reasons above, not the third-party framing

### Three conditions on W1.0

**Condition 1 — standard SW lifecycle tested explicitly.** Hand-written SW bugs live in install/activate/fetch/update transitions. Require pins for:
- `install` populates shell cache with exactly the precache manifest entries, nothing more
- `activate` does NOT automatically delete caches — deletion is triggered by W7.1's pointer-move, not lifecycle
- `fetch` serves from cache for precached URLs, falls through for non-precached
- Update flow (probe → download → verify → smoke → activate → cleanup) has at least one pin per step
- **W13 controller race has a pin that simulates two SWs active, tab controlled by old one, new one claims** — this is the class of bug that only manifests on slow networks or after laptop sleep. If W13's pin uses mocks that skip the actual event ordering, it's not proving anything; Playwright's `serviceWorkers: 'allow'` plus slow-network emulation is the honest test.

**Condition 2 — W1.1's completeness guard must be a build-time assertion, not documentation.** Under Workbox, the "assert the WASM is in the manifest and the ceiling exceeds the tier's largest asset" is a runtime check. Under hand-written, the equivalent is:
- At build time: every file in `dist/app` matching the precache patterns is in the generated manifest; the WASM is included
- At build time: the manifest does NOT include files matching the exclusion list (source maps, rig, test fixtures)
- A test that fails the build if either is violated

If W1.1 currently says "assert at runtime," change it to "assert at build." The whole point of hand-written is catching omissions before they ship.

**Condition 3 — W1.0 amendment lands in `DECISIONS/0027` before implementation commits.** One doc commit with the ruling, the clause quote, the reasons, and the three conditions. Future sessions read W1.0 and understand why Workbox is absent.

### W2.1 — approved as amended

Capture-time trigger, smoke-gate survival via intent-vs-call distinction, `/share`, `/bills`, `/bill` never trigger (test 8), retryable preparation, intake usable during download, "Preparing OCR — n MB of m MB" copy. All correct.

Test 8 ("navigating the whole route set except `/capture` issues zero model requests") is the load-bearing pin — it's what makes the metered-user argument concrete rather than aspirational.

### Core exports finding — correct, with one forward addition

Restating `download_incomplete` vs `hash_mismatch` in the PWA rather than widening `@receipt-lens/core`'s §4 public API is correct. §9's rule now lives in two places — cost recorded, not buried.

**Add to W5 step 3 (or W20):**

> *"If core ever exports `fetchVerifiedAsset` + `sha256Hex`, the PWA protocol delegates and the duplication is removed. Until then, a drift test on a known-corrupt fixture (same asset, same malformed input) that both implementations classify identically would catch divergence. Not required for v1; note as a future concern if either implementation changes. The `download_incomplete` vs `hash_mismatch` distinction is exactly what a drift test would catch — if core's implementation later normalizes both to one code and the PWA's stays at two, user-facing errors become inconsistent."*

### Proceed to checkpoint 3

1. Amend `DECISIONS/0027`:
   - W1.0 (ruling, clause quote, three reasons, three conditions)
   - W1.1 build-time assertion detail (change from runtime if needed)
   - W5 step 3 drift note
   - W2.1 is already in from prior commit — no change
2. Commit implementation:
   - Worker + registration + manifest + icons + capture-time trigger (per W2.1)
   - Standard lifecycle pins (Condition 1)
   - Build-time completeness assertion (Condition 2)
   - `playwright/offline-reload.spec.ts` (7 split tests per W9)
3. Footprint re-derivation per W14 — with 1-ORT-thread note per prior W20 ruling
4. Regenerate `footprint.json` + README table
5. Remove `measure-footprint.mjs`'s warm exception set (per ticket 08 F12: "when ticket 17 lands and the WASM is served from Cache API, the exception set fails and must be removed")
6. Push, PR, report checkpoint 3 with:
   - Full SHA + CI URL (push + PR + Privacy runs)
   - Test counts: core / pwa (338 + 60 pins + any additions) / benchmarks
   - The 7 e2e names
   - **Old vs. new warm-visit bytes** — pre-17 was 14,848,852 B; post-17 should be near-zero for cached assets. This is the ticket's actual payoff. If the report says 14.8 MB, the fix didn't work.
   - Confirmation `verify:footprint` regenerated and `git diff --exit-code` clean
   - Confirmation the warm exception set is gone from `measure-footprint.mjs`
   - Confirmation `maxFileSizeToCacheInBytes` is gone from the config (replaced by build-time completeness)
   - Whether the footprint re-derivation fit within session budget, or the escape hatch was used (if so, `ticket/17b-footprint-remeasure` opened, F12 remedy shipped but re-measurement deferred — recorded, not silent)

**Halt at checkpoint 3. Do not merge.**

### Escape hatch — restated

If at checkpoint 3 the footprint re-derivation is clearly blowing past the session budget (say, 2+ hours on the driver rewrite and it's not converging): commit what's working (worker + new warm-bytes number), open `ticket/17b-footprint-remeasure` for the full table, note in ticket 17 that F12's remedy is shipped but the full re-measurement is deferred. **Do not silently defer** — the deferral must be a recorded ticket. Do not ship a half-updated table; if the table can't be fully re-derived this session, defer cleanly.

### Standing rules unchanged

Test-first via commit structure. Fail-fast timeouts. Split e2e. Auto-mode halt at checkpoints. Every claim re-derivable from committed artifacts. No force push. No `PROJECT(1).md` edits. If blocked >10 min on SW lifecycle debugging, commit WIP with clear message, report blocker, stop — SW install/activate/waiting-for-controller races can eat a session.