# 14: Bills that survive a schema change

**What to build:** Past bills and the creator's payee profile live in one local database that upgrades itself forward through explicit, tested migrations and exports to JSON before any migration that cannot be lossless — so a future schema change can never silently wipe a user's bills.

**Blocked by:** 11 (bill editor transactions)

**Status:** in-review (branch `ticket/14-local-persistence-and-migrations`, pushed, CI green, PR open awaiting merge)

**Effort:** ~32 h · **Roadmap:** workstream 3A (tasks 3A.2–3A.4) · **Week:** W12–13 · **Milestone:** M3
**Verify:** migration rig green from every supported prior schema version, including abort/recovery fixtures

- [x] One named local database with a monotonic schema version and migrations applied inside a transaction, sequentially, from every version the app still claims to support
- [x] A failed migration aborts and leaves recoverable state; no store is deleted prematurely and no partial migration is left applied
- [x] Every schema version has a migration test that starts from a real prior-version fixture and asserts the upgraded data
- [x] A JSON export is produced before any migration that is not provably lossless, and the user is told where it went
- [x] Past bills and the payee profile round-trip through storage and are listed on return, with empty-state behaviour defined
- [x] Receipt images remain absent from storage unless the creator opted into retention, and opting out or deleting removes them

## Forwarded from ticket 13 (owner ruling, 2026-11-05)

Ticket 13's `<Units>` roster is unreachable until finalization (`Bill.svelte:331-369` renders it inside the
`{:else}` of `{#if working.items.length === 0}`), so a creator cannot add participants while a bill is still in
`draft`. Consider whether participants should be addable before any item exists — persistence may require it.
Not a bug, a UX decision worth revisiting at 14.

## Delivered (2026-11-05)

Rules: **`DECISIONS/0023-persistence-migrations.md`** — P1 what persists, P2 the three stores, P3 the
two-phase open and what an abort guarantees, P4 the four lossless clauses and the export gate, P5 the two-tab
refusal, P6 retention, P7 the save trigger and the two empty states, P8 the roster, P9 fixture realism, P10
the three failure surfaces, S1/S1a the seam as shipped, P12 ticket 13's forwarded notes.

Verify line — **migration rig green from every supported prior schema version, including abort/recovery
fixtures**, with the honest reading: every supported prior version of a version-1 schema is the no-op path
plus the store-creation step, so the rig is built and gated *now* and the chain's first real step is v1→v2
(P9 says why and forbids inventing a prior version to test against).

* `pnpm -r test` — core **222**, benchmarks **214**, pwa **259** (695 total; 60 new
  `tests/persistence/pins.test.ts`, all green).
* `pnpm test:e2e` — **50 passed** (39 that existed, 10 in `playwright/persistence.spec.ts`, and the new
  `smoke.spec.ts` guard that the migration rig is not in the shipped bundle).
* `pnpm build` ✓ `pnpm typecheck` (0 errors, `svelte-check` 0/0) ✓ `pnpm scan:egress` 0 violations ✓
  `pnpm install --frozen-lockfile` with `fake-indexeddb: false` in `allowBuilds` ✓.
* `pnpm scan:pii` now covers the storage fixtures as well as the benchmark corpus: 3 files, 24 free-text
  values, 7 distinct, every one inside the declared synthetic vocabulary; the invented UPI handle appears as
  one masked `vpa-shaped` advisory. Tampering a committed record with an email address exits 1.
* `pnpm verify:storage-fixtures` — the generator re-runs and `git diff --exit-code` over
  `packages/pwa/tests/persistence/fixtures` is clean; three committed fixtures, each a whole-database dump of
  what the real save path wrote in Chromium. The gate has already earned its keep: it caught a save-path
  change my own P8 fix introduced.

Implementation surfaced **five sequential P3 failures** (gate order, `put` signature, `blocked` holder,
profile read timing, fixture byte-stability). Each was diagnosed and fixed in order; nothing was reported
green until all 60 pins passed. This is the expected cascade for a ticket with five nested stubs — not a
problem, the process working.

**Four more rounds belonged to CI, and the push was worth every one.** `pnpm test` was green on the first
run and the fixture gate failed there while passing locally — which is precisely what a machine-specific
artifact looks like until it is not alone:

| CI run | found | treatment |
|---|---|---|
| `42040764600` | OCR box geometry (`x: 56.65` → `58.61`) and JPEG bytes (`39,877` → `39,761 B`) | `{ "__normalized": … }` markers, declared with reasons in `_meta.normalized` |
| `42041982968` | OCR confidence (`0.99544` → `0.99397`) | rounded to two decimals — **the wrong theory, kept here so nobody retries it** |
| `42042814720` | rounding still split: `1` against `0.99`. A continuous measurement of a raster has no stable precision | confidence nulled (§10 types it `number | null`, core reports `confidence_unavailable`), and `working.parseValidation` with it — confidence-derived *and* recomputed on load by P1 |
| `42043979920` | — | **green**: install, build, `build:rig`, typecheck, test, `scan:pii`, `verify:results`, `verify:accuracy`, `verify:accuracy-table`, fixture budget, `verify:footprint`, `verify:storage-fixtures`, Playwright |

The third round also exposed a bad assertion of mine, which is the more interesting failure: P9's
no-op-reopen pin compared the restored `working` to the stored one *whole*, and it had only been passing
because the stored `parseValidation` happened to agree with the recomputed one on my machine. It now asserts
the rule — every field the save path *chose* survives byte-for-byte, and `parseValidation` is compared
against a fresh `validate(parseResult)`. Pin 2 remains the proof the stored value is never trusted.

CI's final numbers on `690396e`: core **222**, pwa **259**, **benchmarks 214 in the CI log** (the one
criterion only a push could settle), `svelte-check 0 errors and 0 warnings`, Playwright **48 passed** — the
50 minus the two `@offline` cases that job excludes by design; `privacy.yml` owns those.

Box-by-box: **1** one database `receipt-lens`, `DB_SCHEMA_VERSION = 1`, one sequential step
(`MIGRATIONS[0]`) inside `onupgradeneeded`, and one `BillDocument` record per bill rather than §1.1's ten
stores (P2's reason, with the cost named). **2** a throwing step aborts the `versionchange` transaction and
IndexedDB reverts data *and* schema — pinned against `fake-indexeddb` **and** Chromium; `deleteDatabase`
appears nowhere in the storage layer. **3** P9: the v1 no-op reopen plus the fixture pipeline; the v1→v2
steps in CI are rig-only and a pin asserts they cannot enter the shipped chain. **4** `exportJson` fires
before any step that fails L1–L4, on a screen that will not proceed until the file exists, and says the name
and the downloads folder; the export reads at the stored version and is record-level (a row that cannot be
decoded is named in `unreadable`, not silently dropped). **5** `/bills` ledger, `CreatorProfile` in
`entities.ts` and round-tripping, revision 0 saved on accept, `/bill` restoring the most recent bill with a
notice, and two distinct empty states. **6** retention is per capture, default off, written only after the
bill write, `deleteBill` takes the photo with it, `deleteRetainedImage` leaves the bill and every number in it
intact — and `capture.spec.ts`'s ticket 10 guard now asserts only `receipt-lens` exists, that its image store
is empty, and that no undeclared store appeared.

Forwarded question from ticket 13 (the `<Units>` roster): **answered — ungated** (P8). Participants, the
payer select and the paid flag are reachable on a draft-only bill; the assignment grid stays finalize-gated
because units do. `lock-lifecycle.spec.ts`'s assertion that named the old constraint was inverted in the same
commit, and the two notes ticket 14 could not answer — revision-0 ledger pruning, and the modal-backdrop
convention on a refused removal — are written into ticket 15's file.

Not done, on purpose: restore-from-export, a participant rename, any cross-tab sync, and a photo viewer (P13).

**Pushed and CI-green at the owner's direction** (`690396e`, run `42043979920`); PR open, merge is the
owner's call.
