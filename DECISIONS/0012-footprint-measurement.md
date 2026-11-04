# DECISIONS/0012 — Footprint measurement: deployment, sampling, and what makes a number publishable (the Tier-3 pins for ticket 08)

Date: 2026-11-04 · Ticket 08.

`PROJECT(1).md` §1 makes a measured-footprint claim and §9 fixes the asset contract, but neither says
*how* the measurement is taken: how many samples, what central value, which device class, whose byte
count, which clock, and what makes a run invalid. Every one of those choices moves a published number,
so they are pinned here **before** the numbers are published, in the same role `DECISIONS/0006` plays
for τ and `DECISIONS/0011` for the validation conditions. ADR-002 withdrew the "~4.3 MB complete OCR
pipeline" claim and instructed that only measured numbers be published; this record defines "measured".

The artifact of record is `benchmarks/results/footprint.json`, re-derivable with
`node benchmarks/scripts/measure-footprint.mjs`, with the README table generated from it by
`benchmarks/scripts/render-footprint-table.mjs` and checked by `pnpm verify:footprint`. Nothing below
is a number to quote from this file — quote the artifact.

---

## F1 — What deployment is measured, and what it is not

**The §9 M1 inference harness page (`harness/index.html` + `harness/dist/main.js`), served same-origin
by `harness/serve.mjs`. Not the PWA.**

This is the only browser deployment that exists: tickets 10a (PWA shell/G1) and 10 do not exist yet.
The consequence has to travel with the numbers, so the artifact carries it on itself:

- `measurement.deployment.scope: "core runtime + harness wrapper; PWA not built"`
- `measurement.deployment.remeasureRequiredAfter: "tickets 10a, 10"`
- `measurement.deployment.harnessOnlyBytes` — the harness wrapper's byte share, reported as
  **not separable in the current bundle** because `harness/dist/main.js` is one esbuild output that
  combines `harness/src/main.ts`, `packages/core/dist` and the onnxruntime-web JS glue. The one
  harness-authored file that *is* separable is `harness/index.html`, and it is reported by name and
  size. A PWA build replaces both, so the harness bundle's total is **not** the eventual PWA's total.

Without those three fields a future reader cannot tell whether 21.30 MB is the product's download or
the scaffold's, and would be entitled to read a scaffold measurement as a product claim — the exact
failure mode ADR-002 exists to end.

## F2 — Sample size, and the central value that is publishable at that size

**n = 5 per phase per class. Publish the median with min and max and `n`; publish no percentile.**

Each sample is a fresh `BrowserContext` against a fresh server instance, so the samples are
independent rather than five looks at one warm process. Five is what the ticket's ~22 h covers at
roughly ten seconds of inference per sample across two classes, and it is enough to show a spread but
not enough to estimate a tail: at n=5 the 95th percentile is the maximum, so quoting it as a
percentile would dress the max up as a distribution. Min and max are published as exactly what they
are.

Byte totals are deterministic (same assets, same origin, identity encoding), so n=5 buys reproducibility
there, not statistics: the artifact asserts the per-asset bytes are identical across all cold samples
and fails otherwise. For latency the median is the published value and the spread is reported beside
it.

## F3 — Throttle convention

**The slow class is `Emulation.setCPUThrottlingRate` at 4× on the same machine — the Lighthouse
slow-4× convention.** No network throttling, no memory limit, no GPU emulation.

4× is chosen because it is the rate Lighthouse's mobile preset uses and because it is a *single*
declared multiplier, so a reader can compare it to any other slow-4× measurement. It is not chosen
because it resembles a particular phone: it slows script execution, WASM compile and inference, and
says nothing about a phone's memory, thermals, GPU or network stack.

This must be repeated wherever the table is published, not only in the artifact — the README block
carries it verbatim: *"Slow class is 4× Emulation.setCPUThrottlingRate on the same machine (Lighthouse
slow-4× convention). This is a declared emulation, not a representative phone measurement. Mobile
hardware latency will be higher."* A number from this class may never be described as a phone
measurement.

## F4 — Declared device classes

Two, both this machine and both this browser build:

| id | what it is |
|---|---|
| `desktop-chromium-unthrottled` | physical desktop, native CPU, loopback origin, no network emulation |
| `desktop-chromium-cpu4x` | the same machine with the 4× CPU emulation of F3 |

No third class is invented. A "low-end phone" class without a low-end phone is a guess with a table
around it, which is what this ticket exists to remove.

## F5 — Whose byte count, and why not resource timings

**Bytes are summed from the origin's own request log (`server.requests` in `harness/serve.mjs`), not
from `PerformanceResourceTiming`.**

The page cannot see everything it causes: WebAssembly and worker loads are requested outside the
measured document's resource timings, and `transferSize` mixes response headers into a body count. The
origin sees every request it answers, with status and body length, including the three conditional
re-fetches of the runtime loader that the threaded build makes (one per worker) — visible in the
artifact as `conditionalFetchesPerColdVisit`.

The page-observed totals are still recorded, as a cross-check and to publish the header cost:
`coldHeaderOverheadBytesPageObserved` / `warmHeaderOverheadBytesPageObserved` are `transferSize` minus
counted body bytes. They are reported, never added to a footprint total.

Serving is identity-encoded, so wire bytes equal file bytes; that is recorded in
`measurement.deployment.contentEncoding`.

## F6 — Time anchor

**`performance.timeOrigin` of the measured document.** Latency is computed inside the page, from the
navigation start, so the driver's round-trips are not silently part of a published number.

- `appReadyMs` — page plus script, before any model byte moves. It is the instant the page was handed
  to the driver to attach the image, so it carries one Playwright round-trip; that round-trip is
  reported separately as `harnessLatencyMs` rather than hidden.
- `ocrReadyMs` = `appReadyMs` + `modelLoadMs` — manifest fetched, models downloaded and verified, WASM
  compiled, both sessions created.
- `firstResultMs` = navigation start to result, so it includes decode, detection, recognition,
  `parse()` and `validate()`.
- The **repeat** phase has no navigation: it is the duration from handing over the second receipt to
  the result, with everything already in memory. It therefore publishes no `appReadyMs` and no
  `ocrReadyMs`, and its row is marked supplementary (F8).

## F7 — Byte definition

**Wire body bytes of the response, per asset, summed; HTTP request and response headers excluded.**

Headers are excluded because they are not app footprint the developer controls and they vary with
cookie and UA state. Their measured cost is published beside the totals (F5) so the exclusion is
visible rather than convenient. Also excluded, and listed in
`measurement.excludedFromFootprint`: the receipt image (user data, never a network request) and
anything a service worker would cache (there is no service worker yet — ticket 17).

"Cache" in this artifact means the browser's HTTP cache. `totals.retainedCacheBytes` is the sum of
assets answered `304` on the warm visit; it is not a claim about IndexedDB, the Cache API, or anything
ticket 17 will add.

## F8 — Phases, and which are required

| phase | required | definition |
|---|---|---|
| `cold` | **yes** | first visit, empty cache, fresh context and fresh server |
| `warm` | **yes** | same context, `page.reload()`, ETag revalidation |
| `repeat` | no | supplementary — second inference in the same page, sessions warm |

`measurement.phases.<phase>.required` carries this, and the artifact's latency rows carry the same
labels. Cold and warm are the claim; repeat is a diagnostic for "what does the second receipt in a
session cost", and it must never be published as if the spec required three phases.

## F9 — Fail-loud conditions

A run that violates any of these writes no results. The measurement is allowed to discover facts; it
is not allowed to publish a table with a silent hole in it.

1. A cold visit does not receive `200` for the first use of any URL — the context was not empty.
2. A warm visit re-downloads an asset **outside the declared non-retainable set** (F10). *This is the
   amended form of the original "warm with full body" condition — see F10.*
3. A warm visit revalidates nothing and reads no cache — "warm" would be a fiction.
4. Any `200` carries zero body bytes — server or browser is lying about the cache.
5. The repeat phase issues any request at all.
6. Any response status is `>= 400`.
7. A response body did not complete (`writableFinished` false) — an interrupted download may not be
   summed as a completed one.
8. A run yields zero lines or zero words — footprint numbers from a run that read nothing are
   meaningless.
9. Requests arrive from more than one origin (§9: same-origin only, no third-party CDN).
10. Bytes served for a committed model asset differ from the manifest's pinned `bytes` (and the render
    check re-hashes them).
11. A required row is missing, or an asset was fetched in fewer than all cold samples — an intermittent
    asset cannot carry a published total.
12. Per-asset bytes differ between cold samples — there is nothing reproducible about that.
13. An asset declared non-retainable is now retained — the declaration is stale, so re-measure and
    update this record rather than publishing a finding that is no longer true.
14. `pnpm verify:footprint`: README drift, a missing or non-byte-identical archive, a committed asset
    whose size or SHA-256 moved, a manifest hash that no longer matches the measured one, or a
    provider-reported asset sum that no longer matches the table.

## F10 — The one measured exception: the warm visit is not zero bytes, and cannot be

The approved plan for this ticket asserted "warm with full body ⇒ fail", with the expectation that a
warm visit costs zero bodies. **The measurement contradicts that expectation, and the contradiction is
a property of the browser, not of the harness.** It is recorded here so no future session reads the
artifact as a failed run, or "fixes" the numbers to match the plan.

Measured, in every one of the 10 warm samples (5 per class):

- **7 of 8 assets answer `304`** — page, app script, manifest, both models, dictionary, runtime loader.
  `totals.retainedCacheBytes` = 6,450,237 B.
- **`/ort/ort-wasm-simd-threaded.wasm` answers `200` with its full 14,848,852 B body**, every time.
  That single binary is 69.7% of the 21,299,089 B first visit, and it is larger than all three model
  files together (6,277,292 B).
- The re-download is not a too-small-cache artifact: the browser runs with a 512 MB disk cache
  (`environment.browser.launchArgs`), far larger than any real profile.

A direct probe isolated the cause: the same server, same headers and same browser retain a 6 MiB entity
and revalidate it (`304`), but do **not** retain an 8 MiB entity, which is re-fetched in full
(session-measured probe, not committed). The runtime WASM is 14.85 MB, roughly twice that ceiling, so
no response header can make this deployment warm-cache it. Chromium's HTTP cache has an entity-size
limit; `cache-control` cannot override it.

Nothing in `serve.mjs` is wrong: `cache-control: no-cache` + `ETag` is what a content-hashed deployment
would also send, and every asset under the limit revalidates correctly. The honest options are (a)
publish the finding — this is a per-visit cost until something other than the HTTP cache holds the
binary, which is exactly what ticket 17's service-worker model cache has to prove it does — or (b) hold
the table back. This record takes (a) and flags it: **the warm figure is a published finding, not zero,
and ticket 17's acceptance now has a concrete bar (a warm visit must move 0 bytes).**

The fail-loud condition is therefore 2/F10 rather than "zero bodies": full re-download of an asset
outside this declared set still fails the run, and the declared set is re-checked on every run.

## F11 — Re-measurement triggers

The artifact ages. It must be regenerated when any of these happens:

1. **The PWA exists** — tickets 10a and 10. New entry, new bundle, new cache behaviour; the current
   numbers are the harness's and the artifact says so in `deployment.scope`.
2. **The model tier changes** — ADR-002's swap procedure (§9): a tier swap changes bytes, so the
   measurement is part of the swap, not a follow-up.
3. **The browser has a major version bump and the artifact is older than 90 days.** The cache-status
   classification is browser behaviour, and F10 shows browser behaviour is load-bearing here. A
   browser change that starts retaining the WASM will trip condition 13 and force this.
4. Any change to the ORT version (lockfile), the app bundle, or `serve.mjs`'s caching contract.

`pnpm verify:footprint` already fails on (2)/(4) for committed assets, the manifest hash and the
lockfile-pinned runtime bytes; (1) and (3) are human triggers recorded here.

## F12 — ORT WASM exceeds Chromium's HTTP cache per-entity limit (pinned after owner approval)

The 14,848,852 B `ort-wasm-simd-threaded.wasm` **cannot be held in the HTTP cache**: it re-fetches as
`200` with full body on every warm visit. This is browser behaviour, not a harness bug, and it is not
fixable with response headers — `cache-control: no-cache` + `ETag` already revalidates every other
asset correctly, and the probe bracket (6 MiB retained / 8 MiB not) is a size limit rather than a
misconfiguration. **Ticket 17's Cache API is the remedy. Do not attempt header fixes.**

The warm exception set in `measure-footprint.mjs` is the drift guard for this pin: when ticket 17
lands and the WASM is served from the Cache API, the exception set will fail (condition 13) and must
be removed with a fresh measurement — the failure is the signal, not a bug.

This is published as a finding, not buried: `footprint.json` carries it in `findings[]`
(`warm_not_zero_ort_wasm_exceeds_cache_entity_limit`) so a future reader of the artifact cannot miss
it, and the README states the 21.3 MB / 14.8 MB pair plainly.

## What this record does not decide

- **The PWA's footprint.** Not measured, not extrapolated. `deployment.scope` says so.
- **Peak memory.** The WASM heap, decoded image buffers and both inference graphs are resident after
  load and are not sized here (`measurement.notMeasured`).
- **Network cost on a real link.** Loopback only; bytes are published per asset so RTT and bandwidth
  can be applied by a reader, but no real-link latency is claimed.
- **Tiny vs Small accuracy, quantized builds, lazy model loading.** 09b and the R2 contingencies.
- **Whether the ticket's "~22 h" estimate was right.** It is a planning hint, not a measurement.
