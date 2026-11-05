# DECISIONS/0025 — Fragment share links: the v1 codec, budget and fail-closed messages

Date: 2026-11-05 · Ticket 16 (pins only) · **Status: binding for ticket 16's implementation.**

Ticket 15 put a bearer token in the WhatsApp text and named that placeholder as a gap. Ticket 16 replaces it
with the snapshot ADR-007 locks: the bill travels in the URL fragment, compressed, encrypted and authenticated,
small enough to share, and a corrupted or tampered link fails closed instead of rendering half a bill. This
record pins the codec **before** any of it exists; no codec code is written in this ticket, and nothing below is
a measurement.

## P0 — The pins, in one line each

1. **Format is `#v1.<token>.<nonce>.<ciphertextAndTag>`** — exactly four dot-separated components, all
   base64url, no padding. `v1` fixes this whole codec; a different algorithm is `v2`, never a silent change.
2. **Pipeline is compact JSON UTF-8 → DEFLATE → AES-256-GCM → base64url.** DEFLATE is `fflate` bundled into
   the app (an exact release pinned in `pnpm-lock.yaml`), never `CompressionStream`/`DecompressionStream`.
3. **The key is HKDF-SHA-256 of the token bytes**, `info = "receipt-lens-share-v1"` (ASCII), zero-length salt,
   32-byte output. The recipient derives it from the link, so encryption is not confidentiality against the
   link holder.
4. **The whole fragment after `#` is at most 8192 bytes encoded.** Budget usage is shown to the creator as
   bytes and percent. Over budget fails visibly with `link_budget_exceeded`; it never truncates.
5. **The payload is resolved data only** — §10's `BillShareSnapshot`, no receipt image, no raw OCR text, no
   drafts, no unclassified rows, no extraction confidence. Tests prove absence by marker search, not by eye.
6. **Decode validates before rendering** and fails closed with exactly one of
   `unsupported_link_version`, `link_budget_exceeded`, `link_corrupt_or_tampered`, `link_schema_invalid`.
7. **The link is a bearer secret, and the interface says so** with the pinned wording below — not a promise of
   privacy from the recipient.
8. **Staleness is shown, never inferred as freshness.** The snapshot carries `snapshotCreatedAt`; on the
   creator's device it is compared with `WorkingBill.staleLinkCutoffAt`. Where no local bill exists the view
   says when the snapshot was made and that the bill may have changed, and never calls it current.
9. **`computedShares` is a cache.** Exact shares serialize losslessly as `{numeratorPaise, denominator}`
   decimal strings; the recipient recomputes and does not trust the cached shares when they disagree.
10. **The authoring side and the decode side share one codec seam** (`encodeShareLink`/`decodeShareLink`), and
    round-trip, the budget boundary and every malformed-input case are exercised through it.

## P1 — Fragment structure

```text
#v1.<token>.<nonce>.<ciphertextAndTag>
```

| Component | Bytes before encoding | Encoding | Notes |
|---|---|---|---|
| `v1` | 2 ASCII chars | literal | The version prefix is outside the encryption and is the only cleartext discriminator. |
| `token` | UUID string, 36 chars | used verbatim (base64url-safe) | Bearer secret and HKDF input. Reuses ticket 15's `Participant.token`, encoded as UTF-8 for HKDF. See P11 amendment 1: this supersedes the original 32-random-bytes plan. |
| `nonce` | 12 random bytes | base64url, no `=` | Fresh per encryption; never reused with the same key (GCM's hard requirement). |
| `ciphertextAndTag` | variable | base64url, no `=` | WebCrypto AES-GCM appends the 16-byte authentication tag. |

Base64url is `[A-Za-z0-9_-]`. `.` is the only separator and never appears in any component, so a naive split on
`.` is valid; a component count other than four is `link_corrupt_or_tampered` (or
`unsupported_link_version` when the first component is a well-formed but unknown version).

**No padding characters.** `=` is not in the base64url charset and is rejected by the charset check rather than
tolerated, because padding in a fragment is a second encoding to keep consistent across copy/paste.

## P2 — The codec pipeline

1. **Serialize** the snapshot as compact JSON: no whitespace, keys in the declaration order of P4. The
   serializer is deterministic — the same document produces the same bytes — so a round-trip test can assert
   byte equality and so two encodes of one bill produce the same ciphertext length.
2. **Compress** with `fflate`'s DEFLATE, level 9, memory level 9, raw DEFLATE (no zlib/gzip wrapper). The exact
   `fflate` release is added to `packages/pwa` at implementation and pinned in `pnpm-lock.yaml`; the record does
   not guess a version number.
3. **Encrypt** with AES-256-GCM under the HKDF key and the fresh nonce. No additional authenticated data in v1:
   the version is outside the ciphertext, and binding it as AAD would make a `v2` migration harder without
   adding a property this format needs.
4. **Encode** token, nonce and ciphertext-plus-tag as base64url and join with `.` after the `v1` prefix.

`CompressionStream` is forbidden even where present: its output is implementation-defined, and a link that only
decodes in some browsers is not a share format. `fflate` is the self-hosted, bundled implementation ADR-007
requires.

## P3 — Key derivation, exactly

```text
key = HKDF-SHA-256(
  ikm  = UTF-8(token) (36 bytes; ticket 15's UUID string — see P11),
  salt = empty byte string (zero-length; HKDF's default zero salt),
  info = UTF-8("receipt-lens-share-v1"),
  L    = 32
)
```

The context string is pinned so a future purpose (a different payload type) cannot reuse a key by accident. The
salt is zero-length rather than the bill id because the recipient cannot know the bill id before decrypting, and
a salt carried in the clear would be a second cleartext component for no security gain: the token is already
uniformly random.

**What this does not buy.** Anyone with the complete link has the token and can derive the key, decrypt the
snapshot and forge a valid tag. GCM detects corruption and tampering by parties *without* the key — a truncated
fragment, a flipped base64 character, a re-encoded nonce — but it is not an access-control mechanism. The
security claim is integrity and opacity in transit, not confidentiality from the recipient.

## P4 — The snapshot payload

The shape is §10's `BillShareSnapshot`, unmodified:

```ts
interface BillShareSnapshot {
  snapshotVersion: 1;
  snapshotCreatedAt: string;          // ISO, supplied by the caller (no clock inside the codec)
  bill: { id; title; creatorId; payerId; createdAt; grandTotal; taxIncluded; taxIncludedSource };
  participants: Array<{ id; name; tokenExpiresAt }>;
  items: Array<{ id; name; qty; unitPrice; unitAssignments: Array<{ unitIndex; participantIds; confirmedUnassigned }> }>;
  charges: Array<{ type; label; amount; included; rate?; otherSign? }>;
  adjustmentLines: Array<{ reason: "unassigned"; amount; assignedToParticipantId }>;
  computedShares: Array<{ participantId; exactAmount; settlementSharePaise: number | null }>;
}
```

**Included, because it is resolved bill data:** the title, the roster names, resolved items and their unit
assignments, finalized charges with their inclusion decision, the unassigned adjustment lines, the payer and
creator ids, the resolved grand total and its provenance, and the exact shares plus the derived settlement
amounts.

**Excluded, and proved absent by test:**

- the receipt image, in any encoding (`data:image`, byte arrays, `Blob` handles);
- raw OCR output — `OcrResult`, line text, word boxes, confidences — and `parseResult`;
- drafts (`draftItems`, `draftCharges`), `unclassifiedRows`, `excludedRowIds` and `staleLinkCutoffAt`
  (the last is the *creator's* local staleness watermark, not snapshot content);
- extraction confidence values and `parseValidation`;
- the creator's `CreatorProfile` and `upiId` — the snapshot is a bill, not an address book;
- per-participant share tokens. The token in the fragment is the link's own bearer secret; the payload does not
  duplicate every participant's token.

**`paid` is not in §10's snapshot shape**, so v1 does not add it. Ticket 15's pin 8 is conditional for exactly
this reason: the participant view can show paid status only if a future snapshot version adds it. Recorded as a
gap, not silently widened — adding a field is a `snapshotVersion` decision, not an implementation detail.

`computedShares` is serialized because §10 says so, and treated as a cache: the recipient recomputes shares
from the resolved bill and, on disagreement, shows its own recomputation (and may report the mismatch). A
malicious link holder can forge the cache; the cache is not an authority.

## P5 — The 8 KB budget

- The measured length is the **whole fragment after `#`**, encoded: version, three separators, token, nonce,
  ciphertext and tag. The `#` and the page URL are not counted, matching ADR-007's wording.
- **8192 bytes** is the cap. Exactly 8192 is allowed; 8193 is not.
- The creator sees `used / 8192 bytes (n%)` before the link is offered. The number is computed from the actual
  encoded string, not estimated from the uncompressed JSON.
- Over budget is a visible refusal with `link_budget_exceeded`, and the copy names the remedy ADR-007 names:
  shorten or remove non-essential bill labels and try again. **Never truncate** a component, a field or the
  ciphertext: a truncated GCM message is undecryptable and a truncated component is not a smaller valid link.
- The decode side rejects a fragment longer than 8192 bytes with the same `link_budget_exceeded` before doing
  any decompression work.

## P6 — Decode failure codes, and the order they are checked

Exactly one code per failure, checked in this order so the message is stable:

| Order | Check | Code |
|---|---|---|
| 1 | The fragment starts with `#`; strip it. A missing or non-`v1` first component: a well-formed unknown version (`v2`, `v10`) → `unsupported_link_version`; a malformed version token → `link_corrupt_or_tampered`. | `unsupported_link_version` |
| 2 | Encoded length ≤ 8192. | `link_budget_exceeded` |
| 3 | Four components; each base64url **and a length that can encode bytes** (see the amendment below); token decodes to 32 bytes, nonce to 12 bytes, ciphertext to at least 16 tag bytes. | `link_corrupt_or_tampered` |
| 4 | HKDF + AES-GCM decryption and tag verification. | `link_corrupt_or_tampered` |
| 5 | Inflate, refusing output larger than 64 KiB (a decompression bomb is corruption, not a schema problem). | `link_corrupt_or_tampered` |
| 6 | UTF-8 + JSON parse; then schema validation (version, required fields, types, `snapshotVersion === 1`, integer paise, exact-money decimal strings, no unknown top-level fields). | `link_schema_invalid` |

**P6 amendment (2026-11-05, ticket 16 second sprint).** The charset predicate for base64url components is
"charset matches **AND** length ≠ 1 mod 4". Unpadded base64url is constrained to lengths {0, 2, 3} mod 4;
length 1 mod 4 is impossible and would produce a `DOMException` from `atob` outside the decryption try/catch.
The length constraint is part of the charset predicate — malformed input of length 1 mod 4 fails as
`link_corrupt_or_tampered` **at the charset step**, not at the decode step. The 13th codec pin
(`packages/pwa/tests/share/codec.test.ts`) asserts `v1.A.A.A`, `v1.tok.A.AAAA` and
`v1.<36-char-token>.A.AAAA` all produce `link_corrupt_or_tampered`. The finding, the reproduced inputs and the
reason a truncated paste lands exactly in this class are in `DECISIONS/0026` A15.

Rendering starts only after step 6 succeeds. A failure at any step shows the code's user-readable message and
no bill content — never a partially decoded bill. The codes are a closed union; a new failure mode adds a code
deliberately.

`link_budget_exceeded` therefore has two legitimate origins: the authoring side (cannot make a shareable link)
and the decode side (the received fragment is oversized). Both are the same condition — the budget — and the
same remedy.

## P7 — The bearer-secret disclosure, pinned wording

The participant view and the share sheet carry this text (the sentence may be split across elements, but the
words are pinned):

> **This link is the key.** Anyone who has the complete link can read the whole bill and the shares in it. It is
> a bearer secret, not protection from the person you send it to. “Show only my share” is a display default, not
> access control.

Two supporting facts may be shown beside it, and no stronger claim may replace it:

- browsers do not send the fragment in the HTTP request that loads the page, so ordinary server logs do not see
  it;
- the link can still be copied, synced, backed up, or read by anything on the device that can read
  `location.hash`, and it cannot be reliably revoked.

No copy may say "encrypted, so only the recipient can read it", "secure", "private link", or "expires" as a
security property. Client-side expiry is a UX restriction (ADR-007).

## P8 — Stale snapshots

`snapshotCreatedAt` is written by the caller at encode time. Staleness is a comparison, never a guess:

- **On a device that holds the bill** (the creator's, or a participant who also has the bill locally): if
  `snapshotCreatedAt < working.staleLinkCutoffAt` for that bill id, the view shows "This snapshot was taken
  before the bill was unlocked on {date}. The bill has changed since; ask the creator for a new link." It does
  not render the snapshot as current.
- **When two snapshots for the same bill id are opened on one device**, the older `snapshotCreatedAt` is marked
  stale when the newer one has been seen.
- **On a device with no local bill** (the ordinary recipient), freshness cannot be known. The view always says
  "Snapshot created {date}. The bill may have changed since." and never says "current". This is the honest
  version of ADR-007's "where possible" banner.
- A stale snapshot is still decodable and still shows its frozen amounts, because that is what the sender sent;
  only the *status* changes. There is no secure revocation, and the copy never implies one.

`tokenExpiresAt` is a UX hint only. Passing it does not make a link stop working, does not invalidate the key,
and must not be described as expiry in the security sense.

## P9 — The codec seam

Two functions, in one framework-free module (`packages/pwa/src/lib/share/codec.ts` at implementation):

```ts
encodeShareLink(snapshot, { token, now, nonce? }): { ok: true; fragment: string; bytes: number } | { ok: false; code: "link_budget_exceeded" }
decodeShareLink(fragment): { ok: true; snapshot: BillShareSnapshot } | { ok: false; code: DecodeFailureCode }
```

The shipped names are `encodeSnapshot(snapshot, token)`, `decodeSnapshot(fragment, token)` and
`deriveKey(token, billId?)`; `billId` is accepted and ignored (P11 amendment 2). The behavioural contract below
is unchanged.

`now` and `token` are caller-supplied, so the module reads no clock and no random source (0011's determinism
rule) and a test can pin them; the default `crypto.getRandomValues` lives in the caller. `nonce` is an explicit
test seam, never a production parameter.

The test matrix, all through this seam:

- round trip: encode → decode → deep-equal snapshot, for a minimal bill, a multi-participant bill with
  fractional shares, and one at the budget boundary;
- budget: 8192 passes, 8193 fails with `link_budget_exceeded`, and no component is truncated;
- every malformed case in P6 produces its pinned code;
- excluded-content proof: the encoded fragment and the decrypted plaintext contain no receipt-image marker, no
  OCR line text, no draft id and no `upiId` — asserted by marker search over both the ciphertext and the
  plaintext;
- tamper: flipping one base64url character, swapping two components, and re-encoding a nonce all fail
  `link_corrupt_or_tampered`;
- staleness: a snapshot older than `staleLinkCutoffAt` is identified as stale and never as current.

## P10 — What this hands to ticket 17/18

- **Ticket 17 (offline model cache)** gets no dependency on the codec; the fragment path is static and works
  with the service worker absent.
- **Ticket 18 (privacy audit)** gets the egress claim's exact boundary: the fragment is never fetched, WhatsApp
  is a deliberate external action (§15 rule 6), and the snapshot excludes image and OCR text by construction
  and by test.
- **`PROJECT(1).md` is unedited by this record.**

## P11 — Amendments from the 2026-11-05 codec session

These three amendments were made when the codec landed in `packages/pwa/src/lib/share/codec.ts`; where they
conflict with P1–P10 above, the amendment wins.

1. **Token source (2026-11-05 codec session):** the codec uses the participant token from ticket 15's
   `Participant.token` — a UUID string — encoded as UTF-8 bytes for HKDF input. This deviates from ADR-007's
   "128-bit random token, base64url (22 chars)." UUIDv4 provides 122 bits of entropy (close to 128), costs +14
   bytes per link vs. base64url-128 (negligible against the 8 KB budget), and reuses the existing token field
   from the persistence layer. Accepted as a v1 simplification; ADR-007's "22 chars" claim updated to "UUID
   string (36 chars)" with this note. Future migration to base64url-128 would require ticket-16+ token
   regeneration.
2. **HKDF salt:** 0025 originally specified salt = UTF-8(billId) per ADR-007. The codec omits billId from the
   salt because the decoder does not have the bill id before decryption — including it would make decryption
   impossible without an out-of-band bill-id channel. Current derivation: HKDF-SHA256(ikm = UTF-8(token),
   salt = empty, info = "receipt-lens-share-v1", L = 32). The info context string provides domain separation;
   without a per-bill salt, two different bills encrypted with the same token would use the same key, but
   tokens are per-bill-generated so this is not reachable in practice. ADR-007's billId-salt claim updated to
   match.
3. **Budget enforcement:** measured on the full encoded fragment (`v1.<token>.<nonce>.<ciphertextAndTag>`),
   8192 allowed, 8193 refused. Matches ADR-007's "entire fragment after #" language. Encoder refuses
   (`link_budget_exceeded`) rather than truncating.

Also recorded, not one of the three: the codec derives the key without a bill id (see amendment 2), so
`deriveKey` takes an optional `billId` that is ignored; and the token bytes are the UUID's ASCII form, not a
decoded binary token.

## Reporting discipline

Nothing here is a measurement. The 8192-byte cap and the 64 KiB inflate ceiling are contract constants, not
calibrations; if implementation evidence shows a real bill cannot fit, that is a new decision with the measured
sizes, not a quiet change to this record.
