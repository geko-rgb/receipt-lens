# DECISIONS/0020 — Editor transactions: what fails, what is preserved, and what `validateWorkingBill` returns

Date: 2026-11-04 · Ticket 11 · **Status: binding for tickets 11–16.**

Tier-3 parameters, pinned **before** the code, in the same posture `DECISIONS/0011` takes for validation
and `DECISIONS/0018` takes for capture: every one of these is a predicate the shipped tests assert, and
nothing here is a measurement of behaviour that does not exist yet. The store shape and commit rule are
`DECISIONS/0019`; this record is the semantics of one transaction.

The contract being pinned is §6 line 400 verbatim: *persist → recalculate derived exact totals/shares →
core `validate()` → `validateWorkingBill()` → update UI findings/blockers; on failure roll back and do
not display derived state from the failed mutation.*

## T0 — The pins, in one line each

1. **Failure is a rejected write or a broken invariant — never a finding.** An edit that makes the bill
   disagree with the printed total *succeeds*; that disagreement is the product (§10 line 792).
2. **Unresolved values never block an edit.** They block finalization, unit creation, assignment and
   lock. Blocking the edit would make the value unfixable.
3. **Assumed quantities block lock only**, not edit and not finalization.
4. **Drafts delete without confirmation; finalized items cascade.** No entity-level un-finalize in v1.
5. **`validateWorkingBill` returns §10's shape exactly** (`BillValidationResult`), with a closed code
   vocabulary for its three `string[]` blocker arrays and §10's nine `LockBlockerCode`s for locking.
   Exactly one PWA-owned finding code is introduced; §10's blocker union and §4's warning union are not
   widened.

## T1 — What counts as a transaction failure

`TransactionRejectCode`, closed:

| Code | Condition | Step that emits it |
|---|---|---|
| `invalid_amount` | a paise value that is not a finite safe integer (NaN, ±Infinity, `4.5`, negative where a magnitude is required) | persist |
| `invalid_quantity` | a quantity that is not a positive integer (§11 rule 2: units are countable, `unitIndex 0..qty−1`) | persist |
| `unknown_entity` | the operation names an `itemId`/`chargeId`/`unitId` not in the document | persist |
| `bill_locked` | any mutation while `bill.isLocked` (§13: editing a locked bill needs unlock first — ticket 13's action) | persist |
| `not_finalizable` | an *explicit* finalize whose gates (T6) are unmet | persist |
| `recompute_failed` | an invariant threw inside the recompute step (e.g. `count(units) ≠ Item.qty`) | recompute |

**Not failures:** findings of any severity, `validation.uncertain === true`, a `LockBlocker`, a
`reconciliationGap`, a `line_total_mismatch`, or a printed-vs-calculated `arithmetic_total` critical.
The reason is §10's own delete flow: *"Keep the printed/confirmed receipt `grandTotal` unchanged… Re-run
validation so the difference between calculated and printed totals is visible."* Deleting the false ₹4
item is the ticket's marquee behaviour, and if a critical finding failed the transaction, the gap could
never be produced. Manual input "always takes precedence over extracted values" (§10 line 773) is the
same claim from the other side: the user is allowed to make the bill disagree with the receipt.

Two failure *shapes*, one rollback rule. A rejected precondition (persist step) returns the previous
document; a `recompute_failed` or a thrown step returns the previous document. In both cases the returned
`document` is **the same object as the input** (`===`), so "did not display derived state from the failed
mutation" is an identity property a test can assert, not a rendering convention to hope in (0019 S2.2).

## T2 — What a finding can and cannot do

`LockBlocker`s gate *actions* (finalize-in-bulk, assign, lock). Findings gate *nothing* on their own —
§6 line 394: "Severity and workflow blocking are separate: a minor extraction warning can still block a
specific action", and the blocking is expressed by a blocker, never inferred from severity. Concretely:
`qty_assumed` is **minor** and blocks lock (via `assumed_qty_unreviewed`); `arithmetic_total` is
**critical** and blocks nothing. The UI reads codes (§6 line 401), which is why T8 hands it a set and not
a boolean.

## T3 — Editing an unresolved value

Allowed, always. An item with `qty: null` / `quantitySource: "unresolved"` and `unitPrice: null` /
`priceSource: "unresolved"` is editable in every field, and the edit that supplies a value flips the
provenance to `user_confirmed` (T4) and clears the corresponding blocker. This is the difference between
"blocked" and "unresolved": §6 line 426/468 lists what `qty_unresolved` blocks — unit creation,
assignment, finalization, locking — and an edit is none of those. Stated because the naive reading
("unresolved ⇒ read-only") makes the editor unable to fix the one thing it exists for.

## T4 — Provenance on write

| Operation | Field(s) set | Provenance |
|---|---|---|
| user sets/edits quantity | `qty` | `quantitySource: "user_confirmed"` (§7 row 4) |
| user sets/edits unit price | `unitPrice` | `priceSource: "user_confirmed"` (§7 price table row 3) |
| user sets/edits name | `name` | **no provenance field exists** in §10 — none is invented |
| user adds an item or charge | all supplied values, `manuallyAdded: true` | `user_confirmed` for each field supplied; `unresolved` for each left blank |
| user resolves a charge's inclusion | `included` | that charge's `source: "user_confirmed"`, and the summary rule in T5 |
| user edits the printed grand total | `grandTotal` | `grandTotalSource: "user_confirmed"` (§10 line 743) |

Monotonic, per §7 line 497 and business.md §14.1: `user_confirmed` is never downgraded, and a later parse
never overwrites it without an explicit user action. A manual item whose price the user left blank keeps
`unitPrice: null` / `priceSource: "unresolved"` — business.md §5.5 ("undetected is `null`, never guessed")
applies to user input too; defaulting a blank price to 0 would be inventing a fact.

`user_confirmed` records *origin*, not correctness (§7 line 497) — so it does not suppress findings about
the value, and T6's finalization gates apply to a user-confirmed price exactly as to a detected one.

## T5 — Printed facts survive edits

- **`bill.grandTotal` and `grandTotalSource` are changed only by an explicit `setGrandTotal`
  transaction.** Every other operation copies them verbatim. §10 line 743: "item edits never change it
  implicitly."
- **The printed subtotal is not a `Bill` field.** §10 gives `Bill` no `subtotal`, so the imported fact is
  read from `working.parseResult.subtotal` and is immutable in v1 (correcting it means correcting the
  grand total, which is what settlement uses). 0019 S3 keeps `printedSubtotal` in derived state so the
  comparison is visible without making it writable.
- **`Item.detectedLineTotal` is set once, at finalize, from the parsed row total, and never rewritten.**
  Verified against the shipped parser rather than assumed: `parse/items.ts` sets `lineTotal` only from the
  price-column word (`total = candidate.totalWord ? readMoney(...).paise : null`), never as a derived
  `qty × unitPrice` — so a parsed non-null `lineTotal` *is* a printed fact, and copying it to
  `detectedLineTotal` is faithful to §10 line 631's "immutable imported receipt value when present".
  The calculated `lineTotal` is the one that moves (§10 line 784: "validation compares them instead of
  silently replacing the printed fact").
- **Inclusion semantics.** Setting a charge's `included` marks that charge `user_confirmed` and, per §10
  line 752, updates the summary: if every arithmetic-relevant tax/service charge now agrees on one value,
  `bill.taxIncluded` takes it with `taxIncludedSource: "user_confirmed"`; if they disagree or any is still
  `null`, the summary stays `null` / `"unresolved"`. Never inferred from an arithmetic match (0011 V4,
  business.md §6.6).
- **Re-importing a parse is not a merge.** If a new accepted capture arrives while a document exists,
  the bill view offers an explicit "start a new bill from this parse" action; nothing silently folds
  parser values into a bill the user has edited (T4's "explicit user action" clause). Losing in-progress
  edits is then a deliberate user choice, and persistence of the old one is ticket 14's.

## T6 — Finalization gates

Draft item → `Item` requires **all** of:

| Gate | Code surfaced | Source |
|---|---|---|
| `name` non-empty after trim | `name_missing` | §10 line 765 |
| `qty` resolved, finite, positive **integer** | `qty_unresolved` / `qty_invalid` | §7 line 485, §10 line 765 |
| `unitPrice` resolved, finite, non-negative integer paise | `price_unresolved` | §10 line 765 ("non-negative under the applicable item policy") |
| no item-scoped non-advisory critical finding on the draft | `review_required` | §10 line 765 "required review blockers are cleared"; §6 `item_without_price`, `ocr_critical_field_confidence` |

Explicitly **not** gates: `assumedQtyReviewed` (T3/T0.3 — lock only, §10 line 804), a
`line_total_mismatch`, a confidence below the warning floor (`name_confidence_low` /
`price_confidence_low` are review *recommendations*, §6 line 421), and any receipt-level arithmetic
finding. Reason for the last: the receipt may be wrong, incomplete, or the user may be mid-correction;
making a per-item finalize wait for the whole bill to reconcile inverts §13's Draft → Ready-to-lock order.

Draft charge → `BillCharge` requires: `amount` resolved (signed integer for `round_off`, non-negative
magnitude for every other type), `type` resolved (non-null), `otherSign ∈ {"add","subtract"}` when
`type === "other"`, and `included` a confirmed boolean — the last only "whenever that distinction affects
arithmetic" (§10 line 766), which v1 reads as: **`tax`, `service_charge`, `tip` and `other` must have their
inclusion chosen; `discount` and `round_off` are resolved to `included: false` by definition.** The reason
is §11 rule 8 and §6 line 456: a discount is *subtracted from* the subtotal and a round-off *is* the printed
difference between the subtotal and the grand total, so "already inside the item prices" is not a coherent
question for either. That is a definitional resolution, not an inference from an arithmetic match, which is
what 0011 V4 forbids. Consequence worth stating: those two types finalize without user action, so a
receipt's printed discount and round-off do not each demand a click before the bill can lock.

A `round_off` with `included: true` is nonsense the gates do not prevent, because the user is allowed to
make their bill say something odd deliberately; §11 rule 8's allocation then treats it as an ordinary shared
charge and `chargeEffectsTotal` shows exactly what the creator chose.

- **`finalizeAllResolvable()`** (the bulk form ticket 13 calls at lock attempt) finalizes exactly the
  entities whose gates are met **in one transaction**, leaves the rest as drafts, and reports per-entity
  blockers. There is no partial commit.

- **Finalization preserves the entity id.** A draft `i1` becomes `Item { id: "i1" }`, so core's
  `itemRefs`, the row the user was editing, the units hung beneath it and any later assignment address the
  same thing with the same string. §10 gives `DraftItem.parsedRef` and `Item.id` without linking them;
  keeping the id is the link, and re-keying at finalize would orphan every finding that names the row.

- **`checkDraftItemFinalizable` reads item-scoped criticals from `working.parseValidation`**, not from
  `draft.warnings`: §6 line 408's confidence cap and §6 line 417's `item_without_price` are validation
  results, and `warnings` is parser output that validation may have re-spelled (0011 V10's canonical-code
  mapping happens at core's boundary). Using the validator's own output is the version that cannot drift.

Zero price is legal (a free or fully-discounted line); zero quantity is not (§7 line 485: "reject zero,
negative, NaN, or infinity"). A `1.5` quantity is rejected as `invalid_quantity`: v1's unit model is
countable (`unitIndex 0..qty−1`, §11 rule 2), so a fractional quantity has no representation. That is a
v1 product limit, not a money rule — see "What this record does not decide".

## T7 — Derived state, and when shares are not computable

Recompute (step 2) produces `DerivedBillState` (0019 S3) over **finalized entities only**. Exact
participant shares are produced by ticket 02's `computeExactShares` **only when its precondition holds**:
every `ItemUnit` of every finalized item is either assigned to ≥1 participant or
`confirmedUnassigned`. That predicate is checked before the call, because
`splitting.ts:38-41` *throws* on an unacknowledged unit with a `TODO(ticket 13)` comment — and an
unacknowledged unit is the ordinary mid-edit state of a real bill, not a programming error. A throw inside
recompute would surface as `recompute_failed`, i.e. the editor refusing a price change because the user
has not yet said who gets a naan. So:

- precondition met → `derived.shares` = exact shares, `sharesUnavailableFor = null`;
- precondition unmet → `derived.shares = null`, `sharesUnavailableFor = "units_unassigned"`, and
  **`units_unassigned` is present in `blockers.locking`** — so "no lock while shares are unknown" holds by
  construction, and `negative_share_after_discount` is simply not asserted without evidence.

Ticket 13 replaces the `TODO` with a real blocker path; this record is what makes it safe to do that
without touching the editor.

**Unassigned-unit accounting is derived, not hand-maintained.** After each recompute,
`bill.adjustmentLines` is *regenerated* from the set of `confirmedUnassigned` units with no assignments: one
`AdjustmentLine { id: "adj:" + unitId, reason: "unassigned", amount: unitPrice, assignedToParticipantId:
creatorId }` per acknowledged unit (a unit id is already `unit:<itemId>:<index>`, so the line reads
`adj:unit:i1:0`). `ValidationFinding.code` is an open string (§4 line 276) but `AdjustmentLine` is §10's
shape and is not widened — the deterministic id is the unit linkage, and one line per unit is what makes §10
line 769's "assigning it to anyone clears `confirmedUnassigned` in the same transaction" and T11's cascade
both fall out for free: a line cannot outlive the unit it names. The golden example (§11 line 865, P1's
`+₹20.00`) is one acknowledged unit → one line, so this is consistent with the CI-locked arithmetic rather
than a new interpretation of it.

## T8 — `validateWorkingBill(workingBill)` returns `BillValidationResult`

**§6 line 399's one-argument signature is kept literally**, which means the function recalculates the
working totals, applicable charges, exact shares and reconciliation itself. It calls the *same*
`recomputeDerived` the transaction's step 2 ran, on the same input, so `derived` and `blockers` cannot
disagree and there is exactly one place in the codebase where §10's arithmetic lives. The duplicate call
costs a sum over tens of plain objects; the alternative — threading `derived` in as a second parameter —
would widen a signature §6 fixes and let a caller pass a `derived` that does not match its `working`.

Step 3's output is written into the state it validated: the committed `working.parseValidation` is the
fresh `validate(working.parseResult)` result, not the one `beginFrom` was handed. Core's function is pure
and its input never changes in this ticket, so the value is identical — but it is *stored* in one direction
through the commit, so a reader of `working` cannot get an answer from a different revision.

§10 lines 692-700, literally, with no field added:

```ts
interface BillValidationResult {
  findings: ValidationFinding[];
  blockers: {
    unitCreation: string[];   // codes, currently blocking any unit creation
    assignment: string[];     // codes, currently blocking any assignment
    finalization: string[];   // codes, currently blocking at least one draft
    locking: LockBlocker[];   // §10's nine codes, with refs
  };
}
```

**Why the three arrays are codes without refs:** §10 types them `string[]`, and per-entity addressing
already exists in `findings[].itemRefs/rowRefs/chargeRefs` — `DECISIONS/0011` V9 built that convention for
exactly this reason (findings carry the address; the blocker says only *what* is blocked). Widening §10's
shape to carry refs is not this ticket's call.

Closed vocabularies for the three arrays (PWA-owned; §6 lines 426/468 supply the first four):

| Array | Codes | Meaning |
|---|---|---|
| `unitCreation` | `item_not_finalized`, `qty_unresolved`, `qty_invalid` | units exist only under a finalized `Item` (§10 line 765) with a positive integer qty |
| `assignment` | `unit_missing`, `participant_unknown`, `assignment_duplicate` | `unit_missing` = `count(units) ≠ Item.qty`; the other two are §10 line 768's rejection rules |
| `finalization` | `name_missing`, `price_unresolved`, `qty_unresolved`, `qty_invalid`, `review_required`, `charge_amount_unresolved`, `charge_type_unresolved`, `charge_sign_unresolved`, `charge_inclusion_unresolved` | T6's gates |
| `locking` | §10's `LockBlockerCode` union, all nine, unmodified | §10 lines 798-808 |

Emission rules, so a code means one thing:

- `draft_items_unresolved` ← any draft failing T6's item gates. `refs` = draft item ids.
- `draft_charges_unresolved` ← any draft failing T6's amount/type/sign gates. **This resolves HANDOFF's
  open item "no §13 code exists for `otherSign: "unknown"`"**: §10 line 801 already says "known type/sign
  behavior", so an unknown-sign charge is `draft_charges_unresolved`, and a new blocker code is not
  invented.
- `tax_inclusion_unresolved` ← any charge of a type T6 requires a choice for (`tax`, `service_charge`,
  `tip`, `other`) with `included === null`. **The two blockers are disjoint by charge, not nested:** an
  unknown-sign charge raises `draft_charges_unresolved`, an unchosen-inclusion charge raises
  `tax_inclusion_unresolved`, and a charge failing both raises both with the same ref. T6's
  `discount`/`round_off` definitional resolution is what keeps a printed discount from raising either.
- `assumed_qty_unreviewed` ← any item or draft with `quantitySource === "assumed"` and
  `assumedQtyReviewed === false` (drafts included: §10 line 804 says "every `quantitySource: "assumed"`
  **item**", and a bulk finalize at lock attempt would otherwise carry an unreviewed 1 into a locked bill).
- `units_unassigned` ← any `ItemUnit` with no assignments and `confirmedUnassigned === false`.
- `grand_total_missing` ← `bill.grandTotal === null`.
- `payer_missing` ← `bill.payerId` does not name a participant in `working.participants` (§11 rule 10).
- `negative_share_after_discount` ← `derived.shares` computable and some share < 0 (T7).
- `unclassified_rows_unreviewed` ← a row in `working.unclassifiedRows` that no live draft *or finalized
  item* claims, where an entity claims a row iff its `parsedRef` resolves (in `working.parseResult.items`)
  to a `ParsedItem` sharing a `sourceLineId`. Deleting the draft that claimed a row therefore re-raises the
  blocker, which is the right answer: the row is unexplained again.
  **The "explicitly excluded" half has no representation in §10** —
  `UnclassifiedRow` carries `reason: "ambiguous"` and no review field — so ticket 13 owns adding one (or
  classifying the row into a manual item). Ticket 11 emits the blocker from what exists and records the gap
  rather than inventing a serializable field silently.

- **The nine are not jointly reachable.** `units_unassigned` and `negative_share_after_discount` cannot
  both fire, because T7 computes shares only when every unit is assigned-or-acknowledged. A test demanding
  all nine from one state would be testing an impossible state, so T8's coverage is asserted as eight from
  one authored bill plus the ninth from another.
- **`arithmetic_total` fires whenever both operands exist and the gap is non-zero**, including on a bill
  that is still all drafts. Suppressing it while drafts are unresolved would hide the one number this
  ticket exists to keep visible, and `draft_items_unresolved` already says *why* the bill is short.
  Emission is unconditional; explanation is the blocker's job.

**Findings.** `findings` holds **bill-state** findings only, and exactly these:

| Code | Severity | Scope | Condition |
|---|---|---|---|
| `line_total_mismatch` | minor | item | `Item.lineTotal ≠ detectedLineTotal` (both non-null). The only newly *introduced* code in this record, and legal because §4 line 276 types `ValidationFinding.code` as `string`. It is not in `ParseWarningCode` and is never emitted by core. |
| `arithmetic_item_sum` | critical | receipt | Σ finalized `Item.lineTotal` **>** `parseResult.subtotal`, with full line-total coverage — §6 line 459 / 0011 V1 rows 4-6, restated over working state |
| `items_may_be_missing` | minor | receipt | printed subtotal present, coverage incomplete, or Σ **<** printed subtotal — 0011 V1 rows 3/5, V3's direction rule |
| `arithmetic_total` | critical | receipt | `calculatedPayableTotal` + expected round-off does not reconcile `bill.grandTotal` (§6 line 457) |
| `negative_share` | critical | receipt | some computed share < 0 — mirrors the blocker, because the UI needs a row to show, not only a gate |

**The supersede rule** (§6 line 399: `validateWorkingBill` "must not rely on stale `ParseResult`
arithmetic for edited fields"): core's `validate(parseResult)` recomputes arithmetic over **pre-edit**
values, so once a document's `revision > 0` the PWA's arithmetic findings are authoritative and the
document's combined view drops the core findings whose code is one of `arithmetic_item_sum`,
`arithmetic_total`, `items_may_be_missing`, `round_off_adjusted`. Everything else from core — confidence,
`qty_assumed`, `qty_unresolved`, `ambiguous_row`, `price_not_resolved`, `unclassified_charge`, … — is
extraction evidence about the receipt, stays valid regardless of edits, and is kept verbatim. `derived`
and both validation results are committed together (0019 S3), so the UI never sees one without the other.

## T9 — Deletion and cascade

| Operation | Confirmation | Cascade, same transaction |
|---|---|---|
| delete a `DraftItem` | **none** — a draft is not yet a billing entity (T10) | nothing to cascade. No v1 operation re-derives drafts from the retained `parseResult`, so a deleted draft stays deleted without needing a tombstone field §10 does not provide; `parseResult` is kept only as evidence (the printed subtotal, the ambiguous rows, core's findings) |
| delete a finalized `Item` | UI must first identify the assignments being removed (business.md §14.4) — the transaction returns them, ticket 12/13's UI renders them | its `ItemUnit`s, every `ItemUnitAssignment` naming them, and the `AdjustmentLine`s derived from its acknowledged units |
| delete a `BillCharge` / `DraftCharge` | none | none (charges have no dependents) |
| shrink `qty` | see T11 | the highest-index units and their assignments and derived lines |

Invariant asserted after every transaction: **no assignment references a unit that does not exist**, and no
`AdjustmentLine` references a unit that does not exist. That is §10 line 790's "no assignment to a deleted
unit may survive", and it is checked by T13's recompute rather than trusted from the operation.

Deleting an item reduces `calculatedItemsTotal` immediately while `grandTotal` and `printedSubtotal` stay
(T5) — so `reconciliationGap` widens. That is the ticket's named behaviour, and the transaction that
produces it is a *success* (T1).

## T10 — No un-finalize in v1

A finalized `Item` does not go back to being a `DraftItem`. §13's reversible step is bill-level
(**Locked → Draft** by explicit creator unlock, with the stale-link warning), and an entity-level reverse
transition would need a place to store "this was once a draft" that §10 does not provide — plus it would
make `count(units) = qty` a *revocable* invariant. So: edit a finalized item's values (T3, T4), or delete
it (T9), or unlock the bill (ticket 13). Nothing resurrects an entity as a draft.

## T11 — Units: materialization and quantity maintenance

- **Materialize on finalize** (§10 line 765), one `ItemUnit` per unit, ids deterministic
  (`unit:itemId:index`) so a re-run of the same transaction on the same document produces byte-identical
  state — 0011's "never from `Date.now()` or key order" rule, inherited rather than restated. New units
  start `confirmedUnassigned: false` (§10 line 785).
- **`count(units where itemId = X) === Item.qty` after every transaction** (§10 line 767, §11 rule 2,
  pwa-design §1.2). Growing appends the next indices; shrinking removes the highest indices *and their
  assignments and derived adjustment lines in the same commit* (T9). `unitIndex` stays `0..qty−1` with no
  gap, so the invariant is checked, not assumed: a violation is `recompute_failed` and the document is
  unchanged.
- Assigning a unit is ticket 12; acknowledging one as unassigned is a T1-shaped transaction here because
  the unassigned-accounting pins (T7) need it, and its UI is ticket 13's checklist.

## T12 — The runner, and how the order is proved

```ts
type Operation = (working: WorkingBill) => WorkingBill | TransactionReject;

interface TransactionSteps {            // injectable, defaulted to the real ones
  recompute(working: WorkingBill): DerivedBillState;
  validateParse(parse: ParseResult | null): ParseValidationResult | null;
  validateWorking(working: WorkingBill): BillValidationResult;
}

runTransaction(previous: BillDocument, operation: Operation, steps?: TransactionSteps): TransactionResult
```

`TransactionResult = { ok: true, document, effects } | { ok: false, document: previous, reject }` —
`effects` carries what the UI must say (which assignments were removed, which drafts finalized). The three
steps are *dependencies*, not inline calls, precisely so the contract is testable rather than assumed:
`tests/bill/pins.test.ts` injects wrappers that record call order and can throw at any step, then asserts
(a) the sequence is recompute → validateParse → validateWorking, (b) after a failure at any step the
returned document `===` the input, and (c) the input document's own `derived` and `billValidation` are
untouched — i.e. no derived state from the failed mutation exists anywhere to display.

The persist step is the `operation` itself: a pure function from `WorkingBill` to `WorkingBill`, which is
what "persist the changed working state atomically" means while ticket 14's database is still absent
(0019 S1). `revision` increments by exactly 1 per committed document and not at all per rejected one.

**Why recompute precedes core `validate()`, when core reads only the untouched `ParseResult` and could run
first:** because §6 line 400 puts it second, and the order is load-bearing for two reasons that survive
ticket 14. It is the order that makes step 4 a pure read of step 2's output, which is what lets
`validateWorkingBill` keep §6 line 399's one-argument signature (see T8). And it fails fast:
`recompute_failed` is the only step that can violate an invariant, so running it before the validators means
a broken bill never gets a fresh coat of findings the UI would then have to discard. Core's own result does
not depend on the working bill — `parseResult` is the same object either way — so there is nothing to gain
by moving it up and everything to lose by making step 4 depend on step 2's absence.

## T13 — What each operation guarantees

The seam table `tests/bill/pins.test.ts` asserts, one row per operation: `beginFrom(parse)` (3C.1
mapping: `ParsedItem → DraftItem`, §4's public charge shape → `DraftCharge`, `roundOff` kept signed),
`setItemQuantity`, `setItemPrice`, `setItemName`, `addManualItem`, `finalizeItems`, `finalizeAllResolvable`,
`deleteItem`, `setChargeAmount`, `resolveChargeInclusion`, `addManualCharge`, `deleteCharge`,
`setGrandTotal`, `reviewAssumedQuantity`, `acknowledgeUnassignedUnit`. Every row asserts: provenance after
(T4), printed facts after (T5), `derived` recomputed (T7), blockers per T8, and the cascade invariants of
T9/T11. `Bill.svelte` and `Capture.svelte` own no rule (0019 S1), so the same table is the e2e spec's
acceptance list.

## Reporting discipline

`DECISIONS/0018`'s rule applies verbatim: nothing in this record is presented as a measurement of shipped
code. Each pin is a predicate, and `packages/pwa/tests/bill/pins.test.ts` is the artifact that asserts all
of them; a pin that fails there is a bug in the code or in this record, never a reason to move the test.
Two carried-forward items are *resolved* here rather than measured — the `otherSign: "unknown"` blocker
(HANDOFF's ticket-13 open item) and the `computeExactShares` throw boundary (T7) — and both name the file
and line they come from.

## What this record does not decide

- **The store shape and commit rule** — `DECISIONS/0019`.
- **Fractional quantities.** §11's unit model makes `1.5` unrepresentable, so `invalid_quantity` rejects
  it (T6). A receipt that prints "1.5 kg" is real; v1's answer is "resolve it to an integer or add it as a
  charge/manual item". Whether that deserves a spec-level relaxation, a per-unit-price path, or a documented
  product limit is an owner call, filed as an open item rather than decided by an editor constant.
- **`unclassified_rows_unreviewed`'s "explicitly excluded" half** (T8) — needs a representation §10 does
  not have. Ticket 13's, with a record.
- **Whether a draft the user deleted can be restored from the retained parse.** Ticket 11 records the
  deletion and does not resurrect it; a "restore deleted item" affordance is not in §10 or ROADMAP 3C.
- **Assignment UX, the lock checklist UI, participant editing** — tickets 12/13, on these operations.
- **Persisting any of it** — ticket 14, per 0019 S5.
- **`LockBlockerCode`, `ParseWarningCode`, `BillValidationResult`, `WorkingBill`, `AdjustmentLine`,
  `UnclassifiedRow`, `Item`/`BillCharge` nullability, or any other §10/§4 shape** — none is widened. The
  only new name in this record is the finding code `line_total_mismatch` and the operation-level
  `TransactionRejectCode`/`ShareBlocker` vocabulary, both PWA-owned. `PROJECT(1).md` is unedited.
