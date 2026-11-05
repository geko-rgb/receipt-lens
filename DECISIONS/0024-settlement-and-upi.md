# DECISIONS/0024 — Settlement, UPI intents and the manual paid flag

Date: 2026-11-05 · Ticket 15 · **Status: binding for tickets 15–16.**

Ticket 14 left the bill persistent, lockable and share-token-ready. Ticket 15 turns the exact split into
something a person can act on: each participant's exact share, the separate whole-paise amount a UPI intent can
carry, a payment link for everyone who owes something, a WhatsApp hand-off, and the creator's manual record of
who has paid. As with 0019–0023, every pin below is a predicate the shipped tests assert. Nothing here is a
measurement of behaviour that did not exist when it was written.

## S0 — The pins, in one line each

1. **Payer = creator in v1.** `setPayer` rejects any other participant with `payer_must_be_creator`; the intent's
   `pa` is the creator's UPI id from `CreatorProfile`. A future payer≠creator model needs
   `Participant.upiId` (S8).
2. **Exact and payment are different numbers and are labelled as such.** Where
   `settlementSharePaise` is not the exact rational share, both are shown ("Exact share" / "UPI payment
   amount"). Where they are equal the display collapses to one value. The exact value is always available to
   copy (the WhatsApp text carries it even when the two agree).
3. **The intent is `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…[&tr=…]`**, every value RFC 3986-encoded, `am` always
   two decimals, `pn` ≤ 40, `tn` ≤ 50, `tr` ≤ 35 and `[A-Za-z0-9]`.
4. **`tr` is the first 16 lowercase hex characters of `HMAC-SHA-256(key = shareToken, message =
   "<billId>:<participantId>")`.** It is omitted when the token is empty or when a caller-supplied reference
   would break the charset/length limit — never sanitised into something else.
5. **Zero settlement means no link.** `settlementSharePaise === 0` → "nothing to pay", no intent and no
   WhatsApp hand-off. `0 < share < 100 paise` is a valid transfer (`am=0.50`).
6. **The payer never receives a self-payment link**, because the payer is the creator (pin 1) and the creator's
   share is what they retain after collecting. The row says so instead.
7. **WhatsApp is a `wa.me` click-to-chat link** whose prefilled text labels the exact share, the payment amount
   and the participant link separately. Opening it is a deliberate external action (§15 rule 6).
8. **`paid` is manual and independent of the link.** `setParticipantPaid` remains a locked-bill write
   (0022 L7); the intent is unchanged by it; the flag survives unlock and re-lock. No copy claims a transfer
   was verified (§19).
9. **`pn` comes from `CreatorProfile.displayName`, then the payer participant's name.** If both are empty the
   link is refused with `creator_name_missing`. A missing UPI id refuses with `creator_upi_missing`. These are
   link-generation refusals, not transaction rejections.
10. **G5 is recorded honestly:** the primary NPCI document was read, and it does not publish the numeric limits
    this project uses. The constants are therefore marked *unverified against primary* with the sources listed
    (S7). No limit is presented as an NPCI fact.

## S1 — Why the payer is the creator in v1

§12's template is `pa={creator_upi}` and §10 gives only `CreatorProfile` a UPI field. The creator is also
v1's default payer (§13). `setPayer` therefore becomes a narrower operation: it may clear the payer (`""`,
which `payer_missing` already reports) or name the creator, and nothing else.

`payer_must_be_creator` is a new `TransactionRejectCode` because the condition is neither `unknown_entity` (the
participant exists) nor `protected_participant` (that code is removal's). The remedy is singular and the message
can say it: v1 has no stored payee VPA for a participant, so a non-creator payer cannot be paid. This
deliberately supersedes 0022 L11's looser "any participant" wording — 0022 is still right that the payer is
state on the bill, but ticket 15 is where the state's reachable set narrows.

**Recorded gap:** supporting payer ≠ creator needs `Participant.upiId` (a payee address per participant) and a
UI to collect it. It is not smuggled into `CreatorProfile`, because that profile is the *creator's* local
identity, not a participant address book. A future ticket widens the type and the operation together.

## S2 — Exact versus payment, in display and in copy

`allocateSettlement` (§12, ticket 02) is the only conversion. The display rule is a comparison, not a second
rounding: a row differs when `numeratorPaise !== settlementSharePaise * denominator`. The exact formatter is
lossless long division over the rational, at most four fractional digits, with an ellipsis exactly when the
division has not terminated:

- `24635/3` paise → `₹82.1166…` (exact) against `₹82.12` (payment).
- `2500/1` paise → `₹25.00` (exact) against `₹25.00` (payment) — equal, so one value is shown.
- `0` → `₹0.00`, and the row is "nothing to pay".

The intent amount is never called the exact share, in the UI, in code, or in the WhatsApp text. The exact value
travels in the WhatsApp message even when it equals the payment amount, because that text is the participant's
record of what they owed.

## S3 — The intent

```text
upi://pay?pa={payer_upi}&pn={payer_name}&am={share}&cu=INR&tn={note}&tr={ref}
```

- **Encoding** is `encodeURIComponent` plus the four characters it leaves alone that RFC 3986 does not
  (`!'()*`), so a name containing `&`, `"`, `'`, `+` or non-ASCII text cannot split or corrupt a parameter.
- **`am`** is built from integer paise by string arithmetic, never `Number / 100`: `150` → `1.50`, `100` →
  `1.00`, `10000` → `100.00`.
- **`pn`** is clipped to 40 Unicode code points and **`tn`** to 50. §12 said "truncate the note, not the payee
  name"; the ticket's own invariant matrix requires both limits to be enforced and does not offer a refusal
  code for a long payee name. Clipping is therefore the v1 behaviour, recorded as a deviation in S8 rather than
  hidden. The clip is by code point, not UTF-16 unit, so an emoji is not split into a lone surrogate.
- **`tr`**: derived in `lib/hmac-sha256.ts`, a small synchronous HMAC used only for this non-secret reference —
  the share token is the key material, no key is stored in the bundle. Hex is lowercase, so it satisfies
  `[A-Za-z0-9]`. A caller-supplied reference is used only if it already fits `^[A-Za-z0-9]{1,35}$`; otherwise
  the parameter is omitted. An empty participant token omits `tr` as well: a reference derived from nothing is
  not a reference.
- **Note**: the bill title plus `" share"`, then clipped. It is a label, never a receipt fact.

The builder returns an outcome, not a throw: `{ ok: true, url }` or `{ ok: false, code }` with
`creator_name_missing`, `creator_upi_missing`, or `nothing_to_pay`.

## S4 — Zero shares and self-payment

- A participant row is `payer` when `participantId === payerId`; it gets no `upi://` and no WhatsApp link. Its
  copy is "your share is retained — you collect from the others", and its exact share is still shown.
- A non-payer row with `settlementSharePaise === 0` is `nothing_to_pay`: no link, and the row says exactly
  that. A zero *exact* share always allocates zero, so the two conditions agree; the allocation value is the
  one tested because it is the amount a transfer would carry.
- Any positive allocated amount, including 1–99 paise, produces a link. A 50-paise transfer is a real
  transfer; v1 does not hide it behind a "too small" rule the spec never states.

## S5 — WhatsApp

`https://wa.me/?text=<encoded message>`. The message is intentionally plain text and labels its parts:

```text
Hi {name} — your share of "{bill title}".
Exact share: {exactText}
UPI payment amount: {paymentText}
Pay with UPI: {upiUrl}
Bill link (opens on any device): {participantLink}

The creator marks payments as paid by hand. Nothing here verifies a transfer.
```

The **participant link is supplied by the caller**. Ticket 15's UI supplies
`<origin>/share#v1.<token>` — the version prefix and bearer token only. Ticket 16 replaces that fragment with
the encrypted snapshot (ADR-007, `DECISIONS/0025`); until then `/share` receives the fragment and shows its
existing placeholder. This is a named gap (S8), not a claim that ticket 16 shipped. The token is already a
bearer secret (0022 L5), so putting it in the message adds no disclosure the share model does not already make.

Opening WhatsApp is an external action and never part of the local-inference egress claim (§15 rule 6).

## S6 — Manual payment confirmation

`setParticipantPaid` is unchanged: a settlement-metadata write permitted on a locked bill (0022 L7), one
transaction, one revision. Ticket 15 adds presentation, not a second flag:

- the settlement row renders the committed `paid` value and toggles it through the existing operation;
- the UPI link is a function of the immutable locked document, so marking paid cannot change it;
- unlock re-mints tokens and therefore changes `tr`, but not `paid`; a re-lock keeps the flag;
- no string anywhere says "paid", "settled" or "verified" as a result of a UPI intent being opened. Only the
  creator's action sets the flag, and the copy says so.

## S7 — G5: what the primary source actually says

**Primary document read:** NPCI, *UPI Linking Specifications 1.6*, November 2017, §2 ("UPI Deep Linking"
parameter table). Retrieved and text-extracted 2026-11-05 from the NPCI-published PDF via the Internet Archive:

`https://web.archive.org/web/20200921110005if_/https://www.npci.org.in/sites/default/files/UPI%20Linking%20Specs_ver%201.6.pdf`

**Finding:** the table types `pa`, `pn`, `tr`, `tn`, `am` and `cu` as `String` and marks them mandatory or
optional; it describes `tn` as "a short description" and `tr` as "order number, subscription number, Bill ID,
…". It publishes **no character-length numbers** for `pn`, `tn` or `tr`. (It does give digit counts for `mode`,
`orgid`, `mid` and `msid`, which is evidence that the document states limits when it has them.)

**Therefore:** `pn ≤ 40`, `tn ≤ 50`, `tr ≤ 35` are **unverified against the primary specification**. They are
pinned as this project's contract constants, inherited from `PROJECT(1).md` §12 and `docs/business.md` line 137,
and are not represented as NPCI limits. Secondary corroboration checked on the same date:

- `PROJECT(1).md` §12 and §17's open verification item;
- `docs/business.md` line 137 (the UPI contract row);
- NPCI, *UPI Consolidated Circular v1.0*, 18 September 2026 — requires PSPs/apps to adhere to the UPI Deep
  Linking URL Specifications, but still publishes no per-field character limits (retrieved 2026-11-05 from
  `https://www.npci.org.in/uploads/UPI_Consolidated_Circular_f9c023a0ef.pdf`);
- Google Pay for India, in-app payments (Android) parameter table — `pa`, `pn`, `mc`, `tr`, `tn`, `am`, `cu`,
  no lengths.

No numeric limit in this record is invented, and none is attributed to NPCI. If a future primary document
publishes different numbers, only the constants change; the builder and its pins read them from one place.

## S8 — Deviations and gaps, recorded rather than discovered later

1. **`pn` clipping.** §12 says "truncate the note, not the payee name". Ticket 15's invariant matrix requires
   `pn ≤ 40` and provides no long-name refusal code. v1 clips `pn` at 40 code points and records this as the
   deviation. The alternative — refusing the link — would leave a creator with a long display name unable to
   collect without editing their profile, and no pinned code describes that state.
2. **Payer ≠ creator** is not representable: `Participant` has no UPI field. `setPayer` refuses rather than
   silently producing a link that pays the creator for someone else's share.
3. **The WhatsApp participant link is a placeholder fragment** (`#v1.<token>`) until ticket 16's codec lands.
   Ticket 15 does not decode it and does not claim it is the snapshot format. *(Closed 2026-11-05 by S12: the
   fragment is now the encoded snapshot link, and the placeholder is deleted rather than kept as a fallback.)*
4. **The settlement target is the confirmed printed grand total.** If the printed total and the exact shares
   are inconsistent by more than the allocation's one-paise-per-participant slack, `allocateSettlement` refuses
   and the settlement view reports `settlement_total_inconsistent` instead of inventing amounts. Locking does
   not currently require the reconciliation gap to be zero; the view fails visibly rather than misallocating.

## S9 — What this hands to ticket 16

| Ticket 16 gets | It must not do |
|---|---|
| Rows carrying exact text, payment text, `upiUrl`, `whatsappUrl` and `participantLink` | Recompute shares, re-allocate paise, or build a second UPI intent around the codec |
| `deriveTransactionRef(billId, participantId, token)` and the clipping helpers | Treat `tr` as authentication or as a payment proof |
| `buildWhatsAppMessage` with the participant link as an argument | Embed the receipt image or OCR text to make the message "complete" |
| The `paid` flag as committed settlement metadata | Present `paid` as automatic verification |

## S12 — Ticket 16's amendment: the participant link is the encoded fragment

Date of amendment: 2026-11-05 · ticket 16 · requested by `DECISIONS/0026` A11, which carries the reasoning.
This paragraph exists because S8-3 named the placeholder as ticket 16's to close, and closing it changes three
signatures this record pinned — a change to another ticket's pins is a decision, so it is written here, where a
reader of the settlement contract would look for it, rather than only in the record that asked for it.

**`participantLinkFor(origin, fragment)`.** The second parameter was *the participant's token* and the body
built `${base}/share#v1.${token}`. It is now *the encoded fragment* — `encodeSnapshot`'s output, which already
carries its own `v1.` prefix, the nonce and the ciphertext — and the body is `${base}/share#${fragment}`. The
token-only construction is **deleted, not kept as a fallback**: a `#v1.<token>` URL no longer decodes to
anything, and offering one would make an unshared bill look shared. This is 0026 A4's rule read from the other
side — no link is offered rather than a broken one.

**`SettlementContext.shareLinks: Readonly<Record<string, string>>`**, participantId → fragment. It is required
on the context rather than optional so no caller can fall back into the placeholder by accident. A row whose
participant is absent from the record gets `participantLink: null`, and therefore `whatsappUrl: null`, while its
UPI intent is untouched: the intent never depended on the fragment. `buildSettlement(document, profile, {
origin, shareLinks })` gained the matching option, and the settlement row now says `no bill link yet — see
Share links above` instead of going quiet, because the reason lives on the panel that tried to encode.

**The links are generated once, by the bill view, per locked revision** (0026 A7) and passed into both the share
panel and this component, so the budget the creator reads and the link in the message cannot disagree. They are
not persisted: a stored ciphertext of a bill the ledger already holds would be a second copy of the data, and
the export envelope (0023 P4) would carry a bearer secret.

**Two pins in `packages/pwa/tests/settlement/pins.test.ts` moved, and they are named rather than summarized:**

1. *"supplies the version-and-token placeholder link ticket 16 will replace"* became *"builds the participant
   link from the encoded fragment, not from the token alone"*, asserting
   `participantLinkFor("https://example.test", fragmentFor("p1"))` equals
   `https://example.test/share#v1.token-p1.c2VjcmV0bm9uY2U.c2lnbmFsdGFn`.
2. The fixture `context()` now supplies `shareLinks` for every row, so the WhatsApp-text pin
   (`toContain("https://example.test/share#v1.token-p1")`) still passes — its substring is the front of a real
   fragment — and a *third* pin was added for the other half of the amendment: no fragment means no bill link
   and no WhatsApp hand-off, with the UPI intent still present.

`playwright/settlement.spec.ts`'s `toContain("/share#v1.")` needed no edit. A genuine encoded fragment starts
that way, which is the one piece of ticket 15's browser evidence that survives the amendment unchanged — and
that is a fact about the fixture's token shape, not a reason to relax the assertion.

S9's hand-off table stays correct as written: ticket 16 consumed the rows, the ref and the message builder, and
built no second intent around the codec.

## Reporting discipline

No number in this record is a measurement of shipped code. The G5 section is a statement about what a primary
document does *not* say, not a verification badge. Every pin is discharged by
`packages/pwa/tests/settlement/pins.test.ts` (seam) and `playwright/settlement.spec.ts` (browser), which are the
source of truth for behaviour.
