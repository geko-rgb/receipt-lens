# receipt-lens — Business Logic

> **Version:** 1.0 · derived from the consolidated v0.4 specification (`PROJECT.md`, the source of truth).
> **Supersedes:** the original business document's `Item.assigned_to` ownership model, per ADR-005 — this file adopts the normalized `ItemUnit` / `ItemUnitAssignment` model and thereby closes the doc-update obligation tracked as roadmap gate **G7**.
> **Precedence:** owner decisions DQ-01–DQ-04 and ADR-001–ADR-010 are locked. If this file ever contradicts the spec or a locked ADR, the spec wins and this file must be patched — never the reverse.
>
> receipt-lens is a privacy-first, fully in-browser receipt parser and bill splitter: a receipt photo goes in on the user's device, extracted items and charges come out as reviewable drafts, participants are assigned at unit granularity, and everyone gets an exact share with a UPI payment amount — all computed locally, shared as encrypted URL-fragment snapshots, and settled manually.

---

## 1. The three product claims (business commitments)

1. **Verifiable local processing.** OCR, parsing, validation, and split calculation run on the user's device. This is not a slogan: CI runs inference with outbound network blocked and fails on any unexpected request.
2. **Honest accuracy.** Published accuracy is dataset-scoped (strict exact match + field-level P/R/F1), states each dataset's labelling limits, and is generated from committed benchmark results — never hand-edited, never folklore.
3. **Measured footprint.** Model bytes, runtime/WASM, app script, download, cache, and cold/warm latency are measured and published from committed results. No size claim exists before the measurement exists.

---

## 2. Roles and permissions

| Role | Powers | Constraints |
|---|---|---|
| **Creator** | Full edit rights while the bill is draft/unlocked; adds/edits/deletes items and charges; locks and unlocks; generates share links; marks participants paid; keeps the local ledger of past bills; may store a local `CreatorProfile` (display name, UPI ID) for reuse. | Must be a participant on the bill (v1). Is the default payer. Absorbs acknowledged-unassigned unit costs through their own adjustment line. |
| **Participant** | Opens a share link; sees their own share and UPI link by default; may toggle to the full bill view. | The full link is a bearer secret, not identity verification. "Only my share" is a display default, **not** access control — the snapshot they hold contains the whole included bill. |
| **Payer** | The participant whose UPI ID receives payments. | v1: `payerId` is required and must resolve to a participant; defaults to the creator. Non-participant payers are not representable in v1 accounting. |

**Payment confirmation is manual.** A UPI link opens a payment flow; it never proves a payment happened. Only the creator, marking a participant paid, records settlement. There is no bank reconciliation, no automatic verification.

---

## 3. Lifecycle

```
Draft → Review required → Ready to lock → Locked → Settled
                    ↑__________unlock___________|
```

- **Draft** — editable; imported values are tentative.
- **Review required** — unresolved quantities/prices/charges, ambiguous rows, unreviewed assumed quantities, or blocking findings must be resolved before dependent actions.
- **Ready to lock** — every field resolved, every unit assigned or explicitly acknowledged, payer and grand total present, zero lock blockers.
- **Locked** — the snapshot is frozen and participant links can be generated. Unlocking is an explicit creator action with a stale-link warning.
- **Settled** — all relevant participants manually marked paid.

Two rules hold at every state transition:

1. **Every add/edit/delete is transactional and re-derives everything:** persist atomically → recalculate exact totals/shares → run core `validate()` (where parse-derived findings apply) → run `validateWorkingBill()` → update UI. A failed transaction rolls back and shows no state derived from it.
2. **The printed/confirmed grand total is never silently rewritten.** Edits change calculated values; discrepancies between calculated and printed totals stay visible until the user explicitly resolves them (an explicit correction sets `grandTotalSource = user_confirmed`).

---

## 4. Domain model (conceptual)

- **Bill** — title, creator, payer, participants, items, charges, adjustment lines, printed/confirmed grand total, tax-inclusion summary hint, locked flag.
- **Participant** — a person on the bill: name, manual `paid` flag, share-link token material, client-side expiry hint (UX only).
- **Item** — a resolved bill line: name, positive resolved quantity, resolved integer-paise unit price, current calculated `lineTotal`, and **`detectedLineTotal`** (the immutable printed value, kept for comparison — never overwritten by calculation).
- **ItemUnit** — one countable unit of an item. `count(ItemUnit) = Item.qty` is enforced transactionally whenever quantity changes; units are `unitIndex 0..qty-1`.
- **ItemUnitAssignment** — links one unit to one participant. Uniqueness of `(itemUnitId, participantId)`; assignments must reference participants on the same bill. Zero assignment rows = unassigned until explicitly acknowledged.
- **BillCharge** — a typed, resolved charge (see §6): integer-paise amount, inclusion flag, source.
- **AdjustmentLine** — a visible, labelled adjustment attached to a participant's share. **v1 has exactly one reason: `"unassigned"`**, always attached to the creator.
- **DraftItem / DraftCharge** — import/edit-stage entities that may hold `null`s. Finalized `Item`/`BillCharge` may not. Unresolved drafts cannot finalize; resolved drafts may finalize in bulk at lock attempt.
- **WorkingBill** — the whole mutable state (bill + drafts + finalized entities + participants + units + assignments + unclassified rows + last parse/validation), the unit of persistence and validation.

---

## 5. Money rules (non-negotiable)

1. **Storage is integer paise.** Every receipt amount, item price, charge amount, line total, and grand total is an integer number of paise. No monetary value is ever a float.
2. **Calculated shares are exact rationals.** `ExactMoney = { numeratorPaise: string, denominator: string }`, reduced by GCD, denominator > 0, serialized losslessly as decimal strings (JSON/IndexedDB/share-link safe). Internal arithmetic uses `BigInt` or an exact rational implementation — **never IEEE-754**.
3. **No rounding of calculated shares — ever.** Not to paise, not to whole rupees. A share may contain a fractional paise (or a repeating decimal) and that is preserved exactly. v1 has no participant-share rounding mode.
4. **Display:** terminating decimals are shown in full and exact. Repeating decimals are shown unrounded with an ellipsis (e.g. ₹82.116666…) plus the exact fraction available in details/copy. A truncated decimal is never labelled exact. UI labels distinguish **"Exact share"** from **"UPI payment amount"** wherever they differ.
5. **Undetected is `null`, never guessed.** Missing grand total or charge stays `null`. The only tentative default in the system is quantity = 1 on a normal item row with no printed quantity — and only with `quantitySource: "assumed"` and a visible `qty_assumed` badge.
6. **Derived selectors are distinct from printed facts.** `calculatedItemsTotal` / `calculatedSubtotal` are computed values; the printed `subtotal` / `grandTotal` are receipt facts. They are never conflated.

---

## 6. Charges: taxonomy and allocation

**Public schema (locked, DQ-03 = B):** `taxes[]`, `serviceCharge`, `tip`, `discount`, plus explicit `roundOff` (signed) and `otherCharges[]`. The PWA maps these into one internal `BillCharge[]` with `type ∈ { tax, service_charge, tip, discount, round_off, other }`. The internal unification never replaces the public shape.

**Allocation rules (ADR-001):**

1. Each **applicable non-included** bill-level charge is divided **exactly and equally among all participants — including participants with zero items**. A fractional-paise result stays an exact rational; residual paise are *not* distributed at share-calculation time.
2. **`included: true` charges are display-only** — never added to totals again, never allocated. This prevents double-charging tax already inside item prices.
3. **Discounts** are stored as positive magnitudes and **subtracted**. If any final share would be negative, the bill **cannot lock** (`negative_share_after_discount`) — there is no redistribution policy to invent.
4. **`round_off` carries its printed signed amount** (may be negative) and, when non-included, is shared equally like any other charge. It is *not* a computational rounding adjustment and not a creator-only burden.
5. `other` charges with `sign: "unknown"` are excluded from arithmetic and flagged `unclassified_charge`; the creator must classify or explicitly exclude them before lock if they can affect reconciliation.
6. **Inclusion semantics:** `Bill.taxIncluded` is a receipt-level summary hint only; `BillCharge.included` is authoritative per charge. Inclusion is set from an explicit receipt cue (e.g. "inclusive of GST") — never inferred because the arithmetic happens to match. Ambiguous inclusion stays unresolved until the creator chooses "included in item prices" or "charged separately"; that choice is `user_confirmed`.

---

## 7. Split algorithm

For each participant P, in reduced exact rational arithmetic:

```text
P.item_total   = Σ ( unitPricePaise / assignmentCount(unit) )   over units assigned to P
P.charge_total = Σ ( chargeAmountPaise / participantCount )      over applicable non-included charges
P.share_exact  = P.item_total + P.charge_total + Σ( adjustments assigned to P )
```

- No rounding is applied anywhere in this computation.
- **Sum invariant:** the exact shares sum *algebraically* to the confirmed payable grand total. Always. (Enforced by property tests on randomized bills, not just the golden fixture.)
- **Unassigned units:** a unit with no assignments may exist at lock only after the creator explicitly acknowledges it (`confirmedUnassigned = true`). Its **full unit cost** is added to the creator through a visible `AdjustmentLine{reason: "unassigned"}` — rendered separately from charge allocations and never mixed with printed round-off. Assigning the unit to anyone clears the flag in the same transaction. No unassigned cost may disappear.
- **Zero-share participants** receive no payment link; the UI says "nothing to pay".
- v1 has **one calculation mode: exact shares only**. Whole-rupee rounding and rounding adjustments are not part of v1 bill accounting.

---

## 8. Golden example (CI-locked, must reproduce exactly)

Five participants P1–P5; P1 is creator and payer. All charges confirmed non-included. Fixture exercises a shared unit, an acknowledged-unassigned unit, and a zero-item participant.

**Items:** A Paneer Tikka ₹320.50 (qty 2 @ ₹160.25) · B Naan ₹60.00 (qty 3 @ ₹20.00) · C Biryani ₹240.00 (qty 1 @ ₹240.00).

**Assignments:** A.u1 → P1, P2, P3 jointly (₹160.25/3 each — no paise remainder assigned to one person) · A.u2 → P2 · B.u1 → P2 · B.u2 → P3 · **B.u3 → confirmedUnassigned (₹20.00 → creator's adjustment)** · C.u1 → P5 · P4 has no items.

**Charges:** Service Charge ₹62.05 · CGST ₹15.51 · SGST ₹15.51 · Discount ₹50.00 · Round Off **+₹0.43** · printed grand total **₹664.00**. Per-person exact charge allocation = (62.05 + 15.51 + 15.51 − 50.00 + 0.43) / 5 = **₹8.70** each. Arithmetic: items ₹620.50 + net charges ₹43.50 = ₹664.00 ✓

| Participant | Exact item allocation | Shared charges | Unassigned adj. | Exact final share |
|---|---|---:|---:|---|
| P1 (creator) | ₹160.25/3 = ₹53.416666… | ₹8.70 | +₹20.00 | **₹4927/60 = ₹82.116666…** |
| P2 | ₹160.25/3 + ₹160.25 + ₹20.00 | ₹8.70 | — | **₹7271/30 = ₹242.366666…** |
| P3 | ₹160.25/3 + ₹20.00 = ₹73.416666… | ₹8.70 | — | **₹4927/60 = ₹82.116666…** |
| P4 | ₹0.00 | ₹8.70 | — | **₹87/10 = ₹8.70** |
| P5 | ₹240.00 | ₹8.70 | — | **₹2487/10 = ₹248.70** |

In paise: P1 = 24635/3, P2 = 72710/3, P3 = 24635/3, P4 = 870, P5 = 24870 — **sum exactly 66400 paise**. CI asserts rational equality (shared-unit division, equal charge allocation, creator adjustment, final total) and must not introduce a whole-rupee rounding expectation or a "rounding" adjustment.

**Boundary allocation (UPI only):** P1 → ₹82.12, P2 → ₹242.37, P3 → ₹82.11, P4 → ₹8.70, P5 → ₹248.70 (total ₹664.00). These are settlement amounts, not rounded replacements for the exact shares.

---

## 9. Settlement boundary (UPI / WhatsApp)

- **Largest-remainder conversion, all participants together:** take the integer-paise floor of each non-negative exact share, then distribute the remaining paise one each by descending fractional remainder, ties broken by stable participant ID. **Target: the bill's confirmed grand total in integer paise.** The allocation must sum exactly to it.
- This conversion **never mutates `share_exact`** — it produces a separate `settlementSharePaise` for the transfer only. Both values are shown where they differ.
- **UPI deep link:** `upi://pay?pa={creator_upi}&pn={creator_name}&am={share}&cu=INR&tn={note}&tr={ref}` — all values URL-encoded; `am` always exactly two decimal places; `pn` ≤ 40 chars (from `CreatorProfile`, never truncated); `tn` ≤ 50 chars (truncate the note, not the payee name); `tr` optional, ≤ 35 chars, `[A-Za-z0-9]` only — **omit `tr` rather than emit a malformed intent**. ⚠️ `pn`/`tn`/`tr` limits are tentative pending verification against the primary NPCI specification (roadmap gate G5); constants carry a verification date.
- **The creator/payer gets no self-payment link** — their exact share is their own net cost after collecting from others.
- **WhatsApp:** `wa.me` click-to-chat link prefilled with the participant's exact share, their separate whole-paise UPI amount, and their participant link. Opening WhatsApp is an intentional external action, distinct from local inference.

---

## 10. Share links (ADR-007, DQ-01 = A)

- **Format:** `#v1.<token>.<nonce>.<ciphertextAndTag>` — URL **fragment**, never query parameters. Codec: compact JSON → DEFLATE (self-hosted, pinned `fflate` — no `CompressionStream` dependency) → AES-256-GCM → base64url. Fresh random nonce per encryption.
- **Key derivation:** HKDF with context `receipt-lens-share-v1`, from token material carried **in the same link**. Therefore encryption is not confidentiality against link-holders: **the complete link is a bearer secret.** GCM detects corruption by parties without the key but cannot stop a malicious holder who can derive the key. This must be disclosed in the product copy, not buried.
- **Budget:** the entire fragment ≤ **8 KB** encoded. Show budget usage; over budget → ask to shorten labels or refuse — **never silently truncate**.
- **Contents:** resolved bill data only (title, participants, items/units/assignments, charges, adjustments, payer, timestamps, version, cached shares). **Never** the receipt image, raw OCR, drafts, or extraction confidence. `computedShares` is a cache; the recipient recomputes and never trusts it.
- **Semantics:** links are immutable snapshots. Editing requires unlock → edit → regenerate/re-share. Old links go stale (shown behind a "bill updated on {date}" banner where possible) and **cannot be reliably revoked**. Client-side expiry is UX, not security. No backend exists in v1.

---

## 11. Parser rules (what becomes an item)

1. **Rows are classified before content parsing:** item, continuation, noise/header, or ambiguous. Headers/tax IDs/table furniture never become items. **Ambiguous rows are preserved** with text, geometry, and source reference in `unclassifiedRows` — never discarded, never force-fitted into items.
2. **Continuation merging** (wrapped item names) requires *all four* conditions: indentation, not a charge/header row, within the length cap, and not an all-caps standalone name.
3. **Quantities have provenance:** parser emits only `explicit` / `assumed` / `unresolved`; the PWA records `user_confirmed` on user entry/edit. Missing printed quantity → tentative 1 with `assumed` badge, review before lock. Ambiguous → `null`/unresolved, which blocks unit creation, assignment, finalization, and lock.
4. **Prices have provenance:** `detected` / `unresolved` (parser) and `user_confirmed` (PWA). A row with multiple plausible prices is `ambiguous_price_separator` — preserved, never auto-resolved. Unresolved price blocks finalization.
5. **Label dictionary matches longest-first** over English/Indian-English labels, so "service charge" never fragments into a phantom item. An amount with an unrecognized label is preserved with its label text and a warning (`unclassified_charge`) — never guessed into an item, never dropped.
6. **Locale profiles are explicit** (incl. Indian lakh grouping `1,23,456.78`); every parsed amount lands exactly on an integer-paise boundary.
7. Same fixture in → byte-identical result out. The parser is pure and deterministic.

---

## 12. Validation and findings

- **Conditional and scoped:** checks run only where present, semantically compatible operands exist (no printed subtotal → no item-sum contradiction is possible), and findings attach to the item/row/charge that caused them.
- **Confidence floors (defaults, pinned at M1 exit):** `criticalOcrConfidenceFloor = 0.50`, `warningOcrConfidenceFloor = 0.70`, requiring `critical ≤ warning`. Below critical → `ocr_critical_field_confidence` on that item; between floors → `name_confidence_low` / `price_confidence_low`. `null` confidence is always skipped; if every value is `null`, emit `confidence_unavailable` instead. Receipt-wide confidence is a word-count-weighted mean and **never the sole reason to reject a receipt**. A non-advisory critical finding caps the affected item's confidence at 0.5.
- **Arithmetic validator:**

```text
base_computed_total = subtotal + Σ non-included taxes + Σ non-included service charges
                    + Σ non-included tips + Σ non-included other(sign=add)
                    − Σ non-included other(sign=subtract) − Σ non-included discounts
expected_round_off  = grandTotal − base_computed_total
```

  A printed round-off within **±₹0.02** of expected (magnitude ≤ ₹1.00) passes with minor `round_off_adjusted`; a larger mismatch is a **critical** contradiction, not a tolerance. `arithmetic_item_sum` is critical only with full line-total coverage and plausible row count; otherwise it is the warning `items_may_be_missing` — missing rows mean extraction incompleteness, not arithmetic contradiction.
- **`strictArithmetic: false` (relaxed mode):** checks still run, every arithmetic finding is marked `advisory` — displayed but never capping confidence, setting `uncertain`, or blocking actions.
- **Findings vs blockers are separate systems.** Core `validate(parseResult)` yields extraction findings; PWA `validateWorkingBill(workingBill)` yields bill findings plus `LockBlocker[]`. The UI reacts to **codes, never message text**. A minor finding can still block a specific action (e.g. `qty_assumed` blocks lock until reviewed).

---

## 13. Lock checklist (all nine must be clear)

| Blocker code | Clears when |
|---|---|
| `draft_items_unresolved` | Every draft item has name, resolved valid quantity, resolved price |
| `draft_charges_unresolved` | Every draft charge has resolved amount and known type/sign |
| `tax_inclusion_unresolved` | Every arithmetic-relevant charge has confirmed included/separate semantics |
| `units_unassigned` | Every unit is assigned or explicitly `confirmedUnassigned` |
| `assumed_qty_unreviewed` | Every `assumed` quantity has `assumedQtyReviewed = true` |
| `grand_total_missing` | Grand total resolved (printed or user-confirmed) |
| `payer_missing` | `payerId` resolves to a participant on the bill |
| `unclassified_rows_unreviewed` | Every interpretation-affecting ambiguous row is classified or explicitly excluded |
| `negative_share_after_discount` | No participant's share would be negative after discount allocation |

---

## 14. Edit principles

1. **Manual input always wins.** A user-entered value becomes authoritative with `user_confirmed` provenance and is never overwritten by a later parser result without explicit user action. Provenance records *origin*, not guaranteed correctness.
2. **Printed facts survive edits.** `detectedLineTotal` is kept immutable next to the calculated `lineTotal` so validation can compare them; the printed grand total is never auto-rewritten.
3. **Quantity edits update units transactionally.** When units disappear, the UI first identifies the assignments being removed; new units start unassigned.
4. **Deletes cascade in one transaction** (item + units + assignments; no orphans) and totals recompute immediately — deleting a false ₹4 item drops the calculated total by ₹4 while the printed grand total stays.
5. **Purity boundary:** `parse()` accepts normalized OCR only and never mutates input; `validate(parseResult)` knows nothing about participants, drafts, or lock state; `validateWorkingBill()` owns all bill-state logic. `extract()` is the one-call convenience composing all stages.

---

## 15. Privacy and data rules

- **Local inference:** OCR and all downstream computation run on-device once assets are cached. Models (det, rec, dictionary) are **self-hosted on the app origin** with content-hashed names and a manifest — no third-party CDN, ever.
- **Egress is tested, not promised:** two CI harnesses — core-inference offline/egress proof (M1) and full-PWA audit (M3, upload → share flow) — fail the build on any unexpected outbound request, including service-worker traffic. Static first-party scans supplement, and are labelled as supplement, not proof.
- **Receipt images are not persisted by default.** Local retention is an explicit opt-in, stored only in local browser storage, with a working delete action. HEIC is accepted only with a tested local decoder; otherwise the user is asked to convert locally — there is no upload fallback path.
- **Share links carry no image and no OCR text.** URL fragments are excluded from the HTTP request (server logs don't see them), but browser history, clipboard sync, and device access can — hence bearer-secret disclosure, no revocation claims.

---

## 16. Deliberately out of scope (v1)

Custom model training/fine-tuning · bill-data backend or P2P hosting · receipt images or OCR text in share links or any remote endpoint · UI languages beyond English (Indonesian labels exist only for the CORD layout benchmark bucket) · native mobile app · automatic bank reconciliation or payment verification · multi-currency bills · nearest-rupee share rounding · non-participant payer/creator accounting · server-enforced share expiry, revocation, per-participant access control, or private "only-my-share" authorization. *(An LLM fallback is under evaluation in Phase 2 with a written go/no-go decision — it is not silently absent.)*

---

## 17. Glossary (business-critical terms)

| Term | What it is — and is not |
|---|---|
| `ExactMoney` | Reduced rational paise `{ numeratorPaise, denominator }` as strings. Not a float, not a rounded decimal. |
| `ItemUnit` | One countable unit of an item (`qty` units per item). Not a receipt row. |
| `ItemUnitAssignment` | Unit ↔ participant link. Zero rows = unassigned until explicitly acknowledged. |
| `confirmedUnassigned` | Creator's explicit acknowledgement that a unit is unassigned. Not merely missing assignment rows. |
| `AdjustmentLine{unassigned}` | Visible unassigned-cost line on the creator's share. Not a rounding bucket or hidden balancing. |
| `round_off` | The printed **signed** round-off charge. Not dropped, not forced positive, not the settlement conversion. |
| `BillCharge` | Internal normalized charge entity. Not the public `ParseResult` schema. |
| `DraftItem` / draft charge | Import-stage entity that may hold nulls. Not a finalized billing record. |
| `quantitySource` / `priceSource` | Provenance (`explicit/assumed/unresolved/user_confirmed`, `detected/unresolved/user_confirmed`). Not a confidence score. |
| `LockBlocker` | Structured machine-readable reason a bill cannot lock. Never inferred from warning text. |
| Critical finding | Contradiction/high-concern issue; caps affected item confidence. Not the same as a blocker. |
| Minor finding | Warning/diagnostic; a separate blocker may still prevent an action. |
| `ambiguous_row` | Preserved unclassifiable source line. Not an item, not silently discarded. |
| Zero-item participant | Pays equal shares of applicable non-included charges despite ordering nothing. |
| Exact share | The rational, unrounded result of §7. Distinct from the UPI payment amount. |
| Sharing link | URL-fragment snapshot and bearer secret. Not identity, not access control, not revocable. |
| Local inference | On-device processing after assets load. Not a claim that app loading or intentional sharing makes zero requests. |

---

*Traceability: §2 Locked Facts · §6 Validation · §7 Provenance · §10 Data model & edit flow · §11 Splitting math · §12 Settlement & UPI · §13 Lifecycle & roles · §14 ADR-001…010 · §19 Out of scope of the v0.4 specification. Tickets and implementation cite these rules; changes here require a spec-level owner decision first.*
