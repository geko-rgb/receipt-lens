# DECISIONS/0038 — Acknowledged preserved rows (ticket 23)

Date: 2026-11-10 · Ticket 23 (filed 2026-11-10, ready-for-agent) ·
**Status: decided — implemented, pins green, both real-receipt gates pass.**
Relates to `DECISIONS/0019` (undo/redo stays out of v1 — inverse transactions exist instead),
`DECISIONS/0020` (the editor transaction system), `DECISIONS/0022` (lock blockers),
`DECISIONS/0023` (persistence, P1/P9), `DECISIONS/0025`/`DECISIONS/0026` (snapshots and share links),
`DECISIONS/0035` (the audit that refused a confident-discard rule), `DECISIONS/0034` (metadata rows).

## The problem, as filed

`DECISIONS/0035` §"What is evidence" closed the audit's central question with a refusal: the parser will not
confidently discard the rows it preserves — §5 rule 7 stands. That leaves a real bill with a handful of rows the
machine cannot read and the app cannot resolve, and those rows legitimately keep the lock closed (`unclassified_rows_unreviewed`).
The only way out of that position, without giving the parser a rule it has no evidence for, is a human one: the
creator reads the row and accepts it. Ticket 23 pins the contract: **per-row human provenance, not an exclusion,
not a parser class, not inferable from parser output; undoable before the lock; refused for rows carrying an
amount.** The reviewer-UI bulk action is scope; OCR preprocessing of the illegible rows themselves (`Wtnin 2gis`)
is explicitly out of scope (filed separately).

## The decision

1. **Provenance is a review record, stored in the bill.** `AcknowledgedRow { rowId, text, acknowledgedAt }` lives
   in `working.acknowledgedRows`, written through the editor transaction system (`DECISIONS/0020`): `acknowledgeRows`
   (bulk, all-or-nothing) and its inverse `setUnclassifiedRowAcknowledged`. A timestamp comes from the caller, as
   every other `now` does — `lib/bill/*` reads no clock.
2. **What an acknowledgement is not.** It is not an exclusion (`excludedRowIds` is untouched and the row stays on
   the bill), not an item, not a metadata family, and never a parser inference. `UnclassifiedRow` keeps its
   `reason: "ambiguous"` and its warning code: the parse is the same document either way, so a stored bill can
   always be asked *whether* a human read a row and *when*, which is the whole point of recording it.
3. **The refusal edge is enforced in the transaction, not just the UI.** `rowCarriesAnAmount` reads a money shape
   (currency marker, thousands group, decimal amount) and deliberately does not read a bare integer as money — the
   same distinction `DECISIONS/0037` uses, so a count on a preserved line is a row a human may read and accept.
   Naming an amount-bearing row refuses the whole request with `row_carries_amount`, so the bulk control can never
   wave arithmetic through even if a future UI forgets to disable it.
4. **A row that *starts* carrying an amount voids the acknowledgement, not the row.** If a re-parse or an edit gives
   the preserved row printed money, the record stays (it is history) but is no longer *in force*:
   `effectiveAcknowledgements` filters on the current row text, the blocker returns, and the lock is closed until the
   money is resolved. Undoing that edit restores force without a second human act. The same filter is what the lock
   gate and the share snapshot use, so every consumer sees the same answer.
5. **Lock behaviour.** Acknowledged rows stop blocking (`unclassified_rows_unreviewed` drops their ids) and are
   listed in the lock summary, visibly stamped "user-acknowledged at <time>", so locking stays transparent about
   what the machine could not read. Unacknowledged blockers behave exactly as before.
6. **Persistence is field-additive inside the one `working` record P1 stores** (`DECISIONS/0023`): no store, key,
   index or version change; a record written by an earlier build loads with the empty list supplied by
   `normalizeWorking` at the load path, and the round trip through the real save path keeps every field.
7. **Snapshots and share links carry the acknowledgement** (`DECISIONS/0025/0026`): the codec's `BillShareSnapshot`
   gains an *optional* `acknowledgedRows` of `{ text, acknowledgedAt }` — text and moment only, no internal row ids
   (0026 A3) and no amounts (there are none on an acknowledged row). Omitted when empty, so a link written before
   this field still validates; present links do not silently hide what the owner admitted.

### Rejected alternatives

- **A confident-discard rule / parser-side downgrade** — refused by the owner (2026-11-10) on `DECISIONS/0035`'s
  evidence reasoning; friction is human review, and a bulk "I read these" action is the one-click form of it.
- **Reusing `excludedRowIds` with a flag** — mixes an edit ("drop from view") with a review fact ("accepted as-is"),
  and the two must be distinguishable in stored state and in a shared read-only snapshot.
- **Storing acknowledgements outside `working`** — loses the transaction/revision model, the migration chain, and
  the frozen-lock behaviour in one stroke; the whole point of 0023 P1 is that review state rides in the bill.
- **Deriving acknowledgement from parser output (e.g. "low-confidence row")** — violates the ticket's core
  exclusion: an acknowledged row is a human decision, and a snapshot must be able to tell the two apart.
- **Inferring the money-refusal by decimal-only shape** — a row like `TOT QTY: 28 313.50` would pass as "text".
  The money predicate is deliberately explicit about currencies, groups and decimals (see the tests).

### Implementation notes (movement and where it lives)

- `packages/pwa/src/lib/bill/acknowledge.ts` — pure rules: `rowCarriesAnAmount`, `acknowledgeableRows`,
  `rowsBlockedByAmount`, `effectiveAcknowledgements`, `acknowledgedRowIds`, `recordOf`.
- `packages/pwa/src/lib/bill/transactions.ts` — `acknowledgeRows` / `setUnclassifiedRowAcknowledged`;
  `row_carries_amount` joined `TransactionRejectCode`; records are kept in the bill's own row order (same rule as
  `excludedRowIds`, so acknowledge → undo → redo lands byte-identical); `normalizeWorking` on the load path.
- `packages/pwa/src/lib/validate-bill.ts` — the reviewer gate filters acknowledged ids from the blocker refs.
- `packages/pwa/src/components/Lock.svelte` — per-row checkbox, per-row "carries an amount" marker where the money
  rule refuses, bulk `acknowledge-all-rows`, and the lock-summary list with timestamps.
- `packages/pwa/src/lib/share/{codec,snapshot}.ts` + `routes/Share.svelte` — optional `acknowledgedRows`;
  the recipient's page names each row and the moment of acknowledgement.
- **No core change**: `git diff packages/core/src` is empty for this ticket — the parser still cannot and must not
  decide what a human accepts.

### Tests and gates

- `tests/lock/acknowledge.test.ts` (new, 27 tests): money rule on both real bills' preserved rows; bulk record +
  order + timestamp; all-or-nothing refusal (`row_carries_amount`, `unknown_entity`); empty-no-op; idempotence;
  acknowledge → undo → redo round trip; single-refusal; the voiding edge both ways (edit and undo); real-path save
  → load → rebuild round trip (fake IndexedDB); locked-bill freeze and post-lock refusal; snapshot assembly (rows
  present, field omitted when empty), codec round trip, legacy-codec decode, malformed-timestamp rejection.
- Persistence: `tests/persistence/pins.test.ts` — the committed fixtures now carry `acknowledgedRows: []` (the save
  path writes the field), regeneration is byte-stable, and the earlier-build shape (committed bytes minus the one
  additive field) is asserted to load with the empty list. DB version stays 1.
- `playwright/real-receipts.spec.ts` — both gates extended: Saravana's five preserved rows acknowledged in one
  click, `blockers-list` empties, `no-blockers` appears and `lock-button` enables, single-row undo returns the
  blocker and re-check clears it, and the five rows read back from the actual stored record with timestamps; the
  KOT gate acknowledges its three marks and keeps only the unrelated `grand_total_missing` blocker.
- **Full gates green** after this ticket: core 324, pwa 477, benchmarks 310; typecheck clean; build clean;
  `verify:storage-fixtures`, `scan:egress` 0, `scan:pii`, `check:storage-keys`, `verify:privacy-table`;
  Playwright `real-receipts.spec.ts` 2/2.
