# DECISIONS/0027 — Service worker, model cache and installability: the Tier-3 pins for ticket 17

Date: 2026-11-05 · Ticket 17 (pins only) · **Status: binding for ticket 17's implementation.**

`PROJECT(1).md` §9 already fixes the *contract* — content-hashed model assets, one generated manifest, the
cache key `receipt-lens-models:<providerVersion>:<manifestHash>`, verified-before-activate, cleanup only
after activation, and a visible "model update pending" state when an update fails. `DECISIONS/0012` F12 fixes
the *reason* this ticket exists: the 14,848,852 B `ort-wasm-simd-threaded.wasm` exceeds Chromium's HTTP-cache
per-entity limit and re-downloads in full on every warm visit, and **"Ticket 17's Cache API is the remedy.
Do not attempt header fixes."** `docs/pwa-design.md` §2 fixes the *shape* ticket 10a recorded, and explicitly
says the ticket implementing it "may revise it — with a record, not silently". This is that record.

What is still open, and therefore pinned below, is every choice the spec and those records leave unstated:
what is precached versus prepared later, who runs the update protocol, how the probe bypasses the cache it
is checking, what happens to the published footprint when the measured deployment gains a worker, and what a
headless browser can and cannot prove about installation.

**Evidence in this record is marked as such.** Three of the pins rest on measurements taken in this session
against a throwaway worker and the real 14.85 MB WASM (W8, W13, W19); those are *session* measurements and
each is discharged by a committed test at checkpoint 3. Everything else is contract, not measurement.

---

## W0 — The pins, in one line each

1. **A hand-written worker.** §2.2's exit clause authorizes replacing `generateSW` with a worker we write —
   that part is pre-authorized and its condition is met. Going further and dropping `vite-plugin-pwa` and
   Workbox entirely is **beyond the clause** and is put to the owner as an explicit scope change (W1.0). No
   pin assertion differs between the two outcomes.
2. **Cache strategy: shell precached on install, model set downloaded on navigation to `/capture`.** The
   runtime WASM is *shell*, not *model* — its identity is its filename, so it needs no verification protocol,
   and the warm-visit-0-bytes claim has to hold whether or not anyone has run OCR. A `/share` recipient never
   downloads a model. (W2, owner ruling 2026-11-05)
3. **Cache names: `receipt-lens-shell-v<digest>` and `receipt-lens-models:<providerVersion>:<manifestHash>`,**
   plus one pointer cache. `v<digest>` is generated from the precache manifest, so a shipped-app change
   cannot be shipped without bumping. (W3)
4. **The page runs the update protocol; the worker only serves.** The smoke inference needs the runtime and
   a canvas, which live in the document, not in the worker. This is also what makes every step unit-testable
   against a mocked `fetch` and a mocked `caches`. (W4)
5. **Eight named steps: probe → download → verify → write candidate → smoke → activate → cleanup → report.**
   Activation is one pointer write. Nothing before it is observable by a reader. (W5)
6. **The probe bypasses the cache with `cache: "reload"`, never with a query string.** The worker honours
   `request.cache === "reload"` on model paths by going to the network *without writing anything*. (W6)
7. **A failed update leaves the old set active and the app working,** with a visible pending state and one
   of five pinned reason codes. A corrupt download that passes its hash still fails here, which is why the
   smoke step is not optional. (W7)
8. **Offline reload works and is proven by a new spec.** Measured in this session: a worker that precached
   the WASM served a reload with every request aborted, and `context.route` saw zero requests because none
   reached the network layer. (W8)
9. **`playwright/offline.spec.ts` stays exactly as it is,** including `serviceWorkers: "block"`; the new
   proof is `playwright/offline-reload.spec.ts`. (W9)
10. **`serviceWorkers: "block"` becomes the Playwright default** and ticket 17's spec opts in per file, so
    the 61 existing tests keep the semantics they were written against. (W19)
11. **Scope `/`, registered by the app,** with a failed or blocked registration treated as an ordinary
    degraded start, never an error state. (W10)
12. **Installability is real and the install banner is dismissed for 7 days,** remembered in `localStorage` —
    the only `localStorage` key the app may ever hold. (W11)
13. **Headless Chromium does not fire `beforeinstallprompt`** (measured this session), so the browser's
    dispatch of it is an explicit, declared gap rather than a test that quietly asserts nothing. (W12)
14. **The footprint re-derivation moves the measured deployment from the harness to the PWA,** which
    `DECISIONS/0012` F11 trigger 1 and the owner ruling of 2026-11-05 already require, and which is the only
    way F12's exception set can ever be removed. (W14)
15. **The warm exception set in `measure-footprint.mjs` is deleted in this ticket,** and F9's condition set is
    amended for a worker-served warm visit — "the origin log is empty" stops being a fail-loud and becomes
    the pass condition. (W15)
16. **The superseded harness numbers are kept as a dated archive copy,** and `findings[]` retains
    `warm_not_zero_ort_wasm_exceeds_cache_entity_limit` with `resolvedBy: "ticket 17"`. (W16)
17. **`serve-app.mjs` gains an opt-in request log and keeps `cache-control: no-store`,** because a Cache-API
    precache against a `no-store` origin was measured this session to store the full 14,848,852 B. (W17)
18. **Durability is requested, not assumed.** The Cache API is exempt from the HTTP cache's per-entity limit;
    it is not exempt from origin quota or eviction. (W18)
19. **Ticket 17 adds no COOP/COEP,** changes no provider contract, no `/share` route, no settlement and no
    model tier; the post-17 latency rows are 1-thread and say so, and the install prompt's browser half is a
    manual check this suite cannot automate. (W20)

### W0.1 Checkpoint-1 rulings (2026-11-05)

Approved, with four rulings and one condition. Where a ruling conflicts with W1–W20 as first written, **the
ruling wins** and the amended text carries it in place.

| | Ruling | Where it lands |
|---|---|---|
| 1 | Model download moves from boot-time to **navigation on `/capture`**, with progressive UI | W2.1, W7.3 |
| 2 | Shell cache name **`v<digest>` approved** — "a counter is a rule a human forgets" | W3 |
| 3 | Full footprint re-derivation **is the deliverable**, with an escape hatch into a recorded `17b` ticket | W14.3 |
| 4 | W20 approved **plus**: the footprint table must name the 1-thread basis explicitly | W14, W20 |
| C | Workbox deviation accepted **conditionally**: quote §2.2's exit clause verbatim, or the deviation is a scope change needing a ruling | W1.0 |

**The condition found something.** Quoted in full at W1.0, the clause authorizes switching `generateSW` →
`injectManifest` — a *custom worker built by `vite-plugin-pwa`, with Workbox still in it*. It does not
authorize dropping Workbox. The checkpoint-1 report collapsed the two and overclaimed; W1.0 now separates
them and puts the remainder to the owner as the scope change it is. No pin assertion differs between the
outcomes.

Also accepted as findings: W12's split disposition for the install prompt, W14's deployment move, and the
baseline correction (pwa 338, not 333 — ticket 16's five A6 non-dependence pins landed after its own
checkpoint 3).

---

## W1 — Tooling: a hand-written worker, no service-worker library

### W1.0 What §2.2 actually authorizes, and what it does not (owner condition, 2026-11-05)

The checkpoint-1 report said this deviation was pre-authorized by `docs/pwa-design.md` §2.2. Quoted verbatim,
the clause reads:

> **intent.** `generateSW` is the right strategy *for the shell*. Ticket 17's model-update protocol — download,
> verify, smoke, activate, then clean up — is `precacheAndRoute`-independent and will most likely need
> `injectManifest` (a custom worker) to express the verification gate, because `generateSW` cannot "keep the
> old set until the new one verifies" for a runtime-downloaded asset. Recommendation: start on `generateSW`
> for the shell precache, and switch to `injectManifest` in ticket 17 if the update protocol cannot be
> expressed on top of it. DECISIONS/0017 D5 is the measurement that makes the choice safe either way.

That is two claims, and only the first was pre-authorized:

- **Authorized, condition met** — switch from `generateSW` to *a worker we write*. The stated condition is "if
  the update protocol cannot be expressed on top of it", and `generateSW` has no hook for "keep the old model
  set until the new one verifies", which is §9's whole contract.
- **Not authorized** — `injectManifest` is a *mode of `vite-plugin-pwa`*, not a departure from it: the plugin
  still builds the worker, still generates the precache manifest, still injects `self.__WB_MANIFEST`, and the
  worker still imports `workbox-*` at runtime. Dropping the plugin and Workbox is **beyond the clause**. The
  checkpoint-1 report collapsed these two into one and thereby overclaimed. This is a scope change, put to the
  owner as one rather than landed silently.

Two properties make the ruling cheap either way. Everything W4–W7 pins lives in the **page**, not the worker,
so the protocol and its tests are identical under `injectManifest` with Workbox. And the single
choice-dependent pin — where the precache list comes from — is isolated behind
`packages/pwa/src/precache.ts`, which returns entries in `self.__WB_MANIFEST`'s own shape: under Workbox they
are fed to `precacheAndRoute`, without it to the worker's own install handler. **No pin assertion changes on
either side of this ruling**; only the worker's body does. What would weaken is W1.1's guard: under
`maximumFileSizeToCacheInBytes` it becomes "assert the WASM is in the generated manifest *and* the ceiling is
above the tier's largest asset" — the same guarantee, with a number to remember instead of a completeness
rule.

The case for the change, in full:

- **Six new packages** (`vite-plugin-pwa`, `workbox-build`, `workbox-core`, `workbox-precaching`,
  `workbox-routing`, `workbox-strategies`) inside a product whose §1 claim is that nothing third-party runs.
  `DECISIONS/0017` D6 checked the plugin's *build-time* behaviour and found no install hooks and no request
  targets in the emitted chunks, and it then said the thing that is still owed: *"a runtime audit is still
  required."* Ticket 18 inherits that audit. Adding the dependency now widens the surface that has to be
  audited, for code that is smaller than the audit.
- **A failure mode that only exists because of the library.** `DECISIONS/0017` D5 and `docs/pwa-design.md`
  §2.2 both spend their detail on `maximumFileSizeToCacheInBytes`: at the default 2 MiB the build fails, and
  raising it to 20 MiB makes the build *silently* drop any asset over the limit — the exact shape of the
  Small-model trap D5 warns about (`rec.onnx` at 21,159,378 B would vanish from the precache while the build
  still passed). A hand-built manifest removes the ceiling and replaces it with a completeness rule (W1.1),
  which fails for the right reason and cannot pass by omitting something.
- **Testability.** §9's protocol is the part worth pinning, and it is expressible as a pure function of
  `(fetch, caches, provider) → state`. That is exactly the shape `packages/pwa/tests/sw/pins.test.ts`
  asserts (W4). Workbox's API is not a seam; it is an implementation.

`vite-plugin-pwa` was never a *decided* dependency — D5's own framing is "this dimension cannot
discriminate", and it was measured only to find the friction. Nothing in W1.0 contradicts a measurement; the
ruling being asked for declines an option that was recommended but not selected. **This is the one place
where ticket 17 goes past `docs/pwa-design.md`, and it is the only one in this record.**

### W1.1 The build emits the precache list, and the build fails if the list is incomplete

`packages/pwa/src/sw.ts` is a second Vite input. A small in-repo plugin in `packages/pwa/vite.config.ts`
replaces a `__RL_PRECACHE_MANIFEST__` placeholder in the emitted worker chunk during `generateBundle`, when
every other asset is already in the bundle map. The list is the set of files written into `dist/app` minus an
explicit exclusion set — `sw.js` itself, `.vite/manifest.json`, and any `*.map`.

The guard is the replacement for the size ceiling, and it is stronger: **after `generateBundle`, if any
file that will be written to `dist/app` is neither in the precache list nor in the named exclusion set, the
build fails, naming the file.** A WASM that cannot be precached cannot be shipped by accident. The
commitment is discharged by `playwright/smoke.spec.ts`, which reads the built worker and asserts that the
hashed `.wasm` emitted under `assets/` appears in its manifest — an artifact check, not a source check, in
the same style as the existing rig-leak and chunk-graph assertions.

D5's ceiling warning still travels, in its honest form: with no ceiling there is no silent drop, but the
*origin quota* grows with the tier, and W18 is what notices. Any model-tier change re-opens this config and
`DECISIONS/0012` F11 trigger 2 remains the moment it gets checked.

---

## W2 — What is precached on install, and what is prepared afterwards

The session brief offered two shapes and recommended the second: precache everything including the WASM, or
precache the shell and lazily cache models on first use. The split turns on one question — is the runtime
WASM *shell* or is it *model*? **This record says it is shell.** Three reasons:

1. **Its identity is its filename.** The build emits `assets/ort-wasm-simd-threaded-<hash>.wasm`; a runtime
   change necessarily changes the name. §9's verify-before-activate contract exists for assets whose URL is
   stable across versions — `PP-OCRv6_tiny_rec.onnx` is the same path at every provider version, which is
   exactly why a hash and a smoke run are required before it may replace what is already working. The WASM
   needs neither: content-hashing is the verification, and `revision: null` is honest for it.
2. **The F12 remedy must hold unconditionally.** Ticket 08's bar is "a warm visit must move 0 bytes". If the
   14.85 MB binary were cached on first OCR, then a user who loads the app and reloads without capturing
   still pays 14.85 MB, and the published number depends on what the tester did beforehand — the kind of
   conditional measurement ADR-002 exists to end. Precaching it makes the claim about the deployment rather
   than about the session.
3. **It is a build output, so it is globbable.** `docs/pwa-design.md` §2.1 measured that the generated
   precache list contains no `.onnx` entry, because model bytes are repo files served at runtime and a glob
   cannot see them. The WASM is in `dist/app`. That difference is the split, and it is the split the design
   note already drew.

### W2.1 The model set downloads on navigation to `/capture` — owner ruling, 2026-11-05

> **Ruled at checkpoint 1.** *"Model set download triggers on navigation to `/capture` (not app boot, not
> first-OCR). The smoke-gate is preserved because the user is framing the receipt during the 2–5 second window
> when the download completes. Progressive UI shows 'preparing OCR — X MB of 6.3 MB' if not yet complete when
> the user triggers capture. If the model is ready by capture time, no delay. If not, the user sees explicit
> progress rather than a hang. App shell + WASM remain precached on install (required for offline reload); only
> the model is deferred."*
>
> The reasoning recorded with it: *"the population that navigates to `/share` (participants viewing a bill) or
> browses the ledger without capturing should never download the model."* That is the answer to the cost this
> record raised against its own boot-time pin, and it names the population — once ticket 16's links are in the
> wild, a recipient who only ever views a share link is the majority of visits, not an edge case.

| Asset class | When | Mechanism |
|---|---|---|
| `index.html`, every emitted `assets/*.js` / `*.css` / `*.wasm`, `manifest.webmanifest`, icons | **install** | precache list from W1.1 |
| `/assets/models/manifest.json` + det + rec + dictionary | **first navigation to `/capture` per document**, and only when no active set matches the probed manifest | the W5 protocol |
| a receipt image | **never** | §10: images are not persisted by default; the worker must not write one (W2.2) |

Consequences of the trigger moving, pinned so they are not discovered later:

- **The smoke gate survives**, because the trigger is *intent to capture* rather than *the capture call*. The
  download and the smoke run start when the user arrives at `/capture`, which is while they are pointing a
  camera or choosing a file — the 2–5 s window the ruling describes. Nothing about W5's eight steps changes;
  only what invokes them.
- **`/share`, `/bills` and `/bill` must never start the download.** A recipient decoding someone's bill has no
  use for 6.3 MB of weights, and a participant's device is the least likely place to want them. Pinned as a
  test, not a promise: navigating the whole route set except `/capture` issues zero model requests.
- **Preparing is not one-shot per document.** Returning from `/bill` to `/capture` after a failed attempt must
  be able to retry, so the trigger is "no in-flight or succeeded attempt for this document", not "fired once".
  A retry while a preparation is already running is a no-op, never a second download.
- **Progressive UI.** The capture view shows the W7.3 `preparing` line with a real byte count — *"Preparing
  OCR — X MB of 6.3 MB"* — and the intake control stays usable: the user can pick a file during preparation
  and the run starts when both the file and the model set are ready. A hang with no number is the failure mode
  this rules out.
- **The `unavailable` state (W13) gets more likely, and more legible.** A fresh install offline that never
  reached `/capture` has no models by design; the app says so in the capture view rather than at boot.

### W2.2 The worker never precaches model bytes, and never caches a receipt image

The precache list is generated from `dist/app`. `assets/models/*` lives outside it, so it cannot leak in.
A test asserts the generated manifest contains no path beginning `/assets/models/` — the absence is checked
in the artifact, not promised in a comment.

Receipt images reach the app as `File`/`Blob` objects and are never fetched by URL, so there is no request to
intercept. The rule that matters is the negative one: the worker's `fetch` handler **never writes a response
into any cache**, so a URL a future capture flow invents cannot silently start holding user data. Every cache
write in this design is an explicit `cache.put` performed by the W4 protocol. Pin: `caches.open` appears in
the worker only for reads and for the W3 pointer lookup.

### W2.3 The lazy OCR boundary is untouched

`DECISIONS/0017` D4's rule and `playwright/smoke.spec.ts`'s chunk-graph assertion survive unchanged. The
worker precaches the runtime chunk and its WASM **as files**; first paint still requests neither. Precaching
is not importing. W19 keeps the existing e2e suite's request walks honest while the worker is blocked there,
and `offline-reload.spec.ts` proves the first-paint claim again with the worker active.

---

## W3 — Cache names, exactly

```text
receipt-lens-shell-v<digest>            app shell: W1.1's precache list
receipt-lens-models:<providerVersion>:<manifestHash>   one verified model set (§9, verbatim)
receipt-lens-active-model-cache         one entry: the pointer to the active model cache name
```

`<digest>` is the first 12 hex characters of the SHA-256 of the precache manifest serialised canonically
— entries sorted by `url`, each as `url` + U+001F + `revision` (`null` for content-hashed build outputs, so
the filename is the revision), joined by U+001E. **Ruled at checkpoint 1: approved** — *"A counter is a rule a
human forgets is correct. Automated digest with no manual step. Approve W3 as pinned."* Two properties, both
deliberate:

- **A shipped-app change cannot be shipped without bumping.** The brief's format was `receipt-lens-shell-v<n>`,
  which reads as a hand-incremented counter; the ruling replaces that reading with a generated digest. A
  counter is a rule a human has to remember, and the failure when it is forgotten is the worst one available:
  users keep running the previous shell with no symptom. A digest bumps itself. If a manual counter is
  reinstated later it is a one-line change in `cache-names.ts`, and W3.1's test still catches a forgotten bump
  — the test compares the built worker's cache name against a digest recomputed from the built manifest.
- **Two caches, so the two update stories never collide** (§9: "never reuse a cache solely because a filename
  or generic URL matches", and `docs/pwa-design.md` §2.3: "a shell update must never orphan a model set, and
  a model update must never look like a shell update"). A new shell version does not touch the pointer or any
  model cache; a new model set does not touch the shell cache.

`<providerVersion>` and `<manifestHash>` come from the served manifest — `providerVersion` from
`manifest.providerVersion`, `manifestHash` as SHA-256 of the manifest bytes exactly as served. That value is
already computed and exposed: `fetchModelManifest` returns `{ manifest, manifestHash }`
(`packages/core/src/ocr/model-manifest.ts:242`) and `PPOCRv6Provider` already builds its `version` from the
same digest (`pp-ocrv6.ts:211`). **The hash in the cache name and the hash in the provider version string are
the same bytes of the same response** — a pin test says so rather than trusting it.

### W3.1 The names are derived in one module, and the prefix rules are closed

`packages/pwa/src/lib/models/cache-names.ts` exports `shellCacheName(entries)`,
`modelCacheName(providerVersion, manifestHash)`, `MODEL_CACHE_PREFIX = "receipt-lens-models:"`,
`SHELL_CACHE_PREFIX = "receipt-lens-shell-v"` and `ACTIVE_MODEL_CACHE`. Nothing else composes a name.

Cleanup matches **prefixes, exactly as declared**, and the pointer cache is named so that it matches neither
(`receipt-lens-active-model-cache` starts with neither `receipt-lens-models:` — hyphen, not colon — nor
`receipt-lens-shell-v`). A test enumerates every declared name against every cleanup predicate and asserts
the pointer survives all of them. That looks paranoid; it is the one place where a plausible-looking prefix
silently deletes the record of which model set is live, which would leave an app that serves no models and
knows neither why nor what it had.

---

## W4 — The page runs the protocol; the worker serves reads

The worker cannot honestly run step 5. A smoke inference needs `onnxruntime-web`, a decoder
(`createImageBitmap` + canvas), and the compiled runtime — all of which exist in the document, and
`browserOcrEnvironment` is the provider's declared environment (`pp-ocrv6.ts:221`). Running the smoke test in
the worker would mean either duplicating that environment or shrinking the smoke test to "the bytes hash
correctly", which is W5's whole purpose. So the split is:

| | page (`packages/pwa/src/lib/models/update.ts`) | worker (`packages/pwa/src/sw.ts`) |
|---|---|---|
| precache shell on install | — | yes |
| probe / download / verify / smoke | **yes** | — |
| write model entries | **yes** (`cache.put` after verification) | never |
| serve shell and model reads | — | **yes** |
| activate (pointer write) and cleanup | **yes** | reads the pointer |

The Cache API is available on `Window`, so the page writes directly; no message round trip and no second
implementation of the same rules on the other side. This is also the only arrangement in which the brief's
test plan is honest — "each step testable with mocked fetch/Cache API" — because the protocol is one
function of injected dependencies:

```ts
prepareModelSet(deps: {
  fetchImpl: FetchLike;              // core's existing seam
  caches: CacheStorageLike;          // mocked in tests, real in the browser
  manifestUrl: string;
  runSmoke: (bytes: VerifiedAssetBytes) => Promise<SmokeOutcome>;
  now: () => number;                 // 0011's determinism rule: no clock inside the module
}): Promise<ModelUpdateState>
```

Core's published seams carry what they can: `fetchModelManifest(url, fetchImpl)` is exported and does the
probe and the structural validation, and `PPOCRv6ProviderOptions.fetch` lets the smoke run be handed the
in-memory verified bytes instead of whatever the worker happens to be serving. `fetchVerifiedAsset` and
`sha256Hex` are **not** on core's public surface, so W5's steps 2–3 are the protocol's own — see the finding
recorded there. **No core contract changes in this ticket** (W20).

The worker's read path:

- `mode === "navigate"` → shell cache, falling back to the cached `/index.html`. **Navigation requests only**
  (W4.1).
- `/assets/models/*` → if `request.cache === "reload"`, go to the network and write nothing (W6); else if the
  pointer resolves to a cache that holds the URL, serve it; else pass through to the network.
- anything else same-origin → shell cache hit, else pass through. The worker never rewrites, never pads, and
  never answers a non-navigation miss with `index.html`.
- cross-origin → pass through untouched. There are none in this app, and ticket 18 is where that gets proven
  rather than asserted.

### W4.1 No HTML fallback for a path that is not a navigation

Serving `index.html` for `/assets/models/manifest.json` because the cache happened to miss would hand
`JSON.parse` a document, and the failure would read as a corrupt manifest. §9's cache-invalidation rules and
`docs/pwa-design.md` §2.3 both want a navigation fallback; the boundary is that it is a fallback for
*navigations*. Pinned as a test: an uncached, network-blocked request for a model asset must fail as a
network error, never as a parsed-JSON error.

---

## W5 — The update protocol, in eight named steps

The order is the contract, and each step is separately falsifiable.

1. **probe** — `fetch(manifestUrl, { cache: "reload" })`, then core's exported `fetchModelManifest`, which
   validates the structure and yields `{ manifest, manifestHash }`. Structural validation is already fail-loud
   there (`model-manifest.ts:parseManifest`), so a truncated or non-JSON manifest stops here with
   `manifest_invalid` and never reaches a download.
   - If `receipt-lens-models:<providerVersion>:<manifestHash>` is already the pointer's value, stop:
     `up-to-date`. No download, no smoke, no writes. This is the once-per-version property W2.1 claims.
2. **download** — `fetchImpl(asset.url)` per asset, body read to an `ArrayBuffer`.
3. **verify** — the protocol's own two checks, in this order: `bytes.byteLength === asset.bytes`, then
   SHA-256 of the body against `asset.sha256`. A truncated body fails on length before the hash is computed;
   a substituted body fails on the hash. `download_incomplete` and `hash_mismatch` name which.

   **Found while writing the stubs, not while writing the pins.** An earlier draft of this step reused core's
   `fetchVerifiedAsset`, which does exactly these two checks. It is **not exported** from
   `packages/core/src/index.ts` — the manifest surface core publishes is `fetchModelManifest` plus types —
   and exporting it would widen `@receipt-lens/core`'s public API (§4's staged surface) in a ticket whose W20
   says the core contract is untouched. The same holds for `sha256Hex`. So the protocol restates the two
   checks against `crypto.subtle`, six lines, and the reason codes come out exact rather than being inferred
   from `fetchVerifiedAsset`'s message text, which would be a string match standing between a corrupt download
   and the word a user reads.
   - The cost is honest and it is a duplication: §9's verification rule now lives in two places. What keeps
     them from drifting is that both are exercised by the same committed manifest — `model-manifest.test.ts`
     already pins core's behaviour over the real bytes, and W5's test below pins the protocol's over the same
     two failure classes. If a future ticket prefers one implementation over two, the change is to export
     core's helper and delete the protocol's copy, and the tests stay valid either way.
   **Verification precedes any write**, so nothing unverified is ever in a cache, and a partial download
   cannot be mistaken for a model set.
4. **write candidate** — `caches.open(candidateName)` and `cache.put` for the manifest and the three assets.
   The candidate is opened under its final name from the start, so there is no rename step to get wrong and
   a crash leaves an unreferenced cache rather than a half-active one.
5. **smoke** — construct a `PPOCRv6Provider` whose `fetch` serves the **in-memory verified bytes**, `await
   provider.load()` (both sessions created against the candidate weights and the precached runtime), then one
   `recognize()` on a deterministic image drawn by `packages/pwa/src/lib/models/smoke-image.ts`. The bar is
   **≥1 line and ≥1 word**, mirroring `DECISIONS/0012` F9 condition 8.
   - It is deliberately **not** a specific string. This step asks "do these weights execute and produce a
     plausible output", not "is Tiny accurate" — that question was answered and published by ticket 09b, and
     re-answering it inside a cache-activation gate would couple installability to recognition accuracy and
     make the app un-updatable whenever a receipt is hard to read. A swapped or corrupt model produces either
     a session-creation failure or zero words; both fail here.
6. **activate** — one `put` into `receipt-lens-active-model-cache`. This is the only step that changes what a
   reader sees, and it is a single write.
7. **cleanup** — delete every cache matching `MODEL_CACHE_PREFIX` except the newly active one, and every
   `SHELL_CACHE_PREFIX` except the current one (worker `activate`, W7.2).
8. **report** — the resulting `ModelUpdateState` reaches the UI (W7) and, at checkpoint 3, the footprint
   measurement.

**Hand-off:** the provider built at step 5 is handed to the app as its ready provider rather than thrown
away. The user's first capture therefore reuses warm sessions, and the preparation cost is paid once per
version, not once per capture. `packages/pwa/src/lib/ocr.ts`'s lazy boundary is unchanged; the prepared
provider is what it resolves to.

---

## W6 — How the probe sees the network at all

The page's own model requests are intercepted by the worker, so a naive probe would be answered from the
cache it is trying to check — it would always report "up to date", the update path would never run, and the
test suite would be green while the feature was dead. This is the trap in the design, and it has one clean
answer.

- The probe and every download use **`fetch(url, { cache: "reload" })`**. Core's `FetchLike` takes one
  argument (`model-manifest.ts:218`), so the bypass is not a parameter threaded through a helper — the
  protocol's `fetchImpl` *is* the closure `(input) => fetch(input, { cache: "reload" })`, and that closure is
  the whole mechanism on the page side.
- The worker honours it: for a model path with `request.cache === "reload"`, it goes to the network and
  **writes nothing** to any cache.
- Normal OCR reads use the default cache mode, are served from the active model cache, and therefore work
  offline.

**No query string.** `playwright/offline.spec.ts`'s allowlist requires `url.search === ""` for every
same-origin precache-phase request, and the negative control at line 385 depends on that being strict;
appending `?probe=1` to break the cache would either violate that allowlist or force a weakening of the one
test that proves M1 privacy. `cache: "reload"` keeps every URL byte-identical to today's.

`Request.cache` is settable and readable on the worker side in Chromium; the pin test asserts it on a mocked
`Request` and `offline-reload.spec.ts` asserts it on a real one by installing an active model set and then
confirming that a version bump is actually detected (W9.2 test 5).

---

## W7 — Failure, recovery and the visible pending state

§9's sentence is: *"If the update fails or the device is offline, retain and use the last verified cache with
a visible 'model update pending' state."* Pinned as behaviour:

| Step that failed | Reason code | Active set | Superseded set | Candidate cache |
|---|---|---|---|---|
| 1 probe | `probe_unreachable` (offline / DNS) or `manifest_invalid` | unchanged | retained | none exists |
| 2 download | `download_incomplete` | unchanged | retained | deleted (W7.1) |
| 3 verify | `hash_mismatch` | unchanged | retained | deleted |
| 5 smoke | `smoke_failed` | unchanged | retained | deleted |
| 6 activate | — (a single `put`; if it throws the pointer is unchanged by construction) | unchanged | retained | deleted |

**Nothing in this table disables OCR.** A pending update is a notice, not a gate; the app continues to run
against the last verified set, which is the entire point of keeping it.

### W7.1 A failed candidate is deleted immediately; a superseded active set never is

The two cleanups are different and must not be merged into one "tidy up" step. A candidate that failed
verification is unusable and unreferenced, so leaving it is pure quota waste — deleting it is safe precisely
because nothing can be pointing at it. The **active** set is only ever deleted after a newer one is proven
and the pointer has moved (W5 step 7). Pin, as an ordering assertion rather than a comment: on every failure
path, `caches.delete` is called with the candidate name and never with the pointer's name. The brief's
"cleanup only after successful activation" is about the superseded set, and this is the form that survives
contact with a half-written download.

### W7.2 Shell cleanup runs on worker `activate`

`receipt-lens-shell-v<digest>` is created at install; the previous shell cache is deleted in the `activate`
handler, which by definition runs after the new worker took control. That is `cleanupOutdatedCaches` in
five lines, and it is safe because the new worker's own cache was fully populated at install before it
activated.

### W7.3 The state, and where it is shown

```ts
type ModelUpdateState =
  | { status: "up-to-date";  providerVersion: string; manifestHash: string; preparedAt: number }
  | { status: "probing";     startedAt: number }
  | { status: "preparing";   startedAt: number; bytesDownloaded: number; totalBytes: number }
  | { status: "pending";     reason: ModelUpdateReason; retainedVersion: string | null; lastAttemptAt: number }
  | { status: "unavailable"; reason: ModelUpdateReason; message: string };
```

`pending` is §9's state: a newer set could not be made ready and an older one is in use. `unavailable` is
the state ticket 08's brief did not name and the design needs: **no** verified set exists at all — first
visit, fully offline, or every attempt failed. Then OCR is not possible and the app says so rather than
throwing when the user picks a receipt (W13).

The banner is a shell component beside `StorageStatus` (`packages/pwa/src/components/ModelStatus.svelte`),
shown on every route except `/share` — the same rule ticket 14 set for the storage screens, for the same
reason: a recipient has no model history on this device and must not be told about someone else's cache.
Copy is pinned in the component and asserted verbatim by test, following `DECISIONS/0025` P7's precedent:

- `pending`: **"A model update is pending. Receipts still read with the previous model set."**
- `preparing`: **"Preparing OCR — {n} MB of {m} MB."** (the owner ruling's wording, W2.1; `m` is the manifest's
  own declared byte total, so the denominator is the same number the verification step checks against)
- `unavailable`: **"Models are not on this device yet. Receipt reading needs them."**

No copy may promise the update will arrive, retry on a timer, or describe the retained set as current.

---

## W8 — Offline reload, and the measurement that makes it a pin

The brief names this as the actual proof that F12 is fixed. It is also the claim most likely to be quietly
false, so it was measured rather than argued, in this session, against the real binary:

> A throwaway worker (`/tmp/sw-spike`, deleted after the run) precached `/`, an app script, a manifest, an
> icon and **the repository's actual `ort-wasm-simd-threaded-qh98TCA_.wasm`, 14,848,852 B**, from an origin
> serving every response `cache-control: no-store`. With `context.route("**/*")` aborting everything with
> `internetdisconnected`: `page.reload()` completed, the new document executed its module script, and
> `fetch("/big.wasm")` returned **14,848,852 B with SHA-256
> `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d`**, identical to the file on disk.
> `context.route` fired **0** times during the reload — nothing reached the network layer at all — and the
> origin's own log recorded no request for `/big.wasm` after the reload.

Three facts fall out, each pinned rather than assumed:

1. **The Cache API holds an entity far larger than the HTTP cache's per-entity limit.** That is F12's remedy
   claim, confirmed on the byte count ticket 08 published.
2. **`cache-control: no-store` does not prevent a Cache-API precache.** `cache.addAll` reported no error and
   stored all 14,848,852 B. This is why W17 does not need a cache-mode change on the app server: the
   measurement server can keep today's headers.
3. **The reload's navigation, its script and the large asset are all answered by the worker, and the abort
   handler never runs.** The stronger interpretation of "offline" therefore has to be Playwright-level
   request aborts (as `offline.spec.ts` already uses), not merely an unplugged socket, and the assertion is
   that *nothing was observed leaving*, which is what §9 asks of the privacy record too.

**Behaviour, pinned:** with the worker active and no network, `location.reload()` renders the shell, the app
boots, and a capture runs to a draft using the active model set. Without a worker (or before it controls),
the same reload fails as it does today — which is exactly the before/after that W9.2's tests are built to
show.

The Chromium update check for `sw.js` on navigation did not produce an observable request in this spike.
Whether it does in a real deployment is not pinned and does not need pinning: W15 measures warm-visit bytes
and publishes whatever they turn out to be, and the claim is "the WASM is no longer among them", not "zero
bytes forever".

---

## W9 — `playwright/offline.spec.ts` is kept, and a second spec does the new work

**The brief's one pre-checkpoint question, answered:** read in full this session. `offline.spec.ts` *is* the
"load with network → block → infer without reload" pattern — Phase A line 328, block at line 340, Phase C at
line 344 on the same page — and the header comment at lines 12–14 names F12 as the reason there is no
reload: *"a reload after blocking would fail for a cache reason that has nothing to do with privacy
(DECISIONS/0012 F10/F12). Ticket 17's Cache API owns offline reload."* It has not been weakened. Both its
tests create their context with `serviceWorkers: "block"`.

**Decision: leave it byte-for-byte as it is.** It is `DECISIONS/0013`'s only implementation and the M1 proof;
its allowlist, its negative control and its no-reload shape are all deliberate. Editing it to take advantage
of the worker would destroy the thing it is for — a proof that holds in a world with no service worker. It
also must keep `serviceWorkers: "block"`: with the worker allowed, the app would register it, the precache
would issue requests of its own under the same allowlist, and the test would be measuring a different
system. That is a reason to block it, and the comment in that file should say so when ticket 18 revisits it.

### W9.1 The new file

`playwright/offline-reload.spec.ts`, `test.use({ serviceWorkers: "allow" })`, split rather than one flow
(`HANDOFF`'s owner note for tickets 13+, and these are genuinely separate transitions — each failure names
its own step):

| # | Test | What would have failed before ticket 17 |
|---|---|---|
| 1 | the worker installs on first visit and its precache manifest holds every emitted shell asset including the hashed WASM, and no `/assets/models/` path | there is no worker |
| 2 | **offline across reload**: load with network, wait until the worker controls the page, run one OCR to activate the model set, abort every request, `page.reload()`, run OCR again and require ≥1 line and ≥1 word | the reload could not complete: F12's 14.85 MB WASM was re-fetched and the abort killed it |
| 3 | offline capture-to-draft: after the offline reload, the full intake → OCR → draft flow reaches a reviewable draft with zero origin requests after the block | no shell, no models, no run |
| 4 | installability criteria: `/manifest.webmanifest` is served with the W11 fields and parses; `/sw.js` is served as JavaScript from a scope that covers `/`; the banner logic is driven with a fabricated `BeforeInstallPromptEvent` and shows, dismisses, and stays dismissed for 7 days | no manifest, no worker, no banner. **This test proves the app's side only** — see W12 |
| 5 | a version bump activates a new set, then a hash mismatch on the next bump leaves the *first* set active, the pending copy visible, and OCR still working | no caches to supersede |
| 6 | cleanup: after a verified activation the superseded cache is gone; after a failed activation it is still there, and the pointer still resolves | nothing to clean |
| 7 | offline *before any model set exists*: block the network on a fresh context, load, and the app shows `unavailable` and does not throw on file intake | the shell itself would not load |
| 8 | **trigger discipline (W2.1):** visiting `/`, `/bill`, `/bills` and `/share` issues zero requests under `/assets/models/`; navigating to `/capture` starts exactly one preparation; navigating away and back does not start a second while one is in flight | no trigger exists to be wrong |

Tests 1, 4 and 7 use the real built app from `scripts/serve-app.mjs`. Tests 5 and 6 need a mutable model
origin — a server that can serve a *second* manifest with a bad hash — which is a footprint-style test
fixture rather than a shipping server, and belongs in the spec file (a local `http` server, as
`offline.spec.ts` and `capture.spec.ts` already each do) rather than in `serve-app.mjs`.

Test 2 is the one the brief calls the actual proof. Test 5 needs `DECISIONS/0012` F12's machinery to be
reachable, and it is only reachable if W6 holds.

### W9.2 Timeouts

The config's `timeout: 30_000` stands for tests 1, 4, 6, 7. Tests 2, 3 and 5 run real OCR and override
**per test**, not per file, which is the form `HANDOFF`'s timeout note records ("a spec that genuinely needs
longer overrides per test; the default is what protects every future spec").

---

## W10 — Scope, registration, and a worker that never arrives

**Scope `/`,** registered as `navigator.serviceWorker.register("/sw.js")` with no explicit scope, so the
default root scope applies to every app route: `/`, `/capture`, `/bill`, `/bills`, `/share`. `APP_ROUTES` in
`scripts/serve-app.mjs` already falls back to `index.html` for all five, and `DECISIONS/0026` A14 notes
`/share` needs no cache beyond the shell because the participant view issues no request of its own — with a
worker it now needs *no* request at all, which is what makes a share link open on a plane.

`injectRegister: null` was the design note's instruction and is honoured in spirit: registration is
application code (`packages/pwa/src/lib/sw/registration.ts`, called from `main.ts`), not a generated snippet,
so it is importable and testable.

**A registration failure is an ordinary start.** Three real ways it happens: `serviceWorkers: "block"` in a
Playwright context (which `offline.spec.ts` and, per W19, most of the suite use), a worker script that 404s
or is served as `text/html` by `serve-app.mjs`'s catch-all, and a user who has disabled service workers.
Pin: `register()` is called with a `.catch` that records the outcome and nothing more; **no route, view,
OCR path or persistence path may depend on the worker existing**, and the app must not display an error for
its absence. The consequences are visible in the browser's DevTools, not in the product. This is the
robustness rule that keeps ticket 17 from becoming a load-bearing dependency of every other flow.

`smoke.spec.ts` gains one check for the second way: `/sw.js` is present in `dist/app` and is served with a
JavaScript content type — because a worker that resolves to an HTML document fails registration with a
message that points at nothing useful, and the catch-all fallback makes that silent.

---

## W11 — Installability: the manifest, the icons, and how they are made

`packages/pwa/public/manifest.webmanifest`, copied to `dist/app/` by Vite, linked from `index.html` as
`<link rel="manifest" href="/manifest.webmanifest">`. Fields pinned:

```json
{
  "name": "receipt-lens",
  "short_name": "receipt-lens",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fbfaf7",
  "theme_color": "#efe9dc",
  "description": "In-browser receipt parsing and bill splitting. Receipts never leave your device.",
  "icons": [
    { "src": "/icons/receipt-lens-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/receipt-lens-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/receipt-lens-512-maskable.png", "sizes": "512x512", "type": "image/png",
      "purpose": "maskable" }
  ]
}
```

`background_color` and `theme_color` are taken from the shipped stylesheet, not invented: `app.css` already
uses `#fbfaf7` as the page background and `#efe9dc` as its filled-surface colour, and `#26221c` as its text.
A manifest that introduced a new brand colour would be a design decision smuggled in as metadata.

- `start_url: "/"` and `scope: "/"` match W10's worker scope. A mismatch is the classic near-invisible
  installability failure, so the pin test compares the manifest's `scope` against the registered scope
  instead of trusting that both were written on the same day.
- `description` repeats §1's claim in the store-listing position, and may not exceed it. The wording is
  "Receipts never leave your device", which is the claim ticket 18 is going to have to defend; that is the
  point of putting it where a person reads it.
- Three icons, not one, because Chromium wants both a 192 and a 512 and a maskable variant is what stops the
  launcher from cropping the wordmark.

**The icons are generated by `scripts/make-icons.mjs`, committed alongside the script, and re-derivable.**
The script writes PNGs directly with `node:zlib` — no image library, so no new dependency with a postinstall
(`HANDOFF`'s standing rule: postinstalls are reviewed before allowing, and `DECISIONS/0017` D6 checked three
framework candidates and found none declaring a hook). The image is a deterministic flat tile: `#efe9dc`
field, a `#26221c` receipt glyph, no font rendering — deterministic because it is built from integer
rectangles, so the same script always writes the same bytes. `pnpm verify:icons` re-runs the generator into a
temporary directory and fails on any difference, following `verify:storage-fixtures`' pattern: committed
bytes plus a check that they are the bytes the script writes. Sizes are ~1 KB and ~6 KB — far under the 1 MB
commit ceiling.

**The artwork is an owner call and this record does not pretend to have made it.** A flat green tile with a
receipt shape is a placeholder that is *good enough to install with*; replacing it means editing the inputs
of `make-icons.mjs` and re-running it, and W11's byte-reproducibility check is what stops the replacement
from becoming an untracked binary.

---

## W12 — The install banner, and the thing headless Chromium will not do

**Measured in this session:** with a valid manifest (name, `display: standalone`, `start_url`, a 192 px
icon), a service worker installed, controlling the page and exposing a `fetch` handler, on a `127.0.0.1`
secure context, Playwright's `chromium.launch()` fired **no `beforeinstallprompt` event**, on the online load
or after an offline reload, and polled for 20 s. `navigator.getInstalledRelatedProducts` was absent from the
page entirely.

So the brief's "offline: install prompt appears when eligible" is **not achievable as written** in the CI
browser, and the honest split is:

- **e2e proves the app's half** (W9.1 test 4): the manifest is served and parses with the pinned fields, the
  worker controls a scope covering every route, and — driving a fabricated `BeforeInstallPromptEvent`
  dispatched at the element — the banner appears, the button calls `prompt()`, dismissing suppresses it, and
  the suppression expires. The event is fabricated deliberately: the pin is about *this app's* behaviour
  given the event, which is the only part that can regress silently.
- **the browser's half is a declared gap, in the spec file, in `HANDOFF`, and in whatever ticket 18's
  audit writes down.** Whether Chromium offers install on a real profile with real engagement is a property
  of Chromium. A human check on a headed browser is the only way to see it, and it has to be named as
  outstanding rather than absorbed into a green test.

That distinction is the same one `DECISIONS/0012` F1 draws about the harness measurement and ADR-002 draws
about published claims: do not let an artifact appear to prove something the environment cannot.

### W12.1 The banner and its 7 days

- Shown when and only when `beforeinstallprompt` fires. Safari and Firefox never fire it; there is then no
  banner and no "add to home screen" instructions, because claiming to support an install path this build
  cannot detect is a worse answer than silence.
- Copy: **"Install receipt-lens for offline use"**, dismissible, with `Install` and `Not now`.
- On dismiss, remember the time in `localStorage["receipt-lens:install-banner-dismissed-at"]` and suppress
  for **7 days**.
- After `prompt()` resolves, the banner goes away permanently and the timestamp is removed.

**`localStorage`, and why it is allowed once.** §10's IndexedDB stores are the bill ledger and they are
versioned by `DECISIONS/0023`; a UI preference has no place in them, because a shell preference that
participates in a schema migration would make an app update a data migration. It also holds no bill data, no
name, no amount, no fragment and no image — nothing §10 or `DECISIONS/0026` A3 protects. So it is the right
store, and the rule that travels with it is strict: **this key is the only `localStorage` entry the app may
ever write**, asserted by a source scan in the same style as `scan:egress` — a preference surface that grows
quietly is how a bearer secret ends up in `localStorage` — which is what `docs/pwa-design.md` §3 is reaching
for when it says the fragment "must never be copied somewhere that outlives the page".

---

## W13 — Two states the brief does not name, and the gap it leaves

1. **`unavailable`: offline with no verified model set.** W7.3. The shell precache guarantees a reload works;
   it does not guarantee the models were ever prepared. A user who installs on a train and opens the app for
   the first time on the next one is in this state, and the app must render it rather than reject the file
   input.
2. **The worker not being in control yet on first visit.** `register()` resolves before the new worker
   controls the *current* document unless `clientsClaim()` runs. Pin: the worker calls `skipWaiting()` at the
   end of a successful install and `clientsClaim()` on activate, so the first visit is controlled shortly
   after load, and every test that needs control waits on `navigator.serviceWorker.controller` rather than on
   a timeout. The install-activate-waiting-for-controller race is where ticket 17's time is most likely to
   burn; waiting on `controller` is the deterministic answer and it is the pattern `offline.spec.ts` already
   uses for a different readiness signal.

---

## W14 — The footprint re-derivation moves the measured deployment to the PWA

`DECISIONS/0012` F1 pinned the measured deployment as *"the §9 M1 core inference harness page… **Not the
PWA**"*, and said why: at that date tickets 10a and 10 did not exist. F11's trigger 1 is the same sentence
in the other direction: *"**The PWA exists** — tickets 10a and 10. New entry, new bundle, new cache
behaviour; the current numbers are the harness's."* Both tickets merged; `HANDOFF` records the owner ruling
of 2026-11-05 assigning the reconciliation to ticket 17, in terms that decide this point: *"ticket 17's
service-worker precache definition determines the caching story; the footprint table must be re-derived from
that measurement."* `docs/pwa-design.md` §2.4 lists the same obligation, and `DECISIONS/0017` D9.1 says the
published pair *"must be regenerated once the PWA actually exists."*

There is no version of this ticket that re-derives the table without changing the measured deployment,
because **the harness has no service worker and ticket 17 does not add one.** Staying on the harness means
`secondVisitBytesOverTheWire` remains exactly 14,848,852 B, the exception set cannot be removed without
lying about it, and F12 stays open with its remedy already shipped and unmeasured. So:

| | before | after |
|---|---|---|
| entry | `harness/index.html` | `packages/pwa/dist/app/index.html` |
| server | `harness/serve.mjs` (`cacheMode: "validate"`) | `scripts/serve-app.mjs`, W17 |
| app script | `harness/dist/main.js` (144,526 B, esbuild) | hashed Vite chunks |
| runtime WASM | `/ort/ort-wasm-simd-threaded.wasm` (mounted) | `/assets/ort-wasm-simd-threaded-<hash>.wasm` (build output) |
| ORT threads | 4, under COOP/COEP, `crossOriginIsolated: true` | **1**, no isolation headers |
| warm visit | 14,848,852 B over the wire | measured; expected to be the worker script and nothing else |
| inference driven by | `window.__receiptLensHarness.run()` | the real capture UI |

The thread change is not a detail and it is the largest reason the new numbers will not resemble the old
ones: `resolveThreadCount` (`pp-ocrv6.ts:77`) returns 1 unless `crossOriginIsolated`, and
`scripts/serve-app.mjs` sets no COOP/COEP headers while `harness/serve.mjs` does. **W20 pins that ticket 17
adds no isolation headers** — doing so would improve latency and change the published claim in the same
commit as the caching change, which is exactly the "one variable at a time" rule F3's whole section is built
on. The isolation question is a separate measurement with a separate record.

**Ruled at checkpoint 1, and added to the record as a requirement, not a suggestion:** the thread count is
named explicitly in the footprint table's declared-conditions block, in these words:

> Latency measured at 1 ORT thread (`serve-app.mjs` sends no COOP/COEP; the harness's 4-thread measurement is
> superseded). If isolation headers are added, latency improves and the footprint table regenerates.

A reader comparing pre-17 and post-17 latency must be able to see that the two are apples-to-oranges on
thread count and *not* on the fix. `render-footprint-table.mjs` emits that sentence from
`measurement.deployment.threads`, so it is generated rather than hand-written, and `verify:footprint` still
fails on drift.

### W14.3 Escape hatch — a recorded deferral, never a silent one

**Ruled at checkpoint 1:** the full re-derivation is the deliverable, because the table is §1's "measured
footprint" claim and a pre-17 number under a post-17 build is the dishonesty F1 and ADR-002 exist to prevent.
The owner's framing: *"a SW that caches the WASM with no measured improvement is a technical fix with no
visible effect."*

If at checkpoint 3 the re-derivation is clearly past the session budget — the stated bar is roughly two hours
into the driver rewrite and still not converging — then:

1. commit what works: the worker, the offline-reload proof, installability, **and a new measured
   warm-bytes number for the PWA deployment** so F12's remedy is evidenced even in partial form;
2. open `ticket/17b-footprint-remeasure` as a ticket file under `.scratch/receipt-lens-v1/issues/`, with the
   status, the blocked-by, and exactly which parts of W14/W15 remain (`ROLES`, the F9 amendments, the driver);
3. say so in ticket 17's file and in `HANDOFF`: **F12's remedy is shipped but the full re-measurement is
   deferred to 17b**;
4. and do **not** delete `NOT_RETAINABLE` or the harness `deployment.scope` in a way that makes the stale
   table look current. If the table is not regenerated, it still says it describes the harness, and
   `verify:footprint` keeps passing against the *archive* rather than against a number that has quietly aged.

The condition on that last point is what makes the hatch safe: the deferral is a ticket, the artifact says
which deployment it describes either way, and no intermediate state publishes a PWA claim from harness bytes.

### W14.1 What the harness numbers become

The current artifact is copied to `benchmarks/results/footprint-2026-11-05-<rev>.json` before it is
overwritten — the dated-archive pattern ticket 08 itself established with
`footprint-2026-11-04-16ae8de.json` and ticket 09b reused for the accuracy artifacts. The old
`deployment.scope` text is retained inside the archive; it is the evidence for the claims in
`DECISIONS/0012` F1 and F10 and it must stay findable.

### W14.2 The parts of `measure-footprint.mjs` that change

`ROLES` is re-keyed to the PWA's emitted names, with `/assets/index-*.js` as the entry,
`/assets/ort.wasm.bundle.min-*.js` as the runtime loader and `/assets/ort-wasm-simd-threaded-*.wasm` as the
runtime WASM. The `measurement.deployment` block is rewritten — and notably its
`remeasureRequiredAfter: "tickets 10a, 10"` sentence becomes the date this measurement was taken, because
that condition is now discharged.

Byte counting stays exactly where F5 put it: the origin's own request log. That is what makes the
warm-visit claim checkable — an HTTP cache that cannot hold the WASM leaves a 14,848,852 B line in the log,
and a worker that can holds the line down. `scripts/serve-app.mjs` does not currently record requests, so it
gains an opt-in log (W17) and nothing else changes.

---

## W15 — F9's fail-loud set, amended for a worker-served warm visit

F9 is written for a world with no worker. Two of its thirteen conditions stop meaning what they say, and one
of them is the drift guard F12 designed to break.

- **Condition 3 — "a warm visit revalidates nothing and reads no cache" fails the run.** Under a worker the
  origin may see *no* requests on a warm visit, which would trip this check while the feature works
  perfectly. Amended: the read-from-cache signal moves off the wire. A warm visit must show **zero origin
  requests for the precached and model assets** and must show, from the page, `transferSize === 0` for those
  resources. The new pass condition is the old failure condition inverted, so the change is recorded here
  rather than slipped into a script edit.
- **Condition 13 — "an asset declared non-retainable is now retained" fails the run.** This is the designed
  trigger. F12: *"the exception set will fail (condition 13) and must be removed with a fresh measurement —
  the failure is the signal, not a bug."* **`NOT_RETAINABLE` in `measure-footprint.mjs` is deleted in this
  ticket,** and its check now runs against an empty declared set: any full-body warm re-download of anything
  fails the run, with no exception at all. That is the state ticket 08 said we would reach, and reaching it
  is ticket 17's acceptance bar.
- **Conditions 1 and 4** ("a cold visit does not receive `200` for first use"; "any `200` carries zero body
  bytes") need a note: a cold visit in which the *worker* serves an asset the *origin* never logged is not a
  zero-body `200`, it is no origin response at all. The conditions are re-expressed as "for every asset in
  the cold sample's origin log the status is `200` with a non-zero body" — same intent, no longer able to
  fire on a working worker.
- **F8's `warm` definition** stays "same context, `page.reload()`, ETag revalidation" only in the sense that
  the reload is what defines warm; the revalidation clause is replaced by "answered by the active caches".
  F8's table is amended in place with this record cited.
- **The latency bases** need a new anchor because `window.__receiptLensHarness` does not exist in the PWA.
  Pin: cold and warm are timed from `performance.timeOrigin` of the navigation to the DOM state that proves
  a draft was produced, driven through the real capture UI as `capture.spec.ts` already does. `appReadyMs`
  survives as the `load` event. **`ocrReadyMs` and `modelLoadMs` become "not separable"** with the reason
  written where F1 wrote the comparable harness-bundle caveat: the app has no test-only timing hook, and
  ticket 17 will not add one to the shipped bundle. The precedent for keeping test scaffolding out of what
  ships is `DECISIONS/0023` S1, which put the migration rig in a separate Vite entry so `smoke.spec.ts`
  could fail the build if it leaked; the same rule applies to a timing hook, and the cost is the same — the
  number becomes unreportable rather than dishonest. `firstResultMs` and `inferenceMs` remain measured. A published number that cannot
  be separated is reported as unseparable — not quietly kept in the table from the old deployment.

`pnpm verify:footprint` continues to be the drift check, and after ticket 17 it additionally re-hashes the
built worker's embedded precache manifest against the built assets: a `footprint.json` that no longer
matches what `dist/app` contains fails CI, which is what makes regeneration a deliverable rather than a
habit.

---

## W16 — Closing ticket 08's finding without deleting it

`footprint.json`'s `findings[]` keeps `warm_not_zero_ort_wasm_exceeds_cache_entity_limit` — detail, evidence,
remedy and `affectsClaim` verbatim as ticket 08 published them — and adds:

```json
"resolvedBy": "ticket 17",
"resolvedAt": "2026-11-05",
"resolution": "the worker precaches the runtime WASM into the Cache API, which is not subject to the
               HTTP-cache per-entity limit; this artifact's warm visit no longer lists it"
```

A second finding is added, measured rather than asserted:

```json
"code": "warm_visit_served_by_service_worker",
"detail": "<measured warm bytes over the wire> — <which requests, if any, still reached the origin>",
"evidence": "<the run in this artifact's runs[]>",
"affectsClaim": "section 9 initial-download / re-fetch cost"
```

The historical entry stays because F10's *evidence* (the 6 MiB retained / 8 MiB not probe) is a property of
Chromium's HTTP cache that ticket 17 did not change; what changed is that this deployment no longer depends
on it. Deleting the entry would delete the reason the caches are shaped the way W2 shapes them, and a
reader of the artifact is supposed to be able to find out why.

The README block is then regenerated by `render-footprint-table.mjs` from the new artifact — never edited by
hand — which retires the sentence *"Ticket 17's service-worker Cache API is expected to reduce second-visit
bytes to zero for cached assets. Until then, users re-download the WASM on every reload."* The owner
directive that the table must break out **app shell / models+WASM / total** is served by the existing
`perCategoryBytes` grouping (already `app` / `model` / `runtime`), now populated with PWA rows, plus W14's
amended `deployment` block naming the entry so nobody reads it as the harness's 21.30 MB again.

---

## W17 — `scripts/serve-app.mjs` changes, and only these

It is the server every e2e spec and `scripts/storage-fixtures.mjs` already uses, so the rule is: additive
and opt-in, with the default behaviour byte-identical.

1. **An opt-in request log**, `startServer({ recordRequests: true })` → `server.requests`, recording
   `{ path, status, bodyBytes, cacheState }` per response, in the shape F5 needs. Off by default, so the
   existing callers see no difference.
2. **`/sw.js` must resolve as a file, not as the `index.html` fallback.** Today an unknown path falls through
   to `index.html`, which would hand a would-be worker script back as HTML; W10's smoke check catches it,
   and the server names the missing file instead. (No behaviour change for any path that exists.)
3. **`cache-control: no-store` stays.** W8 measured that it does not obstruct a Cache-API precache, and
   changing the shipping server's headers to make a measurement look better is the kind of fix F12 explicitly
   warns against.
4. The MIME map gains `.webmanifest → application/manifest+json` (already present) and no other entry.

`/assets/models/*` continues to be mapped onto the repository's model directory, and no `/ort/` mount is
added: the PWA never asked for one (`grep` this session: `wasmPaths` is set only by `harness/src/main.ts:23`,
`harness/src/batch.ts:48` and two probe/inspection scripts — never by `packages/pwa`), and the built app
already emits its own hashed WASM. `docs/pwa-design.md` §2.3's recommendation to "let ORT resolve its emitted
asset so the precached copy *is* the used copy" is therefore not a change ticket 17 makes; it is the
existing state, and the pin is that **no `wasmPaths` option may be introduced in `packages/pwa`**, because
that is the exact mechanism that would create the duplication the note warns about.

---

## W18 — Storage durability

The Cache API is exempt from the per-entity limit; it is **not** exempt from origin quota or from eviction
under storage pressure. A deployment that precaches 15 MB and later prepares 6.28 MB of models is asking an
origin to hold roughly 21.5 MB. Pin:

- after a successful activation (W5 step 6), the protocol calls `navigator.storage.persist()` once and
  records the outcome in `ModelUpdateState`. Denied is normal and changes nothing else.
- `navigator.storage.estimate()` is reported in the checkpoint-3 verification output as a *session*
  observation, and nowhere published as a footprint claim — F7 defines footprint as wire bytes, and eviction
  is not a byte count.

Why this is pinned rather than assumed: W8 proves the worker serves the WASM in a test browser with a
scratch profile, which is the best case. The honest claim ticket 17 gets to make is "the Cache API holds
what the HTTP cache could not", not "the cache is durable". Ticket 18's audit wording inherits that limit.

---

## W19 — `serviceWorkers: "block"` becomes the Playwright default

Once the app registers a worker, every context that allows one installs it and precaches ~15 MB, and every
subsequent request in that context is answered by the worker instead of the network. That is the product
behaving correctly and the rest of the suite being reinterpreted by accident. `shell.spec.ts`'s first-paint
request walk, `capture.spec.ts`'s asset assertions and the migration-fixture driver are all written against
a world where a request means a request.

Pin: `playwright/playwright.config.ts` sets `use: { serviceWorkers: "block" }`, and
`offline-reload.spec.ts` opts in with `test.use({ serviceWorkers: "allow" })`. Measured this session that
this is safe to do and does not hide the traffic that matters: with the worker active,
`page.on("request")` **still fires** for `/` and `/app.js` on a reload and both `response()` and
`requestfinished()` still resolve — interception changes who answers, not whether the request is visible.
The only thing that goes quiet is `context.route`, which is a *bypass* of the network rather than a
observation point (W8: zero aborts on an offline reload).

Two consequences, both wanted:

- the existing 61 non-offline tests keep precisely the semantics ticket 16 and earlier wrote them against,
  and none of them pays a 15 MB install precache per context;
- `offline.spec.ts`'s existing `serviceWorkers: "block"` goes from an explicit local choice to the global
  default plus a redundant local statement, which is harmless and should be kept there for readability of
  *that* file's intent.

**This is a decision ticket 18 has to revisit, and it should be written down now rather than rediscovered
there.** §9 M3.4 says service workers must be handled at `BrowserContext` level and that
`page.route()`-only coverage is not enough; a block-everywhere default satisfies "handle them" in the narrow
sense while leaving the worker's own egress unproven. Ticket 18's audit needs at least one scenario with
`serviceWorkers: "allow"` that asserts every request the *worker* makes — install precache, model reads,
probe — is same-origin and unqualified. That scenario cannot be added here without deciding what the audit's
claim is, which is ticket 18's to decide.

---

## W20 — What this ticket does not touch

- **No core contract change.** `OcrProvider`, `OcrResult`, `parse()`, `validate()` and `extract()` are
  untouched, and ADR-002's reversibility sentence ("switching providers must not change `parse()` or the
  normalized OCR contract") is not tested here. Ticket 17 uses core's existing `fetch`/`fetchImpl` seams.
- **No `/share`, snapshot, settlement or codec change.** `DECISIONS/0025` P10 already recorded that ticket
  17 gets no dependency on the codec; W10 confirms the fragment path works offline through the navigation
  fallback, with no new route and no server rewrite.
- **No model tier change.** `DECISIONS/0015` keeps Tiny, and ADR-002's default is untouched. The 20 MiB
  ceiling discussion in `DECISIONS/0017` D5 is superseded by W1.1's completeness rule, which does not
  reintroduce a size assumption.
- **No COOP/COEP headers** (W14), and so no change to ORT's thread count or to the device classes F3/F4
  declare. The consequence is published rather than footnoted: the post-17 latency rows are **1-thread**
  numbers and the superseded harness rows were 4-thread, and W14's ruled sentence names that in the
  declared-conditions block of the generated table.
- **The install prompt does not fire in headless Chromium** (measured, W12). The app's half is e2e-tested
  against a fabricated event; the browser's half is a manual check that cannot be automated in the current
  Playwright setup, and it is left open on purpose rather than replaced by a test that would pass either way.
- **No receipt image in any cache, ever** (W2.2), and no new persistence store.
- **`PROJECT(1).md` is not edited by this record.** It already states every rule W2–W7 implements.
- **Not a privacy audit.** W19 defers the worker-allowed egress scenario to ticket 18, with the reason.

---

## What this record does not decide

- **Whether the owner wants a manual `v<n>` shell counter** instead of W3's manifest digest. Both satisfy
  the brief's format; the digest cannot be forgotten. Overruling costs one function and one test.
- **Whether `/capture` is the right trigger or a visible "download models now" button is better.** W2.1 is
  ruled and implemented as pinned; the open question is only whether a user who wants models prepared without
  visiting the capture view needs an affordance. Nothing in W5 changes if that button is added later.
- **The icon artwork** (W11), and therefore what `verify:icons` compares against once a real logo exists.
- **How installability is verified outside a headless browser.** W12 says what cannot be proven here; the
  human check is not scheduled by this record.
- **Whether `sw.js` is re-requested by Chromium on a real deployment.** W8 measured a spike; W15 publishes
  whatever the re-derived measurement shows. No number in this record is a prediction.
- **The new absolute footprint numbers.** Deliberately absent. They are `DECISIONS/0012` F2's business, they
  come from a run, and a record that guesses them is the thing F1–F12 exist to prevent.
- **Ticket 18's egress claim about the worker** (W19).

## Reporting discipline

Nothing here is a measurement except where it says it is, and the three places that do — W8's offline-reload
run, W12's absent `beforeinstallprompt`, W19's request-visibility probe — are session observations against a
throwaway spike, cited as such, each discharged by a committed test at checkpoint 3 or declared a gap. The
W14 table's byte figures are ticket 08's published artifact, quoted by reference.

Every pin below is discharged by a named test, and the pins commit red against throwing stubs first:

| Pin | Test |
|---|---|
| W3 cache names, W3.1 prefix closure | `packages/pwa/tests/sw/pins.test.ts` |
| W2.1/W1.1 precache manifest contents, exclusion of `/assets/models/`, WASM present | `tests/sw/pins.test.ts` + `playwright/smoke.spec.ts` |
| W2.1 `/capture` is the only route that starts a model download; no concurrent preparations | `tests/sw/pins.test.ts` + `playwright/offline-reload.spec.ts` test 8 |
| W5 step order, W6 probe bypass, W7 each failure path, W7.1 candidate-vs-active cleanup | `tests/sw/pins.test.ts` |
| W7.3 state and copy | `tests/sw/pins.test.ts` + `playwright/offline-reload.spec.ts` |
| W10 registration failure is inert | `tests/sw/pins.test.ts` |
| W11 manifest fields, scope agreement, icon reproducibility | `tests/sw/pins.test.ts` + `pnpm verify:icons` |
| W12 banner and 7-day suppression, `localStorage` single-key rule | `tests/sw/pins.test.ts` + `scripts/scan-egress.mjs` sibling check |
| W8/W9.1 offline reload and offline capture | `playwright/offline-reload.spec.ts` tests 2, 3 |
| W14/W15 re-derived artifact, exception set gone, README table | `pnpm measure:footprint` + `pnpm verify:footprint` |

A claim that cannot be re-derived from a committed artifact is not reported. `HANDOFF`'s ticket 06 lesson
applies to W14 directly: numbers from a throwaway script are a liability, so the spike above is cited for
*feasibility* only, and no byte figure in this record comes from it.
