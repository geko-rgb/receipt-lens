# DECISIONS/0028 — Footprint re-derivation: moving the measured deployment from the harness to the PWA (the Tier-3 pins for ticket 17b)

Date: 2026-11-06 · Ticket 17b (pins) · **Status: binding for ticket 17b's implementation.**

`DECISIONS/0012` F1 pinned the published footprint to *the §9 M1 harness, not the PWA*, and put that
sentence on the artifact's face (`deployment.scope: "core runtime + harness wrapper; PWA not built"`) so a
reader could never mistake scaffold bytes for product bytes. F11 trigger 1 is the same rule read forward:
**the measurement expires when the PWA exists.** Tickets 10a, 10 and 17 have merged, so the trigger has
fired, and the artifact still says `PWA not built` while `packages/pwa/dist/app/sw.js` exists.

Ticket 17 ran out of session and took `DECISIONS/0027` W14.3's escape hatch honestly (W14.4): it shipped
the worker and measured the one headline number separately — `benchmarks/results/warm-bytes.json`,
median **6,527 B** per warm visit — and explicitly left the table wholesale to this ticket. This record is
the pin set for that move. ADR-002 withdrew the "~4.3 MB complete OCR pipeline" claim and required that
only *measured* numbers be published; `DECISIONS/0012` defines "measured"; W14–W17 define what changes when
the measured thing gains a service worker. Nothing below invents a number, and nothing below is quotable —
quote `benchmarks/results/footprint.json`.

**Verified before pinning (2026-11-06, on `main` at `c38dd65`):** `node benchmarks/scripts/measure-warm-bytes.mjs
--check` re-derives **median warm visit 6527 B over the wire**, exit 0. The number has not drifted since
ticket 17 measured it, so pin T3's cross-check has a live baseline rather than a remembered one.

---

## T1 — Deployment identity

`measurement.deployment` becomes, verbatim:

- `entry`: **`packages/pwa/dist/app/index.html`** — the built PWA shell. Not `harness/index.html`; the
  harness stops being measured by anything in this artifact.
- `scope`: **`PWA`**. The word that replaces "PWA not built". Concretely, "the PWA" in this artifact means:
  the Vite build output in `packages/pwa/dist/app`, served by `scripts/serve-measure-app.mjs`, with the
  emitted service worker installed and controlling, visited at **`/capture`** in a fresh browser context.
- `remeasureRequiredAfter`: the harness sentence ("tickets 10a, 10") is **discharged** and replaced by the
  date of this measurement, per W14.2.
- `servedBy`: `scripts/serve-measure-app.mjs` — one same-origin HTTP/1.1 origin on 127.0.0.1,
  `cache-control: no-store`, and *no* `ETag`. This matters for T5: that origin never answers `304`, so
  every F9 condition that was written against a 304/200 distinction has to be re-derived.
- `threads`: see T9. Byte counting stays at the origin (0012 F5) — W14.2 says so explicitly, and it is what
  makes the warm claim checkable rather than asserted.

`ROLES` is re-keyed to the emitted names (W14.2), matched by pattern because the hashes move with the
build: `/assets/index-*.js` (entry), `/assets/index-*.css`, `/assets/ort.wasm.bundle.min-*.js` (runtime
JS loader), `/assets/ort-wasm-simd-threaded-*.wasm` (runtime WASM), `/assets/rolldown-runtime-*.js`,
`/assets/cache-names-*.js` (the worker's own module), `/assets/models/*` (manifest, det, rec, dictionary),
`/sw.js`, `/manifest.webmanifest`, `/icons/*`, and the navigation row for `/capture`. The harness rows
`/dist/main.js` and `/ort/…` are deleted, not renamed.

**New condition, because patterns can go stale:** every asset the cold visit serves must match a `ROLES`
pattern. An uncatalogued path fails the run. The harness run happened to catalogue all eight of its assets;
a PWA cold visit serves roughly 22 (the navigation, the 11 precached shell entries the worker fetches with
`cache: "reload"` at install, its own module import, four model assets, `sw.js`), and a table with a
mysteriously-named row in it is not "measured footprint" — it is a guess with a table around it.

## T2 — What "cold" is, and the exact stop condition

**Cold = fresh browser context + fresh server instance + first navigation to `/capture` + wait for the
observable ready signal + run one inference to completion.** The origin's log window opens *before* the
navigation (F5's rule: the page and its script are part of what a cold visit downloads) and closes when the
inference's result has rendered.

The stop condition is **the W5 step-6 pointer**, not a timing metric: `caches.open("receipt-lens-active-model-cache")`
matching `"/active"` returns a hit. That is the same signal `measure-warm-bytes.mjs:80` already uses, and for
the same reason W14.4 states — *"ready is the pointer naming a verified set, not a flag"*: the shell is
precached, the model set is downloaded and hash-verified, and a smoke inference has run against it. Timeout
240 s, polling 250 ms, no silent fallback: a cold sample that never reaches the pointer writes no results.

**Correction this record has to make, in the brief itself and in `DECISIONS/0027` W15:** the session brief
pinned cold as "wait for `appReadyMs` + wait for `ocrReadyMs`". On the PWA there is no `ocrReadyMs` to wait
for — the app has no test-only timing hook, and ticket 17 refused to add one to the shipped bundle (W15,
following `DECISIONS/0023` S1). So cold readiness is proven by the pointer above (an observation of the
deployment) and `ocrReadyMs` is published as not separable (T4). The brief's "post-17 warm visit is
measured after an inference, not before" point is correct and is kept: with W2.1's capture-time model
trigger, the cold window necessarily ends after one real inference.

## T3 — What "warm" is, and the cross-check that decides which driver is right

**Warm = same browser context, `page.reload()` to `/capture` after the worker has claimed the page.** The
origin log is cleared immediately before the reload and read after the warm run's settle window, so the
warm total is one reload plus one inference and nothing else.

**The cross-check: the warm total must equal `warm-bytes.json`'s `samples.median` (6,527 B) exactly, ±0.**
Both drivers count bytes at the same origin with the same F5 rule, so if they disagree, one of them is
measuring something other than what it claims. The resolution rule is not optional and not negotiable in
the implementation:

1. `measure-footprint.mjs` reads the committed `warm-bytes.json` and compares medians.
2. If they differ, it **fails the run and prints the delta and the per-path diff of both windows**.
3. It **never** writes `warm-bytes.json`, and 17b never edits that file. `measure-warm-bytes.mjs` is the
   only writer of that artifact, and the brief is explicit that 17b is not a re-measurement of it.
4. The disagreement is reported at a checkpoint before anything else in the ticket lands.

If the two numbers legitimately diverge because 17b's warm window contains an inference and 17's does not,
that is a finding about the protocol, not a nuisance to be tuned away — and the honest fix is to make the
windows identical or to declare the difference in both artifacts, in a record, not to pick the smaller
number.

## T4 — Latency: two stop conditions, and what becomes unreportable

Anchored on `performance.timeOrigin` of the measured navigation (0012 F6), measured **page-side**, so no
Playwright round-trip hides inside a published number. Both numbers are taken by a `waitForFunction`
predicate that *returns `performance.now()` when its condition holds* — the old driver's
`page.evaluate`-and-poll pattern is what the harness comments warn about, and the value has to be the
instant the condition was observed in the page, not the instant the driver got around to asking.

- **`appReadyMs`** — navigation start → the `load` event (`PerformanceNavigationTiming.loadEventEnd`), per
  W15 ("`appReadyMs` survives as the `load` event"). This is the honest proxy for "the app can accept a
  file": at `load`, the shell's chunks are parsed and the capture view is mounted.
- **`firstResultMs`** — navigation start → `document.querySelector('[data-testid="draft-review"]')` exists.
  That DOM node is what `capture.spec.ts` already treats as the proof that a draft was produced, and W15
  pins exactly this: *"timed from `performance.timeOrigin` of the navigation to the DOM state that proves a
  draft was produced, driven through the real capture UI as `capture.spec.ts` already does."* Driving it
  means `page.getByTestId("file-input").setInputFiles({name, mimeType: "image/png", buffer})` — the same
  canvas-drawn receipt `capture.spec.ts` uses, so no receipt bytes are committed.

With W2.1's capture-time trigger, `firstResultMs` on a cold device **includes the model download**, because
the download happens between the navigation and the draft. That is the honest number. The "models already
downloaded" variant is not published; if it is ever published it gets its own named column and its own
sentence, which is what T9 does for thread count.

**Becoming not separable — three fields, not two.** W15 pinned `ocrReadyMs` and `modelLoadMs` as not
separable. The same grep that proves the absence of a hook proves one more: there is no `inferenceMs`,
`elapsed`, `durationMs` or `timings` anywhere in `packages/pwa/src` — the app surfaces no OCR duration to
the DOM at all. So `inferenceMs` joins them. All four are published as `n: 0` with `median: null` and a
`reason`, the reason text living where F1 put the harness-bundle caveat
(`measurement.deployment.notSeparable`), and `render-footprint-table.mjs` prints **"not separable"** in the
cell. `firstResultMs` and `appReadyMs` remain measured. A number that cannot be separated is reported as
unseparable, per W15 — quietly carrying it over from the harness deployment is the exact dishonesty this
ticket exists to remove.

The **repeat** phase stays supplementary (0012 F8) and keeps F9 condition 5 unchanged: a second receipt in
the same page must issue zero origin requests. It is a legitimate risk that W2.1's probe fires anyway; if it
does, the run fails, the delta is reported, and the finding gets recorded in a record rather than
pre-legislated out of the condition set.

## T5 — F9's fail-loud set, amended for a worker-served warm visit

`DECISIONS/0012` F9 has fourteen conditions written for a deployment with no worker. Per W15, three change,
one is the designed trigger, and one is new. Amended in place:

| # | pre-17 (harness) | post-17b (PWA) |
|---|---|---|
| 1 | cold must get `200` for the first use of any URL | **unchanged in intent, re-expressed**: for every asset in the cold sample's origin log the status is `200` with a non-zero body. A worker-served asset that the origin never logged is not a zero-body 200 — it is no origin response. |
| 2 | warm re-downloads an asset **outside `NOT_RETAINABLE`** ⇒ fail | **the exception set is gone** (T6). Any warm origin request for a path the worker could have served — every `.wasm`, every model asset, every shell asset except `sw.js` and the worker's own module chunk, which a service worker structurally cannot intercept (T7) — fails with the reason named. |
| 3 | warm revalidates nothing **and reads no cache** ⇒ fail | **inverted.** Under a worker the origin may legitimately see three requests and no 304s. The pass condition is now: **no network request served the body** — the asset is absent from the warm origin log *and* `transferSize === 0` page-side for those resources. The old failure condition is the new pass condition, which is why W15 demands it be recorded here rather than slipped into a script edit. |
| 4 | any `200` carries zero body bytes ⇒ fail | re-expressed with 1: a `200` in the origin log with `bodyBytes === 0` still fails. A cache hit is not a logged response. |
| 9 | more than one origin ⇒ fail | **unchanged.** |
| 11 | required row missing, or fetched in fewer than all cold samples ⇒ fail | **unchanged**, plus T1's new uncatalogued-asset condition. |
| 13 | an asset declared non-retainable is now retained ⇒ fail | **deleted with the declaration.** F12 designed this to break; breaking it is ticket 17b arriving. |
| new | — | **`sw_not_controlling_at_warm`**: the worker must be in `navigator.serviceWorker.controller` state *before* the warm log window opens. Otherwise the warm number measures pre-17 behaviour and is not a PWA number at all. Fails with its own message. |
| new | — | **`warm_cross_check_disagrees`**: T3's ±0 rule. |
| new | — | **`cold_pointer_never_ready`**: T2's 240 s stop condition. |

Conditions 5–8, 10 and 12 (repeat requests, `>= 400`, incomplete body, zero lines/words, manifest byte
mismatch, per-asset instability across cold samples) carry over unchanged, except that "zero lines or words"
is now read from the DOM state rather than a hook: a warm/cold run that renders `draft-review` with
`zero-items-state` in it produced no usable parse and fails, exactly as a harness run returning 0 words did.

`serve-measure-app.mjs`'s log entries gain the `completed` flag (`res.writableFinished`) so F9 condition 7
survives the move: W17 allows this file an opt-in request log "in the shape F5 needs", and today it lacks
the one field a completeness check needs. Additive, default behaviour byte-identical, no header change.

## T6 — `NOT_RETAINABLE` is deleted *in the commit that moves the deployment*, never before

W14.4's amendment is the whole point: on the harness the declaration is **still true** — the harness has no
worker, and there the WASM still moves 14,848,852 B per warm visit — so deleting the set while
`measure-footprint.mjs` measured the harness would fire condition 13 as a false alarm, and keeping it after
the move makes the drift guard decorative. 17b does both halves at once: the deployment moves and the set
disappears in the same commit. **Grep for `NOT_RETAINABLE` in `benchmarks/scripts/` must return zero
occurrences when 17b lands** — that is a pinned test, not a review habit.

## T7 — The ETag defect: what 17b does not do, and why that is a decision

The ticket file's inherited defect and W17.3 both point at the fix: a service worker never intercepts its
own script's imports, and `serve-measure-app.mjs` answers code assets with `cache-control: no-store`, so the
worker re-fetches its **955 B** module chunk on every instantiation — one of the three line items in the
6,527 B warm visit. W17.3 calls it "17b's first item".

**17b does not change the header.** Reasons, in order of weight:

1. It would move the published warm number from 6,527 B to roughly 5,572 B, and T3 pins the two drivers to
   agree at exactly the committed `warm-bytes.json` median. A ticket whose own brief says warm-bytes is
   "already correct and does not need re-measuring" cannot silently invalidate it.
2. It changes the *shipping product's* response headers. The brief scopes 17b as "not a change to the PWA,
   service worker, or model tier", and F12/W17's own rule — "a header change made to move a published
   number is the class of fix F12 warns against" — applies here in the strictest form: the only observable
   effect of the change would be that the headline number gets smaller.
3. `DECISIONS/0012` F3's one-variable-at-a-time principle: 17b's variable is the measured deployment.
   Adding a server-header variable to the same commit makes the pre/post delta unattributable, which is
   precisely the error W14.1's archive and T9's thread-count sentence exist to prevent.

What 17b does instead: the 955 B line item is **declared in the artifact with its reason**, the defect is
recorded as an open finding in `findings[]` (`warm_worker_module_chunk_refetched`, `resolvedBy: null`), and
the fix moves to a ticket whose whole subject is the header — **17c**. Because that fix changes what both
drivers measure, 17c is pinned to regenerate `footprint.json` **and** `warm-bytes.json` in one commit, and
to restate T3's cross-check against the new number in the same commit. A header change and the two
measurements it moves must never land separately.

**Ruled at checkpoint 1 (2026-11-06), and it sharpens the escape hatch rather than following it.** The
hatch in W14.3 and the brief split the work as *17b = bytes, 17c = latency*. The working split is
**17b = the whole re-derivation (bytes *and* latency, both against the current shipping deployment) and 17c
= the `ETag` server change plus the regeneration of the two artifacts it moves.** That is the better cut for
one reason: the header change is a change to what users receive, and 17b is a change to what is measured.
Only measurement belongs in the measurement ticket. 17c is opened at
`.scratch/receipt-lens-v1/issues/17c-etag-code-assets.md` with this condition written into it.

## T8 — The artifact's findings, and `verify:footprint` surviving the move

- `findings[]` keeps `warm_not_zero_ort_wasm_exceeds_cache_entity_limit` with `detail`, `evidence`, `remedy`
  and `affectsClaim` verbatim as ticket 08 published them, and gains W16's
  `resolvedBy: "ticket 17"`, `resolvedAt`, and the one-line resolution (the worker precaches the runtime
  WASM into the Cache API, which is not subject to the HTTP-cache per-entity limit; this artifact's warm
  visit no longer lists it). **The entry stays** because F10's 6 MiB-retained / 8 MiB-not probe is a
  property of Chromium's HTTP cache that ticket 17 did not change; deleting it would delete the reason the
  caches are shaped the way W2 shapes them.
- `findings[]` adds `warm_visit_served_by_service_worker`, *measured* (W16): the warm bytes over the wire,
  and which requests still reached the origin, generated from this run's `runs[]` rather than typed.
- `findings[]` adds T7's open `warm_worker_module_chunk_refetched`.
- `totals.secondVisitBytesOverTheWire.median` = 6,527 B, from this run. `retainedCacheBytes` is redefined —
  F7 defined it as "assets answered 304 on the warm visit", and a `no-store` origin answers no 304s — so the
  field becomes `cacheHeldBytes`: bytes held by the active caches, derived from the precache manifest plus
  the verified model set, with F7's HTTP-cache sentence amended in place in `DECISIONS/0012`. A field that
  silently reads 0 because the mechanism changed would be the loudest possible understatement.
- The harness artifact needs **no new archive copy**: `footprint.json` on `main` was measured at
  `2026-11-04T06:25:09.912Z` at revision `16ae8de`, and `benchmarks/results/footprint-2026-11-04-16ae8de.json`
  is already byte-identical to it (`cmp`, 2026-11-06). W14.1's obligation is discharged by ticket 08's own
  archiving; 17b keeps that file, and the driver's existing dated-archive write produces this run's copy
  automatically. **Closed question: nobody is to re-open it.** A pre-17b session that "notices" the archive
  step is missing will duplicate a committed file and break `verify:footprint`'s byte-identical rule.
- **Discovered while pinning (2026-11-06), and it is 17b's to fix:**
  `measure-warm-bytes.mjs`'s `previousWarmBytes()` reads the **canonical** `footprint.json` for its `before`
  block — `totals.secondVisitBytesOverTheWire.median`, `totals.assetsRedownloadedOnEveryVisit`,
  `findings[].resolvedBy` and `measurement.deployment.entry`. Every one of those four fields changes when
  17b regenerates the table. The artifact would then say ticket 17 reduced warm bytes from **6,527 B to
  6,527 B**, a **1.0×** reduction, with an empty `redownloadedOnEveryVisit` list, `resolvedBy: "ticket 17"`
  as the *before* state, and a hard-coded label calling the file "ticket 08, harness deployment" when it is
  the PWA's own measurement. Nothing fails: `verify:warm-bytes` only compares `samples.median`, so the
  corruption surfaces the next time anyone regenerates that artifact — which is the worst possible time,
  because it will look like ticket 17's fix had never happened. **Pin: 17b points the baseline at the
  archived harness artifact** (`footprint-2026-11-04-16ae8de.json`), so `before` keeps naming the deployment
  it is actually comparing against, and `warm-bytes.json`'s published 6,527 B and 2,275× do not move. This
  is a *source of a number* fix, not a re-measurement, which keeps it inside 17b's scope; the measured number
  itself is untouched and `measure-warm-bytes.mjs` remains the only writer of that artifact.
- **`pnpm verify:footprint` survives, and only its inputs change.** It remains `render-footprint-table.mjs
  --check`: regenerate the README block from `footprint.json`, fail on drift, re-stat and re-hash every
  committed asset, re-hash the manifest, and require the dated archive to be byte-identical. The renderer
  itself must be rewritten, because it is currently harness-shaped: it dereferences
  `deployment.harnessOnlyBytes` (which no longer exists), labels the cache column with 304 semantics a
  `no-store` origin never produces, prints "no service worker yet (§9 cache keying is ticket 17)" as a
  present-tense claim, and emits the paragraph beginning "Ticket 17's service-worker Cache API is expected
  to reduce second-visit bytes to zero" — the exact sentence W16 says this ticket retires. It also has to
  render T4's "not separable" cells and W14's generated thread-count sentence.
- Two additions to the check, because the check is what makes regeneration a deliverable rather than a
  habit: the README block must contain no harness-deployment text (`PWA not built`, `harness/index.html`,
  `/dist/main.js`, `/ort/`), and `footprint.json`'s warm median must equal `warm-bytes.json`'s.

## T9 — Device classes are unchanged; the thread count is not

The classes stay exactly F4's two, and F3's convention is untouched: `desktop-chromium-unthrottled` and
`desktop-chromium-cpu4x`, `Emulation.setCPUThrottlingRate` at 4× on the same machine, no network throttling,
no invented phone class, and the Lighthouse slow-4× caveat carried verbatim wherever the table is published.

Threading is a different matter and it is published, not footnoted (W14's checkpoint-1 ruling, W20). The
PWA origin sends no COOP/COEP, so `crossOriginIsolated` is false and `resolveThreadCount`
(`packages/core/src/ocr/pp-ocrv6.ts:77`) returns **1**, where the harness ran 4 under isolation. The
generated table's declared-conditions block must carry this sentence, emitted from
`measurement.deployment.threads` so nobody hand-writes it:

> Latency measured at 1 ORT thread (`serve-app.mjs` sends no COOP/COEP; the harness's 4-thread measurement
> is superseded). If isolation headers are added, latency improves and the footprint table regenerates.

A reader comparing pre-17 and post-17 latency must be able to see the two are apples-to-oranges on thread
count and *not* on the fix. **Adding COOP/COEP is a scope change and 17b does not make it** — it would move
every latency number in the table in the same commit as the deployment move, which is T7's argument one
layer down.

## T10 — 17b blocks 18, and the sequence is not negotiable

**Ticket 18 cannot write README claims until 17b's footprint table is regenerated against the PWA
deployment.** Ticket 18's per-claim evidence requirement asks each published claim to be traceable to a
committed measurement of the deployment users actually receive. While the table describes the harness, every
claim it would cite cites scaffold bytes — and the ordering was already corrected at ticket 17's checkpoint
3 for exactly that reason. This sentence is restated here so a future session does not have to rediscover
it from two records and a HANDOFF paragraph.

## Escape hatch, restated as a discipline

If the latency driver is clearly past two hours and not converging, 17b ships **byte accuracy and defers
latency**: `footprint.json` regenerated with cold and warm bytes against the PWA, `NOT_RETAINABLE` deleted,
F12's finding closed with `resolvedBy`, README byte rows regenerated, and latency rows published as
`measured pre-17 against a superseded deployment — see ticket 17c` rather than as numbers. `17c` is opened
as a ticket file that blocks 18. **A wrong latency number shipped to hit a deadline is not an escape hatch,
it is the failure mode this whole lineage exists to prevent.** The choice made is reported either way.

## Test surface

`benchmarks/tests/footprint/pins.test.ts` (new dir; `benchmarks/tsconfig.test.json` gains `tests` in its
`include`, mirroring `packages/pwa/tsconfig.test.json`). The fail-loud logic and the deployment identity are
extracted into `benchmarks/scripts/footprint-rules.mjs` so the driver and the tests cannot diverge — a pin
that lives only inside a 20-minute browser run is not a pin. No browser is launched in the unit suite;
`verify:footprint` plus `measure:footprint` remain the CI gate and the measurement, per the brief's "E2E —
none needed".

Pinned: cold-window shape and required rows (T1/T2); warm window with worker controlling and the ±0
cross-check (T3/T5); warm bytes contain no WASM and no model bytes (T5 condition 2); the four
fail-loud messages fire on their fixtures, including `sw_not_controlling_at_warm` and a deliberate
cross-check disagreement; `NOT_RETAINABLE` greps to zero in `benchmarks/scripts/`; the committed
`footprint.json` findings carry `resolvedBy: "ticket 17"` and the new measured finding; `deployment.entry`
and `deployment.scope` name the PWA; the renderer emits no harness text; **and the `warm-bytes` baseline
reads the archived harness artifact, not the canonical `footprint.json` it is about to invalidate** (T8).

## What this record does not decide

- **Peak memory, real-link latency, real devices.** Unchanged from `DECISIONS/0012`.
- **Whether the model tier is still right.** `DECISIONS/0015` and ADR-002 stand; a tier swap re-triggers
  F11 trigger 2 and this measurement with it.
- **The privacy claim's wording.** That is ticket 18's, and T10 is the only thing 17b owes it.
- **Whether `warm-bytes.json` should exist at all after 17b.** It should: it is the artifact that let ticket
  17 take W14.3's hatch without leaving F12's remedy unevidenced, and it stays as the independent second
  measurement of the same number — which is what makes T3's cross-check meaningful rather than circular.
- **Whether 17c fixes the header.** 17b's job is to hand it a measured, honest baseline and a named defect.
- **`docs/adr/0002`'s present-tense sentence about the warm visit.** That ADR records, from ticket 08, that
  "the runtime binary is not held in the HTTP cache at that size, so a warm visit is not free. Both are in
  the table with their measured values." Once 17b regenerates the table, that sentence describes the
  *superseded harness deployment* — the worker holds the binary, so the warm visit is close to free. It is
  reported here rather than edited, because 17b's approved edit surface is `DECISIONS/0012` and
  `DECISIONS/0027`, and an ADR's wording about what is free is ticket 18's claim surface. **Hand it to 18
  with a dated amendment, not a rewrite**: the ADR's own history (withdrawing "~4.3 MB") is evidence and must
  not be quietly improved.
