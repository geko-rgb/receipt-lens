# DECISIONS/0026 — Snapshot assembly, the participant view and the real share link

Date: 2026-11-05 · Ticket 16 (assembly, `/share`, staleness, disclosure) · **Status: binding for ticket 16's
remaining scope.**

DECISIONS/0025 pinned the codec and shipped it (`packages/pwa/src/lib/share/codec.ts`, 12/12). A codec with no
payload and no reader is a library nobody can send. This record pins the other three things ticket 16 owns:
§10's `BillShareSnapshot` assembled from a locked bill, the `/share` view that decodes one and renders it, and
the replacement of ticket 15's placeholder link with the real fragment. As before, every pin below is a
predicate the shipped tests assert, and nothing here is a measurement of behaviour that did not exist when it
was written.

Where this record and 0025 disagree, this one wins for assembly-and-view questions; 0025 wins for codec
questions.

## A0 — The pins, in one line each

1. **One builder, one shape.** `assembleSnapshot(document, { now })` is the only producer of a
   `BillShareSnapshot`, and the shape is §10's verbatim with `snapshotVersion: 1`. No second snapshot type.
2. **Assembly needs a locked bill.** An unlocked document refuses with `bill_locked`, the code 0022 L2
   already owns; §13 freezes the snapshot *at* lock, so there is nothing honest to encode before that.
   `grand_total_missing` rides along as **defensive typing, not a runtime path** — see A1.
3. **Excluded content is proved, not promised.** No receipt image, OCR text, `parseResult`, `parseValidation`,
   `unclassifiedRows`, `excludedRowIds`, `staleLinkCutoffAt`, drafts, confidence, `paid`, participant tokens or
   `CreatorProfile` — a test walks the payload's own key set and a second test searches for planted markers.
4. **The budget is measured once, on the encoded fragment.** Assembly estimates nothing; `encodeSnapshot`
   measures and refuses, and `buildShareLinks` reports that refusal. See A4 for why only one of the two
   candidate designs is pinned.
5. **The snapshot is deep-frozen and JSON-safe.** `Object.isFrozen` holds at every level, and
   `JSON.parse(JSON.stringify(snapshot))` deep-equals the original — a link is the only transport, so anything
   that does not survive JSON is a bug in the payload.
6. **`computedShares` is a cache; the recipient re-derives.** The view recomputes from the snapshot's own items,
   charges and adjustments with ticket 02's engine, and when the cache disagrees the recomputation is what the
   view shows, with the mismatch named.
7. **One link per participant, from one snapshot.** Each participant's `Participant.token` is that link's key
   material, so the roster gets N fragments of the same payload. Generation is a **lock-time action in the
   view**, never a transaction (A7).
8. **`/share` imports the codec and does nothing else with the bytes.** No second validator, no re-encoding, no
   router-side parsing. Before render it passes through `decodeSnapshot`, so the six checks of 0025 P6 run in
   order and the failure set is exactly the four pinned codes.
9. **Staleness is one comparison.** `snapshotCreatedAt` before the local bill's `staleLinkCutoffAt` ⇒ stale,
   with the banner 0022 L6 asks for, and the screen still shows the *snapshot's* frozen numbers. With no local
   bill the view says the snapshot may have changed and never says "current".
10. **The disclosure is 0025 P7's pinned words,** on the participant view and on the creator's share panel,
    with no copy that calls the link private, secure, or expiring.
11. **Ticket 15's placeholder is deleted, not shadowed.** `participantLinkFor(origin, fragment)` builds
    `<origin>/share#<fragment>` from the encoded fragment, and the WhatsApp text carries the real link. A11
    records the two ticket-15 pins this amends.
12. **Nothing is truncated, dropped or silently widened.** An over-budget bill has no link; a participant
    without a token has no link; a field §10 does not carry is not added because it would be convenient.

## A1 — The assembly seam

`packages/pwa/src/lib/share/snapshot.ts`, framework-free, no store, no clock read inside:

```ts
function assembleSnapshot(document: BillDocument, options: { readonly now: string }): BillShareSnapshot;
```

`now` is the `snapshotCreatedAt`, supplied by the caller for the same reason `lockBill` takes `now` and
`mintToken` (0011's determinism rule, restated in 0022 L5): the value a staleness comparison depends on must be
a parameter a test can pin. `ShareAssemblyError` carries the refusal code.

Three refusals, all from vocabulary that already exists:

| Condition | Code | Why it is reachable or not |
|---|---|---|
| `working.bill.isLocked === false` | `bill_locked` | The ordinary guard: the UI only offers the panel on a locked bill, and a caller that ignores that gets this. |
| `working.bill.grandTotal` is not resolved integer paise | `grand_total_missing` | §10's own blocker code. **Defensive typing only.** It narrows the return type: 0022 L3's invariant makes it unreachable through `runTransaction`, because a committed locked document has zero locking blockers and this is one of the nine. Its pin forges the state to assert the narrowing — a type check, not a user-facing path. |
| `derived.shares === null` | `units_unassigned` | Same class, same reason: `shares` is null exactly when a unit is neither assigned nor acknowledged (§10's `units_unassigned`), which a locked bill cannot be. It is read from the committed document rather than recomputed, so that the recipient's own answer stays a second opinion instead of an echo — A6's mismatch flag is only meaningful if the cache came from somewhere else. |

**No second budget check, no schema re-validation, no re-computation of derived numbers.** Assembly reads the
committed document's `derived` and `billValidation` results as the runner produced them (0019 S9: 16 must not
recompute blockers outside the runner, and the same discipline applies to shares).

## A2 — The shape, field by field, with its source

Serialized in exactly this order, so the compact JSON of 0025 P2 is deterministic:

```ts
{
  snapshotVersion: 1,
  snapshotCreatedAt: now,
  bill: { id, title, creatorId, payerId, createdAt, grandTotal, taxIncluded, taxIncludedSource },
  participants: [{ id, name, tokenExpiresAt }],
  items: [{ id, name, qty, unitPrice,
            unitAssignments: [{ unitIndex, participantIds, confirmedUnassigned }] }],
  charges: [{ type, label, amount, included, rate?, otherSign? }],
  adjustmentLines: [{ reason, amount, assignedToParticipantId }],
  computedShares: [{ participantId, exactAmount, settlementSharePaise }],
}
```

| Snapshot field | Source in the locked document | Notes |
|---|---|---|
| `bill.*` | `working.bill` | `grandTotal` is the resolved integer paise §10 requires; `taxIncluded`/`taxIncludedSource` travel as the summary hint plus provenance they are, not as an arithmetic input. |
| `participants[i].id/name` | `working.participants`, roster order | `token` and `paid` are not copied — A3. |
| `participants[i].tokenExpiresAt` | `working.participants` | Copied verbatim, including `""`. Ticket 13 never writes it (0022 L5), so v1 links carry an empty hint; see G3. |
| `items[i]` | `working.items`, document order | `id`, `name`, `qty`, `unitPrice` only. `lineTotal`, `detectedLineTotal`, `confidence`, `assumedQtyReviewed`, `quantitySource`, `priceSource` are editorial/parse state, not bill state the recipient acts on. |
| `items[i].unitAssignments` | `working.itemUnits` for that item, ascending `unitIndex`, joined to `working.assignments` | `participantIds` in **roster order**, deduplicated. The `ItemUnit.id` and `ItemUnitAssignment.itemUnitId` keys are internal row identity and are not copied; `unitIndex` is what survives as meaning (§10's `0..qty−1`). |
| `charges[i]` | `working.charges`, document order | `id`, `billId`, `source` dropped. `rate` passes through when present. `otherSign` is copied only when it is `"add"` or `"subtract"`: §10's snapshot type has no `unknown`, and `draft_charges_unresolved` means a locked bill cannot contain one — so the recipient's recompute agrees with the creator's by construction, not by luck. |
| `adjustmentLines[i]` | `working.bill.adjustmentLines`, regenerated by `totals.ts` | `id` (`adj:<unitId>`) and `billId` dropped; `reason`, `amount`, `assignedToParticipantId` kept. This is ADR-009's "creator absorbs it visibly" surviving into the link, which is the whole point: a recipient can see why the creator's share is larger. |
| `computedShares[i]` | `derived.shares`, zipped with `allocateSettlement(shares, confirmedTotal)` | Same confirmed-total target ticket 15 uses (`printedGrandTotal ?? calculatedPayableTotal`), so the cache and the settlement rows cannot disagree about which number was the transfer boundary. |

**Order is a contract.** Every list follows the document's own order (`items`, `charges`, roster) or a numeric
key (`unitIndex` ascending). A second encode of an unchanged bill therefore produces a byte-identical plaintext;
only the nonce and the resulting ciphertext move. That is what makes "the same bill, the same payload" testable
rather than plausible.

**When the settlement allocation refuses** (0024 S8-4: a reconciliation gap larger than the allocation's slack),
every `settlementSharePaise` in the cache is `null` and the shares still travel. §10's field is
`number | null` for exactly this reason, and the refusal surface is already ticket 15's settlement panel — a
second code for the same condition on a second panel would be two messages about one gap.

## A3 — Excluded content, and how absence is proved

§10's line is "Never include the receipt image, raw OCR result, drafts, or extraction confidence data"; 0025 P4
enumerated it for the codec. Assembly enforces it by **constructing a new object field-by-field rather than
projecting or spreading `working`**, so exclusion is the default: nothing gets in unless named. The forbidden
set, asserted present-in-the-document and absent-from-the-payload:

| Forbidden | Where it lives | Why it must not travel |
|---|---|---|
| receipt image bytes, `data:image`, Blob handles, retained-image keys | `storage` (ticket 14), `RetainedImageRecord` | §10, ADR-007: raw receipt material is the one thing the format exists to keep out. |
| `parseResult`, `parseValidation` | `WorkingBill` | The parse is evidence about the photograph, not about the bill. It also carries line text, boxes and confidences wholesale. |
| `unclassifiedRows`, `excludedRowIds` | `WorkingBill` | 0022 L1: creator review state. An excluded row is OCR text the creator decided is not part of the bill — shipping it would re-add exactly what was excluded. |
| `staleLinkCutoffAt` | `WorkingBill` | 0025 P4: the creator's local watermark. It is the *comparison*, not snapshot content; the recipient must not receive a value that only means something next to a ledger. |
| `draftItems`, `draftCharges` | `WorkingBill` | Nulls, provenance and unresolved decisions. §10: drafts may hold what a finalized record may not. |
| `confidence`, `warnings`, `manuallyAdded`, `parsedRef`, `detectedLineTotal`, `quantitySource`/`priceSource` on items | `DraftItem`/`Item`/`BillCharge` | Extraction quality and edit history. The recipient acts on resolved amounts, and 0014's accuracy work is not a share payload. |
| `Participant.token` | `Participant` | The fragment's token component *is* the key. Repeating every participant's token inside the payload would put N−1 bearer secrets in the hands of bearer #N. |
| `Participant.paid`, `Participant.billId` | `Participant` | §10's snapshot shape has no `paid` (0025 P4 records it as a gap, not a field to invent), and `billId` is already `bill.id`. |
| `CreatorProfile.displayName`, `CreatorProfile.upiId` | ticket 14's profile row | 0025 P4: "the snapshot is a bill, not an address book". The consequence — the recipient cannot rebuild a UPI intent — is G2, stated rather than papered over. |
| `revision`, `billId` on items/charges/adjustments, `ItemUnit.id`, `ItemUnitAssignment.itemUnitId` | the committed document | Internal row identity, not recipient-meaningful. `revision` is local ledger bookkeeping that a stale link must not be able to contradict. |

**Two proofs, because one is not enough.**

- *Structural:* the test walks the assembled payload's own JSON key set and fails on any forbidden name, so a
  future `{ ...working }` shortcut cannot pass by accident.
- *Marker:* a document whose parse-derived state carries planted strings (a fake `data:image/...` value, an OCR
  line, a draft id, a UPI id). The test asserts the markers are present in the working bill — otherwise the
  assertion proves nothing — and absent from the payload, from its JSON, and from the encoded fragment.

## A4 — The budget: where it is measured, and the refusal the creator sees

0025 P5 pinned the cap (8192 encoded bytes, whole fragment after `#`) and the shipped codec enforces it inside
`encodeSnapshot`. That leaves the open question the brief names: measure before encoding, or measure after?

**Pinned: after — on the encoded fragment, in the codec, and nowhere else.** Two candidate designs were
available; one is pinned and the other is rejected on the record:

- **Rejected — a pre-encode estimate.** Assembly would have to predict DEFLATE's output and base64url's
  expansion from the JSON length. Both are data-dependent, so the estimate is either pessimistic (a bill that
  would have fit gets refused) or optimistic (the refusal moves to the codec anyway) — and the moment the two
  disagree, the number shown to the creator is a lie about a byte count. The record refuses to add a second
  measurement of one quantity, per 0025 P5's own rule that the number "is computed from the actual encoded
  string, not estimated from the uncompressed JSON".
- **Pinned — encode, then measure.** The refusal is about the artefact the recipient will actually receive.
  `buildShareLinks` calls `encodeSnapshot`, catches its `ShareCodecError`, and reports `{ ok: false, code:
  "link_budget_exceeded" }`. Assembly stays free of budget logic entirely: it cannot know a size it has not
  produced.

**Budget usage shown to the creator** (0025 P5, ticket 16 checklist item 2, ROADMAP 3E.3): the share panel
renders `{bytes} / 8192 ({percent}%)` per link, `bytes` being the encoded fragment's length and `percent` its
floor at whole percent. The meter is derived from the string that was produced, so the displayed number and the
link under it cannot drift.

**All-or-nothing per roster.** The payload is one snapshot and every token is a UUID of the same length, so all
N fragments have the same byte count give or take the nonce. A partial roster of links would therefore be a
distinction without a difference, and worse: it would let a creator send three participants a bill and two a
refusal. One over-budget ⇒ zero links, one visible `link_budget_exceeded`, and the remedy copy 0025 P5 names —
shorten or remove non-essential bill labels, then share again. **Never truncated**: a truncated GCM message is
undecryptable, and 0025 P5 already forbids it.

## A5 — Immutability, JSON-safety and the JSON ceiling

`assembleSnapshot` returns `deepFreeze(snapshot)` using 0019's existing `deepFreeze` from `bill/document.ts` —
one implementation of "the committed value cannot be written in place", shared by the document and the snapshot.
The point is not ceremony: a link is assembled once and handed to the codec, to the panel and to the cache
comparison. A mutation anywhere would make those three disagree, and 0019 S7's argument for freezing the
document applies verbatim.

JSON-safety is the same rule from the other side. `0025 P2`'s transport is JSON, and every money value is a
decimal string, so:

- a deep round trip through `JSON.parse(JSON.stringify(...))` must deep-equal the original;
- no `BigInt`, `Map`, `Set`, `Uint8Array`, `Date` or `undefined`-valued optional survives in the payload;
- every integer paise field satisfies `isIntegerPaise` (0022's existing guard) before it is copied, so a float
  that "looks round" cannot enter a link — this is §10's "never IEEE-754 float" rule applied at the boundary
  where the payload leaves the app.

## A6 — The recipient re-derives; the cache is checked, not trusted

§10: "Shares are recomputed on load and never trusted from a cache." The view therefore needs no second split
engine, only an adapter:

```ts
function splittableFromSnapshot(snapshot: BillShareSnapshot): SplittableBill;
function sharesFromSnapshot(snapshot: BillShareSnapshot): { shares, settlement, mismatch }
```

The adapter synthesizes what the engine needs and nothing else: unit rows keyed `"<itemId>#<unitIndex>"`,
assignment rows from `participantIds`, `adjustmentLines` rebuilt onto a `bill` object with `reason: "unassigned"`.
Those ids are *local* identity for the join, not snapshot content, so A3's ban on internal ids is untouched.

Then it runs ticket 02's `computeExactShares` and, against `bill.grandTotal`, ticket 02's
`allocateSettlement` — the same functions the creator's device ran. `mismatch` is a boolean comparing each
cached `exactAmount` with the recomputation by exact rational equality (`compare`, never float). When it is true
the view shows the recomputed numbers and names the mismatch (`data-testid="share-cache-mismatch"`); it does not
refuse to render, because 0025 P4's own reasoning is that a link holder can forge the cache, so a disagreement
is expected behaviour, not corruption. `decodeSnapshot`'s schema check still guarantees the cache is
*well-formed*; the recomputation is what makes it not *authoritative*.

## A7 — Generating links is a lock-time action, in the view

```ts
function buildShareLinks(
  document: BillDocument,
  options: { readonly now: string }
): Promise<{ ok: true; snapshot: BillShareSnapshot; links: readonly ShareLink[] }
       | { ok: false; code: "bill_locked" | "grand_total_missing" | ShareFailureCode }>;

interface ShareLink { readonly participantId: string; readonly fragment: string; readonly bytes: number }
```

`Share.svelte`'s sibling on the creator's side is `components/ShareLinks.svelte`, mounted in the bill view when
`working.bill.isLocked`. It calls `buildShareLinks` once per locked document revision, holds the result as view
state, and passes the fragments to `Settlement` so the WhatsApp hand-off carries the real link.

**Why the view and not the transaction.** `lib/bill/*` reads no clock and no random source (0011, restated by
0022 L5 as the reason `mintToken` and `now` are parameters). Encoding needs a nonce from `crypto.getRandomValues`
and is `async` because WebCrypto is `async`. A transaction that called it would be a non-deterministic write in
a deterministic runner, and its product would be a ciphertext of data the document already contains. So:

- share links are **not persisted**. They are regenerable from the locked document plus the tokens the document
  already stores; persisting them would create a second copy of the bill, encrypted, in the ledger — a store of
  bearer secrets the export envelope would then carry (0023 P4's export is a file a user keeps).
- a reload re-encodes: the same payload, a fresh nonce, therefore different bytes. That is correct behaviour,
  not drift, and G6 records the consequence: a link copied before the reload still decodes, because its own
  nonce and token travel inside it.
- "**at lock time**" means *the locked bill is the only state from which links exist* (§13: "Locked: the bill
  snapshot is frozen and participant links can be generated"). It does not mean the lock transaction encodes
  them. The generator is offered the moment the bill is locked and again on every revision after that, so the
  creator never has to think about it.
- a participant whose `token` is `""` gets no link. 0022 L5 makes that unreachable on a locked bill (lock mints
  what is missing), so it is the same guard ticket 15 already carries, not a new state.

Unlock is the creator's stale-link event: 0022 L6 stamps `staleLinkCutoffAt`, and re-locking mints fresh tokens
(A7's links therefore change key material as well as nonces). The panel shows the existing `stale-links-notice`
beside the new links, so "these are the new ones" and "the old ones are frozen" appear together.

## A8 — The `/share` view

`packages/pwa/src/lib/share/view.ts` owns the participant view's *model*; `routes/Share.svelte` renders it and
adds nothing. The seam exists so the four failure codes, the copy and the staleness rules are testable without a
browser, which is how every other ticket in this repo splits seam pins from browser pins.

```ts
function openShareLink(
  fragment: string,
  options: { readonly cutoffOf?: (billId: string) => Promise<string | null> }
): Promise<ShareView>;

type ShareView =
  | { readonly state: "empty" }
  | { readonly state: "failed"; readonly code: ShareFailureCode; readonly message: string }
  | { readonly state: "ready"; readonly snapshot: BillShareSnapshot;
      readonly shares: readonly RecomputedShare[]; readonly mismatch: boolean;
      readonly staleness: Staleness };
```

- **The token comes out of the link.** `decodeSnapshot` takes `(fragment, token)`; the recipient's token is the
  fragment's second component, which is the whole of 0025 P3's "the recipient derives it from the link". When
  the component is absent or garbage the derived key simply fails GCM and the code is
  `link_corrupt_or_tampered`, which is the correct answer for a malformed link. An unexpected throw from WebCrypto
  (an empty key material, say) is **normalized to `link_corrupt_or_tampered`** — fail closed, never white-screen,
  and never a partially decoded bill.
- **The router hands the raw fragment and nothing changes it.** `router.ts` already guarantees
  byte-for-byte preservation (DECISIONS/0017 D3a), and `codec.ts` strips a leading `#` itself.
- **States are exclusive and ordered**: `empty` → (`failed` | `ready`). There is no "decoding" branch in the
  model because `openShareLink` resolves once; the component holds the promise and shows a loading line *only*
  while it is pending, with no bill content in that branch.
- **Failure copy**, one message per code, no bill content, no stack, no plaintext fragment. The message is the
  codec's own `ShareCodecError.message` for the three integrity codes, plus the pinned per-code headline:

  | Code | Headline the view shows |
  |---|---|
  | `unsupported_link_version` | This link is from a newer receipt-lens than this page. |
  | `link_budget_exceeded` | This link is longer than this format allows. Ask the creator to shorten the bill's labels and send a new link. |
  | `link_corrupt_or_tampered` | This link is incomplete, damaged or was altered. Nothing was read from it. |
  | `link_schema_invalid` | This link decrypted into something that is not a v1 bill snapshot. Nothing was rendered. |

  The exact `code` string is also rendered (`data-testid="share-failure-code"`) because a readable message that
  hides which check failed is not a diagnostic. Fail-closed behaviour is asserted for **all four**, and each is
  reached through the real codec rather than a hand-written fragment where the code allows it.
- **`ready` renders**: the bill title, every participant's exact share and payment amount *from the
  recomputation*, G1's identity prompt (a `which-one-are-you` select over the roster names; choosing one marks
  that row `data-testid="share-mine"` and reorders it to the top, choosing "nobody yet" leaves the list flat),
  the full-bill toggle (items with their unit holders, charges with their inclusion decision, adjustment lines),
  the `tokenExpiresAt` hint labelled as a client-side hint, the created-by-snapshot date, the staleness banner or
  the honest "may have changed" line, and the disclosure.
- **The identity prompt is view state, not a decode result.** `ShareView` carries no
  `selectedParticipantId`: `openShareLink` answers what the link says, and which row is "mine" is a question the
  person holding the device answers. That keeps the seam pure — one fragment, one model, any number of viewers —
  and it is why the selection cannot become a security property by accident: it reorders and highlights, and
  hides nothing, because ADR-007's whole point is that the recipient already holds the whole bill.
- **No UPI intent is rebuilt here.** The payload has no payee VPA by design (0025 P4), and G2 states the
  consequence: the view shows the payment *amount* and says the creator's message carries the link.
- **The fragment is not printed, and one attribute still carries it.** What changed from ticket 10a's
  placeholder is that the bytes are no longer rendered as page text; `data-testid="share-fragment"` keeps
  `data-raw={fragment}`, because DECISIONS/0017 D3a's byte-for-byte proof reads exactly that attribute and
  `playwright/shell.spec.ts` asserts it three times. The claim therefore has to be precise: the view adds no
  *new* copy of the secret, and the one it keeps is the shell's existing evidence — the fragment is already in
  `location.hash`, in history, and readable by anything on the device, which is A10's disclosure sentence rather
  than a bug this screen could fix. Deleting the attribute would have traded a real guarantee for a symbolic one.
- **The ledger lookup never blocks the bill.** `cutoffOf` can wait on a storage migration gate, and `/share`
  deliberately shows no storage screens (App.svelte hides them, because a recipient has no ledger). So the route
  renders from `openShareLink(fragment)` with the honest "may have changed" label, and refines it through
  `withStaleness(view, cutoffAt)` if and when the lookup answers. That is the same three answers through the same
  `stalenessOf`, one of them arrived late rather than never — and a hang in IndexedDB degrades the label, not the
  bill.

`cutoffOf` is injected for the same reason `mintToken` is: a pin can then test all three staleness outcomes
without a ledger, and `Share.svelte` supplies the real one — `storage.session().restoreBill(billId)` under
`storage.guard(...)`, reading only `working.staleLinkCutoffAt`. A recipient device has no such bill (or no
ledger at all, or a gated/failed storage phase), and every one of those paths returns `null`, which is the
"cannot know" state, not an error. **No local amount ever reaches the share view**: the ledger is read for that
one timestamp and the numbers on screen come from the fragment, which A9 makes testable.

## A9 — Staleness

```ts
type Staleness =
  | { readonly state: "stale"; readonly cutoffAt: string }
  | { readonly state: "current_for_this_bill" }
  | { readonly state: "unknown" };

function stalenessOf(snapshotCreatedAt: string, staleLinkCutoffAt: string | null): Staleness;
```

- Comparison is `Date.parse(snapshotCreatedAt) < Date.parse(staleLinkCutoffAt)`, strictly less-than: a snapshot
  taken *at* the cutoff instant belongs to this lock epoch. Timestamps are ISO strings; 0022 L6 chose a timestamp
  over a revision precisely because §10's snapshot carries `snapshotCreatedAt` and no revision field, and this is
  that comparison being used for its one purpose.
- `stale` ⇒ the banner is **"Bill updated on {date}"** with `{date}` the cutoff, formatted for reading, plus the
  0022 L6 sentence that the amounts shown are the frozen ones and a new link has to come from the creator. The
  values on screen are still the snapshot's. This is the pin that matters: a stale snapshot is *not* patched up
  to look current, and the view does not fetch or compute anything from the live bill to "help".
- `unknown` (no local bill — the ordinary recipient) ⇒ "Snapshot created {date}. The bill may have changed
  since." and **never the word "current"**. 0025 P8 calls this the honest version of ADR-007's "where possible".
- `current_for_this_bill` ⇒ the view says the snapshot is from this lock on this device. The claim is bounded to
  what the comparison actually shows: the snapshot was taken at or after the last unlock here, on this device,
  for this bill id. It does not claim the creator has not since unlocked on *another* device — 0022 L6 says
  exactly that, and the copy must not exceed it.
- **No revocation language anywhere.** A stale link decodes, shows its frozen numbers, and is labelled. Nothing
  says revoked, expired, disabled or invalidated. `tokenExpiresAt` is a UX hint (0025 P8) and its copy says so.
- 0025 P8's second bullet — two snapshots for one bill id on one device, the older one marked stale when the
  newer has been seen — is **not implemented separately**. G4 records why: the reachable way to hold two
  snapshots of one bill is unlock→re-lock, and that path already stamps the cutoff *and* rotates the tokens, so
  the comparison above catches it. Encoding twice inside one lock epoch produces two links that are equally
  current, and calling the first one stale would be a false statement about the bill.

## A10 — The disclosure copy

0025 P7 pinned the wording; this record pins where it appears and forbids strengthening it. It is on:

- the participant view (`/share`, `data-testid="share-disclosure"`), always rendered when a snapshot renders —
  a recipient who is shown a bill without being shown that they hold the whole thing is the failure mode ADR-007
  names;
- the creator's share panel, where the links are made, so the person copying the link reads the same sentence as
  the person opening it.

The words are pinned in 0025 P7's own text — "**This link is the key.** Anyone who has the complete link can
read the whole bill and the shares in it. It is a bearer secret, not protection from the person you send it to.
'Show only my share' is a display default, not access control." — and may be split across elements but not
paraphrased. The two supporting facts (fragments stay out of server logs; the link can still be copied, synced,
backed up, or read by anything on the device that can read `location.hash`, and cannot be reliably revoked) may
appear beside it. No copy on either screen may say encrypted-so-only-the-recipient, secure, private link, or
present expiry as a security property. The tests assert the sentences are present, not that something is absent:
the absence checks are the staleness and failure-code cases.

## A11 — Amendments to ticket 15's pins (the placeholder goes away)

0024 S8-3 named the placeholder as a gap ticket 16 would close. Closing it edits another ticket's pins, so they
are listed rather than quietly changed:

1. **`participantLinkFor(origin, fragment)`**, second parameter meaning changes from *token* to *encoded
   fragment* (which already includes the `v1.` prefix): `` `${base}/share#${fragment}` ``. The old
   `v1.${token}` construction is deleted; leaving it as a fallback would mean a bill whose link failed to encode
   could still be "shared" as a token-only URL that decodes to nothing.
2. **`SettlementContext.shareLinks: Readonly<Record<string, string>>`** (participantId → fragment) and
   **`buildSettlement(document, profile, { origin, shareLinks })`**. A row with no fragment has
   `participantLink: null` and therefore `whatsappUrl: null`: no link is offered rather than a broken one, and the
   reason is on the share panel, where the encoding actually failed.
3. **Two assertions in `packages/pwa/tests/settlement/pins.test.ts` move** with it: the pin that "supplies the
   version-and-token placeholder link ticket 16 will replace" becomes a pin that the link is built from the
   encoded fragment, and the WhatsApp-text pin asserts the real fragment rather than `share#v1.token-p1`. Its
   e2e counterpart in `playwright/settlement.spec.ts` (`toContain("/share#v1.")`) needs no edit — a real fragment
   still starts that way, which is the one piece of ticket 15's evidence that survives unchanged.

**This amendment lands as a `DECISIONS/0024` S12 paragraph in the same implementation commit**, not only here:
0024 is the record that owns the settlement seam, so a signature change to `participantLinkFor`,
`SettlementContext` and `buildSettlement` has to be readable from the document a ticket-15 reviewer would open.
S12 names the new parameter meanings, the `shareLinks` shape, the two pins that moved and the reason no
placeholder fallback survives. The moved pins' own comments carry the rationale, the amendment commit message
references ticket 16 A11, and **nothing here edits another ticket's pins silently** — a pin that changes meaning
is a decision, and it is reviewable as one.

`deriveTransactionRef`, the `tr` derivation, the intent builder and the exact/payment formatting are untouched:
0024 S9 hands ticket 16 those rows and forbids rebuilding a second UPI intent around the codec, which A8's "no
UPI intent on the participant view" obeys for a second reason (there is no payee VPA in the payload anyway).

## A12 — Gaps, recorded rather than discovered later

- **G1 — "show only my share" has no recipient identity to default to, so the viewer names themselves.** §10's
  snapshot has no recipient field, and 0025 P4 forbids putting participant tokens in the payload. The v1 view
  therefore shows the **full bill**, and the viewer selects their own name from the roster (A8's "Which one of
  you are you?" prompt) to highlight their share; with no selection every share is shown flat. Per-recipient
  defaulting — the view knowing it is "you" without asking — needs `recipientId` in the snapshot, which is a
  `snapshotVersion` 2 decision. The reason it stays deferred: adding `recipientId` to the encrypted payload is a
  small step beyond "bill data" and toward "who this link is for", which is a claim about a person rather than
  about a meal. The selection is view state and never leaves the device.
- **G2 — how a participant actually pays, pinned.** The share snapshot excludes `upiId` (0025 P4), so the
  `/share` view shows the exact share and the payment amount and **rebuilds no `upi://` intent**. Payment links
  are delivered by WhatsApp at settlement time — `buildWhatsAppMessage` line 196 already carries
  `Pay with UPI: {upiUrl}`, the full `upi://pay?pa=…&am=…` intent, alongside `Bill link (opens on any device):
  {participantLink}` on line 197, both fed from ticket 15's `SettlementContext.shareLinks` from ticket 16 on. So
  the intended flow is that **both halves arrive together in one message**: the tap-to-pay link and the bill. A
  participant who receives only the bill link sees the amounts and contacts the payer for a payment link; that is
  a real degradation, and the view says so rather than offering a dead button. If a future v2 wants tap-to-pay
  from the share view itself, `payerUpiId` has to enter the snapshot as a `snapshotVersion` 2 field, trading
  disclosure of the payer's VPA to every participant holding the link for a one-tap flow — which is exactly the
  address-book exclusion 0025 P4 chose to keep.
- **G3 — `tokenExpiresAt` is `""` for every real bill.** 0022 L5 deliberately left it unwritten; inventing a TTL
  here would be a product number with no evidence. `""` means "no expiry set", and the hint renders that way
  rather than as a fabricated date. If a TTL is ever added, the field becomes `string | null` with `null` meaning
  no expiry, and the empty-string convention goes away with it. **No sentinel values** — `"never"`, `"0000"` or
  `"none"` inside a link a recipient can forge at leisure is a string that pretends to be a type; absence is
  `null`, and §10's field having no `null` today is the reason the convention is tolerated for one more ticket.
- **G4 — 0025 P8's "two snapshots for one bill id on one device" needs no second mechanism.** The case P8 named
  is a device holding a stale snapshot and a current one for the same bill. Every way that actually happens is
  unlock → edit → re-lock, and 0022 L6's `unlockBill` stamps `staleLinkCutoffAt` with the unlock time while
  minting fresh tokens for the new epoch. So the older snapshot's `snapshotCreatedAt` precedes the cutoff and the
  A9 comparison resolves it to `stale` on its own — the banner appears, the frozen amounts stay on screen, and the
  newer link is unaffected. The remaining case, encoding twice inside one lock epoch, produces two links that are
  *equally* current: no unlock happened, nothing changed on the bill, and labelling the first one stale would be a
  false statement about the bill rather than a conservative one. Recording the argument is the pin here, not a
  reference to one; a session-scoped "most recent snapshot seen" map would add state that can only be wrong.
- **G5 — `paid` is not in the snapshot** (0025 P4). A recipient cannot see settlement status; 0024 S9's
  "present `paid` as automatic verification" prohibition is unaffected.
- **G6 — links are per view session, not durable.** Regenerated fragments differ in bytes (fresh nonce) while
  carrying the identical payload. Anyone who copied an earlier fragment keeps a working link; that is the
  no-revocation property ADR-007 already states, and the panel's copy says so rather than pretending a new
  listing invalidates the old one.
- **G7 — a bill whose labels are long is refused, not trimmed.** ADR-007 permits "shorten/remove non-essential
  bill labels" as the creator's remedy. This ticket does not build a trimming assistant: automatic label
  removal would silently change what the recipient reads, which is the opposite of the freeze the snapshot
  exists to provide. The refusal names the remedy and leaves the choice to the creator.
- **G8 — `PROJECT(1).md` is unedited by this record**, as with 0025.

## A13 — The browser proof

`playwright/share.spec.ts`, seven split cases, each self-contained from its own capture, no `setTimeout`
overrides, against the built app:

1. **`share: opening a valid link renders the participant view`** — three rows at ₹33.3333… exact and a ₹33.33
   transfer, asserted per person rather than per position because the one spare paise goes to the id the
   largest-remainder tie-break chooses; the pinned disclosure sentences; the "may have changed" label on a
   device with no ledger; **zero outbound requests** other than the page's own same-origin assets; G1's roster
   prompt moving the chosen row to the top with `data-mine` while all three rows stay present; the expiry hint
   reading "no expiry set"; and the full-bill toggle showing the real item and its holders. The creator's side
   is checked in the same case: three rows in the panel, each with `data-bytes` greater than zero and at most
   8192.
2. **`share: tampered fragment fails closed with link_corrupt_or_tampered`** — one flipped base64url character,
   and no title, no rows and no amounts on the screen.
3. **`share: wrong version fails with unsupported_link_version`** — the same bytes under a `v9.` prefix.
4. **`share: a length-1-mod-4 fragment fails closed with the codec's own words`** — A15 through the route, and
   the assertion is on the codec's message text ("impossible length"), which is what distinguishes a classified
   failure from the view catching a platform exception.
5. **`share: over-budget assembly is refused at lock time, and no link is offered`** — a 20 KB incompressible
   item label, `share-refusal[data-code="link_budget_exceeded"]`, zero `share-link-row`, and A11's other half:
   the settlement row says `no bill link yet` and offers no WhatsApp hand-off.
6. **`share: stale snapshot shows banner, not current values`** — lock, capture the fragment, unlock through
   L4's dialog, read the cutoff out of `stale-links-notice`'s `<time datetime>`, change the price *and* the
   printed total so the creator's settlement really becomes ₹50.00, re-lock, then open the old fragment on the
   same device: the banner names the cutoff date, `data-staleness="stale"`, and the rows still read
   ₹33.3333… / ₹33.33 with no ₹50.00 anywhere in the view.
7. **`share: receipt image and OCR text are absent from the fragment`** — the `AMBIGUOUS` fixture whose
   excluded row is `NAAN 60.00`; the row is asserted visible on the creator's bill (so the absence below has
   something to be absent *from*), then absent from the fragment, from the collapsed participant view, and from
   the expanded full-bill view, with zero `<img>` elements.

The case list is eight bullets of intent against seven tests because the G1 roster-selection promise is proved
inside case 1 rather than as its own capture: it is the same link, the same device state, and one more click.

Cases 2, 3, 4 and 7 are honest about what a browser can see: the fragment is opaque by construction, so absence
of a marker from an encrypted string is a weak assertion on its own — which is why the structural and marker
proofs live in A3's seam tests, where the payload is inspectable. The browser adds the two things only it can
prove: that the shipped route renders the pinned copy for a shipped codec's output, and that nothing on the
screen came from the receipt rather than the bill.

## A14 — What this hands to tickets 17 and 18

- **17 (offline model cache):** `/share` is one of `scripts/serve-app.mjs`'s `APP_ROUTES` already, so a deep link
  resolves with no server rewrite; the participant view issues no request of its own and needs no cache beyond
  the shell.
- **18 (privacy audit):** the egress claim gains a concrete boundary. `packages/pwa/src/lib/share/*` adds no
  remote literal, so `scan:egress` needs no new allowance entry. The fragment never leaves the device: it is
  absent from the HTTP request that loads the page (ADR-007) and no share code reads it into anything that
  could. The snapshot excludes image, OCR text, confidence and drafts by construction and by test (A3), and the
  only deliberate external action remains WhatsApp's `wa.me` link, now carrying a real fragment instead of a
  placeholder.
- **`PROJECT(1).md`, §10's shape, and ADR-007 are unmodified.** This record implements them.

## A15 — Fail-closed amendment to 0025 P6: an impossible-length base64url component

Found while pinning the view, not while writing the codec, and it escapes 0025 P6's closed set of four codes.
Reproduced against the shipped `packages/pwa/dist/lib/share/codec.js` on 2026-11-05:

| Input | Expected | Actual |
|---|---|---|
| `v1.A.A.A` | `ShareCodecError: link_corrupt_or_tampered` | `DOMException: InvalidCharacterError` |
| `v1.tok.A.AAAA` | `ShareCodecError: link_corrupt_or_tampered` | `DOMException: InvalidCharacterError` |
| `v1.<36-char-token>.A.AAAA` | `ShareCodecError: link_corrupt_or_tampered` | `DOMException: InvalidCharacterError` |

**The condition.** P6 step 3's charset rule is `[A-Za-z0-9_-]+`, and `fromBase64url` then pads to a multiple of
four and hands the string to `atob`. An unpadded base64url component can have length 0, 2 or 3 mod 4 — never 1,
because one leftover character encodes no byte at all. A component of length 1 mod 4 passes the charset test and
then makes the platform decoder throw. `atob` is called on the nonce and the ciphertext **outside** the
try/catch that guards decryption, so the exception leaves the codec as neither a `ShareCodecError` nor one of
the four codes.

**Why it is not academic.** A link truncated by a messenger, a clipboard, a URL shortener or a line wrap is
exactly the input class this format must fail closed on — ADR-007's sentence is "malformed input must fail
closed with a user-readable error". A fragment whose last component lost its characters in transit can land at
1 mod 4, and today it produces an exception the view has to guess about rather than a code it was told to show.

**The fix, pinned.** The charset predicate becomes "base64url **and not 1 mod 4**", checked in the same place as
the charset, so the classification happens before any platform call and the code is `link_corrupt_or_tampered` —
no new code, because P6 already assigned this position in the order to that answer. The length rule is exact, not
heuristic: 1 mod 4 is not a smaller valid encoding of anything, so no real link is affected. The pin lands in
`packages/pwa/tests/share/codec.test.ts` as a thirteenth case, which is red against the shipped codec and green
after the change.

**The view keeps its own normalization anyway** (A8), and the reason is defence rather than reachability: the
`/share` screen is the boundary between a WebCrypto rejection and a person's browser, and 0025 P6's promise is a
readable message at that boundary even if a future platform says no to something this build did not anticipate.
Its pins test it by making the codec module itself throw, because no fragment can produce that state — the pin
asserts what the view does with a thing it cannot name.

## Reporting discipline

Nothing in this record is a measurement. The 8192-byte cap, the 64 KiB inflate ceiling and §10's field list are
contract constants this ticket inherited, not calibrated here. Every pin is discharged by
`packages/pwa/tests/share/snapshot.test.ts` and `packages/pwa/tests/share/view.test.ts` (seam),
`packages/pwa/tests/settlement/pins.test.ts` (A11's amended rows, whose rationale also lands in
`DECISIONS/0024` S12), and `playwright/share.spec.ts` (browser), which are the source of truth for behaviour. If a real bill turns out not to fit the budget, that is ROADMAP R4
becoming evidence and needs a new record with the measured sizes — not a quieter cap.
