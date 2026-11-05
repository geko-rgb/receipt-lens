# DECISIONS/0021 — Unit assignment: when units exist, what assignment means, and how quantity changes warn

Date: 2026-11-05 · Ticket 12 · **Status: binding for tickets 12–16.**

Tier-3 parameters, pinned **before** the code, in the posture `DECISIONS/0011` takes for validation,
`DECISIONS/0018` for capture and `DECISIONS/0020` for editor transactions: every item below is a predicate
the shipped tests assert, and nothing here is a measurement of behaviour that does not exist yet.

`PROJECT(1).md` §10 lines 762–790 and §11 rules 2–4 fix the *data model* (`ItemUnit`, `ItemUnitAssignment`,
`count(units) = Item.qty`, exact division of a shared unit) and one behavioural sentence —
*"assigning it to anyone clears `confirmedUnassigned` in the same transaction"*. They leave six parameters
open, which is what this record is for. The store and commit rule are `DECISIONS/0019`; the transaction
semantics are `DECISIONS/0020`.

## A0 — The pins, in one line each

1. **Units materialize at finalization only**, one per unit of `Item.qty`, never from a draft (§10 line 765).
2. **Assignment is set membership over `(unitId, participantId)` pairs**, one transaction per toggle; order
   of the `assignments` array is insertion order and is never sorted or rewritten.
3. **A duplicate pair is rejected, not ignored**, and the two codes needed for that and for a blank
   participant name are added to `TransactionRejectCode` explicitly (A3).
4. **Unassigning the last assignee is not an acknowledgement** — the unit returns to pending and
   `units_unassigned` re-raises (A4).
5. **Acknowledgement is per unit and is rescinded by assignment**, in the same transaction (A5).
6. **Quantity increase appends highest-index units, unassigned and unacknowledged**; existing
   acknowledgements survive (A6).
7. **Quantity decrease warns first, then applies in one transaction** — never apply-and-undo, and the
   shrink always removes the *highest* indices (A7).
8. **Quantity 0 is rejected as `invalid_quantity`**, never treated as a delete (A8).
9. **Assignment stores a pointer, never a price** (A9).
10. **Participants can be added in 12, not removed**; removal's cascade is pre-pinned for 13 (A11).
11. **Assignment is not gated on unresolved drafts, charges or totals** — only on unit, participant,
    duplicate and lock (A12).
12. **The UI is a participant-per-unit checkbox grid**, one transaction per click, with a confirm-first
    dialog for quantity decreases (A14).

## A1 — When a unit materializes

**At finalization, and only then** (§10 line 765: *"Unit materialization occurs after finalization"*).
`finalizeItems` and `finalizeAllResolvable` materialize in the same commit that moves the draft into
`items` — already shipped in `transactions.ts`, and this record is the ruling that it stays that way:

- A draft may hold `qty: null` (§10 line 764), so there is nothing to count and no unit to create. A unit
  under a draft would be a number the bill has not committed to.
- A `DraftItem`'s quantity can be corrected any number of times before finalize; materializing earlier
  would mean creating and destroying assignment targets for a value that is still being negotiated.
- Because drafts have no units, **assignment to a draft is impossible by construction** and surfaces as
  `unknown_entity`, not as a new blocker.

Ids are `unit:<itemId>:<unitIndex>` and `unitIndex` is `0..qty−1` with no gap (0011's determinism rule,
0020 T11). `count(units where itemId = X) = Item.qty` is checked by `recompute`, and a violation is
`recompute_failed` with the previous document returned by identity — never silently repaired.

## A2 — What an assignment is

An `ItemUnitAssignment` is a pair. The two operations are

| Operation | Effect | Transaction |
|---|---|---|
| `assignUnit(document, unitId, participantId)` | append the pair; set `confirmedUnassigned = false` on that unit | one |
| `unassignUnit(document, unitId, participantId)` | remove the pair; leave every other pair and the unit's flag alone | one |

Both are §10-line-400 transactions through `runTransaction`, so they get the order, the freeze, the
revision bump and the identity rollback for free. Neither is a rule inside `Bill.svelte` (0019 S1).

- **Insertion order is preserved.** No sort, no canonicalization at commit: determinism is per-operation
  sequence (the same document plus the same calls yields the same array), and sorting would reorder a
  persisted record for no user-visible gain.
- **The pair set is checked against the unit's own item.** A unit id names exactly one item, so no
  cross-item check is needed; the participant check is `working.participants`, which is the bill
  (§10 line 768's *"participants on the same bill"*).
- **Both operations are money-neutral except through shares**: they change `derived.shares` and nothing
  else. `unitPrice`, `lineTotal`, `charges`, `grandTotal` and `adjustmentLines` are untouched — the last
  because an assignment can only ever remove an acknowledgement, which A5 does atomically.

## A3 — Rejections, and the two codes this ticket adds

`DECISIONS/0020` T1's union is closed *per operation kind*; assignment is a new kind, so two conditions
no existing code describes are added here deliberately rather than squeezed into a wrong one.

| Code | Condition | Refs |
|---|---|---|
| `unknown_entity` | a `unitId` not in `working.itemUnits`; a `participantId` not in `working.participants`; or an `(unitId, participantId)` pair `unassignUnit` was asked to remove that is not present | the ids named |
| `assignment_duplicate` **(new)** | `assignUnit` for a pair already in `working.assignments` | `[unitId, participantId]` |
| `invalid_name` **(new)** | `addParticipant` with a name that is empty after trim | `["participant"]` |
| `bill_locked` | any of the three while `bill.isLocked` | the bill id (emitted by the runner) |

The absent-pair case reuses `unknown_entity` because it is the same condition 0020 T1 already words — *the
operation names something the document does not contain* — applied to a pair instead of a single id. That
is an extension of the condition's subject, recorded here, not a third code.

**Why a duplicate is rejected rather than a no-op.** §10 line 768 says *"reject duplicate
`(itemUnitId, participantId)` pairs"*, and `validateWorkingBill` already emits the `assignment_duplicate`
blocker for a state that contains one. A silent no-op would make a double-fired click indistinguishable
from a real change, commit a revision that changed nothing, and leave the seam unable to distinguish "the
UI asked twice" from "the UI asked once". The UI never issues it (a checkbox renders from the committed
document), so the rejection is a programming guard rather than a user-facing error.

**Why a blank participant name is a rejection.** §10 gives `Participant` a name and no finalization gate
exists for participants — there is no `name_missing` equivalent on that path. A blank name reaches the
share link (16) and the settlement list (15) as an unlabelled row. Duplicate *names* are allowed: two
people called Alex on one receipt is ordinary, and only the id is an identity.

The two new codes are **transaction rejections, not validation findings**: the operation returns a reject
and the runner rolls back to the previous document by identity (0020 T1's failure model). Neither is added
to `BillValidationResult.findings`, and the UI never infers either from message text.

**`bill_locked` is reachable through the generic transaction seam, but no product lock path exists in 12.**
`runTransaction` accepts any operation, and ticket 11's own `tests/bill/pins.test.ts:500` sets
`isLocked: true` that way — so `assignUnit`/`unassignUnit`/`addParticipant` on a locked document can be
asserted without a new seam. Ticket 12 must **not** add a `lockBill` operation or a `setLocked` helper to
make such a test convenient: that would create a lock path ticket 13 then has to remove. Ticket 13
activates the rejection through its real lock flow.

## A4 — Unassigning the last assignee is not an acknowledgement

Removing the final pair leaves the unit with zero assignments and `confirmedUnassigned: false` — the
pending state — so `units_unassigned` re-raises with that unit's id, `derived.shares` becomes `null`
(0020 T7), and the acknowledgement's `AdjustmentLine` disappears with the flag.

Auto-acknowledging here would be the one thing §10 line 785 rules out: *"true only after explicit creator
acknowledgement"*. The creator un-ticking a box is a statement about who *holds* the unit, not a statement
that they will pay for it.

## A5 — Acknowledgement: per unit, rescinded by assignment, no bulk in 12

`acknowledgeUnassignedUnit(document, unitId)` ships from ticket 11. Its rules are now pinned:

- **Guarded by `unit_assigned`**: acknowledgement is rejected while any pair names the unit. That is what
  makes §10 line 785's *"a confirmed-unassigned unit must have no participant assignments"* an enforced
  invariant rather than a comment.
- **Cleared by assignment in the same transaction** (§10 line 769): `assignUnit` sets the flag false in the
  commit that appends the pair, so no revision exists in which both are true.
- **Idempotent at the seam**: acknowledging an already-acknowledged unit succeeds and writes the same
  value. The runner still commits a revision (0020 T12 has no "no-op" concept), which is acceptable because
  the UI only offers the action on an unacknowledged unit.
- **No bulk action in 12.** A "mark all unassigned" button would be one statement about many units, each of
  which adds a different amount to the creator's share. If ticket 13's checklist offers it, it must be one
  transaction that sets the flag on every pending unit *and still yields one `AdjustmentLine` per unit*
  (0020 T7's deterministic `adj:<unitId>` regeneration already gives that). It must not become N commits,
  and it must not introduce a default that treats silence as the creator paying.

## A6 — Quantity increase

Growing `qty` appends indices `mine.length .. qty−1` (0020 T11), each with `confirmedUnassigned: false`.
Consequences, all pinned:

- The new units are **pending**, so `units_unassigned` re-raises and lock is blocked until each is assigned
  or acknowledged.
- **Existing units keep their flag and their assignments** — `syncUnitsToQuantity` passes them through
  untouched, and a previously acknowledged unit stays acknowledged. Growing a line does not re-open a
  decision the creator already made.
- **No auto-assignment**, not even "the same people as the other units of this item". Who a new naan
  belongs to is not derivable from who the earlier naans belonged to, and business.md §5.5's
  *"undetected is `null`, never guessed"* is the same posture applied to ownership.

## A7 — Quantity decrease: warn first, then apply in one transaction

Three separate decisions, because they are easy to conflate.

**(a) The shrink removes the highest indices, always** — even when a lower-index unit is unassigned and a
higher one is shared. Choosing "the cheapest to remove" would silently move money between people, and it
would make the outcome depend on assignment state rather than on the quantity the user typed. §10 line 722
answers this by making the *UI* responsible for saying what goes, not by making the operation clever.

**(b) The warning is a projection over the committed document, not a transaction.** `units.ts` gains a
pure `previewQuantityChange(working, itemId, newQty)` returning exactly the units that would be removed,
the assignments attached to them, and the acknowledged units among them. It reads state, writes nothing and
does not bump `revision`. The UI shows the item name, the removed unit indices, each removed participant's
name, and — separately — any acknowledged unit whose creator-borne line will disappear, then calls
`setItemQuantity` only on confirmation.

**(c) Apply-and-undo is rejected.** `DECISIONS/0019` S10 records that v1 has no undo stack, and the
document model deliberately has no history field to restore an assignment from. Worse, the apply-and-undo
shape publishes derived state from a removal the user has not agreed to — exactly the class of state 0019
S2.2 exists to make unrepresentable. So the warning precedes the commit, and the commit is atomic.

**The confirm dialog is blocking** — the transaction does not fire until the user accepts. Cancel is a
no-op: no state change, no revision increment, no re-render of derived state. The dialog names the specific
units and participants that will be removed.

**The preview is a prediction, never an authority.** If `setItemQuantity` is rejected (the bill locked
between render and click, an invalid quantity, an invariant failure), nothing is removed and the returned
document is the input by identity. The UI must render the removal from `effects.removedAssignments` of the
*successful* transaction, not from the preview it showed a moment earlier.

## A8 — Quantity 0 is a rejection, not a delete

`setItemQuantity(…, 0)` returns `invalid_quantity` (§7 line 485: reject zero; §10 `Item.qty` is positive and
resolved) and the document is unchanged. Deleting the line is `deleteItem`, which removes the item, its
units, their assignments and the derived adjustment lines in one transaction (0020 T9).

Two reasons it must not be a silent delete: a zero-quantity `Item` violates §10's own contract and would
leave an item whose units cannot exist; and a typo in a quantity field would then destroy the line's name,
price and `detectedLineTotal`, which the user can no longer compare against the print. `syncUnitsToQuantity`
therefore never sees a zero — the gate is upstream.

Fractional quantity (`1.5 kg`) is likewise `invalid_quantity` with no unit representation (0020 T6, §19's
documented v1 limit). Ticket 12 adds nothing here; it only re-asserts it at the assignment boundary.

## A9 — Assignment stores a pointer, never a price

`ItemUnit` has no amount field, and §11's formula divides `Item.unitPrice` by `assignmentCount(unit)` at
compute time. So:

- Assigning copies no money. Editing the item price afterwards moves every unit's share, assigned or not.
- The golden example's `₹160.25 / 3` per assignee stays exact rational paise with no residual distribution
  (§11 rule 3) — ticket 02's `computeExactShares` already does this and 12 does not touch it.
- A price snapshot on the unit would need a field §10 does not have and would leave stale money on a bill
  after a price correction, which is the failure §10 line 784 exists to prevent for printed totals.

## A10 — Participants: add in 12, remove in 13

**`addParticipant(document, name)` is in 12**, because a bill with one participant has nobody to assign to
and 12's acceptance path (two people, two units) is otherwise unbuildable.

- Deterministic id: the next `p<n>` above every existing `p<number>` id, in the `nextManualId` style
  `transactions.ts` already uses for `m`/`mc`. The creator's id (`<billId>:creator`) is never renumbered.
  No clock, no randomness (0011's determinism rule).
- One transaction, no cascade: adding a participant **does not** touch units, assignments, `payerId` or
  `grandTotal`. A zero-item participant still pays an equal share of every applicable non-included charge
  (§11 rule 5, ADR-001) — that is the split's answer, not an assignment's.
- Blank name → `invalid_name` (A3). Duplicates allowed.
- **Adding a participant does not affect existing `confirmedUnassigned` units.** New participants start
  with zero assignments; existing acknowledgements stand. To assign a previously-acknowledged unit to a
  new participant, clear the acknowledgement first (assigning to anyone already clears it per A5), then
  reassign.

**`removeParticipant` is deferred to ticket 13**, whose checklist already owns payer selection
(§13: *"Payer defaults to the creator, both are participants, and a non-participant payer is rejected"*).
Its rule is pre-pinned here so 13 does not re-open the question:

- One transaction removes the participant **and every assignment naming them**; `recompute`'s orphan check
  then guarantees no pair survives.
- Units that lose their only assignee become **pending**, not acknowledged (A4), so `units_unassigned`
  re-raises — the transfer of cost to the creator is never implicit.
- Removing the `creatorId` or the current `payerId` is rejected, because §11 rule 10 requires both to be
  participants; 13 decides which code (`unknown_entity` is wrong here, and `payer_missing` is the state
  that would result, not the rejection).
- Not in 12 because neither the ticket nor its acceptance path needs removal, and inventing a
  payer-reassignment rule here would pre-empt the lock checklist that owns it.

## A11 — What assignment is *not* gated on

The only gates are the four in A3. In particular, assignment is allowed while drafts remain unresolved,
while charges are unresolved, while `grandTotal` is missing and while a negative share is pending. §10's
table scopes `draft_items_unresolved` to locking, and §6 line 394's separation of *severity* from
*workflow* blocking is only coherent if the `assignment` blocker array names invariants
(`unit_missing`, `participant_unknown`, `assignment_duplicate`) rather than "the bill is incomplete".
The naive reading — "a blocker exists, so assignment is blocked" — would make units unassignable on every
real mid-edit bill.

## A12 — Lock interaction (regression pins, not new logic)

Ticket 11 already computes all of this; 12 pins it so it cannot drift:

- `units_unassigned` carries the ids of every unit with zero assignments and `confirmedUnassigned: false`.
- Shares are computed only when that set is empty (0020 T7); until then `derived.shares = null` and
  `sharesUnavailableFor = "units_unassigned"`.
- Each acknowledged unit regenerates exactly one `AdjustmentLine { id: "adj:<unitId>", reason:
  "unassigned", amount: Item.unitPrice, assignedToParticipantId: creatorId }` — full cost, no rounding
  bucket, no split across participants (§11 rule 4).
- Assigning an acknowledged unit removes its line in the same commit, because the line is derived from the
  flag rather than appended by the operation.

## A13 — The UI decision

**A new `src/components/Units.svelte`, imported by `Bill.svelte`**, replacing the current inline
`data-testid="unit-list"` block. The route keeps the item fields and the charges; the component owns the
participants roster and the assignment grid. 0019 S1 still holds: the component projects from
`billStore.document` and calls transactions, and no rule lives in it.

Layout and interaction:

- One row per unit: the unit index, the exact division (`₹160.25 ÷ 3`, from the unit price and the number
  of ticked boxes), one **checkbox per participant**, and a **"Mark unassigned"** toggle that is only
  enabled when no box is ticked. A unit assigned to P1 and P3 is two ticked boxes, not a separate concept.
- **One click = one transaction.** `assignUnit`/`unassignUnit`/`acknowledgeUnassignedUnit`, each through
  the existing `apply` wrapper that writes the committed value back on rejection. Per 0019 S8 the checkbox
  is never `bind:`-bound to the document; it renders `checked` from state and changes through an `onchange`
  handler. Ticking is therefore idempotent from the user's point of view even though the seam rejects a
  duplicate pair.
- **Quantity field**: on change, if `previewQuantityChange` reports removals, a dialog names the item, the
  unit indices, the participants and any acknowledged units; confirm calls `setItemQuantity`, cancel
  restores the field's committed value. The dialog is blocking: the transaction does not fire until the
  user accepts, and cancel is a no-op with no state change, no revision increment and no re-render of
  derived state. Without removals the change applies directly, exactly as today.
- **Exactness is visible**: a shared unit's per-person amount is shown as a fraction with an ellipsis for a
  repeating decimal and the exact fraction in the title/details, never a truncated decimal labelled exact
  (business.md §5.4). The divisor is the count of ticked boxes, so the label updates with the assignment.
- **No drag-and-drop.** Dragging is a money-bearing mutation behind an undiscoverable gesture, needs a
  parallel keyboard path to be usable, and no v1 requirement asks for it. Checkboxes are the set model the
  data already has.
- E2E hooks: `data-testid="unit-row"`, `data-testid="assign-unit"` with `data-unit` / `data-participant`,
  `data-testid="unit-division"`, `data-testid="acknowledge-unit"`, `data-testid="quantity-warning"`.

## A14 — The seam, and which file owns what

| Concern | File | Kind |
|---|---|---|
| `materializeUnits`, `syncUnitsToQuantity`, `findQuantityUnitViolations` | `lib/bill/units.ts` | pure, shipped in 11 |
| `previewQuantityChange`, `assignPair`, `unassignPair` | `lib/bill/units.ts` | pure, added in 12 |
| `assignUnit`, `unassignUnit`, `addParticipant` | `lib/bill/transactions.ts` | operations, added in 12 |
| `acknowledgeUnassignedUnit` | `lib/bill/transactions.ts` | operation, shipped in 11 |
| `validateWorkingBill` blockers | `lib/validate-bill.ts` | shipped in 11, unchanged |
| `computeExactShares`, `signedChargePaise` | `lib/splitting.ts` | shipped in 02, **unchanged** |

The pure helpers in `units.ts` return data or a reject-worthy reason; the operations in `transactions.ts`
wrap them in `runTransaction` and own the codes. `splitting.ts`'s `TODO(ticket 13)` throw stays: 0020 T7
already calls `computeExactShares` only when every unit is settled, so ticket 12 has no reason to touch it.

## A15 — Pins as tests

`packages/pwa/tests/units/pins.test.ts` (the path the ticket names), written before the implementation and
red on CI until it is real:

| # | Pin | Asserted as |
|---|---|---|
| 1 | qty N finalizes into exactly N units | count, contiguous `unitIndex`, ids `unit:<itemId>:<i>`, no units on a draft |
| 2 | shared unit divides exactly | P1+P2 on a ₹160.25 unit yields `16025/2` each; three assignees yields `16025/3`; rational equality, never rounded |
| 3 | `count = qty` after increase | new units unassigned and unacknowledged; old flags survive; `units_unassigned` names only the new ones |
| 4 | decrease with assignments warns then cascades | preview names the assignments; the transaction removes units, pairs and lines together; revision +1; one commit |
| 5 | decrease to 0 | `invalid_quantity`; returned document `===` input; item and units intact |
| 6 | assigning an acknowledged unit clears the flag | same commit; its `adj:` line gone from the same commit |
| 7 | duplicate pair | `assignment_duplicate`; document unchanged by identity |
| 8 | unassigned blocks lock | `units_unassigned` with unit ids; acknowledging clears it; shares become computable |
| 9 | acknowledged unit has no assignments | `unit_assigned` on acknowledge; flag false after any assignment |
| 10 | participant deletion | not in 12 — no `removeParticipant` operation exists; A10's cascade rule is recorded for 13, and 12 adds no test seam that would pre-empt it |
| 11 | participant addition | deterministic ids, no assignment/unit mutation, zero-item charge share still equal |
| 12 | assignment is not gated on drafts | assign while a draft is unresolved succeeds; blockers unchanged except `units_unassigned` shrinking |
| 13 | unknown unit / participant / absent pair | `unknown_entity` with the ids in `refs` |
| 14 | blank participant name | `invalid_name`; nothing added |

`playwright/unit-ownership.spec.ts` covers the same rules through the UI: finalize qty 2 and assign one
unit to each of two people; a unit shared by both shows the exact division; an unassigned unit blocks and
acknowledgement clears; increase adds unassigned units; decrease warns and then applies.

### The quantity-change dialog, in three states

Asserting only the result after confirmation does not prove the dialog blocking or cancel a no-op. The
e2e spec asserts the three UI states and the seam pins assert their state-level half:

| State | UI assertion | Seam assertion |
|---|---|---|
| 1 — warning shown | dialog visible, naming P1/P2 (or the unit ids); `revision` unchanged | `previewQuantityChange` returns the removals and the document is byte-identical afterwards |
| 2 — cancel | dialog closes; qty still 2, units still 2, both assignments still present | no transaction ran: same document object, same revision, same JSON |
| 3 — confirm | qty 1 applied; the removed unit and its assignment are gone; revision +1 | `setItemQuantity` returns one commit whose `effects.removedAssignments` equals the preview, and `document.revision === before + 1` |

A fourth assertion belongs to A8 rather than the dialog: a decrease **to 0** is a rejection, so the confirm
path for 0 shows `invalid_quantity` and changes nothing.

## What this record does not decide

- **The lock flow, bulk finalize at lock, unlock and link staleness** — ticket 13.
- **Participant removal and payer choice** — ticket 13, with A10's cascade rule pre-pinned.
- **Persistence** — ticket 14 (`DECISIONS/0019` S5).
- **Settlement amounts, UPI links, WhatsApp text** — ticket 15; 12 shows exact shares only.
- **The share snapshot's `unitAssignments` projection** — ticket 16; §10's snapshot shape already has
  `unitIndex → participantIds`, which A2's pair model maps onto without a new field.
- **Any §10/§4 shape.** `ItemUnit`, `ItemUnitAssignment`, `AdjustmentLine`, `WorkingBill` and
  `BillValidationResult` are unchanged. The only new names are three operations, two pure helpers and the
  two reject codes in A3.
- **`PROJECT(1).md`** — this record does not edit it. The file *has* been edited once, in ticket 11, by
  owner instruction: §19 gained the fractional/weight-quantity limit. The standing rule "no
  `PROJECT(1).md` edits except `DECISIONS/` pointers" was overridden for that specific limitation; further
  edits require the same explicit instruction.

## Reporting discipline

`DECISIONS/0018`'s rule applies verbatim: nothing here is presented as a measurement. Each pin is a
predicate, and `packages/pwa/tests/units/pins.test.ts` is the artifact that asserts it; a pin that fails
there is a bug in the code or in this record, never a reason to move the test. The two reject codes are
declared widenings of `DECISIONS/0020`'s closed union, each with the condition no existing code covers,
rather than reinterpretations of a code that means something else.
