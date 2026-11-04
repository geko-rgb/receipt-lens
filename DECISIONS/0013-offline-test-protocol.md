# DECISIONS/0013 — Offline-inference test protocol (the Tier-3 pins for ticket 09a)

Date: 2026-11-04 · Ticket 09a.

`PROJECT(1).md` §9 M1 fixes the claim — *"receipt images and OCR text are processed locally, and the
tested inference workflow succeeds after the app/model assets are available"* — and M1.3 fixes the
shape of the proof: *"Precache/download required assets, then block outbound network during processing
and verify inference still succeeds."* It does not say how to block, what to record, what counts as an
unexpected request, or how CI turns red. Those choices decide whether the test proves the claim or
merely decorates it, so they are pinned here before the test is written.

Nothing in this record weakens §9's own scoping: this is **M1, the core harness**, not the M3 full-PWA
audit (ticket 18), and it is not a claim that no conceivable exfiltration exists.

---

## T1 — Deployment under test

The harness page (`harness/index.html` + `harness/dist/main.js`) served same-origin by
`harness/serve.mjs`, in headless Chromium through Playwright. Not the PWA (10a/10 do not exist).

`BrowserContext` is created with `serviceWorkers: "block"`. There is no service worker today, so this
changes nothing now; it is set so that a future service worker cannot silently bypass
`context.route()`. Coverage limitation to state in the README: Playwright's interception of
service-worker traffic is Chromium-specific and not complete (§9 M3.4 anticipates this).

## T2 — Phase structure: precache → block → infer, never reload

```
launch context (serviceWorkers: block)
page.goto(/)
  wait for window.__receiptLensHarness to exist
PHASE A  precache: set #file -> await result   (network allowed, recorded, allowlisted)
         <-- this completed run IS the readiness proof: provider.load() resolved,
             manifest verified, both ORT sessions created, WASM compiled
PHASE B  block: context.route('**/*') -> abort every request
         context.routeWebSocket('**/*') -> record + close
         record blockStartedAt
PHASE C  clear #file, set #file again -> await a NEW result object
         no navigation, no reload, no second page
```

**Phase A readiness requires a non-empty `OcrResult` (`lines >= 1` and `words >= 1`).** An empty
result is a pipeline failure, not a readiness signal — the test fails **before Phase B begins**. This
prevents a broken pipeline from passing the offline test by producing nothing.

**Harness readiness signal is "Phase A returned a non-empty result", not a `sessionsReady` flag.**
The harness exposes `run`, `last`, `error`; models load lazily inside `run()`
(`provider.load()` at `harness/src/main.ts:37`), so no load-time flag exists. The non-empty-result
signal is stronger than a flag would be — it proves the full pipeline executed. **Do not add a
`sessionsReady` flag**; it would be a weaker check that could pass before inference actually runs.

**Why Phase C must not navigate or reload.** Ticket 08 measured that
`/ort/ort-wasm-simd-threaded.wasm` (14,848,852 B) exceeds Chromium's HTTP cache per-entity limit
(~6–8 MiB), so it re-fetches with status 200 on **every** reload — `DECISIONS/0012` F10/F12. A
`page.reload()` after blocking therefore fails for a cache-limit reason that has nothing to do with
the privacy claim. Ticket 17's Cache API is what makes an offline *reload* possible; 09a does not need
to prove that. §9 M1.3 itself says "during processing", not "during reload".

## T3 — Request-recording mechanism

Two mechanisms with different jobs, because one alone is insufficient:

| mechanism | job |
|---|---|
| `context.on("request")` | the complete log: every request Playwright observes, whether or not a route handles it |
| `context.route("**/*")` | enforcement: same-origin → `continue()`, cross-origin → record + `abort("blockedbyclient")` |
| `context.routeWebSocket("**/*")` | record and `close()` — `context.route` does not intercept WebSocket upgrades |
| `serviceWorkers: "block"` | removes the one channel context-level routing cannot fully observe |

**Each record is `{ phase, method, url (path + query), origin, resourceType, bodySha256 }`.** The body
hash is SHA-256 of `request.postDataBuffer()` when a body exists, `null` otherwise. **No body content
and no headers are ever logged**: headers can carry cookies and referrers, and the whole point is to
prove the image does not leave, not to create a second copy of user data in a CI log. The receipt
image's own SHA-256 is computed from the exact bytes handed to `#file` and compared to every
`bodySha256` seen — a hit is a failure, and it is the assertion that makes "no upload" a measurement
rather than an absence.

`context.on("request")` is the authoritative list for assertions; the route handler's log is what
proves enforcement happened. A request that appears in the event log but never reaches a route (for
example, a service-worker fetch on a browser that does not hand it to routes) still fails the test,
which is why both are kept.

## T4 — The same-origin allowlist, and the zero-request phase

**Phase A (network allowed):** exactly one origin may appear, and only these paths:

```
/                                        harness/index.html
/dist/main.js                            app bundle
/assets/models/manifest.json             provider manifest
/assets/models/PP-OCRv6_tiny_det.onnx    detection model
/assets/models/PP-OCRv6_tiny_rec.onnx    recognition model
/assets/models/PP-OCRv6_tiny_rec.txt     dictionary
/ort/ort-wasm-simd-threaded.mjs          ORT JS loader
/ort/ort-wasm-simd-threaded.wasm         ORT WASM
```

Absolute URLs and query strings are not allowlisted: the manifest pins relative paths, and a query
string on an asset request is not something this deployment produces. Repeated requests to a listed
path are permitted in Phase A (the threaded build re-fetches its loader once per worker — measured by
ticket 08), and each one is logged.

**Phase B/C (blocked):** the allowlist is empty. **Zero requests of any kind**, same-origin included,
may occur after `blockStartedAt`. A same-origin re-fetch during processing would mean the pipeline is
not running from memory, which is the thing M1.3 asks about.

## T5 — Failure conditions (all of them fail the test)

1. Any cross-origin request at any phase — origin, method and path reported.
2. Any same-origin request in Phase A outside T4's path list.
3. Any request at all after the block, of any origin or type, including WebSocket.
4. Any request body whose SHA-256 equals the receipt image's SHA-256.
5. Phase A produces no result, a result with zero lines or zero words, or `harness.error` is set.
6. Phase C produces no **new** result object (a stale `harness.last` is not a result; the marker
   technique from ticket 08's measurement is reused).
7. Phase C result has `lines.length === 0` or zero words — a zero-word result cannot distinguish
   "ran offline" from "failed quietly".
8. Any `console.error` or page error during the run.
9. Phase A observes more than one origin (a pre-cached third party would invalidate the allowlist).
10. The negative control (T6) does not fail — an egress monitor that cannot catch a deliberate leak
    proves nothing.

## T6 — The image, and the negative control

**There is no committed receipt image.** `benchmarks/datasets/raw/` is fetched and git-ignored;
`harness/out/` is build output and git-ignored. CI cannot fetch datasets, so Phase A/C cannot use
`ex.jpg`.

**Pinned: the receipt is synthesised at test time in the page**, driven by a committed fixture at
`playwright/fixtures/synthetic-receipt.json`: canvas geometry, the four text lines, the font, and the
reference output observed when the protocol was pinned (`{lines: 4, words: 7, text: ["RECEIPT",
"COFFEE 4.50", "TOTAL 100.00", "CASH 100.00"]}`, noted as *session-measured at Playwright 1.64.1 with
PP-OCRv6 Tiny; re-derive if model tier or Playwright version changes*). The fixture's draw parameters
are the source of truth for the canvas, so there is no second copy to drift.

The test asserts `lines >= 1` and `words >= 1` — robust to model drift — and the reference is
documentation of what working looks like, never an equality gate. The PNG bytes are hashed, handed to
`#file`, and never committed: no binary, no dataset, no PII by construction. If the model reads nothing
from the synthetic page, the test fails loudly and replacing it with a redacted real scan becomes a new
decision record — not a silent swap and not a weakened assertion.

**Negative control, separate test:** after the block, `page.evaluate(() => fetch("https://example.com/"))`
must produce a recorded cross-origin request that is aborted, and the same assertion helper used by the
main test must throw on that log. A second injection, a same-origin fetch to an unlisted path, must
also be rejected by T4's rule. Injecting at runtime rather than editing the harness source exercises
the same monitor the main test relies on; mutating `main.ts` to prove the monitor works would be
testing a build that never ships.

## T7 — Static scan: a labelled supplement

`scripts/scan-egress.mjs` (run as `pnpm scan:egress`) scans `packages/core/src`, `packages/pwa/src`
and `harness/src` for:

- `navigator.sendBeacon`, `new WebSocket`, `new EventSource`, `new Image(`, `form.action` assignments;
- `XMLHttpRequest` construction outside an allowlisted site;
- `import(` with a string literal that is an absolute `http(s)://` URL;
- any `fetch("http…")` or other absolute-URL literal; a `fetch(input)` whose argument is not a literal
  is reported as an indirect site and allowed, with its file:line printed in the output.

The scan's output is printed and its allowlist is explicit, so a reviewer can see what it tolerated.
The provider's one expected egress site is printed with this exact justification:

```
pp-ocrv6.ts:155 — provider fetch(input) where input is a manifest URL; runtime interception verifies same-origin. Re-review when manifest schema changes.
```
The README calls it a supplement: the runtime test is the proof, the scan catches a class of change
the runtime test cannot see (an unused or conditionally dead code path).

## T8 — CI wiring

`PROJECT(1).md` §9 names the file: **`.github/workflows/privacy.yml`**, on `pull_request` and on
`push` to `main`, job id `privacy`:

```
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:offline        # playwright test --config playwright/playwright.config.ts --grep @offline
pnpm scan:egress
```

`ci.yml`'s existing `pnpm test:e2e` becomes `--grep-invert @offline`, so the browser OCR run has
exactly one owner and the unit job does not pay for it twice; the smoke test stays where it is.

Branch protection must add `privacy` to the required checks. That is a repository setting, not a file
in this PR: the owner (or an admin token) has to add it, and this record notes it rather than
pretending the workflow is enforced by existing protection. `unit` remains required.

## T9 — What this test proves, and what it does not

**What this test proves:** after initial load with network enabled, inference runs to completion with
all outbound network blocked (context-level route + WebSocket route), no cross-origin request is made,
and no receipt-image body leaves the device.

**What this test does NOT prove:**

- **(a) Offline reload** — the 14.85 MB ORT WASM cannot be held in HTTP cache (`DECISIONS/0012` F12);
  ticket 17's Cache API is the remedy.
- **(b) Service-worker-originated traffic safety** — `serviceWorkers: "block"` avoids SW interception
  for M1, but M3's full-PWA audit (ticket 18) needs service-worker-level routing.
- **(c) Non-Chromium browsers.**
- **(d) No network requests outside inference** — app loading and deliberate sharing are separate §9
  M3 concerns.
- **(e) Mathematical impossibility of exfiltration** — this is an empirical demonstration, not proof.

## Re-derivability

Test output (request logs) is CI evidence, not a committed artifact; the protocol above is what is
committed. The 14.85 MB / ~6–8 MiB cache facts cited here come from
`benchmarks/results/footprint.json` and `DECISIONS/0012` F10/F12, not from session arithmetic.
