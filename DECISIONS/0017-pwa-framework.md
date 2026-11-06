# DECISIONS/0017 — PWA framework (gate G1): Svelte 5 + Vite, path routing, no SSR

Date: 2026-11-04 · Ticket 10a · **Status: binding for M3.**

`PROJECT(1).md` §3 line 119 leaves the choice open — "PWA framework is still an open implementation
choice (Svelte 5 is implied by the current structure but is not locked); choose it before M3, with its
service-worker precache and IndexedDB design documented". ROADMAP §4 gate G1 ("PWA framework commitment",
due end W11) names the default **Svelte 5 + Vite + TypeScript** with "fallback: React 19 + Vite if
ecosystem wins", and task 3A.1 sets the bar this record has to clear: "precache + IndexedDB design
documented; shell deploys".

A default is not an argument. Every number below is measured against the shipped `@receipt-lens/core`
(the same build path ticket 04/08/09 exercised), in a throwaway probe that builds one identical
three-view shell four ways: Svelte 5 + svelte-spa-router, Svelte 5 + svelte-routing, React 19 +
react-router, and no framework at all. The artifact of record is
`scripts/pwa-framework/results/framework-evidence.json`, produced by
`node scripts/pwa-framework/measure.mjs --browser`, and every figure published here is re-read from it by
`node scripts/pwa-framework/verify-evidence.mjs`, which fails on drift. Nothing below is a number to
quote from this file — quote the artifact (DECISIONS/0012 F1).

## D0 — The decision, in one line each

- **Framework: Svelte 5 (5.57.3) + Vite 8 (8.3.5) + TypeScript, plain SPA.** No SvelteKit, no SSR, no
  hydration: the app is a static bundle plus a fragment, and §4 keeps `parse()`/`validate()` isomorphic
  while the OCR provider is the one browser-only surface (DECISIONS/0007). SSR would put a module-scope
  `await import("onnxruntime-web/wasm")` on a code path that has no WASM host.
- **Routing: path (history) routing, ~40 lines in-house.** Not a hash router (§D3), not a third-party
  Svelte SPA router (§D3 measured both).
- **Share links: `https://<host>/#v1.<token>.<nonce>.<ciphertext>`.** The payload is read from
  `window.location.hash` **raw**, at boot, by the app — never from a router param. Path routes carry app
  navigation; the fragment carries the snapshot. A link therefore never needs a server rewrite (§D3).
- **Lazy boundary: OCR behind a dynamic import from the capture view.** Measured: the ONNX runtime is
  absent from the first-paint graph in every build (§D4).
- **Service worker: `vite-plugin-pwa` 2.0.0 (`generateSW`, Workbox 7.4.1) with
  `workbox.maximumFileSizeToCacheInBytes` raised above the 2 MiB default** — otherwise the build fails
  outright and the runtime WASM is not precached (§D5). The intent is written up in this ticket's design
  note (`docs/pwa-design.md`); ticket 17 implements it.
- **React 19 is not adopted.** It wins no dimension: it loses D1 by a factor of ~3 on the shell and ties
  D2, D4 and D5.

## D1 — Dimension 1: bundle size after tree-shaking

Every build bundles the same thing — `@receipt-lens/core` (parse + validate + the provider wrapper),
three placeholder views, a router, one nav — and lazily imports the same OCR path. `bytes` is the emitted
file, `gzip`/`brotli` are `node:zlib` defaults on that file. Artifact: `apps.<app>.variants.<variant>`.chunkGraph.entry
→ the matching `dist[]` row.

| build | first-paint entry JS | gzip | brotli |
|---|---|---|---|
| no framework, hand-rolled router | 47,188 | 16,031 | 14,268 |
| **Svelte 5 + svelte-spa-router (hash)** | **86,603** | **30,844** | **27,602** |
| **Svelte 5 + svelte-routing (path)** | **103,598** | **37,462** | **33,359** |
| React 19 + react-router (hash) | 303,256 | 96,669 | 82,867 |
| React 19 + react-router (path) | 303,013 | 96,580 | 82,883 |

The pair that answers the actual question — both frameworks in the routing mode the app needs:
**React is +199,415 B raw, +59,118 B gzip, +49,524 B brotli over Svelte**, i.e. 2.9× the shell. The
Svelte runtime plus router costs 39,415 B raw over no framework at all, and the choice between the two
Svelte routers measured 16,995 B raw.

Stated against the whole download, because that is where it lands: the cold OCR phase measured
21,372,257 B over the wire (models + runtime + glue + sample image), so the framework delta is ~0.9% of a
first visit that runs OCR and 3.5× the shell a user sees before they do. The shell is what every visit
costs; the OCR path is what only the capture flow pays. Both favour the smaller runtime, neither makes
the framework the footprint story — DECISIONS/0012's `ort-wasm-simd-threaded.wasm` does.

## D2 — Dimension 2: compatibility with onnxruntime-web

Measured in headless Chromium on this machine (DECISIONS/0012 F4's class — loopback, unthrottled,
declared emulation, not a phone claim). Each app's capture view imports core's provider, loads the pinned
Tiny assets from `/assets/models/` and runs one inference on the git-ignored SROIE receipt ticket 04 used.

| build | inference | lines / words | ORT in first paint | `crossOriginIsolated` | runtime loader requests |
|---|---|---|---|---|---|
| no framework | ok | 29 / 75 | no | true | 4 × `.mjs` + 1 × 14,848,852 B `.wasm` |
| Svelte + svelte-spa-router | ok | 29 / 75 | no | true | 4 × `.mjs` + 1 × `.wasm` |
| Svelte + svelte-routing | ok | 29 / 75 | no | true | 4 × `.mjs` + 1 × `.wasm` |
| React 19 + react-router | ok | 29 / 75 | no | true | 4 × `.mjs` + 1 × `.wasm` |

29 provider lines / 75 words is the same receipt ticket 04 and DECISIONS/0008 P5 describe, so the parser
downstream of each bundle sees the familiar input. The repeated `ort-wasm-simd-threaded.mjs` fetch is the
per-worker loader fan-out ticket 08 already recorded (DECISIONS/0012 F5), reproduced identically under a
Vite/Rolldown bundle rather than the harness's esbuild one — a cross-check, not a new finding.

No framework interferes with WASM, worker creation or `wasmPaths`. Worker *management* is framework-free
here: the OCR worker boundary is DECISIONS/0007's deferral and `ocr/worker.ts` is still unwritten, so
nothing in this decision constrains it. **This dimension is a tie**, and the requirement it produces is a
constraint rather than a discriminator: stay off SSR/hydration (D0).

## D3 — Dimension 3: routing, and the `#v1.…` fragment it has to coexist with

Ticket 16 puts the entire encrypted snapshot in the fragment. Each build was driven at five URLs and the
observed DOM plus `window.__probe` (what the view itself can read) were recorded; the payload is a
deterministic 7,755-character base64url string, i.e. at ticket 16's 8 KB budget (artifact
`how.fragmentPayloadLength`).

| case | Svelte+spa (hash) | React+router (hash) | Svelte+routing (path) | React+router (path) |
|---|---|---|---|---|
| `/` renders capture view | Capture | Capture | Capture | Capture |
| `/bill` deep link (server fallback on) | Capture | Capture | **Bill** | **Bill** |
| `/share#<7,755-char payload>` | Capture | *(nothing rendered)* | **Share**, hash byte-identical | **Share**, hash byte-identical |
| `/#<payload>` (the link shape §13 describes) | hash intact, view not routed | hash intact, view not routed | **fragment intact and readable at boot** | **fragment intact and readable at boot** |
| `/#/v1/<payload>` (payload as route tail) | **Share**, param intact | **Share**, param intact | Capture | Capture |
| `/bill` with no server rewrite | 404 | 404 | 404 | 404 |

Three findings, all measured:

1. **A hash router swallows the fragment.** In hash mode the payload arrives as a *route* to match, and
   the ticket-16 link shape (`#v1.…`, no leading slash) matches nothing: the Svelte hash build stayed on
   the Capture view, the React hash build rendered **no view at all**. The bytes are still in
   `location.hash`, so a link is never corrupted — the router just never hands the payload to the view
   that wants it.
2. **A path router leaves the fragment alone.** `/share#v1.…` routed correctly and `location.hash` came
   back byte-identical at 7,755 characters in both path-mode builds, and `/#v1.…` served `/` intact with
   the payload readable at boot. So the coexistence rule is: **path routing for navigation, fragment
   reading for snapshots, and never a router param for the payload** — a param is a decoded, normalised
   view of the URL, and the codec seam (ticket 16) must own the raw string.
3. **Path routing costs a rewrite rule, and the app can dodge it.** `/bill` 404s on a server that does
   not rewrite, in every build. The generated service worker registers a `NavigationRoute` bound to
   `index.html` (D5), so an installed app is covered; a *first* visit is not. Putting the payload at the
   site root (`/#v1.…`) means the recipient's link is always `/` plus an opaque fragment — no rewrite
   needed ever, on any static host, before or after install. That is the link shape D0 commits to.

The Svelte router options were measured because the roadmap default implies one. `svelte-spa-router`
5.1.1 is hash-only — v5 has no mode prop and its `Router.svelte` assigns `window.location.hash` on every
navigate — so it cannot implement D0's rule. `svelte-routing` 2.13.0 does path routing on Svelte 5 but
its documented `component={…}` prop form threw `TypeError: Cannot read properties of undefined (reading
'before')` under Svelte 5's component API; the children form (`<Route path="/bill"><Bill /></Route>`)
works, and it costs 16,995 B raw over the hash router. `react-router` 8.5.1 worked in both modes from the
same package. **That is the one place React's ecosystem is measurably ahead, and it does not change the
framework**: routing is a 4-route surface in a v1 that needs exactly one rule (`read location.hash raw`),
so the answer is a small in-house router rather than either a 17 KB dependency with a broken documented
API or a framework switch. That choice is only safe while it stays true to D7's promise: `router.ts`
imports nothing from any framework, and if it ever does, the "the router transfers unchanged to React"
claim in D7 stops being true and must be rewritten rather than inherited. Revisit trigger: if a later ticket needs nested/parallel routes, loaders or
scroll restoration beyond what the in-house module does, re-evaluate `svelte-routing` (children API only)
or SvelteKit — not React.

## D3a — The router contract (owner conditions, 2026-11-04)

The in-house router is approved with three binding conditions. They are the module's specification, not
implementation notes: the shell's `lib/router.ts` and `playwright/shell.spec.ts` are the artifacts that
hold them, and a violation is a bug in 10a, not a discovery for 16.

1. **The router listens for `hashchange` and `popstate`, not just for startup.** Initial route resolution
   reads `location.hash` raw; subsequent hash changes re-render the route **without a navigation**. The
   raw fragment is **never URL-decoded before handoff to the share-link parser** — decoding is ticket
   16's concern, not the router's. The router treats `location.hash` as an opaque string after the first
   `#`; it never splits on subsequent `#` characters.
2. **Unknown-route fallback is pinned.** Unknown routes and fragment-bearing landing pages route to the
   share view. A navigation to `/#v1.…` (fragment only, no path) is the primary share-link entry point;
   the router treats it as `/share` with the fragment preserved. A navigation to `/nonexistent` shows a
   not-found view **without breaking fragment preservation if one is present**.
   > **How the two halves are reconciled** (stated because the first sentence alone reads as "unknown
   > routes go to share", which the third sentence contradicts for `/nonexistent#v1.…`): the fragment
   > decides it only at the **landing path**. `routeFor("/", "v1.…")` is `share` — a fragment-bearing `/`
   > is a share link, and it is the only shape ticket 16 emits. Every other unknown path is `notFound`
   > whether or not it carries a fragment, and showing not-found must leave `location.hash` untouched, so
   > the fragment survives even though the view says not-found. `routeFor("/bill", "v1.…")` stays `bill`:
   > a known path owns the route, and the fragment is just carried along (condition 3 depends on that).
   > Implemented in `packages/pwa/src/lib/router.ts`, unit-tested in `router.test.ts`, proved in the
   > browser in `playwright/shell.spec.ts`.
3. **Fragment integrity across route changes.** Navigating `/capture#v1.x` → `/bill#v1.x` →
   `/share#v1.x` preserves the fragment byte-for-byte at every step. If any route change corrupts a byte,
   ticket 16's share links fail silently — this condition exists because that failure is invisible.

Tested, in order: the re-render-without-reload case (condition 1), the fragment-bearing landing and the
`/nonexistent` fallback (condition 2), and the three-hop byte-for-byte walk (condition 3), in
`playwright/shell.spec.ts` against the built shell.

## D4 — Dimension 4: lazy loading, so first paint never forces the ONNX runtime

In all four builds the ORT JS glue is emitted as its own dynamic chunk
(`assets/ort.wasm.bundle.min-*.js`, 74,322 B raw / 24,382 B gzip) alongside the 14,848,852 B `.wasm`, and
`chunkGraph.dynamicEntries` lists it while `firstPaintClosure` does not contain it. Over the wire, the
landing page requested only `index.html`, the entry chunk and the Rolldown runtime: 87,556 B (Svelte+hash),
104,551 B (Svelte+path), 304,781 B (React+hash), 48,141 B (no framework), with
`ortTouchedAtFirstPaint: false` and the probe state still `idle` in every case. Only the click pulled the
glue, the WASM, both models and the dictionary (21,372,257 B).

Two implementation consequences for ticket 10, both from warnings the build emitted rather than from
theory:

- Vite reports `[INEFFECTIVE_DYNAMIC_IMPORT] … core/dist/index.js is dynamically imported by
  lib/ocr.js but also statically imported by lib/parse-demo.js`. Because the bill view needs
  `parse()`/`validate()` eagerly, **core itself cannot split out** — only what sits behind core's own
  internal `await import("onnxruntime-web/wasm")` does. The no-framework build proves the boundary that
  works: a lazy module that *wraps* the OCR call gets its own chunk (803 B). So the shell must not import
  the provider eagerly, and any OCR-adjacent core module the capture flow owns should be reached only
  through the lazy chunk.
- The bundler hoists `ort-wasm-simd-threaded.wasm` into `dist/assets/` as a content-hashed 14.85 MB
  **build output** even though `wasmPaths: "/ort/"` sends the runtime fetch elsewhere. The probe measured
  both: the emitted copy was precached (D5) and unused; the fetched copy came from `/ort/`. Ticket 17 must
  pick one deliberately — the design note recommends letting ORT resolve its own emitted asset (so the
  precached copy *is* the used copy, and the content hash gives cache busting for free).

## D5 — Dimension 5: service-worker precache compatibility

`vite-plugin-pwa` is framework-agnostic, so this dimension cannot discriminate — and it is recorded
anyway because ticket 17's friction lives here, and both candidate stacks hit it identically:

| config | outcome, both frameworks |
|---|---|
| plugin defaults, `globPatterns: ["**/*.{js,css,html,wasm}"]` | **build fails**: `Configure "workbox.maximumFileSizeToCacheInBytes" to change the limit: the default value is 2 MiB.` The emitted WASM is excluded from the 5-entry manifest (162,382 B svelte / 379,370 B react precached). |
| `maximumFileSizeToCacheInBytes: 20 MiB` | build succeeds; 6 entries; **15,011,240 B** precached for the Svelte shell, **15,228,465 B** for React, **14,972,628 B** for no-framework (7 entries); `wasmPrecached: true`, `notPrecached: []`. |

**The 20 MiB figure is sized for Tiny, and it is a ceiling, not a margin.** Tiny's largest cacheable
asset is the 14,848,852 B WASM. If DECISIONS/0015's revisit condition ever fires and Small wins the tier,
`rec.onnx` alone is 21,159,378 B — over the limit — and it would be **silently dropped from the precache**
while the build still succeeded, because the default behaviour this record had to raise a limit to defeat
is exactly a silent exclusion. So: **any model-tier change re-opens the service-worker config; the tier's
largest asset must fit below the limit or the limit must rise.** Ticket 17 owns the config; DECISIONS/0012
F11's trigger 2 (the tier changes) is the moment this gets checked, and the `verify:footprint` drift guard
is what makes an unraised limit visible rather than assumed.

The generated `sw.js` in every raised-limit build contains `precacheAndRoute([...])` with
`revision: null` for content-hashed assets (filename hashing is the cache-buster), plus
`skipWaiting()`, `clientsClaim()`, `cleanupOutdatedCaches()` and a `NavigationRoute` bound to
`index.html`. That is exactly the DECISIONS/0012 F12 remedy: the Cache API is not subject to the HTTP
cache's per-entity limit that makes the 14.85 MB runtime re-download on every warm visit, and ticket 17's
acceptance bar ("a warm visit must move 0 bytes") is reachable with this one setting.

The **model assets are not build outputs** — `assets/models/*.onnx` and the dictionary are repo files
served at runtime, and the generated precache list contains no `.onnx` entry (checked). So the §9
model-cache contract (`providerVersion` + manifest hash keys, verified-before-activate, cleanup only
after activation) is ticket 17's own work — `additionalManifestEntries` or a runtime cache, not the glob.
Recorded for the ticket-10a design note (`docs/pwa-design.md`); **not decided here**.

No framework difference appears: same plugin, same Workbox, same numbers modulo the entry chunk size.
Per the rule this ticket was set with, a tie on a dimension is not a reason to switch.

## D6 — Privacy and dependency surface (standing rules, checked rather than asserted)

- Registry metadata for every candidate: `svelte` 5.57.3, `svelte-routing` 2.13.0 (0 deps),
  `svelte-spa-router` 5.1.1 (1 dep), `react` 19.3.1 (0 deps), `react-dom` 19.3.1 (1 dep),
  `react-router` 8.5.1 (2 deps), `vite-plugin-pwa` 2.0.0 (5 deps), `workbox-build` 7.4.1 (37 deps),
  `@vite-pwa/sveltekit` 2.0.0 — **none declares a `preinstall`/`install`/`postinstall`/`prepare` script**,
  so the script-free frozen-install posture (pnpm `allowBuilds` in `pnpm-workspace.yaml`) survives the
  choice. The probe itself installed with `--ignore-scripts`.
- Every built chunk was scanned for `http(s)` literals (artifact `dist[].externalUrlRefs`). What appears
  is documentation and error strings inside framework code (`svelte.dev/e/…`, `react.dev/errors/`,
  `reactrouter.com/…`, `rolldown.rs/…`, `web.dev/cross-origin-isolation-guide`, `bit.ly/wb-precache`) and
  XML namespace URIs (`www.w3.org/…`) — no request target, no CDN base, no telemetry endpoint in either
  candidate's output. §9's egress audit (ticket 18) still owns proving this at runtime.
- Install weight, recorded because it is a real if minor cost: `react-dom` unpacks 8.07 MB against
  `svelte`'s 2.95 MB (registry `dist.unpackedSize`), and `@vitejs/plugin-react` 6.2.1 declares three
  optional peer packages for its transform path (`@rolldown/plugin-babel`, `oxc-transform-react`,
  `babel-plugin-react-compiler`) where `@sveltejs/vite-plugin-svelte` 7.3.1 declares none of that kind.

## D7 — Alternatives considered

| option | verdict | why |
|---|---|---|
| **React 19 + Vite + TS** (the documented fallback) | rejected | 2.9× the shell at first paint (D1), nothing bought for it: ORT compatibility identical (D2), lazy splitting identical (D4), the same Workbox friction (D5). Its one measurable advantage is router quality (D3), and the routing rule that actually matters is framework-neutral. |
| **SvelteKit + `@sveltejs/adapter-static`** | rejected, not measured | File-based routing and `@vite-pwa/sveltekit` are real, but the app is a static bundle with a fragment-carrying link on a no-rewrite host; SSR/hydration machinery buys nothing and adds an `onnxruntime-web` hazard D0 avoids. The route count (3 views for all of v1) does not justify the toolchain. Revisit if routing outgrows the in-house module. |
| **`svelte-spa-router`** | rejected on measurement | Hash-only in v5.1.1, and in hash mode the ticket-16 link shape renders the wrong view (D3 table) or none. |
| **`svelte-routing`** | rejected on cost and maturity, kept as the fallback | Path routing works and was measured, but the documented `component={}` API throws under Svelte 5 and it costs 16,995 B raw for four static routes. |
| **No framework (hand-rolled everything)** | rejected | Cheapest by 39 KB of first-paint JS, and the v1 UI is exactly the reactive workload a runtime buys: derived exact shares recomputed on every add/edit/delete (§10/§11), lock blockers recomputed from state (§13), lifecycle views (§13). The shell ticket 10a ships is *almost* framework-free, which is why the baseline is measured and why the premium is stated rather than waved away. |
| **Vue 3 / Solid / Preact** | not evaluated | Not the default, not the documented fallback; G1 was a binary gate. Nothing found in v1's needs would be answered only by them. |
| **TanStack Router / wouter / `@tanstack/react-router`** | not evaluated as frameworks | Routing libraries; D3 settles routing regardless of the framework, and v1's router surface is one rule. |

**If the Svelte 5 ecosystem fails in practice, the fallback is React 19 on the same decisions, not a
re-argument.** If ticket 14 (IndexedDB migrations) or ticket 17 (service-worker update protocol) hits an
unresolvable Svelte 5 incompatibility, the documented fallback is **React 19 with the same in-house router
and the same Vite toolchain**. The router, the fragment-preservation rules (D3a) and the lazy-ONNX pattern
(D4) are framework-neutral and transfer unchanged; only the view layer and the ~200 KB of runtime differ.
The fallback is a component-layer swap under this same record, not a reopening of G1's evidence.

## D8 — What would overturn this, stated in advance

- A library the product genuinely needs that ships React-only. (The Svelte-5-incompatibility path is
  D7's fallback, which keeps this record's routing, fragment and lazy-load decisions intact.) Nothing in v1 does: IndexedDB is a browser
  API, §10's money is `BigInt`, ticket 16's codec is a bundled compressor plus WebCrypto, tickets 15's
  UPI/WhatsApp are URL builders.
- `onnxruntime-web` behaving differently under Svelte in a configuration this probe did not run (GPU/WebGPU
  provider, a worker-owned pipeline after DECISIONS/0007's deferral closes, or SSR). The probe ran CPU/WASM,
  which is what ADR-002 and ticket 04 ship.
- Routing needs growing past the in-house module's reach (nested/parallel routes, loaders, scroll
  restoration) → revisit `svelte-routing` (children API) or SvelteKit, not React.
- A re-measurement showing a different *ratio*: these numbers move with core's own bundle (a bigger parser
  shrinks the framework's share), so the delta and the reason — not the absolute — is the claim.

## D9 — Follow-ups this decision hands to other tickets

1. **DECISIONS/0012 F11 trigger 1 is now live**: "the PWA exists — tickets 10a and 10". Once the shell (and
   then the capture flow) is deployed, `pnpm measure:footprint` must be re-run and the README table
   regenerated: today's 21.3 MB / 14.8 MB pair is the harness's (`deployment.scope`), not the PWA's.
2. **Ticket 17** inherits: `maximumFileSizeToCacheInBytes` raised (D5) and re-checked on every tier
   change (D5's Tiny-shaped ceiling), one deliberate choice about the emitted-WASM copy versus `wasmPaths`
   (D4), and the model-asset cache contract that the glob does not cover (D5).
3. **Ticket 16** inherits the link shape (`https://<host>/#v1.…`), the "read `location.hash` raw, never a
   router param" rule, D3a's no-URL-decode-before-handoff rule (decoding is the codec's, and the codec
   owns it), and the measured fact that a 7,755-character base64url fragment survives intact.
4. **Ticket 10** inherits the lazy-boundary rule (D4): core stays eager because the bill view needs it, so
   nothing OCR-adjacent may be imported eagerly, or it lands in the first-paint chunk.

## D10 — The shell as it landed (2026-11-04)

`packages/pwa` is now a Vite + Svelte 5 app: `index.html` → `src/main.ts` → `App.svelte` with a header
wordmark, a three-link nav and `Capture` / `Bill` / `Share` / `NotFound` placeholder views, no product
behaviour. The router is `src/lib/router.ts` — framework-neutral by design, because D7's fallback claims
the routing layer transfers to React unchanged — with D3a's rules written into it and unit-tested in
`router.test.ts`, and the live history behaviour proved in Chromium by `playwright/shell.spec.ts`.

Built shell, from `packages/pwa/dist/app/.vite/manifest.json` and its assets: one entry chunk
**34,278 B raw / 13.34 kB gzip**, one CSS chunk **760 B / 0.41 kB gzip**, no code splitting (nothing in
the shell is lazy, because the shell imports neither core nor the OCR runtime), no `.wasm` in `assets/`.
Core joins the graph in ticket 10; that is when the DECISIONS/0012 F11 remeasurement becomes meaningful
(D9.1).

Two deliberate absences, both asserted by `playwright/smoke.spec.ts` so they cannot drift in silently:
no `onnxruntime`/`ort-wasm-simd-threaded` reference in any shell chunk (D4's lazy boundary), and no core
entry symbol in the bundle at all (10a is navigation and layout only).

## Artifact retention

`scripts/pwa-framework/` is a throwaway probe, and `results/framework-evidence.json` is 417 KB of
committed evidence for it. It is the re-derivation baseline for every number above, so it stays for now.
**Delete `scripts/pwa-framework/` — probe sources, `verify-evidence.mjs` and the artifact together — when
this ticket merges**, per the owner's ruling on probe lifetime; the numbers then live on only in this
record and in the shell's own tests. If a later revision supersedes G1 first, the same rule applies from
that moment: a published number outlives the session that measured it only while its artifact exists
(DECISIONS/0008), so pruning the artifact means annotating this record that the table is no longer
re-derivable rather than leaving an orphan check pointing at a deleted file.

### Deletion carried out — 2026-11-06, ticket 17 cleanup

`scripts/pwa-framework/` is deleted: probe sources, `verify-evidence.mjs`, its `package.json` + lockfile and
`results/framework-evidence.json`, together, as ruled. The directory had survived three tickets past the
merge that should have removed it, and ticket 17 found it only because a claim in `DECISIONS/0027` W1.1
needed checking against the tree rather than asserting from memory — it was the one place in the repo that
still named `workbox`/`vite-plugin-pwa`.

**Therefore, as this section's own rule requires in plain words: the G1 table above is no longer
re-derivable.** Every number in D1–D5 (first-paint bytes per candidate stack, the 39 KB framework baseline,
the 20 MiB ceiling behaviour, the 15,011,240 B precache figure) now lives on only in this record and in the
shell's own tests — `playwright/shell.spec.ts`, `playwright/smoke.spec.ts` and `packages/pwa/tests/`. Nothing
in the repository can regenerate the artifact or re-run the four probe builds. That is the accepted cost of
the ruling, not an oversight: `DECISIONS/0008`'s principle is that a published number outlives its session
*while its artifact exists*, and the owner decided in 2026-11-04 that keeping a permanent scaffold was worse.
A future revision that wants the table re-derivable would have to rebuild the probe, and should say so here
rather than discover it.

G1 itself is unaffected: the decision, the criteria, and the shipped consequences (Svelte 5 + Vite 8, the
lazy boundary, the hand-written router) are all tested in the suite that replaced the probe.

## What this record does not decide

- **The IndexedDB schema and the precache plan as design** — ticket 10a's design note
  (`docs/pwa-design.md`, this ticket's third deliverable) states the intent; tickets 14 and 17 implement
  them.
- Any UI, component library, styling or CSS approach. Placeholder views only.
- The fragment codec, encryption and the 8 KB enforcement (ticket 16).
- Whether `svelte-spa-router`'s hash mode could be configured differently: v5.1.1 offers no such option
  (its router writes `location.hash` unconditionally), which is the measured reason it is out.
- `PROJECT(1).md` is unedited (standing rule). §3 line 119's open choice and ROADMAP G1 are discharged by
  this record; §16's M3 first bullet ("Choose and document the PWA framework before implementation") is
  satisfied here and by the design note.
- Any claim about mobile hardware, real networks or cold-cache behaviour on a phone: DECISIONS/0012 F3/F4
  classes are what was measured, and the probe used loopback Chromium on this machine.
