# ADR-007: URL-fragment snapshot sharing

Status: **locked** (DQ-01 = A; seeded from `PROJECT(1).md` §14; exercised by ticket 16).

v1 has no bill-data backend or peer-to-peer hosting. Share a compact resolved bill snapshot in the URL fragment (never query parameters). Raw receipt image and OCR text are never included.

Fragment format: `#v1.<token>.<nonce>.<ciphertextAndTag>`.

**Token source (2026-11-05 codec session):** the codec uses the participant token from ticket 15's `Participant.token` — a UUID string — encoded as UTF-8 bytes for HKDF input. This deviates from this ADR's earlier "128-bit random token, base64url (22 chars)" wording: UUIDv4 provides 122 bits of entropy (close to 128), costs +14 bytes per link vs. base64url-128 (negligible against the 8 KB budget), and reuses the existing token field from the persistence layer. Accepted as a v1 simplification; the "22 chars" claim is updated to "UUID string (36 chars)" with this note. Future migration to base64url-128 would require ticket-16+ token regeneration. The HKDF salt is empty rather than the bill id, because the decoder has no bill id before decryption (context string `receipt-lens-share-v1` still separates domains); see `DECISIONS/0025` P11. Codec: compact JSON → DEFLATE (self-hosted `fflate`, release pinned in `pnpm-lock.yaml`; no `CompressionStream` dependency) → AES-256-GCM → base64url. Nonce freshly random per encryption. Whole fragment ≤ 8 KB including version and separators; budget usage shown; never silently truncate — trim nonessential labels with consent or refuse.

Validation before render: version, component count/size/charset, authentication tag, decompressed size limit, snapshot schema; malformed input fails closed with a readable error.

Security disclosure: key is derived (HKDF, context `receipt-lens-share-v1`) from token material carried in the same link — anyone with the full link can decrypt the whole snapshot. GCM detects corruption by keyless parties but a link-holder can re-forge valid tags. The complete link is a bearer secret; "only my share" is a view default, not access control. Fragments stay out of server logs but not browser history/clipboard/sync. Client-only expiry is UX, not secure expiry; no reliable revocation; unlock+edit requires regenerating links, old ones become stale snapshots behind a dated banner. A future backend may reuse the snapshot data model — outside v1.
