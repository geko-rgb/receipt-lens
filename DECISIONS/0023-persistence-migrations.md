# DECISIONS/0023 — Local persistence: what is written, how the schema moves, and what a failed upgrade promises

Date: 2026-11-05 · Ticket 14 · **Status: binding for tickets 14–18.**

Tier-3 parameters, pinned **before** the code, in the posture `DECISIONS/0011`, `0018`, `0019`, `0020`,
`0021` and `0022` take: every pin below is a predicate `packages/pwa/tests/persistence/pins.test.ts`
asserts, and nothing here is a measurement of behaviour that does not exist yet.

Ticket 14's own headline is the reason the pins are heavy: *"a future schema change can never silently
wipe a user's bills."* That is a promise about a code path that does not exist yet (there is no version 2),
so it has to be discharged by a rig that is real today and by rules that a future migration can be checked
against — not by the intention that the next migration will be careful.

Sources of the constraints: `PROJECT(1).md` §10 lines 747–752 (versioning and migrations), §10 line 745
(shares and derived selectors recomputed on load), §10 line 761 (images not persisted by default), §10
lines 602–605 (`CreatorProfile`), §13 lines 922–923 (the creator's local ledger, profile reuse),
`docs/business.md` §15 (privacy and data rules), ROADMAP 3A.2/3A.3/3A.4 and 3B.6, and
`docs/pwa-design.md` §1 (the 10a schema plan this record supersedes in part).

## P0 — The pins, in one line each

1. **What persists is `{ billId, revision, savedAt, working }` — one record per bill.** `derived`,
   `billValidation` and the `document` wrapper are rebuilt on load by the transaction runner's own steps;
   the stored copy of `working.parseValidation` is read, discarded and recomputed (P1).
2. **Version 1 has three stores** — `bills`, `creatorProfile`, `retainedImages` — and **no indexes**.
   `unclassifiedRows` and `excludedRowIds` stay inside `working`; §1.1's ten-store normalization is
   superseded, with the cost stated (P2).
3. **Migrations run sequentially inside the `versionchange` transaction; a throw aborts the whole upgrade**
   and the database stays at its old version with its data intact. `deleteDatabase` is not in this module's
   vocabulary (P3).
4. **A step is provably lossless iff it drops nothing, retypes nothing, removes nothing and is total** —
   four clauses, checked mechanically against real fixtures, not asserted in a comment. Any step that fails
   them exports first, and the export gate blocks the upgrade instead of suggesting it (P4).
5. **Concurrent tabs: last write wins, and the loser is told.** Detection is `revision` against the value
   this tab last wrote; there is no cross-tab channel and no sync in v1 (P5).
6. **Retention is per capture, default off, and the `retainedImages` record's existence *is* the state.**
   The byte is the accepted working copy, written after the bill write; deleting the photo and deleting the
   bill are different actions, and deleting a bill removes its image in the same transaction (P6).
7. **Every document published into the root is written** — including revision 0, the accepted import — and
   `/bill` with nothing in memory restores the most recently saved bill. Two distinct empty states (P7).
8. **`<Units>`' roster is reachable before any item is finalized**; the assignment grid keeps its own
   "no units yet" hint. Ticket 13's forwarded UX question, answered (P8).
9. **Migration fixtures come from the real save path, never hand-built.** The committed v1 fixture is a
   dump of what `bills` actually held, produced by a generator CI verifies byte-for-byte (P9).
10. **Three failures, three surfaces, one promise each** — a failed upgrade, an unloadable record, a full
    disk. None of them says "start over", all of them offer an export, and none of them clears anything
    (P10).

## P1 — What persists, exactly

```ts
/** keyPath: "billId". One record per bill. The whole mutable state travels as one value. */
interface StoredBillRecord {
  readonly billId: string;        // === working.bill.id; stored so a record can be keyed without decoding it
  readonly revision: number;      // 0019 S5's concurrency token, stored verbatim and never re-derived
  readonly savedAt: string;       // ISO — persistence metadata, never bill content, never read by a rule
  readonly working: WorkingBill;  // §10 lines 679–691 + 0022 L1's two fields, verbatim
}
```

- **`working` is persisted whole, and it is the only bill content on disk.** `derived` and
  `billValidation` are *siblings* of `working` in `BillDocument` (0019 S3) precisely so that "persist the
  working bill" and "persist the totals" are two different acts, and only the first is allowed
  (0019 S5, §10 line 745).
- **Load path:** `rebuildDocument(working, revision)` in `lib/bill/transactions.ts` — the function 0019 S9
  promised ticket 14 — runs `recompute` → `validateParse` → writes `parseValidation` into `working` →
  `validateWorking` → `deepFreeze`. It is the same code with the same `TransactionSteps` seam a transaction
  uses (0020 T12), so a reload cannot disagree with an edit. It does **not** bump `revision`.
  `beginFrom` and `rebuildDocument` are the only two ways a document is minted outside a transaction.
- **The wrinkle, pinned rather than glossed:** `working.parseValidation` is §10 line 690's own field, so
  "persist only `working`" *does* write a validation result to disk. The load path discards the stored copy
  and overwrites it with a fresh `validate(working.parseResult)`. Removing the field would be a §10 shape
  change this ticket has no mandate for, so the redundancy is stored and ignored; a pin asserts that a
  deliberately poisoned stored `parseValidation` cannot survive a load.
- **`revision` survives by value, not by recompute.** After a load, the next committed transaction is
  `revision + 1` of what was on disk, so P5's divergence test has something to compare.
- **Not persisted anywhere:** receipt image bytes (unless P6's opt-in fired), OCR text beyond what
  `working.parseResult` already carries (`mapping.ts` copies fields and never retains an `OcrResult` —
  0019 S9), the capture handoff (`lib/draft.ts` stays an in-memory value), view state, and the last
  rejection.
- **Round trip is asserted by value:** for a document produced by the real path,
  `loaded.working` deep-equals `saved.working`, `loaded.revision === saved.revision`, and
  `loaded.derived` deep-equals the document's own `derived` — because both sides ran the same recompute, not
  because anything was stored. That last equality is the test of §10 line 745, and it is the ticket's
  "bill identical" acceptance case.

## P2 — The stores at version 1

One database, `receipt-lens`, `DB_SCHEMA_VERSION = 1`, monotonic (§10 line 749).

| store | keyPath | value | §10 source |
|---|---|---|---|
| `bills` | `billId` | `StoredBillRecord` (P1) | the `WorkingBill` + `revision` |
| `creatorProfile` | `id` | `{ id: "self", displayName, upiId }` — §10 lines 602–605, un-widened, one row | §13 line 923 |
| `retainedImages` | `billId` | `{ billId, retainedAt, mediaType, bytes: ArrayBuffer }` | §10 line 761 opt-in |

- **`docs/pwa-design.md` §1.1's ten stores are superseded in favour of one record per bill.** §1.1 itself
  left this open ("ticket 14 may choose otherwise; the decision belongs in a `DECISIONS/` record either
  way"), and the §1.1/§1.2 tables get a pointer to this record in the same commit, because a stale schema
  plan is how a fresh session gets misled.
- **Why whole-document:** 0019 S2.1 rejected ten in-memory stores because a reader could see new items with
  old totals — "a single root value makes the intermediate state *unnameable*." The same argument is
  stronger on disk: `recompute` **throws** on a torn read (`totals.ts:82` on `count(units) ≠ Item.qty`,
  `:87` on an assignment to a deleted unit), so a bill whose units and items landed in different
  transactions is not merely observable-but-wrong, it is *unloadable* — and an unloadable bill is the
  "silently wiped a user's bills" failure this ticket exists to prevent, reached through a different door.
  One record, one `put`, one transaction: a torn bill cannot be written.
- **What the supersession costs, named.** (a) `assignments` no longer gets a compound key that makes a
  duplicate `(itemUnitId, participantId)` pair physically impossible (§1.1's stated intent). It was already
  impossible by policy — `assignment_duplicate` rejects it in the runner (0021 A3) and `recompute`'s orphan
  check runs after every commit and on every load — so the loss is a second enforcement of a rule the
  application layer already owns. (b) No per-entity indexes, so nothing can query "all drafts of all bills"
  without decoding records; no v1 screen does. (c) Every save writes the whole document; a bill is tens of
  records and §10 line 745 already prices copy-on-write at "irrelevant".
- **`unclassifiedRows` and `excludedRowIds` stay inside `working`.** They are §10's and 0022 L1's fields on
  the whole mutable state, and `unclassified_rows_unreviewed` needs `unclassifiedRows`, `excludedRowIds`
  *and* the drafts' `parsedRef` → `parseResult.items[].sourceLineId` chain (0020 T8) resolved together. As
  separate stores they would be three transactions that can half-land, for a query nobody runs.
- **No indexes at version 1**, including on `bills`. IndexedDB indexes key on a record's own property, and
  the list view's sort key (`working.bill.createdAt`) is nested two levels down; promoting it to a
  duplicated top-level field would put a second copy of a bill fact on disk that a migration must keep
  consistent — the exact staleness §10 line 745 refuses for cached shares. So the ledger reads every
  record and sorts in memory. **Scale assumption, stated as an assumption:** one creator's ledger, so
  hundreds of records; `parseResult` costs kilobytes, not megabytes (`OcrResult` is not retained). If that
  ever stops being true, an index is a version bump with a fixture, not a redesign.
- **`indexedDB.databases()` is never called by shipped code** — it is Chromium-only (the existing
  `capture.spec.ts:219` use is a test). Shipped code always opens by name.
- **Blobs are stored as `ArrayBuffer`.** IndexedDB can hold a `Blob` natively, but an `ArrayBuffer` is the
  most portable structured-clone value on every target this app claims, it is what
  `blob.arrayBuffer()` yields at the one boundary that matters, it avoids a base64 round trip that would
  make image bytes look like a string someone could put in an export, and it makes P6's absence test a
  length check. The UI wraps it back: `new Blob([record.bytes], { type: record.mediaType })`.

## P3 — The migration mechanism, and what an abort guarantees

```ts
interface MigrationStep {
  readonly from: number;                       // applies when storedVersion === from
  readonly description: string;                // what it does, one line, for the reviewer and the log
  readonly lossless: LosslessProof;            // P4's four clauses, or { lossless: false }
  readonly up: (tx: IDBTransaction, db: IDBDatabase) => void;  // request chains only
}
const MIGRATIONS: readonly MigrationStep[];    // v1: one step, from: 0 — store creation
```

- **`openDatabase()` is two-phase, and the reason is a hard IndexedDB limit.** `onupgradeneeded`'s
  transaction auto-commits as soon as its IDB request queue drains, so nothing that is not an IndexedDB
  request can be awaited inside it — *a user prompt or a file download cannot happen mid-upgrade*. P4's
  export-before-migration requirement is therefore only implementable before `open()` is called at the new
  version:
  1. **Probe.** `indexedDB.open(DB_NAME)` with **no** version argument opens at the stored version, and
     creates the database at version 1 when it is absent (`IDBFactory.open`'s version handling; the
     behaviour is asserted by pins 3 and 4 rather than trusted, in both implementations).
     `probe.version` is the on-disk schema version, read without upgrading anything.
  2. **Gate.** If `probe.version < DB_SCHEMA_VERSION` and the range `probe.version → DB_SCHEMA_VERSION`
     contains a step that is not provably lossless **and** that step's input stores hold at least one
     record, the app reads the whole database *through the probe connection, at the old version* (so the
     export is in the old shape — which is the only shape that restores anything) and shows the blocking
     export screen. A fresh install with nothing to lose never sees it.
  3. **Upgrade.** `probe.close()`, then `indexedDB.open(DB_NAME, DB_SCHEMA_VERSION)`. Each step runs in
     `event.transaction`; the chain is contiguous (`step.from` covers `0 .. version-1`) and a structural test
     fails the build on a gap, a duplicate or an unregistered version.
- **A step is a chain of IDB requests, not `async` code.** `getAll()` inside the upgrade transaction is
  acceptable at the scale P2 assumes; a step must not reach for `fetch`, a timer or `localStorage`.
- **Failure = abort, by the transaction, not by us.** A step's request erroring, or its read-back check
  throwing, calls `event.transaction.abort()` and the `open` promise rejects with
  `MigrationFailure { from, to, cause }`. IndexedDB rolls back an aborted `versionchange` transaction's
  *data and schema* changes together, so the database stays at the old version with the old stores. This is
  the property the ticket calls "never leaves a partially-applied migration", and it is asserted twice: once
  against `fake-indexeddb` and once against Chromium, because the fake's fidelity is itself an assumption
  (P9).
- **`deleteDatabase` is not called by this module**, in any path, ever — not on failure, not on
  `VersionError`, not as a "reset". No empty-database fallback, no silent clear (§10 line 750). The only
  deletions are a user's `deleteBill` / `deleteRetainedImage` and the rig's test-local factory teardown.
- **An obsolete store is dropped only by the step that has already copied its records,** in the same
  transaction, after the copy's read-back succeeded (§10 line 750). Atomicity makes the ordering free:
  if the copy fails, the transaction aborts and the drop never happened. There is no such store at
  version 1; the rule exists so version 2 cannot invent a dangerous shortcut.
- **`VersionError` (stored version > requested) is a distinct, expected case:** a newer build wrote this
  database and an older build opened it. It is not a migration failure and it is not repaired: P10's
  recoverable error, saying the app is older than the data, never "open at a lower version".
- **`blocked` and `versionchange` are handled, because P3's design makes the upgrade a real event.**
  `openDatabase` listens for `blocked` and shows "close this app's other tab to continue" (ties to P5), and
  every connection closes itself on `versionchange`, after which the app is in P10's "database moved on"
  state rather than silently writing into a dead connection.

## P4 — Provably lossless, and when the export fires

**Definition.** Step `v → v+1` is *provably lossless* iff it can show all four:

- **L1 drops no field** present in any record it reads.
- **L2 changes no field's type or meaning** (a `null` becoming `0` is a meaning change; a `null` gaining a
  real value from another field is not).
- **L3 removes nothing** — no store, no record, no index a caller still reads.
- **L4 is total** — every input record maps to exactly one output record; no record is skipped, merged or
  split.

Adding a field with a constant default **is** lossless (there is nothing to lose). Recomputing a field that
`working` already determines (P1's `parseValidation`) is lossless *by re-derivation*, which is L4's
`f(record) → record'` with `f` reading only the record. Removing a field, renaming a store, retyping an
amount, or dropping records fails L1–L4.

**Consequence for this ticket:** at version 1 there are **zero** data migrations, so the export gate never
fires today, and the honest statement of ticket checkbox 3 ("every schema version has a migration test that
starts from a real prior-version fixture") is: the *rig* is green and fixture-gated today, and the *chain*
is exercised for real by v1→v2. P9 is what makes that a claim rather than a hedge.

**`lossless` is checked, not declared.** Every step carries `lossless: LosslessProof` where
`LosslessProof = { lossless: true, clauses: ["L1","L2","L3","L4"] } | { lossless: false, reason: string }`,
and the rig's structural test walks the committed fixtures through each step and asserts:

- no key path present in a `before` record is absent from its `after` record (mechanical L1/L2 — types
  compared by `typeof` + an array/object tag),
- `beforeCount === afterCount` for every store the step reads (L3/L4),
- a declared-lossless step produced byte-identical results when re-run (L4's determinism, 0011's rule
  inherited), and
- a step whose `lossless` is `false` is refused by `openDatabase` until the export completed.

A step that cannot name all four clauses is `lossless: false` — **fail-closed by default.** The rule the
brief asked for, verbatim: export before any migration that (a) removes a field, (b) changes a field's type,
(c) renames or drops a store, or (d) cannot be re-derived from `working` + `revision`. (d) is what L1–L3
protect: `derived`, `billValidation` and the totals are re-derivable by definition (P1), so a schema change
that touches only them could never be lossy.

**The gate blocks.** On a lossy upgrade the app shows a screen that (i) says the update changes how bills
are stored, (ii) offers **Download my bills first** and does not proceed until the download has actually
been produced by this session (the app knows whether it wrote the file — "I exported it" is not a checkbox a
misclick satisfies), (iii) states plainly that skipping it means data may not survive, and (iv) always
leaves a **Not yet** exit that keeps the app usable at the *old* version, read-write, with the upgrade
re-offered next launch. Blocking is possible because the gate runs before `open(name, target)` (P3), so
declining simply never requests the new version.

**The export envelope** — `exportJson()` writes a file, always available from the ledger ("Download a
backup"), and its shape is a fourth version number, distinct from `DB_SCHEMA_VERSION`,
`BillShareSnapshot.snapshotVersion` and the link format (§10 line 751 keeps the first three separate; this
record adds the fourth and says why: an export is a file a user keeps, and its format must survive app
upgrades):

```ts
interface ExportEnvelope {
  readonly app: "receipt-lens";
  readonly exportVersion: 1;
  readonly dbVersion: number;          // the version the records were written at — pre-migration, always
  readonly exportedAt: string;         // ISO
  readonly creatorProfile: CreatorProfile | null;
  readonly bills: StoredBillRecord[];  // verbatim records, not re-encoded documents
  readonly retainedImageBillIds: string[];  // ids only: which bills had a photo, never the bytes
}
```

- Records are exported **verbatim as stored**, so the file means "what this app wrote" and a future restore
  can honour `dbVersion`. Re-encoding through `BillDocument` would put derived values in the file — the
  §10 line 745 rule again, at the export boundary.
- **`retainedImages` bytes are never in an export.** The reasoning, because it is a product judgement a
  reviewer should be able to refuse: an export file is something users email, paste and upload, so
  including photos would route the most sensitive artefact in the app through the least controlled channel
  (§15's privacy rule in `docs/business.md`: images are opt-in, local-only, deletable). And the loss it
  risks is recoverable in a way bill state is not — the receipt photo came from the user's own device, while
  a bill is derived work they cannot reproduce. The envelope still lists *which* bills had images, so nothing
  is hidden about what the backup does not cover, and the export screen says so in one line.
- Restore is **not** in ticket 14's scope (P12).
- File name `receipt-lens-export-v{dbVersion}-{exportedAt}.json`; "where it went" is said on screen
  (the browser's downloads folder) because ticket checkbox 4 requires the user be told.
- A failed migration's export (P10) uses the same envelope at the intact old version — the upgrade rolled
  back, so the probe's version *is* the on-disk shape.

## P5 — Two tabs, one bill

v1 is single-tab by `DECISIONS/0019` S10, and `revision` exists because S5 said "last write wins" must be
14's deliberate choice. It is made here.

- **The write always lands: last write wins.** `saveBill` refuses nothing.
- **Divergence is detected, and shown.** Each tab tracks the `revision` it last wrote; a save whose stored
  record's `revision` is not the value this tab last wrote means another tab wrote in between. The saving
  tab shows a persistent notice: *"Another tab saved this bill (revision N). This tab's version replaced it
  — the other tab's edits are gone."* The other tab gets the mirror notice on its next save, so **both**
  losers are told, and neither edit is silently swallowed.
- **Rejecting instead was considered and refused.** A `revision_stale` rejection would leave the second tab
  unable to save at all until it reloaded — and reloading discards the edits it is refusing to persist. That
  is worse than the loss it prevents, and it is invisible: the user is typing into a screen that has stopped
  being saved. The brief's alternative, a visible warning, is the same detection with the user kept in the
  loop; v1 has no way to merge two divergent `WorkingBill`s, so honesty about overwrite is the only
  defensible behaviour.
- **No cross-tab channel.** No `BroadcastChannel`, no `navigator.locks`, no leader election: v1 does not
  sync, it detects and reports. Both notices are one string each; the merge protocol is not.
- **The bill-id case is not a conflict.** Two tabs that each accept a capture mint
  `bill:${createdAt}` (`Bill.svelte:46`) and save two different records; the ledger shows both.
- **Upgrade-time contention is P3's `blocked`/`versionchange` path**, not this pin's: while tab B holds the
  database, tab A's upgrade waits, B gets `versionchange`, closes, and A proceeds. B's in-memory document is
  then stale against the schema and shows "this app's data was updated by another tab — reload".

## P6 — Receipt image retention

§10 line 761: *"Do not persist receipt images by default after the session; if the user explicitly enables
local retention, store them only in local browser storage and provide a delete action."* Ticket 10 shipped
the promise as "never"; ROADMAP 3B.6 defers the opt-in to this ticket. All four of the brief's questions —
where, when, what, and what delete means — are pinned.

- **Where the toggle lives: `/capture`, beside the preview**, next to the copy that currently reads
  "Nothing leaves the device and no image is stored" (`Capture.svelte:341`), which becomes conditional on
  the box. The image byte exists only in that screen's memory (`adoptBlob`, `Capture.svelte:115-120`);
  `/bill` never holds one, so a toggle there would be promising to store something it cannot reach.
- **Default off, per capture, and the choice is not remembered.** A "always keep photos" preference would
  make a checkbox on an unrelated screen flip the privacy default for every future receipt — the one thing
  §15's "explicit opt-in" is strict about.
- **When the byte is stored: at accept, then at the bill's first save, after it.** The tick decides only
  whether the blob is *carried* into the handoff (`CaptureDraft` gains an optional `retainedImage`);
  `billStore.begin` hands it to the storage layer, and the write happens after a successful `bills` write,
  as a **separate** transaction. Ordering is the whole design:
  - bill write fails → nothing was retained (the image write is never attempted), no orphan photo;
  - bill ok, image write fails (quota) → the bill is saved and the photo is not; the panel says so, and
    because presence *is* the state, the UI is automatically truthful;
  - a capture whose box was ticked but which never reaches `/bill` → the blob dies with the page.
  Doing it in one transaction instead would let a 3 MB photo veto the save of the bill the user made out of
  it, i.e. a privacy opt-in causing the data loss P3/P10 exist to prevent.
- **Which byte: the accepted working copy** — the rotated, cropped, preprocessed image OCR actually ran on
  (`transform.ts`'s output), not the camera original. It is the artefact the bill came from, and the one a
  later re-OCR would need in order to reproduce this parse. §10 line 759's "preserve the original until the
  user accepts" is about *reversibility during the session*, which the in-memory copy already satisfies.
  Cost, stated: if the crop was wrong, the photo kept is the wrong crop, and the remedy is re-capture.
- **Presence is the state.** There is no `retentionEnabled` flag on the bill or in the profile: a
  `retainedImages[billId]` record exists, or it does not. A flag would be a second source that can promise a
  photo the store does not contain.
- **Delete is two actions, not one.**
  - `deleteRetainedImage(billId)` removes the image record only. The bill survives — every number in it was
    derived from the photo already, so the photo is evidence, not input.
  - `deleteBill(billId)` removes `bills[billId]` **and** `retainedImages[billId]` in one `readwrite`
    transaction. A bill delete that left a photo behind is precisely the §15 leak this pin is about.
  - Turning the box off later is the same `deleteRetainedImage`, reachable from `/bill`'s retention panel.
  - `deleteBill` is a **storage operation, not a transaction**: it does not go through `runTransaction`, does
    not touch the document, and is not blocked by the `bill_locked` guard (0020 T1's guard is about editing
    content). It is confirm-first, and the dialog says the locked-bill truth: deleting locally does not
    recall links already sent (0022 L6).
- **What the panel shows:** `Photo kept on this device — {mediaType}, {bytes} bytes, {retainedAt}` +
  Delete. **No viewer in v1.** Rendering a kept photo would need a blob URL, an `<img>` and a revoke path on
  unmount, for a screen whose job is to let you *not* keep it; the metadata answers "what am I deleting".
  Stated so the omission reads as a decision.
- **`/share` never reads or writes `retainedImages`**, and ticket 16's snapshot must not project from it
  (§10 line 814: never the receipt image). The one place a kept photo may be rendered is `/bill`'s panel.

## P7 — The save trigger, the restore, and the two empty states

- **Every document published into the root is written**, including `revision 0`. `billStore.begin` and
  `billStore.publish` call `storage.saveBill(document)` — two lines in the module that 0019 S3 already made
  the only writer of memory, so the root is also the only trigger of disk writes. No debounce: a save is one
  record of a few KB, and a debounce would put a window where the screen shows an edit the disk does not
  have.
- **Saving at revision 0 is a decision, with a cost.** An accepted capture becomes a ledger row
  immediately, so a navigation or a crash cannot eat work the user has already reviewed — which is what the
  reload path below needs to be coherent. The cost is that every accepted-but-abandoned import leaves a row;
  it is labelled with its draft count and the `draft` badge, and the ledger's Delete action is the remedy.
  `billStore.clear()` clears **memory only**; storage deletion is an explicit ledger action, so "close this
  view" is never "delete the user's bill".
- **`/bill` with nothing in memory restores the most recently saved bill** — the record with the greatest
  `savedAt`, ties broken by `billId` (0011's determinism rule, applied to storage). This is what makes
  reload keep the ticket's promise (`ticket: save bill → reload → bill identical`), and it is the app-side
  half of what ticket 17 needs for offline reload. It shows *which* bill was restored:
  `Restored from this device — revision N, saved {savedAt}`.
- **Empty states, both, named separately** because ticket checkbox 5 says "with empty-state behaviour
  defined" and the naive answer conflates them:
  - **`/bills`, no records:** heading, an explanatory line, and one working CTA — `Capture a receipt` →
    `/capture`. A test asserts the CTA is the thing that navigates, not that a sentence is present.
  - **`/bill`, no document and no capture handoff and nothing saved:** `No bill open` + `Capture a receipt`
    + `Open a past bill`. The current copy at `Bill.svelte:206` ("No draft yet — capture a receipt first")
    was written when an empty draft meant the database was empty too; after this ticket it does not, so the
    copy changes.
  - `/bills` with records: one row per bill — title, `createdAt`, `isLocked`, printed `grandTotal`
    (`working.bill.grandTotal`, `null` shown as `—`, never as ₹0.00), draft/item/participant counts —
    sorted newest-first by `createdAt`, and per row `Open`, `Delete`, `Download a backup`.
  - **The list projects from `working` only and runs no recompute.** `lifecycleOf` needs
    `document.billValidation` (0022 L10), so the row badge is `isLocked` + `paid` flags + draft counts —
    fields, not a second lifecycle engine. Opening a row builds the real document through
    `rebuildDocument`, where the lifecycle lives.

## P8 — The roster before any item exists (ticket 13's forwarded question)

Ticket 13's note: `<Units>` renders inside the `{:else}` of `{#if working.items.length === 0}`
(`Bill.svelte:331-369`), so a creator cannot add participants while a bill is a draft-only import. It asked
whether persistence changes the answer. It does, and the answer is **yes — ungate the roster.**

- `Bill.svelte` renders `<Units {bill} />` whenever a document exists. The **roster** (name entry,
  participant list, `paid` checkbox, payer selector) is always reachable; the **assignment grid** keeps its
  own hint — `Finalize an item to assign its units` — because units still materialize at finalization only
  (0021 A1), and that is a data fact, not a UI gate.
- **Why it is right, in order of load-bearing-ness.**
  1. **Order of operations.** A group-splitting conversation starts with *who is in*, not with the receipt
     line items. §11 rule 5 / ADR-001 make a zero-item participant fully meaningful — they pay an equal
     share of every applicable non-included charge — so "add people first" is not a degenerate state the UI
     should treat as unavailable.
  2. **Restored bills.** After P7, `/bill` can open a bill that is nothing but an unreviewed import. Before
     this ticket the only reachable action on that screen was editing draft lines; the roster's gate was
     invisible when the only way into `/bill` was a fresh capture the user was about to edit anyway.
  3. **Payer selection lives in the roster** (0022 L13), and §13's `payer_missing` is a lock blocker a user
     must be able to clear before anything is finalized.
- **Why it costs nothing.** `addParticipant` is unit- and money-neutral by 0021 A10 (no units, no
  assignments, no `payerId`, no `grandTotal`); the blocker set already handles "participants with no units";
  and no new §10 field or transaction operation is needed.
- **Not ungated, and why.** `assignUnit`/`acknowledgeUnassignedUnit` (no units until finalize — 0021 A1);
  the lock checklist's *unit* rows (nothing pending yet); receipt images (P6 keeps them out of `/bill`'s
  data).
- **`CreatorProfile.displayName` seeds the creator participant's name** at `begin`
  (`mapping.ts:144-148`'s `creatorName` option, `"Creator"` as the fallback), and nothing else. A later
  profile edit does **not** rename the participant on past bills: a bill records what it said when it was
  made, and rewriting stored bills to track a setting is a derived-value write P1's rules forbid. Renaming a
  participant on one bill is not in this ticket's scope (P12) — no operation exists in `transactions.ts`
  today and nothing in 14 needs one.

## P9 — Migration test realism: the "before" state is an artifact, not a story

The brief's constraint, adopted as a rule: *a migration test that starts from a synthetic version someone
invented is not a migration test.* Three things follow.

1. **The v1 fixture is produced by the real save path, in a real browser.**
   `scripts/storage-fixtures.mjs` (committed generator, Playwright-driven, Chromium, served by
   `playwright/app-server.ts`) runs the app's own flow — capture a fixture receipt, accept, edit — then
   dumps every store of `receipt-lens` verbatim:

   ```
   packages/pwa/tests/persistence/fixtures/v1-bills.json          // the bills records, raw
   packages/pwa/tests/persistence/fixtures/v1-creatorProfile.json
   packages/pwa/tests/persistence/fixtures/v1-retainedImages.json // the opt-in case only
   ```

   with a `_meta` block naming the generator, the app head, the `dbVersion` and **the fields the comparison
   normalizes** (`savedAt`, and any clock-derived id such as `billId` = `bill:${createdAt}` — P7's clock and
   0011's determinism rule are the only reason these are not byte-stable). Nothing else is normalized: a
   fixture diff that is not a clock field is a real change and fails the gate.
   Verified by **`pnpm verify:storage-fixtures`** (regenerate + byte-compare, the same
   `--check` discipline as `verify:fixtures`, `verify:accuracy` and `verify:results`), wired into the same CI
   job that runs those.

2. **What CI runs today, since there is no prior version to migrate from.**
   - **Round trip through the real path:** save a document built by `beginFrom` + real transactions, reload,
     assert `working` and `revision` by deep equality and `derived`/`billValidation` recomputed to the same
     values (P1). Not a hand-built `WorkingBill`.
   - **v1 → v1 is a no-op:** open at the stored version, assert `onupgradeneeded` **did not fire** (a
     counter on the handler) and the fixture's bill still loads and rebuilds identically. This is the path
     the brief asks the first test to prove, and the counter is what distinguishes it from an accidental
     upgrade.
   - **Synthetic v1→v2 in the rig, never in shipped `MIGRATIONS`:** test-local steps that read the committed
     v1 fixture and prove the gate and the abort — one that *adds* a field (declared lossless; no export
     prompt; the L1–L4 checks pass), one that *removes* a field (`lossless: false`; the export prompt fires
     **before** the upgrade runs and the DB is still at v1 with the fixture's bytes while the gate is open),
     one that *throws* (the abort assertions in P3, checked against the fake and against Chromium).
     A guard test asserts `MIGRATIONS` is derived from shipped code and contains only `from: 0` at version
     1, so a rig step can never leak into the released chain.
   - **Fake-and-browser agreement:** the unit rig uses `fake-indexeddb` (new **dev** dependency, Apache-2.0,
     no install hook — its only lifecycle script is `prepare: husky`, which does not run for a registry
     tarball; declined in `pnpm-workspace.yaml`'s `allowBuilds` exactly as `hyparquet`'s identical case already
     is), each test constructing its own `new IDBFactory()` so nothing leaks between files; `fake-indexeddb/auto`
     (globals) is not used anywhere. The e2e then dumps the same bill from **Chromium** and asserts equality
     with the fake's fixture modulo the declared clock fields — which is what makes "the fake is faithful
     enough to prove an abort rolls back schema changes" a measured agreement rather than an assumption
     about a library.

3. **The rule for version 2, stated now so the ticket that needs it cannot skip it.** Adding
   `DB_SCHEMA_VERSION = 2` requires: the v1 fixture regenerated by the generator at the shipped v1 code
   (not edited by hand), a `MigrationStep` whose `LosslessProof` names the clauses it satisfies, and a
   rig test migrating the *committed fixture* to v2 with the L1–L4 structural checks. A version bump whose
   step is tested only against a hand-built record fails the rig's own assertion that every step's input is
   a committed fixture.

## P10 — What each failure says, and what it promises

Ticket checkbox 2 says "leaves recoverable state". Three states can produce that phrase, so each gets its
own surface, its own test, and one shared promise: **nothing was deleted, and here is an export.**

| Surface | Cause | It says | It offers | It never does |
|---|---|---|---|---|
| **Migration failed** | a step threw; the upgrade aborted | *"Your data was not changed — the database is still at version {v}, revision-for-revision as before."* Names the step. | Export at the intact old version (same envelope, `dbVersion` = stored); Retry; where to report it | `deleteDatabase`; open at the target version with missing stores; start fresh; hide the export |
| **Unloadable bill** | `rebuildDocument`'s `recompute` threw on a stored record (torn, corrupt, or a future bug) | *"This bill could not be opened. Nothing was changed."* Per record. | Export (raw records still read fine — the failure is in re-derivation, not the row); other bills still list and open | failing the whole ledger; clearing the bad record; pretending `derived` was empty |
| **Storage full** | `QuotaExceededError` on a `put` | *"This device's storage is full. Your change is still on screen and was NOT saved."* | Free space, or export and delete a bill, then `Retry save`; keep working in memory meanwhile | rolling the document back (the transaction committed in memory and stays committed); showing "Saved" |

- **P10.1 — the disk/memory split is deliberate and is the one place the two disagree.** A storage failure
  does **not** undo an in-memory commit (0020 T1's failures are rejected writes and broken invariants, and
  a full disk is neither); the save-status chip is the truth: `saving` → `saved {time}` → `not saved` with
  `Retry save`. `data-testid="save-status"` carries the state, and every persistence e2e waits for `saved`
  rather than sleeping (the fail-fast timeout rule from HANDOFF).
- **Retention quota is P6's separate transaction**, so a 3 MB photo can fail to store while the bill
  succeeds; the retention panel then correctly reports *no photo*, and P6's "presence is the state" makes
  the lie impossible.
- **`blocked`/`versionchange`** (P3) is a fourth, informational state: "another tab is holding the
  database" / "the data was upgraded by another tab — reload". Same promise, no clearing.

## S1 — The seam, and which file owns what

| Concern | File | Kind |
|---|---|---|
| `DB_NAME`, `DB_SCHEMA_VERSION`, `StoreNames`, `MigrationStep`, `MIGRATIONS`, `LosslessProof` | `src/lib/storage/schema.ts` | pure data + a chain-shape test |
| `openDatabase({ factory?, migrationsOverride?, onGate? })`, probe/gate/upgrade, `blocked`/`versionchange` | `src/lib/storage/database.ts` | the only module touching `IDBFactory` |
| `StoredBillRecord`, `CreatorProfileRow`, `RetainedImageRecord`, `ExportEnvelope`, encode/decode | `src/lib/storage/records.ts` | types, verbatim §10 |
| `saveBill`, `loadBill`, `listBills`, `deleteBill`, `saveCreatorProfile`, `loadCreatorProfile`, `putRetainedImage`, `deleteRetainedImage`, `exportJson` | `src/lib/storage/repository.ts` | one transaction per operation |
| `rebuildDocument(working, revision, steps?)` | `src/lib/bill/transactions.ts` | pure, alongside `beginFrom` |
| `CreatorProfile` (§10 lines 602–605, un-widened) | `src/lib/entities.ts` | type |
| persist-on-publish, restore, save status, `lastWrittenRevision` | `src/lib/bill/bill-document.svelte.ts` | the reactive slot, ~10 more lines |
| Ledger view + profile panel + export + empty state | `src/routes/Bills.svelte` **(new)**, `/bills` in `router.ts` + `App.svelte` nav | UI |
| Retention checkbox + conditional copy | `src/routes/Capture.svelte` | UI |
| Roster ungating (P8) | `src/routes/Bill.svelte:331-369` | UI |
| Error surfaces (P10) | `src/components/StorageStatus.svelte` **(new)**, mounted by `App.svelte` | UI |
| Fixture generator + gate | `scripts/storage-fixtures.mjs`, `pnpm verify:storage-fixtures` | tooling |
| Broken-migration / lossy-gate rig (never in the shipped bundle) | `playwright/rig/` + `vite.rig.config.ts` | test entry |

- **The rig is a second Vite entry that is not in `dist/app`.** A throwing migration cannot be produced by
  shipped code (P3: no test backdoor in a module that owns the user's data), so `openDatabase`'s
  `migrationsOverride` parameter is exercised from `playwright/rig/`, served by the e2e app-server, and
  `smoke.spec.ts` gains the guard: the app bundle must not contain the rig — the same chunk-graph assertion
  pattern ticket 11 introduced for the OCR runtime.
- **`pnpm scan:egress` keeps passing**: no absolute URL literal anywhere in `packages/pwa/src`, including
  `storage/`. The export is a `Blob` + object URL + `<a download>`, which is not an egress path and is not
  a fragment (0017 D3a).
- **`fake-indexeddb` is a dev dependency on `@receipt-lens/pwa` only** — it is never imported by
  `src/`, so it cannot enter the bundle, and the app always uses `globalThis.indexedDB`.
- **No new runtime dependency.** No network. No service worker (17). No UPI (15). No snapshot codec (16).

## S2 — Tests

`packages/pwa/tests/persistence/pins.test.ts`, written before the implementation and red on exactly these
pins (the ticket's own list, each naming its pin):

| # | Pin | Asserted as |
|---|---|---|
| 1 | round trip | `working` + `revision` deep-equal after reload; `derived`/`billValidation` equal to the pre-save document's, recomputed |
| 2 | nothing else persists | a poisoned stored `parseValidation` is overwritten on load; no stored `derived` key path exists |
| 3 | v1 store creation | a fresh factory at version 1 gives exactly `bills`/`creatorProfile`/`retainedImages`, with the pinned keyPaths and no indexes |
| 4 | v1→v1 no-op | fixture loaded through the real save path, reopened at 1, `onupgradeneeded` never fired, bill survives |
| 5 | migration from a committed fixture | the v1 fixture's records survive a declared-lossless synthetic step (field added), with L1–L4 structural checks |
| 6 | lossy step prompts export first | `lossless: false` step: gate screen shown, DB still at 1 with fixture bytes while it is open, export produced, upgrade only after |
| 7 | failed migration aborts | synthetic throw: DB at old version, all records intact, schema changes rolled back, `MigrationFailure.from/to`, no `deleteDatabase` call (spied) |
| 8 | quota exceeded | `QuotaExceededError` → save status `not saved`, document still committed in memory, `Retry save` succeeds once the error is cleared |
| 9 | `CreatorProfile` round trip | save, reload, restored verbatim; §10's two fields and nothing else |
| 10 | profile seeds the creator | `begin` uses `displayName` when present, `"Creator"` otherwise; editing the profile never rewrites a stored bill |
| 11 | image absent by default | capture→accept→save: `retainedImages.count === 0` |
| 12 | image present when opted in | one record keyed to the bill, `bytes.byteLength > 0`, `mediaType` set, working copy not original |
| 13 | image write order | bill write fails → no image record; image write fails → bill record intact |
| 14 | delete photo ≠ delete bill | photo removal keeps the bill and every number in it; bill deletion removes both records in one transaction |
| 15 | export excludes images | `retainedImageBillIds` lists the bill; no `bytes` key anywhere in the envelope |
| 16 | export envelope shape | `app`/`exportVersion`/`dbVersion`/`exportedAt` present; `bills` verbatim-equal to the records, not to documents |
| 17 | concurrent tabs, documented | tab B writes after tab A on the same bill: last write wins, divergence recorded on both sides, no `revision` regression in the stored record |
| 18 | `versionchange` handling | a held connection blocks the upgrade, `blocked` surfaces, connections close on `versionchange` |
| 19 | downgrade refusal | stored version 2 opened at 1 → `VersionError`, recoverable surface, data intact |
| 20 | empty ledger state | new factory → `/bills` shows the CTA and the CTA is what navigates |
| 21 | restore-on-open | no in-memory document → most recent `savedAt` restored, tie broken by `billId`, with the revision/`savedAt` notice |
| 22 | save on revision 0 | `begin` alone writes a record; `clear()` does not delete it |
| 23 | roster reachable in a draft-only bill | `addParticipant` succeeds with zero items; the grid shows its own hint |
| 24 | unloadable record is per-bill | a fixture with `count(units) ≠ qty` throws in `rebuildDocument`, the ledger still lists and opens the others |

`playwright/persistence.spec.ts` — **split tests**, each self-contained from its own capture per HANDOFF's
e2e-structure note (fully-parallel contexts are isolated, so each gets its own IndexedDB), and no
`test.setTimeout` overrides (the 30 s / 5 s / 5 s fail-fast defaults in `playwright/playwright.config.ts`
stand):

1. `bill persists across reload` — capture, accept, edit a price, wait for `save-status=saved`, reload,
   assert the same values and the restored notice.
2. `past bills appear in the list` — two bills, newest first, counts and totals as stored, `Open` reaches
   the right one.
3. `empty ledger offers a capture CTA` — no DB writes yet, CTA navigates.
4. `creator profile saves and restores` — panel, reload, values intact; a later bill's creator participant
   carries the name (P8).
5. `no receipt image is stored by default` — capture+accept+edit, then enumerate the stores **inside the
   page**: only `bills`/`creatorProfile` exist and `retainedImages` has 0 records; no localStorage /
   sessionStorage / caches.
6. `receipt image opt-in stores and deletes` — tick the box, accept, panel shows the kept photo's metadata,
   record present; delete it, record gone, bill and its numbers unchanged.
7. `failed migration shows the export screen and keeps the data` — via `playwright/rig/` (P9/S1): the DB
   stays at v1, the fixture's bill is still readable through the app, the export downloads and the downloaded
   file's contents are read back and asserted (`page.waitForDownload()`), and *Not yet* leaves the app
   working at v1.
8. `lossy upgrade gates on the export` — same rig, a synthetic `lossless: false` step: the upgrade does not
   run until a download has been produced, and `indexedDB.databases()` still reports version 1 beforehand.
9. `a deleted bill takes its photo with it` — opt in, delete the bill, assert both records gone.
10. `last write wins across two tabs, and both are told` — two `context.newPage()`s on one bill, edits in
    each, the notices asserted on both (P5's honest version of the brief's "or last-write-wins" case).

**Existing specs ticket 14 must touch, in this ticket, with the reason:**
`capture.spec.ts:211-229` ("no receipt bytes reach any store") asserts
`expect(stores.databases).toEqual([])`, which stops being true the moment `/bill` opens the database — P7's
restore reads it. It becomes test 5's shape: the only database is `receipt-lens`, its image-bearing store is
empty, and the other three emptiness assertions stay. This is a strengthening, not a weakening: the old test
proved "no DB exists", the new one proves "the DB exists and holds no image". `app-server.ts`'s
`APP_ROUTES` gains `/bills`; `smoke.spec.ts` gains the rig-absent-from-bundle guard; both test counts move,
and the numbers reported at Checkpoint 3 are the ones `pnpm -r test` and `pnpm test:e2e` print, not ones
predicted here.

## P11 — Reporting discipline

`DECISIONS/0018`'s rule applies verbatim: **nothing in this record is a measurement of shipped code.** There
is no IndexedDB code in the repo yet; every claim here is a predicate `tests/persistence/pins.test.ts`
asserts, or a citation of a spec line, or a statement about what a browser's API does (§10 line 749's rules
and the W3C upgrade-transaction semantics P3 relies on). The two behavioural assumptions that are *not*
mine — that an aborted `versionchange` transaction reverts schema changes as well as data, and that
`fake-indexeddb` agrees with Chromium about this record's shapes — are each discharged by a test in two
implementations (pins 7 and P9.2's agreement check), not asserted as true because a spec says so.

`docs/pwa-design.md` §1.1 and §1.2 carry a supersession pointer to this record from the same commit that
adds it (P2's supersession), because a schema plan that still points a fresh session at ten stores is worse
than no plan. `PROJECT(1).md` is not edited: the standing rule is unchanged, and §10 lines 747–752 already
say everything P1–P4 pins.

## P12 — What this record does not decide

- **Restore from an export.** Ticket 14 produces the file; importing one is not asked for by any ticket or
  by ROADMAP 3A, and a restore has its own conflict rules (what if the DB already holds a newer revision of
  that bill?) that deserve a record with a use case in front of it. `exportVersion`/`dbVersion` exist so a
  later ticket can decide without a format change.
- **A participant rename operation.** P8 seeds the creator's name from the profile; nothing in 14 needs to
  rename an existing participant, `transactions.ts` has no such operation, and inventing one to make the
  roster feel complete is not this ticket's job.
- **Undo/redo.** Still not in v1 (0019 "does not decide"), and an undo that skipped the runner would be
  §6 line 400's worst violation.
- **A cross-tab sync protocol.** P5 detects and reports; merging two divergent `WorkingBill`s is not
  representable in v1 and nothing asked for it.
- **Photo viewer, EXIF stripping, image size policy.** P6 stores the accepted working copy at its own
  bytes; a re-encode/resizing rule is a capture-pipeline decision (3B) with a footprint measurement
  attached, and there is no number for it yet.
- **Multi-device, backend sync, `StorageManager.persist()`/`requestPersistentOwnership`.** §19's no-backend
  rule. The quota surface (P10.1) is handled as the failure it is, not as a reason to ask for persistence
  permission.
- **`BillShareSnapshot.snapshotVersion`, the fragment format, service-worker caches.** §10 line 751 keeps
  these numbers apart; tickets 16 and 17 own them. P4's `exportVersion` is a fourth one, and it belongs to
  the file, not to the database or the link.
- **Any §10/§4 shape.** `WorkingBill`, `Bill`, `Participant`, `ItemUnit`, `ItemUnitAssignment`,
  `AdjustmentLine`, `UnclassifiedRow`, `BillValidationResult` and `LockBlockerCode` are unmodified.
  `CreatorProfile` is transcribed from §10 lines 602–605 verbatim — the brief for this ticket says it
  already exists in `entities.ts`; **it does not** (verified: `entities.ts` has `Bill`, `Participant`,
  `Item`, `ItemUnit`, `ItemUnitAssignment`, `BillCharge`, `AdjustmentLine`, `SplittableBill`), so ticket 14
  adds it as the first consumer of its own row. The new types in this record are `StoredBillRecord`,
  `CreatorProfileRow`, `RetainedImageRecord`, `ExportEnvelope` and `MigrationStep` — all storage-layer, none
  bill-layer.
- **Whether the citation drift in the earlier records matters.** 0019 S3/S5 and 0020 T8 cite "§10 line 743"
  for the recomputed-on-load rule; ticket 13 inserted the `excludedRowIds`/`staleLinkCutoffAt` paragraph at
  line 743, pushing that rule to **line 745**. This record cites 745 and leaves the older records alone —
  editing a merged decision's line numbers would break its own git blame for a cosmetic fix — but a fresh
  session reading "§10 line 743" should go to 745.
