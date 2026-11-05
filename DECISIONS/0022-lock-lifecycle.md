# DECISIONS/0022 — The lock checklist and the bill lifecycle: exclusion, unlock, and where "locked" lives

Date: 2026-11-05 · Ticket 13 · **Status: binding for tickets 13–16.**

Tier-3 parameters, pinned **before** the code, in the posture `DECISIONS/0011`, `0018`, `0019`, `0020` and
`0021` take: every pin below is a predicate the shipped tests assert, and nothing here is a measurement of
behaviour that does not exist yet. The store and commit rule are `DECISIONS/0019`; the transaction semantics
are `DECISIONS/0020`; assignment is `DECISIONS/0021`. This record answers the seven questions ticket 13 was
handed, closes ticket 11's `unclassified_rows_unreviewed` gap, and states one consequence of §10 + §13 +
0021 A1 that the ticket order did not anticipate (L3).

## L0 — The pins, in one line each

1. **"Explicitly excluded" is a PWA-owned set on the working bill** — `excludedRowIds: string[]` — not a
   field on core's `UnclassifiedRow`. Exclusion is a lock-gate acknowledgement and moves no money (L1).
2. **Locked-bill edits keep the one existing code, `bill_locked`.** No per-operation codes: the condition is
   the state, and the remedy is the same unlock for every operation (L2).
3. **Unlock's dialog warns that already-sent links keep showing the amounts they were locked with and cannot
   be recalled**, that new tokens mean new links must be sent, that the bill becomes editable, and that paid
   flags survive. It never promises revocation (L4).
4. **Tokens are minted by the lifecycle:** lock mints only for participants whose token is empty, unlock
   re-mints for all. Every locked document is therefore link-ready, and a re-lock does not churn a second
   generation (L5).
5. **Unlock never reverts `paid`.** Settlement is not a property of the lock (L7).
6. **There is no `lockedBill`.** A locked bill is the same committed `BillDocument` with
   `working.bill.isLocked === true`; "frozen" is the runner's guard, not a second object (L8).
7. **`zero_items` is a parse finding and never a lock blocker.** A hand-built bill may lock with zero items
   if every checklist item is clear (L9).
8. **The five lifecycle states are derived, never stored** — `lifecycleOf(document)`; `draft` is the
   untouched import, `review_required` is an edited bill still blocked, `ready_to_lock` is unlocked with a
   clear checklist and no draft items, `locked`/`settled` follow `isLocked` and `paid` (L10).

## L1 — "Explicitly excluded" gets a field: `excludedRowIds` on `WorkingBill`

§10's table says `unclassified_rows_unreviewed` clears when "every ambiguous row affecting receipt
interpretation is classified or explicitly excluded", and `UnclassifiedRow` (`packages/core/src/types.ts:53`)
carries `id, text, box, sourceLineIds, reason: "ambiguous", warningCode` — no review state. `DECISIONS/0020`
T8 emitted the blocker from what existed and named the gap as ticket 13's. The representation:

```ts
interface WorkingBill {
  // ... §10's ten fields, unchanged ...
  /** Row ids the creator has accounted for. PWA review state, never parse output. */
  excludedRowIds: string[];
  /** ISO timestamp: snapshots created before this were taken from an earlier lock (L6). */
  staleLinkCutoffAt: string | null;
}
```

**Why a set beside the rows instead of `UnclassifiedRow.excluded: boolean`.** `UnclassifiedRow` is core's
public parse output, and core's `validate()` "does not know about persisted participants, `ItemUnitAssignment`s,
drafts, payer IDs, or lock state" (§6). A review flag on it would make core carry a PWA decision, and would
put "the parser saw this row as ambiguous" and "the creator chose to exclude it" into one record — the
distinction the findings/blokers split exists to keep. The precedent is `DraftItem.assumedQtyReviewed`: the
acknowledgement lives on the PWA tier's entity, not on the parser's `ParsedItem`. `WorkingBill` is §10's
"whole mutable state" and 0019 S5's persistence unit, so both new fields travel with the bill through ticket
14 and are absent from ticket 16's snapshot (which carries resolved data only).

§10 now carries the owner-authorized note (2026-11-05) for both fields, verbatim: *"PWA-layer
additions to the working model, not core types: `WorkingBill.excludedRowIds: string[]` … and
`WorkingBill.staleLinkCutoffAt: string | null` … These live on `WorkingBill`, not on core `ParseResult` or
`ParsedItem`, to preserve the tier boundary. Full semantics in `DECISIONS/0022`."*

**The cost, named:** an id set can in principle go stale. In v1 it cannot: rows are only replaced when the
bill is replaced (0020 T5 — a re-import is an explicit new bill, never a merge), so nothing removes a row from
a live `WorkingBill`. The blocker filter treats an unknown id as inert rather than as corruption.

**What exclusion means, exactly.**

- The row stays in `working.unclassifiedRows` and stays visible. Exclusion is not deletion; hiding parse
  evidence is the one thing §10's row preservation forbids.
- **Exclusion moves no money.** `calculatedItemsTotal`, `chargeEffectsTotal`, `calculatedPayableTotal`,
  `derived.shares` and `reconciliationGap` are identical before and after. The row never entered arithmetic
  (§6 line 461: ambiguous rows do not create items), so there is no effect to remove. It is a statement that
  the row is intentionally not part of the bill.
- `unclassified_rows_unreviewed` keeps `DECISIONS/0020` T8's claim rule — a row is explained while a live
  draft or item resolves to a `ParsedItem` sharing a `sourceLineId` — and adds: *or* its id is in
  `excludedRowIds`. Refs are the row ids that are neither.
- **One operation, both directions:** `setUnclassifiedRowExcluded(document, rowId, excluded)` in
  `transactions.ts`. Setting `false` restores the row to blocking. A one-way "exclude" would make a misclick
  permanent short of deleting the row, and there is no operation that deletes a row. Unknown id →
  `unknown_entity`.
- **"Classified" is not separately representable in v1.** Binding a row to a hand-entered line would need a
  `sourceLineIds` field on `DraftItem` that §10 does not have, and matching by text is exactly what §6 line
  401 forbids. So exclusion is also the v1 way to say "I have accounted for this row by hand": the row is not
  part of the *computed* bill, but the typed line is. The UI's label says "Exclude from bill", and the hint
  beside it says the row stays visible and is not counted. Recorded here rather than discovered as a UX
  argument later.

**The blocker matrix** the ticket's Verify line asks for — every code produced by its condition, cleared by
its fix, asserted in `packages/pwa/tests/lock/pins.test.ts`:

| Code | Fixture that produces it | Fix that clears it |
|---|---|---|
| `draft_items_unresolved` | a parsed line with `qty: null` | `setItemQuantity` a whole count (then finalize/assign as needed) |
| `draft_charges_unresolved` | an `other` charge with `otherSign: "unknown"` | `setChargeSign` to `add`/`subtract` |
| `tax_inclusion_unresolved` | a detected tax with `included: null` | `resolveChargeInclusion` |
| `units_unassigned` | a finalized qty-2 line with one unit held | `assignUnit` or `acknowledgeUnassignedUnit` |
| `assumed_qty_unreviewed` | a parsed item with `quantitySource: "assumed"` | `reviewAssumedQuantity` |
| `grand_total_missing` | `parse.grandTotal === null` | `setGrandTotal` |
| `payer_missing` | a working bill whose `payerId` names nobody (raw-operation seam, below) | `setPayer` to a participant |
| `unclassified_rows_unreviewed` | an ambiguous row no live line claims | `setUnclassifiedRowExcluded(row, true)` |
| `negative_share_after_discount` | a discount larger than every settled item plus the other charges | `setChargeAmount`/`deleteCharge` to bring the discount inside the bill |

`payer_missing` is unreachable through the product operations — `beginFrom` sets the payer to the creator and
`setPayer` rejects an unknown participant — so its pin builds the state through `runTransaction`'s generic
operation parameter (the seam `DECISIONS/0021` A3 used for `bill_locked`), then asserts the lock refuses. That
is a test seam, not a product path, exactly as 0021 A3 ruled.

The nine are not jointly reachable: `units_unassigned` and `negative_share_after_discount` cannot co-fire
because shares are computed only when every unit is assigned or acknowledged (0020 T7). The matrix is
therefore eight from one authored bill plus the ninth from another, as 0020 T8 already states.

## L2 — Locked-bill rejections: `bill_locked`, one code, at the runner

`runTransaction` already returns `bill_locked` before the operation runs when `previous.working.bill.isLocked`.
Ticket 13 activates that path through the real lock flow and adds **no per-operation codes**
(`edit_locked`, `assign_locked`, …). Three reasons:

- The condition is the bill's state, not the operation's kind; 0020 T1 words it as "any mutation while
  `bill.isLocked`", and five codes with one remedy would be five names for one decision.
- The guard sits above the operation table, so no future operation can forget it. Per-operation codes would
  invite an operation to check for itself.
- The UI's response is identical for every rejection: show the message and offer Unlock. A code that does not
  change the remedy is vocabulary without information.

The lifecycle actions themselves are the one exception, and it is not a bypass: `unlockBill` must write while
`isLocked` is true, so the runner gains an internal `requireUnlocked` flag on a shared commit path.
`runTransaction`'s exported signature is unchanged (`requireUnlocked: true`); only `unlockBill` passes
`false`, and no caller can reach the flag. `lockBill` runs with the guard on, so locking an already-locked bill
returns `bill_locked` — the code's own condition, applied to a lifecycle action, with no tenth code invented.

## L3 — The lock transaction, the checklist invariant, and the recorded deviation

`lockBill(document, options)` is one §6-line-400 transaction whose operation:

1. finalizes every **draft charge** whose §10 gates are met (`DECISIONS/0020` T6's bulk form, the same helper
   `finalizeAllResolvable` uses — one implementation, two callers);
2. rejects **`items_unfinalized`** if any draft **item** remains, with `refs` = those ids;
3. sets `working.bill.isLocked = true`;
4. mints the missing tokens (L5).

**Deviation from §10 line 645 (recorded, not silent):** *"At lock attempt, resolved drafts may be finalized
in bulk"* cannot apply atomically to draft items, because item finalization materializes units in pending
state (0021 A1) and per-unit acknowledgment is a creator act that bulk-finalize cannot perform on the
creator's behalf (0021 A4). `lockBill` therefore finalizes only draft charges (which have no units); draft
items must be finalized via `finalizeAllResolvable` as a separate committed transaction before lock. If the
user clicks Lock with draft items present, the UI surfaces the path ("finalize N draft items" → assignment UI
→ lock) rather than attempting it atomically. This is a UX constraint, not a correctness compromise: the
outcome is the same, just one more step.

**Why `items_unfinalized` and not `draft_items_unresolved`.** Broadening that blocker to fire for any draft
would make the checklist complete, but it contradicts `DECISIONS/0020` T8's pinned clearing rule — a
resolvable draft does not raise it — which has its own assertion (`packages/pwa/tests/bill/pins.test.ts:235`).
So the lock action carries the missing precondition as a rejection of its own: a guard for a state the UI
never sends, in the shape 0021 A3 used for a duplicate pair. The checklist panel shows a "finalize N draft
items first" line beside the blockers instead of inventing a tenth blocker code (§13's nine are closed), and
`ready_to_lock` (L10) requires no draft items for the same reason. Draft *charges* are the exception that
proves the rule: they materialize no units, so a bill whose only drafts are charges locks in one transaction.

The checklist itself is **not** evaluated inside the operation. The runner runs
`recompute` → core `validate` → `validateWorkingBill` in the pinned order, and only then applies the
invariant:

> A committed `BillDocument` with `working.bill.isLocked === true` must have
> `billValidation.blockers.locking.length === 0`.

If it does not, the transaction is rejected as **`lock_blocked`** with `refs` = the blocker codes, sorted, and
the input document is returned by identity. This is what keeps `DECISIONS/0019` S9's "13 must not recompute
blockers outside the runner" true: the blockers that decide the commit are the ones the runner just computed
and would have committed, not a second calculation in the operation.

**Why a rejection rather than a thrown error:** the same reason 0020 T1 gives for every other failure — the
document is returned `===` the input, so "no derived state from the failed mutation" is an identity a test
asserts.

**Why one transaction and not "finalize, then lock":** 0020 T6 says there is no partial commit, and 0021 A7
rejects apply-and-undo. A lock attempt that cannot complete leaves the bill exactly as it was.

**`refs` carries codes here, deliberately.** 0020 T1's `refs` normally name entities. For `lock_blocked` the
subject of the rejection *is* the checklist, so the codes are the addresses, and the per-entity detail stays
in the returned document's `billValidation.blockers.locking[].refs`. This is a widening of `refs`' meaning for
one code, recorded rather than assumed, in the same spirit as 0021 A3's extension of `unknown_entity`'s
subject to a pair.

**Lock moves no money.** `calculatedPayableTotal`, `derived.shares` and `reconciliationGap` are recomputed in
the locking commit and are numerically what they were a revision earlier; only `isLocked` and the tokens
change. Locking is not a settlement and sets no `paid` flag (L7).

**No confirmation for locking.** It is reversible by unlock, moves no money, and invalidates nothing. The
dialog budget belongs to the destructive direction.

## L4 — Unlock: the confirmation crosses the seam, and the dialog's exact warnings

```ts
interface UnlockOptions {
  readonly confirmed: true;                 // only the dialog's confirm handler produces this
  readonly now: string;                     // ISO; lib/bill/* never reads a clock (0011)
  readonly mintToken: (participantId: string) => string;
}
unlockBill(document: BillDocument, options: UnlockOptions): TransactionResult
```

The confirmation is a **transaction parameter**, as the ticket asks, not only a UI dialog: unlock invalidates
share material that has already left the device, so "was this deliberate?" is a data-level precondition. A
call without `confirmed: true` (a keyboard shortcut, a retry, a future automation) is rejected as
**`unlock_unconfirmed`** with the document unchanged, rather than relying on the component to be the only
caller. The type makes it hard to write and the runtime check makes it impossible to ship.

Unlocking an already-unlocked bill is rejected as **`not_locked`**. It cannot be a silent no-op: the operation
mints tokens, so "unlocking" an unlocked bill would rotate link material for no reason, and 0020 T12 has no
concept of a revision that changed nothing.

**The dialog warns, in this order:**

1. Unlocking makes the bill editable again.
2. **Links already sent are snapshots of the bill as it is locked now. They will keep showing these amounts,
   and they cannot be recalled or revoked.** (business.md §10: links are immutable snapshots; §13: "cannot be
   reliably revoked". No backend exists.)
3. New share material is generated, so **new links must be sent after the bill is re-locked**; the old link
   and the new one may disagree until then.
4. Payments already marked as paid stay marked (L7).
5. Cancel changes nothing: no transaction, no revision, no token rotation.

Wording rule for the implementation: the dialog must not say the old link "stops working", "is invalidated"
or "is revoked". A fragment link carries its own key material and its own payload (business.md §10), so
rotation cannot reach a copy already on someone's phone. Only the *new* link reflects the edited bill.

## L5 — Token generation: lock mints what is missing, unlock re-mints everything

`Participant.token`/`tokenExpiresAt` are §10's share-link material, created empty by `mapping.ts` and
`addParticipant` because nothing needed them before. The rule:

- **`lockBill`** mints a token for every participant whose `token` is `""`, and leaves every non-empty token
  alone. A locked bill is the only state from which links can be generated (§13), so it must not be
  link-unready; ticket 16 then never has to distinguish "never locked" from "locked".
- **`unlockBill`** mints a fresh token for **every** participant, unconditionally. That is the ticket's
  "unlock regenerates share links", and it is what makes the token generation a lock epoch: any link built
  from a token minted at an earlier lock is recognisably from that lock.
- **`tokenExpiresAt` is not written by ticket 13.** Expiry is client-enforced UX (§10) and the snapshot's
  expiry hint is ticket 16's field to decide; inventing a default TTL here would be a product number with no
  evidence. Recorded in L15.

Injection, not randomness: `mintToken` is a parameter, because `lib/bill/*` never reads a clock or a random
source (0011's determinism rule, the same reason `createdAt` is a caller-supplied ISO string). Tests pass a
deterministic counter; the component passes `crypto.randomUUID()`-backed material. Re-running the same
operation on the same document with the same factory is byte-identical.

## L6 — "Marks previous links stale": a cutoff on this bill, and its honest limits

```ts
staleLinkCutoffAt: string | null   // on WorkingBill
```

`unlockBill` sets it to `options.now`. `lockBill` does **not** clear it, and nothing does. Meaning: *a
`BillShareSnapshot` whose `snapshotCreatedAt` is earlier than this timestamp was taken from an earlier lock of
this bill.* Why it must not clear on re-lock: the old links still exist and still show the old amounts, so
clearing the marker would recreate exactly the "silently contradicting the bill" state the ticket names.

Why a timestamp and not a revision or a lock counter: §10's snapshot carries `snapshotCreatedAt` and no
bill-revision field, so a cutoff in the same unit is the only comparison ticket 16 can make without widening
the snapshot shape (which this ticket must not do). The document's own `revision` (0019 S5) is not in the
link.

**What this can and cannot say — stated because the alternative is a false claim:**

- On a device that holds the current bill (the creator's, and any device after ticket 14) a link whose
  snapshot timestamp precedes the cutoff can be labelled stale, e.g. "a newer version of this bill was locked
  on {cutoff}".
- A recipient holding only an old link has no current bill to compare against, so nothing can be labelled for
  them. The honest surface there is ticket 16's "snapshot from {snapshotCreatedAt}" plus the product copy
  that links are snapshots. This is business.md §10's "where possible", not a gap this ticket can close.
- No revocation, no remote update, no push: there is no backend in v1 and the link is the payload.

## L7 — Unlock leaves paid flags alone

`Participant.paid` is the creator's manual settlement statement (§12 "Payment confirmation is manual"; §13
Settled). Unlocking is an edit-lock transition; it says nothing about money that has changed hands. So
`unlockBill` copies `paid` verbatim, and `lockBill` never writes it either. The visible consequence is
deliberate: unlock → price edit → re-lock can leave a participant marked paid against an amount that has
changed, and ticket 15's settlement view must show the new amount next to the flag rather than silently
clearing it. Re-locking a bill whose relevant participants are still all marked paid lands back in `settled`
(L10) — a settlement record that survives an edit is the honest one, and an amount change is visible because
the share is recomputed.

## L8 — There is no `lockedBill`; the freeze is the guard

The ticket asks whether the locked bill is a projection taken at lock time or the working bill with
`isLocked = true`. It is **the same committed document**, and the reasons are structural:

- `DECISIONS/0019` S3 makes the document the single committed value; S5 persists `revision` + `working` only.
  A second frozen copy would either be persisted (a second source of truth for totals and shares) or rebuilt
  on load (at which point it *is* the derived state 0019 S3 already commits per revision).
- `working.bill.isLocked` is §10's own field. A `lockedBill` entity would be a §10 shape change this ticket
  has no mandate for.
- "Frozen" is enforced, not represented: `runTransaction` rejects every mutation on a locked document before
  the operation runs (L2), and the committed document is deep-frozen (0019 S7), so even a direct in-place
  write throws.
- "Totals and shares computed once against resolved data" is the locking commit's own step 2. The locked
  document's `derived` was produced in the same commit that set `isLocked`, from the post-finalize working
  state, and no later operation can change it except `unlockBill` (which changes neither).

Ticket 16's `BillShareSnapshot` is the projection, built from the locked document when a link is generated;
caching it inside the bill would make 0016's "computedShares is a cache only" into a second authority.

## L9 — `zero_items` does not block lock

`zero_items` is a core critical finding about the *parse* (§6: "No items extracted from input expected to be
itemized"). Findings gate nothing on their own (0020 T2), and §13's lock checklist is closed at nine codes
that do not include it. Adding a tenth would also make the product wrong in the case the ticket names: a user
who hand-adds every line after a failed parse has done the work the finding is complaining about, and §14.1's
"manual input always wins" cannot coexist with a parser opinion blocking that bill forever.

So a bill may lock with zero items if — and only if — every checklist item is clear: a user-confirmed grand
total, a payer, no pending rows, no negative share. `zero_items` remains visible in `visibleFindings`
(`document.ts` keeps every non-arithmetic core code verbatim), which is where a warning about the parse
belongs. Pinned by a test that builds a zero-item parse, sets the total, locks, and asserts both the lock and
the surviving finding.

## L10 — The lifecycle projection

```ts
type LifecycleState = "draft" | "review_required" | "ready_to_lock" | "locked" | "settled";
lifecycleOf(document: BillDocument): LifecycleState   // lib/bill/lifecycle.ts, pure
```

```
if (working.bill.isLocked) return allRelevantPaid ? "settled" : "locked";
if (billValidation.blockers.locking.length === 0 && working.draftItems.length === 0) return "ready_to_lock";
return revision === 0 ? "draft" : "review_required";
```

- **Derived, never stored.** No field, no component variable: the badge reads this function, so a state can
  never disagree with the document that produced it (the ticket's "derived from blockers rather than tracked
  separately").
- **`draft` is the untouched import** (revision 0, not yet lockable). Once anything is committed the bill is
  in review; this is the only distinction §13 offers between the first two states, and it is expressible
  without a flag.
- **`ready_to_lock` requires no **draft items**, not merely an empty checklist, because a lock attempt that
  has to finalize an item cannot succeed (L3). Draft *charges* are excluded from the condition: they finalize
  without creating units, so the lock can complete in one transaction.
- **`settled`** = locked, shares computable, and every **relevant** participant has `paid === true`, where
  relevant means not the payer and not owed exactly zero (§11 rule 10: the payer receives; §12 rule 11: a zero
  share gets no payment link). A locked bill with only the payer is vacuously settled. The state is reachable
  in 13 only by a document that already carries paid flags; ticket 15 adds the toggle, and 13 defines the
  projection it will drive.

## L11 — Payer

`beginFrom` already sets `payerId = creatorId` and the creator is a participant (§11 rule 10's default, §13
Roles). Ticket 13 adds the operation that makes "a non-participant payer is rejected" a rejection rather than
only a blocker:

`setPayer(document, participantId)` — one transaction, `unknown_entity` for an id not in
`working.participants`, otherwise `bill.payerId = participantId`. `DECISIONS/0021` A10 assigns payer
reassignment to this ticket ("inventing a payer-reassignment rule here would pre-empt the lock checklist that
owns it"). The operation is money-neutral: the payer is the payee, not a participant in the split — every
participant's exact share is unchanged, and §12's "the payer gets no self-payment link" is ticket 15's
rendering.

`payer_missing` remains the blocker for a state that does not resolve (L1's matrix builds one through the raw
seam). No operation can produce one.

**Participant removal** is in scope after all — see A16, which builds 0021 A10's
pre-pinned cascade and adds the paid-participant guard.

## A16 — `removeParticipant`: 0021 A10's deferral, in scope, and why a paid participant is unremovable

0021 A10 pre-pinned removal's cascade and deferred the operation to this ticket. It is built here with one
additional rule, per the owner's ruling: **settlement is a completed state that removal cannot un-do.**

`removeParticipant(document, participantId)` is one transaction, and its preconditions are checked in this
order:

- **`unknown_entity`** — no participant on the bill has that id.
- **`protected_participant`** — the id is `bill.creatorId` or `bill.payerId`. §11 rule 10 requires both to be
  participants, so their removal is not a state this model can represent even transiently. Checked before
  `participant_paid`, because it is a structural impossibility while paid is a settlement fact.
- **`participant_paid`** — `participant.paid === true`. The creator must un-mark them paid first (ticket 15's
  toggle), then remove.
- Otherwise the participant and **every assignment naming them** are removed in the same commit. Units that
  lose their only assignee stay `confirmedUnassigned: false`, so `units_unassigned` re-raises and the cost
  transfer to the creator happens only through an explicit acknowledgement (0021 A10/A4) — never as a side
  effect of removal. Charges redistribute because `participantCount` changed; that is the split's answer
  (§11 rule 5), not a removal rule. `effects.removedAssignments` carries the cascade so the UI can name it
  (business.md §14.3), and the roster's Remove action is confirm-first for that reason.

**Why `participant_paid` and not `bill_locked`.** 0020 T1 defines `bill_locked` as a mutation while
`bill.isLocked`. The removal this rule rejects happens on an *unlocked* bill — a locked bill never reaches the
check, because the runner's guard rejects it first — so `bill_locked` would be false on its face. Redefining
it as "any operation that would invalidate the settlement record" would make one code mean two unrelated
conditions, and the remedies differ: unlock a locked bill, but un-mark a paid participant. A code whose
remedy differs is a different code.

The operation does not un-mark `paid`, does not touch units or acknowledgements beyond the cascade, and does
not change `payerId` (the payer cannot be removed at all).

## L12 — Rejections added

Closed-union widenings of `DECISIONS/0020` T1, each for a condition no existing code describes:

| Code | Condition | `refs` |
|---|---|---|
| `lock_blocked` | a lock attempt whose post-finalize `blockers.locking` is not empty (L3) | the blocker codes, sorted |
| `unlock_unconfirmed` | `unlockBill` without `confirmed: true` (L4) | `[]` |
| `not_locked` | `unlockBill` on an unlocked bill (L4) | `[billId]` |
| `unknown_entity` | `setUnclassifiedRowExcluded` names a row not on the bill; `setPayer` names a non-participant | the id |
| `items_unfinalized` | `lockBill` while any draft item remains (L3) | the draft item ids |
| `participant_paid` | `removeParticipant` names a participant with `paid === true` (A16) | the participant id |
| `protected_participant` | `removeParticipant` names the creator or the payer (A16) | the participant id |

`bill_locked` is not new; it becomes reachable through the real lock flow for the first time. None of the four
is a finding and none is added to §13's nine.

## L13 — The seam, and which file owns what

| Concern | File | Kind |
|---|---|---|
| `excludedRowIds`, `staleLinkCutoffAt` on `WorkingBill`; no change to `LockBlockerCode` | `lib/bill/working-bill.ts` | shape |
| `lockBill`, `unlockBill`, `setUnclassifiedRowExcluded`, `setPayer`, `removeParticipant`; the runner's `requireUnlocked` flag and the locked-bill invariant | `lib/bill/transactions.ts` | operations |
| `finalizeResolvable(working)` extracted from `finalizeAllResolvable`, so lock and the bulk form share one implementation | `lib/bill/finalize.ts` | pure |
| `lifecycleOf`, `LifecycleState` | `lib/bill/lifecycle.ts` | pure |
| `unclassified_rows_unreviewed` honours `excludedRowIds` | `lib/validate-bill.ts` | one predicate |
| checklist, lifecycle badge, Lock/Unlock, the unlock dialog, the stale-links notice, the ambiguous-row review list | `src/components/Lock.svelte` (new) + `Bill.svelte` removes the "ticket 13 takes it from here" hint | UI |
| payer selector, the rejected-payer path, and the confirm-first Remove action (A16) | `src/components/Units.svelte` | UI |

`Bill.svelte` keeps no rule: the badge is `lifecycleOf(bill)`, the checklist is
`bill.billValidation.blockers.locking`, and the buttons call the operations through the existing `apply`
wrapper. The lock action's one flow rule — run `finalizeAllResolvable` first when `draftItems.length > 0` — is
in the component, because it is a sequence, not a predicate, and it is named in L3.

E2E hooks: `data-testid="lifecycle-state"`, `lock-button`, `unlock-button`, `unlock-dialog`,
`unlock-confirm`, `unlock-cancel`, `stale-links-notice`, `unclassified-row`, `exclude-row`, `row-excluded`,
`draft-finalize-hint`.

## L14 — Tests

`packages/pwa/tests/lock/pins.test.ts`, written before the implementation and red on exactly these pins:

| # | Pin | Asserted as |
|---|---|---|
| 1 | lock with a clear checklist | `ok`, `isLocked === true`, `revision + 1`, `blockers.locking` empty, shares unchanged in value |
| 2 | lock with each blocker | `lock_blocked`, `refs` = the codes, returned document `===` input |
| 3 | the blocker matrix | each row of L1's table produced by its fixture and cleared by its fix, in CI |
| 4 | locked edits | `setItemPrice` / `setItemQuantity` / `assignUnit` / `deleteItem` → `bill_locked`, document `===` input |
| 5 | lock finalizes resolvable charges | one transaction, `isLocked`, charge moved to `charges`, revision + 1 |
| 6 | lock with draft items | `items_unfinalized` with the draft ids, document `===` input, nothing finalized |
| 7 | unlock without confirmation | `unlock_unconfirmed`, `===` input, tokens untouched |
| 8 | unlock twice | second is `not_locked`, `===` input |
| 9 | unlock regenerates tokens | every token changed, none empty, all distinct |
| 10 | lock mints missing tokens | a never-locked bill's tokens are non-empty and distinct after lock |
| 11 | unlock marks links stale | `staleLinkCutoffAt === now`; re-lock leaves it; derived values unchanged across both |
| 12 | unlock keeps paid | `paid` true before and after |
| 13 | excluded rows | exclusion clears the blocker, row still present, every derived number byte-identical; restore re-raises |
| 14 | zero items | a zero-item bill with a set total locks; `zero_items` still in `visibleFindings` |
| 15 | lifecycle | all five states from documents that reach them; `draft` at revision 0, `review_required` after an edit, `ready_to_lock` only with no draft items, `settled` only when relevant participants are paid |
| 16 | payer | `setPayer` to a participant succeeds and moves no share; a non-participant is `unknown_entity`; a raw-seam non-participant payer raises `payer_missing` and blocks lock |
| 17 | remove a paid participant | `participant_paid`, document `===` input, participant still present |
| 18 | remove an unpaid participant | assignments gone in the same commit, orphaned units pending, `units_unassigned` re-raised, `effects.removedAssignments` names them |
| 19 | remove the creator or the payer | `protected_participant`, document `===` input |

`playwright/lock-lifecycle.spec.ts` is **four separate tests, each self-contained from its own capture** —
`fullyParallel` is on, and each transition is a distinct failure mode, so a shared continuous story would make
one break mask the rest:

1. `lock clears only when every blocker is resolved` — lock early (blocked, codes visible), clear the
   checklist, lock, badge says locked.
2. `locked bill rejects edits` — lock, edit a price and a quantity, both rejected with `bill_locked`, fields
   unchanged.
3. `unlock requires confirmation, then accepts edits` — dialog visible with the stale-link warning, cancel
   leaves it locked, confirm unlocks, a price edit then commits, stale notice visible.
4. `an ambiguous row blocks lock until it is excluded` — the ticket-11 receipt fixture (the `NAAN` row), which
   is the most complex blocker and needs no invented fixture.

The other seven blockers are pinned at the seam (row 3), not repeated through OCR: each e2e capture is a real
inference run, and buying six more of them to re-test predicates the seam already asserts is cost without a
new guarantee.

## L15 — What this record does not decide

- **§10's note for the two fields** — added by explicit owner authorization (2026-11-05) in the same
  pattern as ticket 11's §19 addition, and quoted in L1. Further `PROJECT(1).md` edits remain prohibited
  without the same instruction.
- **`tokenExpiresAt` policy** (L5) and the link format, budget, codec and expiry hint — ticket 16.
- **Settlement amounts, the paid toggle, UPI and WhatsApp text** — ticket 15. L10 defines `settled` as a
  projection of flags that 13 never writes.
- **Persistence of the two new fields** — ticket 14 persists `working` whole (0019 S5); no schema decision is
  made here.
- **Whether a `BillShareSnapshot` should carry the lock epoch** — ticket 16; L6's cutoff was chosen to work
  with §10's shape as it stands.
- **A row-to-item "classify" action** — L1 records why it has no representation in v1.
- **`LockBlockerCode`, `UnclassifiedRow`, `Bill`, `Item`, `BillCharge`, `BillValidationResult`** — none is
  widened. The new names are two `WorkingBill` fields, one lifecycle type, three operations and four reject
  codes, all PWA-owned.

## Reporting discipline

`DECISIONS/0018`'s rule applies verbatim: nothing here is presented as a measurement. Each pin is a predicate,
and `packages/pwa/tests/lock/pins.test.ts` is the artifact that asserts it; a pin that fails there is a bug in
the code or in this record, never a reason to move the test. L3's finding — that a lock attempt which
finalizes an item cannot succeed, because finalization creates pending units — is a claim about §10 and §13
read together, and it is discharged by pins 5 and 6 rather than asserted as behaviour that exists.
