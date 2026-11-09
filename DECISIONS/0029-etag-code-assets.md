# DECISIONS/0029 — Conditional requests on code assets: what 17c changes, what it measures, and what it must not assume (the Tier-3 pins for ticket 17c)

Date: 2026-11-06 · Ticket 17c (pins) · **Status: binding for ticket 17c's implementation.**

`DECISIONS/0028` T7 handed this ticket one job: put an `ETag` on code assets so the worker's own module import
revalidates instead of re-downloading, and regenerate both footprint artifacts in the same commit. Ticket 08's
F10 already measured that `cache-control: no-cache` + `ETag` revalidates correctly on this browser for every
entity under the HTTP-cache size limit, and `DECISIONS/0012` F12 forbade header fixes as a *substitute* for the
Cache API — not as a repair for the one thing the Cache API structurally cannot intercept (W17.3, F12's own
exception).

**Four things the brief got wrong, found by reading the tree before writing any code.** They are in the pins
below, and the first is a blocker that must be fixed *before* the regeneration step, not during it:

- **(A) The baseline wiring 17b pinned was never installed, and 17c is the ticket that trips it.**
  `measure-warm-bytes.mjs:42` still reads the *canonical* `benchmarks/results/footprint.json` for its `before`
  block. Since 17b regenerated that file, running `pnpm measure:warm-bytes` **today** produces
  `before.secondVisitBytesOverTheWire = 6527` (was 14,848,852), `before.findingResolvedBy = "ticket 17"`,
  `before.deployment = packages/pwa/dist/app/index.html` under a hard-coded label reading *"ticket 08, harness
  deployment"*, and `before.redownloadedOnEveryVisit` **missing from the JSON entirely** — the field it reads
  (`totals.assetsRedownloadedOnEveryVisit`) no longer exists, and `JSON.stringify` drops `undefined`. The
  artifact would then report that ticket 17 reduced warm bytes from 6,527 to the new number, i.e. a ~1.2×
  improvement of a 2,275× story that actually happened. 17b's `rules.ts` already exports the correct reader —
  `harnessBaseline()`, pointed at the archived harness artifact, and pinned by a test that passes — but the
  **driver never called it**. So the rule exists, the test exists, and the thing the rule governs still does
  the wrong thing. Wiring it is 17c's first commit, before any measurement runs.
- **(B) The ticket file's expected value is arithmetically wrong under `DECISIONS/0012` F7.** It predicts
  `6,527 − 955 + ~200 B of 304 headers ≈ 5,572–5,772 B`. F7 excludes header bytes from every total, and both
  drivers sum `bodyBytes` from the origin log, so a `304` contributes **0 B**, not ~200. The outcomes are
  discrete, not a range: see P4.
- **(C) One server is not enough.** The brief names `serve-measure-app.mjs`; the shipping server is
  `scripts/serve-app.mjs`, and it is what every e2e spec and `scripts/storage-fixtures.mjs` runs against. A
  header change applied only to the measurement server publishes a warm number for an origin users never reach —
  precisely the F1 failure mode 17b was created to end. Both change, and a test proves they agree.
- **(D) Three existing pins in 17b's suite go red on purpose**, and a silent edit would be the same sin as a
  silent header: `pins.test.ts:194` asserts `deployment.cacheContract` contains `no-store`, `:467` asserts the
  measure server contains `no-store` **and no ETag** ("changes no shipping header while it is at it" — the guard
  that kept 17b out of this work), and `rules.ts`' `deployment()` text says the origin "answers no 304 to
  anything". They are updated in the implementation commit with the reason stated on the same line, and P5 lists
  them so a reviewer can check that exactly these three moved.

---

## P1 — ETag derivation: content hash, not filesystem metadata

**`etag = '"' + sha256(body).slice(0, 32) + '"'`** — a strong validator over the bytes actually served.

Why not `mtime`: the in-repo reference (`harness/serve.mjs`, `cacheMode: "validate"`, added by ticket 08 and
measured by F10 revalidating correctly) uses `"size-mtime"`. That is *correct* — a rebuild changes mtime, so a
changed file never yields a false 304 — but it is **not deterministic**: the same bytes get a different
validator after a rebuild that touched nothing, and `verify:footprint`'s job is to re-derive a published
measurement from committed inputs. A number whose conditional-request behaviour depends on when the working tree
was touched is not re-derivable. (mtime is still fine as a *memoisation key*, never as the value: see below.)

Why not the content-hashed filename alone: `/assets/index-0itO_252.js` already cannot change bytes without
changing name, so an ETag on those assets is arguably redundant — except that the three assets this ticket
exists for are exactly the ones where it is not redundant (`/sw.js`, `/assets/cache-names-*.js` is content-hashed
but re-fetched anyway, and `/assets/models/*` are *not* content-hashed: they are `PP-OCRv6_tiny_rec.onnx` and
friends, whose identity is their name and whose bytes move on a tier swap). So the validator is content, and the
model assets get it too.

**Cost and memoisation.** Hashing the 14,848,852 B WASM on every request is ~15 ms of CPU on the measured path
and would perturb the very latency numbers `footprint.json` publishes. The digest is therefore memoised per
`(absolute path, size, mtimeMs)` and recomputed only when one of those moves. The memoisation key may use
metadata; **the ETag value may not.**

**Shape.** Quoted, strong, no `W/`. No `Last-Modified` alongside it: two validators mean two ways to get a
wrong answer about which one the client was honouring, and `If-None-Match` is the only one this deployment's
correctness argument rests on.

## P2 — What gets the ETag, on which servers

**Both servers, identically, enforced by test:**

- `scripts/serve-app.mjs` — the shipping origin. This is the change that alters what users receive, and it is
  the reason the ticket exists rather than a side effect.
- `scripts/serve-measure-app.mjs` — the measurement origin, whose header docblock says it *is* the shipping
  server plus three test affordances. If they diverge, the published measurement describes neither.

**Pinned parity:** a test walks the asset classes and asserts both servers emit the same `cache-control`
directive and the same validator for the same bytes. Not a comment saying they should agree.

**P2 split, ruled at checkpoint 1 — two caching policies, not one.** The first cut put every static asset under
`no-cache`. That was wrong on the merits: a model is 6.3 MB and the runtime WASM 14.85 MB, both already held by
the worker's Cache API, so an HTTP-cache copy is a **second copy** that the worker never consults — it doubles
on-device footprint for zero warm-visit gain, and it opens a stale-weights path that bypasses the worker's
update protocol (`DECISIONS/0027` W5's verified-before-activate rule). So:

| Policy | Assets | Why |
|---|---|---|
| **`no-cache` + `ETag`** | `/assets/*.js` (entry, bundle runtime, worker module, runtime JS loader), `/assets/*.css`, `/sw.js`, `/manifest.webmanifest`, `/icons/*.png`, `/assets/models/manifest.json` | code and metadata: small, revalidated every visit, and the whole point of the ticket |
| **`no-store`, no validator** | `/assets/models/*.onnx`, `/assets/models/*.txt`, `/assets/ort-wasm-simd-threaded-*.wasm` | bulk binary: the Cache API owns it, an HTTP-cache copy would be dead weight and a staleness risk |

Emitting an `ETag` on a `no-store` response would advertise a validator the client is forbidden to use, so the
bulk assets get neither. `/assets/models/manifest.json` is in the `no-cache` group because it is *data about*
the models — 2,700 B, re-read every visit by design (W6's probe) — not model bytes.

**Two extensions of the approved list, made explicitly so they can be vetoed:** `/manifest.webmanifest` and
`/icons/*.png` were not named in the ruling. They are app static metadata and artwork, not bulk binary and not
user data, and their names are *not* content-hashed, which is exactly the case `no-cache` + a content validator
serves. `/assets/ort-wasm-simd-threaded-*.wasm` takes the ruling's `no-store` slot: the brief named
`/ort/*.wasm`, a harness mount that does not exist in this deployment (P2 above), and the emitted WASM is its
equivalent here.

**Not on the brief's list, and must not be added:** `/ort/*.wasm` — that mount belongs to the §9 M1 harness
server, which 17b deleted from the measured deployment. Grepping `packages/pwa` for `wasmPaths` returns nothing,
and W17 pins that no `wasmPaths` option may be introduced; the PWA emits its own hashed WASM. A header on a path
the product never requests is a change measured by nobody.

**Excluded: the HTML.** `/index.html` and the route fallbacks stay `no-store`, for two reasons, and the second is
the one that matters: on a warm visit the document is answered by the worker's navigation fallback
(`SHELL_NAVIGATION_FALLBACK = "/index.html"`, W4.1), so it generates no origin request at all and an ETag would
change nothing measurable; and a SPA shell answering arbitrary routes is exactly the response whose
freshness `beforeinstallprompt`/update-prompt behaviour depends on. If a future session wants to revalidate the
shell, that is a record, not a header tweak.

**`playwright/capture.spec.ts:66` has its own inline server** with `cache-control: no-store`, and
`playwright/offline.spec.ts:92` runs the harness server with `CACHE_MODE=no-store`. Neither is a measured
deployment and 17c does not touch them; **pinning that explicitly**, because a reviewer asking "why are there
three servers and only two changed?" deserves an answer in the record rather than in a commit message.

## P3 — The 304 shape, and the `no-store` → `no-cache` switch that is the actual change

For an ETag'd asset:

- **first response:** `200` with `cache-control: no-cache`, `etag`, `content-length` — for the `no-cache`
  asset group only (P2's split). `no-cache` means "you may store this, but ask me every time", which is the whole
  point: the browser keeps a copy to revalidate against, and the origin still sees a request, so
  `DECISIONS/0012` F5's byte accounting keeps working and the privacy audit still sees every request. Bulk
  binaries keep `no-store` and serve no validator at all.
- **`If-None-Match` equal:** `304` with `etag`, `cache-control: no-cache`, **no body, no `content-length`**.
  The origin log records `status: 304, bodyBytes: 0` — the existing `completed` marker (added by 17b for F9.7)
  must be set from the `end` callback of the header-only response, or every 304 looks like an interrupted
  download and 17b's F9.7 gate fails the run for a working feature.
- **`If-None-Match` different, or absent:** `200` with the body. No 412, no special casing.

**Privacy consequence, scoped by P2's split rather than discovered by ticket 18:** `no-cache` puts **code and
metadata** (~256 KB: chunks, worker script, stylesheet, icons, web manifest, model manifest) into the browser's
HTTP cache, which `no-store` forbade. Model weights, the dictionary and the runtime WASM do not — that is the
ruling's point, and it keeps the doubling of a 21 MB binary footprint off the table. No *user* data is ever
affected, because a receipt image is not a network request (`DECISIONS/0012` F7's exclusion, §9's claim). What
ticket 18 now has to describe is a three-surface story rather than two: the worker's Cache API (W18: requested
durability, not assumed), IndexedDB, and — for static code only — the HTTP cache. The defensible sentence is
"code assets revalidate, model data is never HTTP-cached, the worker's Cache API owns model caching", and it is
true of this deployment rather than aspirational.

## P4 — The re-derivation contract, and the three candidate warm numbers

**Order of work, pinned, because one step is destructive:**

1. Wire `measure-warm-bytes.mjs` to `rules.harnessBaseline()` so its `before` block names the archived harness
   artifact (surprise A). Prove it with a test that reads the committed artifacts, not a stub: the assertion is
   that `before.secondVisitBytesOverTheWire === 14,848,852` **while `footprint.json` publishes 6,527 B** — the
   exact state that makes the bug visible.
2. Only then change the headers, and only then regenerate.

**Both artifacts regenerate in one commit** (T7's condition). `measure:footprint` fails its run at ±0 unless
`warm-bytes.json` carries the same number the new headers produce, and `verify:footprint` compares them without
a browser, so a half-done 17c cannot pass CI.

**What the number can be.** Under F7 (headers excluded, bodies summed at the origin), the warm total is one of
exactly three values, each with a named mechanism:

| Outcome | Warm bytes | Mechanism |
|---|---:|---|
| neither revalidates | **6,527 B** | both fetches bypass the HTTP cache — the worker script update check is the browser's, and a worker's module import may inherit it |
| module chunk revalidates only | **5,572 B** | `/assets/cache-names-*.js` answers `304` (0 B) while `/sw.js` still answers `200` with its 2,872 B body. **This is the ticket file's prediction, and the most likely outcome.** |
| both revalidate | **2,700 B** | only the W5/W6 model-manifest probe still costs a body |

The table's middle row is written out exactly because the brief's arithmetic was wrong: 5,572 is not
"6,527 − 955 + headers", it is "6,527 − 955 − 0", and if it comes out at 2,700 the reason is that `/sw.js`
became conditional too, which the ticket file predicted it could not. **The measured value is published; the
estimate is not.** Whatever it is, `DECISIONS/0028` T3's cross-check target and `warm-bytes.json`'s declared
warm set are restated in the same commit, and the README row that reads "2,275×" is regenerated from the two
artifacts rather than edited.

**Cold was pinned at ±0 and the run falsified it: 21,719,232 B became 21,718,277 B, −955 B. Reported, not
absorbed.** The reasoning was sound and the outcome was not: a fresh context does have an empty HTTP cache, so
every *first* use of a URL is a 200 with a body — but a cold visit is not one fetch per URL. The worker fetches
its own module chunk with `cache: "reload"` for the precache, and then the worker's module graph fetch asks for
the same path again. Under 17b that second fetch downloaded 955 B again; under 17c it carries
`If-None-Match` and is answered `304`. So 17c did **not** change what the app requests, and cold moved anyway —
it changed how the origin answered a request the app already made twice. The consequence is published as
`totals.conditionalRefetchesPerColdVisit` and `conditionalRefetchPathsPerColdVisit`, and the cold-delta
paragraph in the README names it, because a table whose total shifted by an unexplained 955 B is exactly the
thing this ticket lineage was built to prevent.

**Falsified by the same measurement: 17b's own cold gate.** `assertColdSample` rejected *any* 304 in the cold
window, where `DECISIONS/0012` F9 condition 1 is about the **first use of a URL**. Invisible while the origin
answered no 304s; a false alarm the moment it could. Fixed to first-use scope, which also means the artifact now
reports revalidated refetches as what they are — evidence the fix landed — instead of failing a working run.
The original 0012 text was right; 17b's implementation of it was not, and the pin that caught it was the
measurement, not the test suite: `pins.test.ts`'s cold-304 fixture appended a *repeat* 304, which is now legal,
so that fixture had to be rewritten to fail a first-use 304. A test that stays green when the behaviour it
describes becomes permitted is the same "green rule, wrong behaviour" family as Blocker A.

`cacheHeldBytes` **did** hold at 21,459,809 B ±0, as pinned: it is a derivation from the built precache manifest
plus the committed model manifest, so nothing a response header does can move it — which is the check that makes
the derivation an actual derivation rather than a restated number.

## P5 — The cross-check is unchanged, and three pins change on purpose

**Unchanged:** `measure-footprint.mjs`'s warm median must equal `warm-bytes.json`'s exactly, tolerance ±0, and
neither driver may write the other's artifact. A disagreement is a finding to report, not a bug to fix by
editing a number.

**A null result is a valid result — and ruling 2 named the mechanism to look for.** If neither fetch becomes
conditional, 17c ships the header (still the right contract for a deployment whose assets are static), publishes
**6,527 B unchanged**, and records *why* rather than leaving the reader to guess. The candidate mechanism, cross-
referenced with 17b's duplicate-fetch finding: the worker precaches with `cache: "reload"`, which bypasses the
browser's HTTP cache entirely — so no cached copy exists, no `If-None-Match` is ever sent, and an origin-side
validator cannot help. If that is what the run shows, then:

1. 17c ships the header anyway, because it *is* correct for requests that do go through the HTTP cache (the
   first warm visit before the worker claims, and any fetch the worker does not make `reload`);
2. 17c publishes 6,527 B unchanged, with the measured per-path statuses in the artifact so the claim is visible;
3. 17c extends **17e**'s scope to "the worker's `cache: "reload"` precache bypasses the HTTP cache, which is
   both why the cold visit fetches the shell twice *and* why an ETag does not move the warm number" — one
   mechanism, two published symptoms, one owner;
4. the README cites 6,527 B with a footnote saying a warm-byte reduction requires 17e, rather than implying a
   fix that did not land.

**That branch is the difference between a ticket and a wish.** Forcing the number down by suppressing the actual
mechanism is the failure F12 was written to end.

**Pins that go red and must be updated in the implementation commit. Three were predicted; a fourth appeared
when the artifacts regenerated, and it is the instructive one — see the note under the table.**

| Pin | Where | From | To |
|---|---|---|---|
| cache contract | `pins.test.ts:194` | `cacheContract` contains `no-store` | contains `no-cache` **and** `ETag`, and still says no `304` is *required* for the pass condition |
| header guard | `pins.test.ts:467` | server contains `no-store`, no ETag | server emits a content-derived ETag and `no-cache` for code assets, `no-store` for the document |
| baseline witness | `pins.test.ts` T3 "holds the live baseline this ticket must not move" | `warm-bytes.json` reads 6,527 B | the witness exists, is deterministic across its 5 samples, describes the PWA, and **equals** the footprint table's warm median — a relationship, not a snapshot value |
| cold 304 fixture | `pins.test.ts` T2 | any 304 in the cold window fails | a 304 on a URL's **first use** fails; a repeat one is the fix working |
| baseline constants | `baseline-pins.test.ts` | `canonicalWarmBytes === 6527` | read from the tree, asserted only to *differ* from the 14,848,852 B archive |
| deployment text | `rules.ts` `deployment().cacheContract` | "answers no 304 to anything, so warm liveness is proven by …" | "answers `200` or `304`; code assets revalidate under `no-cache` + `ETag`, bulk binaries stay `no-store` with no validator; warm liveness is proven by **no body served over the origin** for anything the caches hold, and a `304` is evidence *for* the claim, not against it" |

**What the fourth red pin teaches.** It was written in 17b as "assert the witness file says 6,527 B", which is a
copy of a measurement wearing the clothes of a property. The moment 17c legitimately regenerated that
measurement, the pin went red for no defect at all. The rewritten form asserts the *relationship* — witness
exists, independent, deterministic, same deployment, equal to the table — and will survive any future number.
Pins should hold invariants; values belong in artifacts.

## P6 — Findings: append, never rewrite

- `warm_not_zero_ort_wasm_exceeds_cache_entity_limit` — stays exactly as 17b left it (`resolvedBy: "ticket 17"`,
  text verbatim). 17c does not touch it; the entity limit it records is untouched by an ETag.
- `warm_visit_served_by_service_worker` — 17b published the measured 6,527 B in its `detail`. That value is
  history and **is not edited**. The finding gains a `history` entry: the superseded number, the artifact and
  commit that measured it, the new number, and what changed. A reader who cites 6,527 B from a 17b-era clone has
  to be able to find both measurements in this file.
- `warm_worker_module_chunk_refetched` — gains `resolvedBy: "ticket 17c"` **only if the measured warm total
  actually stops paying for it**, with the measured byte count in the resolution text. If P5's null result
  happens, it stays open with the new reason.
- **New finding:** `sw_js_byte_check_conditional` (or `sw_js_byte_check_unconditional`, whichever the run
  shows), recording whether `/sw.js` became revalidatable. This is the ticket file's open question — "it
  probably cannot: a worker script fetch is the browser's, not the page's" — and 17c's job is to answer it from
  a run, not from a guess about Chromium.

## P7 — Warm classification becomes status-aware (three states, not two)

17b's rule was binary: a catalogued asset *appearing* in the warm origin log was the violation, because with
`no-store` the only reason to appear was a full re-download. After 17c, appearance is **expected** and body bytes
are the violation. So `assertWarmSample` must classify by status:

| State | Meaning | Verdict |
|---|---|---|
| absent from the warm log | the active caches answered it | pass — the claim |
| `304`, `bodyBytes === 0` | revalidated over the wire, body not moved | pass — and worth naming in the table |
| `200` with `bodyBytes > 0` | a body was served on a warm visit | **fail** — unless structural, and the structural set shrinks |

`footprint.json`'s per-asset warm field becomes a three-valued `warmVisitOutcome` (`worker-served` /
`revalidated-304` / `redownloaded-200`) instead of 17b's `warmVisitCacheState` pair, and the README's "Held for
the next visit" column prints all three. **The reason this is a pin and not a detail:** left binary, the table
would render the biggest win of the ticket as "**no** — 0 B paid again, 10/10 warm visits", which is literally
true and rhetorically the opposite of what happened. A measurement that reports an improvement as a failure
state has not been updated, only re-run.

### P6 amendment — a supersession caused by a bundle move is a history entry too (2026-11-09)

P6 as written assumes the only reason a run supersedes another is the ETag, i.e. that the warm total moved. The
2026-11-09 re-derivation (`fb200ee`, `DECISIONS/0012` F11 trigger 1) broke that assumption: the parser and review-UI
commits grew the shell, which moved the published byte totals (initial download 21,718,277 → 21,810,197 B; held
21,459,809 → 21,505,769 B) while the warm path stayed at one 2,700 B manifest probe. Under P6's old condition the new
artifact carried **no** `history` entry, and `render-footprint-table.mjs --check` refused it: P8's latency comparison
has no superseded run to name, so the reader would have seen a table whose numbers moved with no artifact explaining
which run they replaced.

`buildFindings` therefore takes an optional `supersedesCause` and appends the history entry when it is supplied even
if the warm total is unchanged. `measure-footprint.mjs` supplies it only when the *derived* `cacheHeldBytes` differs
from the superseded artifact's, and the text is generated from those two numbers rather than written by hand. Nothing
else in P6 changes: the finding's `detail` is never edited, the entry names the superseded artifact, its measurement
time and the revision that replaced it, and a run with nothing changed still appends nothing (both cases are pinned in
`benchmarks/tests/footprint/etag-pins.test.ts`).

## P8 — What must not change, and how it is checked

- **Latency.** Only byte measurements should move. If cold or warm `firstResultMs` shifts more than the run's own
  spread, that is a 17c finding to report before committing, not a line to re-baseline — the ticket is a header
  change, and a latency number that moved with it would mean the change altered execution, not validation.
  (`footprint.json` publishes min/max/n, so this is checkable from the artifact rather than from memory.)
- **Model bytes.** 6,279,992 B across det/rec/dictionary, byte-identical, hashes pinned in
  `assets/models/manifest.json` and re-hashed by `verify:footprint`.
- **Worker, precache strategy, model tier, COOP/COEP.** None of them. `maximumFileSizeToCacheInBytes` stays
  absent (W1.1's build-time guard is the mechanism). No `wasmPaths` in `packages/pwa` (W17).
- **The gates** `verify:footprint` and `verify:warm-bytes` stay green and keep re-deriving from this tree; the
  new parity test from P2 joins them.

## What this record does not decide

- **The duplicate-fetch optimisation** — cold pays 252,946 B twice over because the worker precaches with
  `cache: "reload"`. That is `17e`, post-v1, and it is *not* folded in here: one mechanism per ticket, or the
  pre/post delta stops being attributable (F3, T7).
- **Whether ticket 18 waits for 17c.** The 17c ticket file says it is a sequencing call, and 17b's merge already
  unblocked 18 against the current honest table. If 17c lands, 18 cites post-17c numbers; if 18 runs first, it
  cites 6,527 B and 17c's regeneration is a deliberate, recorded change to a table 18 already cited.
- **`docs/adr/0002`'s wording**, which 17b handed to 18 as a dated amendment. 17c changes the numbers that
  amendment will cite — "not free" → "6,527 B pre-17c, measured post-17c value" — and still does not edit the
  ADR, because the edit surface of a claims ticket belongs to the claims ticket.
- **Whether `no-cache` is the right long-term contract** for a deployment whose code assets are content-hashed.
  For `/assets/index-<hash>.js` an immutable cache would be faster still; this ticket deliberately does not go
  there, because "always revalidate" is what the current privacy and update-prompt story assumes.


---

## Checkpoint-1 rulings (2026-11-06), and what each one changed in this record

| | Ruling | Effect |
|---|---|---|
| 1 | **Blocker A lands in 17c commit 1**, not a separate ticket | Done first: `warmBytesBeforeBlock()` in the rule module, the driver calling it, and a test bound to the *driver* rather than the rule. Three of four assertions were red before the wiring; the one that was already green is the lesson — a green rule test did not make the behaviour correct |
| 2 | **Null result pre-authorized**, with the mechanism named | P5 rewritten: `cache: "reload"` is the candidate cause, 17e absorbs it, README footnotes 6,527 B rather than implying a fix that did not land |
| 3 | **`no-cache` for code only; models and WASM keep `no-store`** | P2 split into two policy rows; P3 and the privacy paragraph scoped accordingly; the 14.85 MB WASM and the 6.3 MB model set never enter the HTTP cache |
| 4 | **18 waits for 17c** | The 17c ticket file's "Blocks: *potentially* 18" becomes a real block: any of the three outcomes changes what the README must cite, so the audit is written against the final number |

Two corrections to earlier text, kept visible rather than silently edited: the ticket file's `5,572 B` estimate
added ~200 B of `304` header bytes to a total from which `DECISIONS/0012` F7 excludes headers, and this record's
first cut put the model weights under `no-cache`, which would have doubled the on-device binary footprint to
optimize 955 bytes.

---

## Checkpoint-3 finding — P8's stop trigger fired on one latency cell, and it is reported, not re-rolled

`DECISIONS/0029` P8 said: if a latency number moves more than the run's own spread, report before committing. It
moved.

| cell | 17b committed | 17c committed | ranges overlap |
|---|---:|---:|---|
| unthrottled cold `firstResultMs` | 1,206.0 ms | 1,256.7 ms | **no** (1,186.7–1,226.1 vs 1,228.6–1,310.0) |
| unthrottled warm | 618.7 ms | 623.5 ms | yes |
| unthrottled repeat | 426.2 ms | 434.3 ms | yes |
| 4× cold | 3,670.8 ms | 3,817.6 ms | yes |
| 4× warm | 2,308.8 ms | 2,375.2 ms | yes |
| 4× repeat | 1,566.3 ms | 1,686.5 ms | yes |

Three pieces of evidence, and none of them is a mechanism claim:

1. **Same-code variance exceeds the gap.** The 17c code on this branch measured unthrottled cold at **1,213 ms**
   in the pre-commit pass (a dirty-tree run, discarded, not published) and **1,257 ms** in the committed run — a
   44 ms swing with nothing in the deployment changed. 17b's own five runs of identical code spanned
   1,206–1,240 ms.
2. **The committed 17c run drifts within itself.** ~~Its five cold samples are 1,228.6 → 1,229.5 → 1,256.7 →
   1,276.3 → 1,310.0, monotonic across ~6 minutes.~~ **Corrected before merge: that is the sorted array, not the
   run order, and in run order the first sample is the maximum — see the verification section at the end of this
   record.** 17b's committed run's samples are flat. A trend inside a run is
   machine state, not a property of the code under measurement.
3. **The plausible mechanism is four orders of magnitude too small.** The header change adds one conditional
   round trip over loopback per revalidated asset. Loopback RTT is microseconds; the gap is 51 ms.

Disposition, and why it is this one: **publish the measurement as taken, and attach the variance evidence.**
The alternative — re-running until the cell lands inside the old range — is fitting a measurement to an
expectation, which is the specific act `DECISIONS/0012` F10 and ADR-002 exist to forbid. The number in the
artifact is the one the tree produced; the claim a reader should take is "unthrottled first result is about
1.2–1.3 s on this machine, and this deployment's latency is not separable from this machine's run-to-run
variance at better than ~5%". That sentence belongs in the README's emulation caveat area for ticket 18 to
own (it is a claim about claims), and it is flagged here rather than written into the generator, because
17c's scope was headers and bytes.

**What this costs the next session to know:** a footprint table with five samples per cell on a single desktop
cannot resolve a 4% latency difference. If latency ever needs to be *compared* between tickets rather than
published, the comparison needs interleaved A/B runs in one process — not two artifacts measured an hour apart.

### Checkpoint-3 verification, before merge: one sentence above is wrong about its own evidence

Evidence 2 was checked against the committed `runs[]` array, and it does not say what the record claims.

The five unthrottled cold samples **in run order** are 1,310.0 → 1,228.6 → 1,229.5 → 1,256.7 → 1,276.3. The
monotonic sequence quoted above (1,228.6 → … → 1,310.0) is the **sorted** array, which is also how `samples[]`
reads once the driver pushes them, and the sentence mistook the sorted list for the timeline. A trend inside a
run is only evidence of machine state if it is a trend: what the artifact actually shows is a run whose
**first sample is its maximum** — the shape you expect from a cold Chromium profile and a cold WASM compile
cache, not from drift.

What survives the check, and carries the same conclusion without the trend:

| claim | in the artifact | 17b (6b3ca50) | 17c (2782934) |
|---|---|---:|---:|
| unthrottled cold range | `latency…cold.firstResultMs.min/max` | 39.4 ms (3.3% of median) | 81.4 ms (6.5%) |
| 4× cold range | same, `desktop-chromium-cpu4x` | 267.2 ms (7.3%) | 574.4 ms (15.1%) |
| samples with no trend | `runs[]` in order | down-up-down-up | max first, then a rise |
| ranges overlap | min/max of the two runs | — | **no**: 1,226.1 < 1,228.6 |

17b's samples are not "flat" either — they are a 39 ms range with no direction. The 17c run is simply noisier
in every cell (its 4× repeat series is 1,569.8–1,729.0 with one 2,039.2 outlier), which is the honest form of
the argument: the run-to-run and within-run spread of this machine is several times the size of the difference
being attributed to a response header.

**Disposition unchanged — published as measured, not re-rolled** — and the README now carries the comparison
with its per-cell ranges, so a reader sees the non-overlap rather than being asked to trust a footnote. The
lesson is sharper than the one originally written: a claim about a *trend* needs the run order, and every claim
in this lineage has to be re-readable from the field it cites, including the claims this record makes about its
own measurement.

**P8, in the form the README cites.** Latency stop trigger fired on unthrottled cold `firstResultMs` —
1,256.7 ms against 17b's 1,206.0, +50.7 ms (+4.2%), ranges non-overlapping. Published as measured, not
re-rolled. The same code on this branch measured 1,213 ms in a pre-commit pass; the committed run spans
1,228.6–1,310.0 with its maximum in the first sample, while 17b's five samples span 1,186.7–1,226.1 with no
direction. The only mechanism the header change supplies is one conditional round trip over loopback per
revalidated asset — microseconds, four orders of magnitude short of 51 ms. So the gap is not attributable to
this ticket, and five samples on one desktop cannot resolve 4% anyway: a cross-ticket latency comparison needs
interleaved A/B runs in one process, which is a follow-up ticket, not a re-run of this one.

---

## Implementation finding 9 — two strings in the committed artifacts described the ticket that wrote them, not the deployment measured

`DECISIONS/0012` F1's discipline applies to prose as much as to bytes: a published artifact may not assert
something the deployment contradicts. Three strings did.

| Where | Said | Contradicted by |
|---|---|---|
| `footprint.json` `measurement.phases.warm.description` | "…because this origin answers no `304`" | `totals.assetsRevalidatedOnWarmVisits` in the same file: this origin answered `304` twice on every warm sample |
| `footprint.json` `warmStructuralRequests[]` for `/assets/cache-names-*.js` | "the open defect ticket 17c owns" | `findings[].code: warm_worker_module_chunk_refetched`, `resolvedBy: "ticket 17c"` in the same file |
| `warm-bytes.json` `deployment.servedBy` | "`cache-control: no-store`, exactly as the shipping server" | the two-policy contract P2 ruled, in `footprint.json`'s `deployment.cacheContract` |

**Mechanism.** The F8 phase text and the structural reasons were literals in `measure-footprint.mjs`, and the
served-by line was a literal in `measure-warm-bytes.mjs`. P5's pin updated the one copy of this class that
already lived in the rule module (`deployment().cacheContract`), so the copies that had not been moved drifted
silently — the same "a green rule does not make the behaviour correct" family as Blocker A, one level down.

**Fix, and why it is not a hand edit of a measurement.** The phase descriptions and the structural reasons now
come from `rules.ts` (`phaseDescriptions()`, `warmRequestReason(path, outcome)`), both drivers call them, and
`render-footprint-table.mjs` fails when a committed artifact's prose differs from what those functions derive
from that artifact's **own numbers**. The two committed artifacts were then repaired by calling those same
functions, not by typing sentences. No numeric field moved: cold, warm, `cacheHeldBytes` and every latency
sample in this file are the ones the run produced, so P8's "published, not re-rolled" disposition is untouched
by this repair. Where the correction needed a fact the driver measures rather than derives — which asset
carries the whole warm cost — the sentence is now assembled from the artifact's paid-path list, so the finding
naming 2,700 B also names W6's `cache: "reload"` probe as its mechanism.
