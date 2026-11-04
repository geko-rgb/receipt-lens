# DECISIONS/0019 — Bill state management: one immutable document behind a single reactive root

Date: 2026-11-04 · Ticket 11 · **Status: binding for tickets 11–16.**

Ticket 10 moved state by hand: `Capture.svelte` kept its parse in local `$state`, and `lib/draft.ts`
handed the accepted one to `/bill` as a module value. That is a *handoff*, and it works because a
capture session has exactly one owner. Ticket 11 is the first ticket whose state outlives the component
that created it: the same bill must be readable and writable from `/bill` (11), while units are assigned
(12), at lock (13), from IndexedDB (14), as a snapshot (16) and through the participant view (16).
Choosing the transport later means refactoring all of them, so the choice is made here, before any
editor code exists, per the ticket's own order of work.

This record decides **the shape and the commit rule**. The transaction *semantics* — what counts as a
failure, what an edit may not touch — are `DECISIONS/0020`.

## S1 — The decision, in one line each

- **Svelte 5 runes, one module-scope `$state` root**, in `packages/pwa/src/lib/bill/bill-document.svelte.ts`.
  The same mechanism ticket 10 already uses for every view-level value (`Capture.svelte:40-62`), and the
  reason `DECISIONS/0017` D7 rejected the framework-free build: "the v1 UI is exactly the reactive
  workload a runtime buys: derived exact shares recomputed on every add/edit/delete, lock blockers
  recomputed from state."
- **The root holds one immutable `BillDocument`** — the working bill *plus* the derived totals and shares
  *plus* both validation results — and every mutation replaces it as a single value. That is what makes
  §6 line 400's "persist the changed working state **atomically**" implementable rather than aspirational.
- **No business rule lives in the reactive module.** All of it is framework-free in
  `packages/pwa/src/lib/bill/*.ts` — `working-bill.ts` (§10 entity types), `document.ts` (the committed
  unit, `deepFreeze`, `visibleFindings`), `mapping.ts` (3C.1: `ParseResult` → drafts), `totals.ts`
  (recompute), `units.ts` (materialization and quantity maintenance), `finalize.ts`, `transactions.ts`
  (the runner) — the same separation `DECISIONS/0018`'s salvage note set for `lib/capture/`.
  `validateWorkingBill` sits at **`src/lib/validate-bill.ts`**, outside `bill/`, because §6 line 399 names
  that exact path and `PROJECT(1).md` is the source of truth: a reviewer grepping the spec's path must find
  the file there. The reactive module is a slot plus projections: ~40 lines, and it is the only file in
  `bill/` that imports Svelte.
- **The document is JSON-safe by construction, and a test enforces it** (S6), because ticket 14 persists
  it and ticket 16 serializes a projection of it.
- **Derived state is recomputed, never trusted** — including from this document's own previous copy
  (§10 line 743), and including across a reload: what persists is `working`, and nothing else.

## S2 — What §6 line 400 actually constrains

The contract, verbatim: *persist the changed working state atomically → recalculate derived exact
totals/shares → run core `validate()` → run `validateWorkingBill()` → update UI findings/blockers. If the
transaction fails, roll back the data change and do not display derived state from the failed mutation.*

Three consequences decide the shape, and each rules something out on its own:

1. **One commit point, not five writes.** With one store per collection (`items`, `charges`, `totals`,
   `blockers`), the five steps are five separately observable states. A reader — a `$derived`, an e2e
   assertion, a Svelte effect — can see new items with old totals. The spec's "never sees a number that
   disagrees with the data just written" (ticket 11's own headline) is then unachievable by construction,
   not by care. A single root value makes the intermediate state *unnameable*.
2. **Rollback means "never committed", not "undo".** §6 line 400's failure clause forbids *displaying*
   derived state from a failed mutation. If derived state is a lazy `$derived` of the data, then writing
   the data publishes the derived values, and a later failure must retract them — a retract path in every
   reader. If derived state is committed *inside the same value* as the data it came from, the failed
   transaction simply does not produce a document, and there is nothing to retract. This is the single
   strongest argument in this record, and it is why option (b) in S3 wins over option (a).
3. **`validateWorkingBill(workingBill)` takes the whole bill** (§6 line 399: "computes lock blockers from
   the complete working state"), so the complete working state must be reachable as one value from one
   place — not assembled per call from several stores that may be mid-update.

## S3 — The shape

```ts
// The committed unit. Everything in it belongs together, and nothing in it is a closure.
interface BillDocument {
  readonly revision: number;                     // 0 at beginFrom, +1 per committed transaction
  readonly working: WorkingBill;                 // §10 entity — incl. parseResult/parseValidation
  readonly derived: DerivedBillState;            // written by the recompute step, same value
  readonly billValidation: BillValidationResult; // written by validateWorkingBill
}

// Not part of the committed value: what the operation changed, returned so the UI can say so.
interface TransactionEffects {
  readonly finalizedItemIds: string[];
  readonly finalizedChargeIds: string[];
  readonly removedUnitIds: string[];             // business.md §14.3: "the UI must clearly identify
  readonly removedAssignments: ItemUnitAssignment[]; //  assignments that will be removed"
}
```

`DerivedBillState` and `TransactionEffects` are deliberately different kinds of thing. The first is a
projection of the current state, so it belongs inside the committed value and is replaced with it. The
second is an *event*: true about the transaction, not about the bill, and it would go stale the moment
anything else happened. Keeping it out of `BillDocument` is the ticket's "do not display derived state from
the failed mutation" made structural — there is no history field in the document to display.

`working.parseValidation` is §10's own field (line 690), so the document does not duplicate it — and the
transaction's step 3 writes its fresh `validate(working.parseResult)` result *into* `working`, not beside it.
Core is pure and this ticket never mutates `parseResult`, so the value equals what `beginFrom` was handed;
what matters is that it is stored in one direction through the commit, so no reader of `working` can be
given an answer computed against a different revision.

What the UI shows is `visibleFindings(document)` — core's extraction findings minus the arithmetic ones §10's
edited fields make stale, plus the PWA's — and that supersede rule is `DECISIONS/0020` T8's, not a rendering
convention.

`DerivedBillState` — the numbers the editor shows, named after §10 line 743's derived selectors and kept
separate from the printed facts they are compared against:

```ts
interface DerivedBillState {
  readonly calculatedItemsTotal: number;        // Σ Item.lineTotal, finalized items only
  readonly calculatedSubtotal: number;          // === calculatedItemsTotal in v1 (see note)
  readonly chargeEffectsTotal: number;          // Σ signed, non-included, classifiable charges
  readonly calculatedPayableTotal: number;      // subtotal + chargeEffectsTotal
  readonly printedSubtotal: number | null;      // parseResult.subtotal — never rewritten by an edit
  readonly printedGrandTotal: number | null;    // bill.grandTotal — only an explicit edit moves it
  readonly reconciliationGap: number | null;    // printedGrandTotal − calculatedPayableTotal
  readonly shares: ParticipantShare[] | null;   // null when its preconditions are unmet (0020 T7)
  readonly sharesBlocked: readonly ShareBlockerCode[]; // why, as codes, never as a thrown error
}
```

Two choices worth naming, because both would otherwise be rediscovered as bugs:

- **Totals are over finalized entities only.** A `DraftItem` may hold `null` price (§10 line 764), so it
  has no line amount to sum. An all-draft bill therefore shows `calculatedItemsTotal = 0`, and that is
  the correct answer to a question the bill has not yet committed to. The UI must show the draft count
  and the `draft_items_unresolved` blocker next to it, so an honest zero is never mistaken for "nothing
  bought" — and `reconciliationGap` against the printed total is what makes the gap visible (§10 line 792).
- **`calculatedSubtotal` duplicates `calculatedItemsTotal`** rather than substituting for the printed
  subtotal. §10's arithmetic (`base_computed_total = subtotal + charges …`, §6 line 445) starts from the
  *printed* subtotal, and computing it from Σ item totals would be "computing the thing being checked" —
  the exact reasoning DECISIONS/0011 V1 row 8 uses to refuse that substitution inside `validate()`. So
  the printed subtotal stays an input (from the retained `ParseResult`) and the derived one is the item
  list's own sum. `Bill` has no `subtotal` field in §10, so the printed fact lives where it was
  imported: `working.parseResult.subtotal`.

Reactive access, in the one module that holds it:

```ts
let current = $state<BillDocument | null>(null);          // the only mutable cell
export const bill = {
  get document() { return current; },                     // whole-document reads (validate, snapshot)
  commit(document: BillDocument) { current = document; }, // the only writer
};
```

Views project from it (`$derived` over `document.derived.*` / `document.billValidation.*`); they never
recompute a rule. `totals.ts` and `validate-bill.ts` are callable without Svelte at all, which is how the
bill-state seam the ticket's Verify line names is tested: construct a document, apply an operation,
assert the full observable delta.

## S4 — Alternatives, and what each loses

| Option | Verdict | Why |
|---|---|---|
| **Svelte stores** (`writable`/`derived`) | rejected on S2.1/S2.2 | A derived store recomputes *lazily, from whatever the data currently is*, so the persist→recompute→validate order cannot be enforced by the graph, and a rolled-back write leaves derived stores recomputed from the state that was supposed to vanish. Getting atomicity back means writing one combined `writable<BillDocument>` — at which point the store is the S5 shape with an extra subscription layer and `$`-syntax per consumer, not a different design. `get(store)` from a pure module also needs the store, so the seam gets a framework dependency it does not want. |
| **Custom class with hand-rolled signals** | rejected | It re-implements runes S1 already commits to, and `DECISIONS/0017` D7 already rejected the same argument for the whole framework choice. A class instance also fails S6 (methods and prototypes are not JSON), so ticket 14/16 would need a serialization boundary anyway — the cost lands later and the benefit is nil now. |
| **Context API** (`setContext`/`getContext`) | rejected on scope | Context lives in a component tree, and the tree is torn down on every route change: `/capture` unmounts before `/bill` mounts (ticket 10 navigates with `pushState`, `Capture.svelte:319`). The state must outlive that, be readable from the transaction runner (plain TS), and be reachable from a test with no component tree. Context also makes the state invisible to `lib/bill/*`, which is exactly where the rules must live. |
| **Keep ticket 10's route-local pattern** | rejected | It is one component's state with a manual handoff. Four tickets now need the same value, and the handoff cannot carry blockers, units or shares without becoming this record. |
| **URL/router as the store** | rejected | The in-house router owns path→view and the fragment is ticket 16's bearer payload (D3a). Bill state in a URL would put editable data through a router that is explicitly forbidden from decoding or normalising it. |
| **Zustand/Jotai/nanostores** | not evaluated | A new runtime dependency for a single-document store; `DECISIONS/0017` D6's posture (no new runtime dep without a measured reason) applies, and no dimension here needs it. |

## S5 — What persists (the ticket-14 contract)

`docs/pwa-design.md` §1.1 lays out ten object stores and states the rule: "Nothing in this list is a
*derived* value… Shares are recomputed on load and never trusted from a cache." So:

- **Persisted: `document.revision` and `document.working`, nothing else.** §10's `Bill`, `draftItems`,
  `items`, `units`, `assignments`, `charges`, `adjustments`, `participants` and the retained
  `parseResult` are all inside `working`. `derived` and `billValidation` are rebuilt on load by running the
  recompute and validate steps over the restored `working` — the same code path a transaction uses, so a
  reload cannot disagree with an edit. `working.parseValidation` (§10 line 690) is rebuilt too: it is a
  pure function of `parseResult`, so storing it would be storing a second answer to the same question.
- **`derived` is a cache in memory only.** Keeping it out of IndexedDB is not a simplification, it is
  §10 line 743's rule, and it is why it is a *sibling* of `working` in the document rather than fields
  on `Bill`: the shape makes "persist the working bill" and "persist the totals" two different acts,
  and only the first is allowed.
- **The document is normalized into §1.1's stores or kept whole — ticket 14's call.** This record only
  requires the lossless round trip (S6). §1.1 already flags the same open question about
  `parseResult`/`parseValidation` and `adjustmentLines`, and its recommendation stands.
- **`revision` is the concurrency token.** If two tabs are ever open, ticket 14's write must compare it.
  v1 is single-tab; the field exists so "last write wins" is a decision 14 can make deliberately.

## S6 — Serializability, enforced rather than hoped

The rule: a committed `BillDocument` must survive `JSON.parse(JSON.stringify(x))` with deep equality
intact. No `Map`, `Set`, `Date`, `BigInt`, class instance, closure or `undefined`-valued property anywhere
in it. `ExactMoney` stays `{ numeratorPaise, denominator }` as decimal strings (§10 line 585, and
`exact-money.ts` already returns exactly that plain object), so S6 is a constraint on *this* record's
types, not on ticket 02's money.

Why pin it now instead of in ticket 14: every non-JSON field added in 11–13 is a migration bug in 14 and
a silent data loss in 16, and both failures are invisible until a reload. `tests/bill/pins.test.ts`
asserts the round trip on a committed document, so the rule has a test rather than an intention.

## S7 — Immutability, and what freezes

`working` and everything reachable from it is deep-frozen at commit. Not as decoration: the transaction
runner builds each new document by copying the entity it changes and reusing the rest (structural
sharing), so a stray `draftItems[0].unitPrice = 1000` in some later view would corrupt the document that
is also the persistence record, the validation input and the snapshot source — while looking exactly like
a working edit. A frozen committed value turns that into a `TypeError` at the line that did it, in a
browser console and in tests alike. The copy-on-write cost is irrelevant: a bill is tens of records.

`Object.freeze` is shallow, so `totals.ts`/`transactions.ts` freeze recursively at the commit boundary
(one `deepFreeze` helper, used in exactly one place). Test: attempting an in-place write on a committed
entity throws (strict mode) and the document is unchanged.

## S8 — The reactivity trap ticket 10 hit, recorded where 11 will find it

From ticket 10 (`Capture.svelte:133-142`): **`bind:` on an element whose existence is gated by the value
being bound is a reactivity loop.** `bind:naturalWidth` inside `{#if naturalWidth > 0}` tore down and
remounted its own image forever; the fix was to take the value from an explicit `onload` handler instead
of a binding. The bill editor is the same shape twice: `{#if editing}<input bind:value={editing}/>{/if}`
and any `{#each units}` list that re-creates rows as their own bound value changes.

**Rule for 11–16:** the source of truth is the committed document plus explicit event handlers; an input
may be `bind:`-bound only to *component-local draft text* that is not a gate for its own element, and a
value that reaches `BillDocument` must arrive through a handler calling a transaction. `tests/bill`'s
e2e spec drives a price edit and a delete, so the loop, if reintroduced, hangs the acceptance test rather
than the reviewer's browser. Recorded here because it belongs with the state decision; `docs/pwa-design.md`
§3 is the shell's state note and stays as ticket 10a wrote it.

## S9 — What this hands to the next tickets

| Ticket | It gets | It must not do |
|---|---|---|
| 12 — unit assignment | `assignments`/`itemUnits` already live in `working`; assignment is one more transaction returning a new document | add a store, or read units from the DOM |
| 13 — lock | `billValidation.blockers.locking` is already the full nine-code set (0020 T9) after every transaction; locking is a transaction that finalizes resolved drafts in bulk and sets `isLocked` | recompute blockers outside the runner, or infer a blocker from finding *text* (§6 line 401) |
| 14 — IndexedDB | one JSON-safe `working` + `revision`, and a `recomputeDocument(working)` that rebuilds the rest | persist `derived` or either validation result (§10 line 743) |
| 16 — share snapshot | a committed locked document to project `BillShareSnapshot` from, never live `$state` | read the snapshot mid-transaction; there is no such thing |
| 18 — egress audit | no network anywhere in the store; the document holds no image or OCR text (`mapping.ts` copies fields, it does not retain `OcrResult`) | — |

## S10 — Revisit triggers

- **More than one bill open at once.** The root becomes `Map<billId, BillDocument>`; S3's shape and S2's
  commit rule are unchanged, so this is a widening, not a rewrite. Not in v1 (§13: one creator, one bill
  in flight; the local ledger of past bills is ticket 14's own store).
- **Routing outgrows the in-house router** (`DECISIONS/0017` D3/D8): the state decision survives, because
  it never touched routing.
- **A Svelte 5 incompatibility forcing D7's React fallback:** everything in `lib/bill/*.ts` transfers
  unchanged — that is the boundary's purpose — and only the ~40-line slot in S3 is rewritten. The
  fallback must not be used as a reason to move rules into components.
- **A transaction that needs to write two documents** (e.g. splitting one bill into two): S2.1's single
  root no longer covers it. Nothing in v1 does.

## Reporting discipline

`DECISIONS/0018`'s rule applies verbatim: no number in this record is a measurement of shipped code, and
nothing here claims one. The claims are structural (which shapes can be observed, which writes are
possible) and each is discharged by `packages/pwa/tests/bill/pins.test.ts` in the same ticket, which is
the source of truth for any behaviour asserted here. The framework evidence this record leans on is
`DECISIONS/0017` D1–D5, whose probe artifact is retained per that record's own terms.

## What this record does not decide

- **The transaction *semantics*** — what counts as a failure, whether findings block edits, provenance
  and printed-fact rules: `DECISIONS/0020`.
- **The IndexedDB mapping** (whole document vs §1.1's ten stores): ticket 14, in its own record, as
  §1.1's "open" paragraph already says.
- **Undo/redo history.** S3 keeps `revision` and immutable documents, so a history stack is *possible*;
  v1 asks for it nowhere, and an undo that skips the transaction runner would be the §6 contract's
  worst violation. Not built, not implied.
- **Whether `billValidation` results are cached across transactions.** They are recomputed per
  transaction inside the runner; caching them is a performance question with no v1 evidence behind it.
- **Multi-tab or cross-window state.** `revision` exists; no sync protocol exists; ticket 14 decides.
- **`PROJECT(1).md`**: unedited by this record. It was later edited once in ticket 11, by owner instruction
  and for a different question — the §19 out-of-scope entry for fractional/weight quantities — not by this
  decision.
