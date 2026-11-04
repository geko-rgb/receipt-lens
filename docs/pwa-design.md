# PWA design note — IndexedDB schema plan and service-worker precache plan

Ticket 10a · 2026-11-04 · **Intent, not implementation.** Ticket 14 builds the persistence layer and the
migration rig; ticket 17 builds the service worker and the model cache. This note exists because
`PROJECT(1).md` §3 line 119 requires the framework decision to be documented *with* "its service-worker
precache and IndexedDB design", and because gate G1's exit bar (ROADMAP 3A.1) is "precache + IndexedDB
design documented; shell deploys". Framework choice: `DECISIONS/0017-pwa-framework.md`.

Everything below is keyed to the spec sections it comes from. Where the spec fixes a rule, the rule is
quoted or cited; where this note chooses, the choice is labelled **intent** and the ticket that implements
it may revise it — with a record, not silently.

---

## 1. IndexedDB schema plan (ticket 14 implements)

One database, `receipt-lens`, with a monotonic `DB_SCHEMA_VERSION` starting at 1 (§10 "IndexedDB
versioning and migrations"). Object stores are tables; each record is a plain JSON-serialisable object
matching §10's entity, and §10's `ExactMoney` stays `{ numeratorPaise: string; denominator: string }` on
disk — decimal strings, so a stored share never loses exactness to a float.

### 1.1 Stores, keys and indexes

| store | keyPath | indexes | §10 source |
|---|---|---|---|
| `bills` | `id` | `creatorId`, `createdAt` | `Bill` (title, creatorId, payerId, isLocked, taxIncluded + source, grandTotal + source) |
| `participants` | `id` | `billId`, unique `billId+token` | `Participant` (name, paid, token, tokenExpiresAt) |
| `draftItems` | `id` | `billId` | `DraftItem` — nullable price/qty, provenance fields kept verbatim |
| `draftCharges` | `id` | `billId` | `DraftCharge` — `amount`, `included`, `otherSign` may be null |
| `items` | `id` | `billId`, `billId+unitIndex`? no — see `units` | `Item` — no nulls allowed in a finalized record (§10: finalized `Item`/`BillCharge` may not contain nulls) |
| `units` | `id` | `itemId`, unique `itemId+unitIndex` | `ItemUnit` — `unitIndex` 0..qty−1, `confirmedUnassigned` |
| `assignments` | composite `[itemUnitId, participantId]` | `itemUnitId`, `participantId` | `ItemUnitAssignment`; the composite key *is* the duplicate rejection §10 requires |
| `charges` | `id` | `billId`, `billId+type` | `BillCharge` — `amount` integer paise, `included` a confirmed boolean |
| `adjustments` | `id` | `billId` | `AdjustmentLine` — v1 reason is `unassigned` only |
| `unclassifiedRows` | composite `[billId, id]` | `billId` | core's `UnclassifiedRow` (`ambiguous` rows a reviewer must still see) |

**intent.** `assignments` uses a compound key rather than an `id` plus a uniqueness index, because
"reject duplicate `(itemUnitId, participantId)` pairs" (§10) is then enforced by the storage layer itself
instead of by application code that can forget to run.

**intent.** Nothing in this list is a *derived* value. `calculatedItemsTotal`, `calculatedSubtotal` and
participant shares are recomputed on load and never stored — §10: "Shares are recomputed on load and never
trusted from a cache." A stored share would be a second source of truth that a migration can silently
stale.

**open, for ticket 14 to settle:** `WorkingBill` also carries `parseResult` and `parseValidation`, and
`Bill` carries `adjustmentLines` inline in §10 while the table above puts them in `adjustments`. Both
readings are spec-compatible. Recommendation: keep the §10 inline array on the `bills` record for
adjustments (it is small, always loaded with the bill, and has no independent lifecycle), and store the
parse artefacts under a `billId`-keyed `parseSnapshots` store so a draft can be re-reviewed after reload
without re-running OCR. Ticket 14 may choose otherwise; the decision belongs in a `DECISIONS/` record
either way, because it is a schema question and the schema is versioned.

### 1.2 Transactional invariants

Each of these is a multi-store transaction in one `IDBTransaction`, not a sequence of puts (§10):

- `count(units where itemId = X) === Item.qty` whenever quantity changes. Growing quantity appends units
  with the next free `unitIndex`; shrinking removes the highest-index units **and their assignments in the
  same transaction** (§10 edit flow: "no assignment to a deleted unit may survive").
- Finalizing a draft (draft → `items`/`charges`) removes the draft row and creates the final row
  atomically; unit materialisation happens only after finalization ("Do not materialize units from
  unresolved quantities").
- `confirmedUnassigned` and assignments are mutually exclusive; assigning a unit to anyone clears
  `confirmedUnassigned` in the same transaction (§10).
- Every write path ends with the §10 recalculation order: derived exact totals → core `validate(parseResult)`
  where parse-derived findings apply → PWA `validateWorkingBill(workingBill)`. The shell never renders a
  blocker by parsing warning *text*; finding codes are the UI contract (DECISIONS/0007 handoff, ticket 07).

### 1.3 Migration contract

- Sequential `onupgradeneeded` steps from each supported prior version; a released migration is never
  edited in place (§10).
- A failed migration **aborts the version-change transaction**; the UI shows a recoverable error. No
  silent `deleteDatabase`, no empty-database fallback, no replacing failed data (§10).
- An obsolete store is dropped only after its data has migrated successfully.
- Migration tests run for every supported prior schema, including bills with drafts, participant
  assignments, exact-share cache fields and unassigned-unit acknowledgements, plus abort/rollback cases.
- A local JSON export exists before any migration that cannot be made lossless (§10; ROADMAP R6's
  mitigation).
- The app DB version stays separate from `BillShareSnapshot.snapshotVersion` and the link format version
  (§10) — three different compatibility surfaces, one number each.

**intent.** Nothing in `bills`…`unclassifiedRows` ever holds a receipt image or raw OCR text. §10's capture
rule is that images are not persisted by default, and ticket 16's snapshot rule is that the share payload
carries resolved data only. Persistence and sharing therefore share one guarantee: the sensitive artefacts
are not in the stores this schema defines.

---

## 2. Service-worker precache plan (ticket 17 implements)

### 2.1 What is precached, and why that split

Measured facts this plan starts from (DECISIONS/0012 F10/F12, re-measured for candidate stacks in
`DECISIONS/0017` D5):

- `ort-wasm-simd-threaded.wasm` is 14,848,852 B and **exceeds Chromium's HTTP-cache per-entity limit**, so
  it re-downloads as a `200` on every warm visit. The Cache API is not subject to that limit, so precaching
  this one file is what turns a warm visit into 0 bytes.
- Under Vite/Rolldown, that WASM is a **build output** (`assets/ort-wasm-simd-threaded-<hash>.wasm`), so it
  is globbable by the service worker without any runtime download step.
- Model assets (`PP-OCRv6_tiny_det.onnx` 1,780,590 B, `PP-OCRv6_tiny_rec.onnx` 4,462,639 B, dictionary
  34,063 B) are repo files served at runtime, **not** build outputs. The generated precache manifest
  measured in the probe contains no `.onnx` entry: a glob cannot see them.

| asset class | on install? | reason |
|---|---|---|
| app shell: `index.html`, hashed JS/CSS chunks, icons, `manifest.webmanifest` | **precached on install** | small, content-hashed names, needed for an offline start |
| `ort.wasm.bundle.min-*.js` glue chunk (74,322 B) and the 14.85 MB threaded WASM | **precached on install** | they are build outputs with content-hashed names, and F12's remedy is precisely to hold the WASM outside the HTTP cache |
| the lazy OCR chunk (whatever core exposes behind the dynamic import) | **precached on install** | it is a build output too; precaching it costs nothing and keeps a first offline capture attempt from failing on a missing chunk |
| model assets (det/rec ONNX + dictionary) | **on demand**, keyed `providerVersion:manifestHash` | §9's cache-invalidation contract: download fully, verify against the manifest, run a smoke inference, activate, and only then delete the superseded set |
| receipt images | never | §10: not persisted by default |

So: **app shell + core assets on install; models on demand.** That is also the shape ticket 17's acceptance
tests already assume — "installing, going offline, reloading and running a full capture-to-draft flow
succeeds without network" requires the model set to be present, which it becomes through the verified
download path, not through the install-time precache.

### 2.2 Tooling and the one config that matters

`vite-plugin-pwa` 2.0.0 with Workbox 7.4.1, `generateSW` strategy, `injectRegister: null` (ticket 17 owns
registration so it can be tested). Measured in the probe against both candidate frameworks, identical
results:

- At the plugin's defaults, with `globPatterns: ["**/*.{js,css,html,wasm}"]`, **the build fails** with
  `Configure "workbox.maximumFileSizeToCacheInBytes" to change the limit: the default value is 2 MiB`, and
  the WASM is silently excluded from the manifest.
- With `maximumFileSizeToCacheInBytes: 20 * 1024 * 1024`, the build succeeds and the generated `sw.js`
  precaches 6 entries / 15,011,240 B (Svelte shell), including the WASM, plus `skipWaiting()`,
  `clientsClaim()`, `cleanupOutdatedCaches()` and a `NavigationRoute` bound to `index.html`.

**intent.** `generateSW` is the right strategy *for the shell*. Ticket 17's model-update protocol —
download, verify, smoke, activate, then clean up — is `precacheAndRoute`-independent and will most likely
need `injectManifest` (a custom worker) to express the verification gate, because `generateSW` cannot
"keep the old set until the new one verifies" for a runtime-downloaded asset. Recommendation: start on
`generateSW` for the shell precache, and switch to `injectManifest` in ticket 17 if the update protocol
cannot be expressed on top of it. DECISIONS/0017 D5 is the measurement that makes the choice safe either
way.

**The 20 MiB limit is Tiny-shaped, not generous.** Tiny's largest cacheable asset is the 14.85 MB WASM; if
DECISIONS/0015's revisit condition ever fires and Small wins, `rec.onnx` alone is 21,159,378 B, over the
limit, and it would be silently dropped while the build still succeeds. Any tier change re-opens this
config (DECISIONS/0017 D5, DECISIONS/0012 F11 trigger 2).

### 2.3 Caches, keys and invalidation

- Two caches, deliberately separate: the Workbox precache for build outputs (content-hashed names, so
  `revision: null` is correct and a filename change *is* the invalidation), and a model cache keyed
  `providerVersion:manifestHash` (§9). A shell update must never orphan a model set, and a model update
  must never look like a shell update.
- Model cache activation order: fetch → hash-verify every asset against the manifest → create sessions →
  one smoke inference → only then remove superseded caches. A failure at any step leaves the previous set
  in place and surfaces a visible model-update-pending state (§9, ticket 17 boxes 2–4).
- `cleanupOutdatedCaches()` handles precache revisions; it is not the model cache's cleanup mechanism and
  must not be treated as one.
- **intent.** Offline start is served by the `NavigationRoute` → `index.html` fallback. This is also what
  makes a deep link survive without a server rewrite; share links still anchor at `/` with the payload in
  the fragment (DECISIONS/0017 D3a), so the fallback is a convenience, not a requirement for a recipient's
  first open.
- **intent.** `wasmPaths` should not be pointed at a separate `/ort/` mount in the shipped app. The probe
  measured the duplication that creates: the bundler emits its own hashed copy (precached) while the
  runtime fetches the mount's copy (used, and never cached). Let ORT resolve its emitted asset so the
  precached copy *is* the used copy.

### 2.4 What ticket 17 must be able to prove

1. Warm visit moves 0 bytes over the wire — F12's remedy claim, and the concrete bar ticket 08 set.
2. `pnpm measure:footprint` re-run, `secondVisitBytesOverTheWire` down, README caveat updated, and the warm
   exception set in `measure-footprint.mjs` **removed** (that failure is the drift guard working).
3. DECISIONS/0017 D9.1: the published 21.3 MB / 14.8 MB pair is the harness's, and it must be regenerated
   once the PWA actually exists — including the shell's own chunk sizes, which are now known
   (34.3 KB entry / 0.8 KB CSS at ticket 10a; core joins the graph in ticket 10).
4. Playwright scenarios: version bump, hash mismatch, partial download, offline start — cleanup only after
   verified activation.
5. The egress audit (ticket 18) covers the service worker's own requests: same-origin only, no third party,
   no telemetry in `vite-plugin-pwa`/Workbox. The dependency check at G1 found no install hooks and no
   request targets in the built chunks (`DECISIONS/0017` D6); a runtime audit is still required.

---

## 3. Shell state (for completeness)

The ticket 10a shell has no state beyond the route: `packages/pwa/src/lib/router.ts` resolves
`(pathname, rawFragment)` to a view, and `App.svelte` holds `route`, `fragment` and a render counter that
exists to prove D3a condition 1. There is deliberately no store, no IndexedDB call, no service worker and
no OCR import yet — `playwright/smoke.spec.ts` fails the build if any of those appears in the bundle
before its ticket does.

**One thing ticket 16 must notice about the share view.** To make D3a condition 3 assertable, the shell
publishes the raw fragment into a DOM attribute (`data-raw` on `Share.svelte`) — a bearer secret, rendered.
It is test scaffolding and ticket 16 replaces it with the decoded view, but the rule it demonstrates stays:
the fragment may be read, decoded and rendered, and must never be copied somewhere that outlives the page —
not IndexedDB, not a console log, not an error-report payload. §10's snapshot rule (never the receipt image,
never raw OCR) and the sharing-link rule in `GLOSSARY.md` (a link is a bearer secret, not access control)
both apply to the decoded contents, not only to the URL.
