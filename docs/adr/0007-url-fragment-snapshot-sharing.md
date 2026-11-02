# ADR-007: URL-fragment snapshot sharing

Status: **locked** (DQ-01 = A; seeded from `PROJECT(1).md` §14; exercised by ticket 16).

v1 has no bill-data backend or peer-to-peer hosting. Share a compact resolved bill snapshot in the URL fragment (never query parameters). Raw receipt image and OCR text are never included.

Fragment format: `#v1.<token>.<nonce>.<ciphertextAndTag>`. Codec: compact JSON → DEFLATE (self-hosted `fflate`, release pinned in `pnpm-lock.yaml`; no `CompressionStream` dependency) → AES-256-GCM → base64url. Nonce freshly random per encryption. Whole fragment ≤ 8 KB including version and separators; budget usage shown; never silently truncate — trim nonessential labels with consent or refuse.

Validation before render: version, component count/size/charset, authentication tag, decompressed size limit, snapshot schema; malformed input fails closed with a readable error.

Security disclosure: key is derived (HKDF, context `receipt-lens-share-v1`) from token material carried in the same link — anyone with the full link can decrypt the whole snapshot. GCM detects corruption by keyless parties but a link-holder can re-forge valid tags. The complete link is a bearer secret; "only my share" is a view default, not access control. Fragments stay out of server logs but not browser history/clipboard/sync. Client-only expiry is UX, not secure expiry; no reliable revocation; unlock+edit requires regenerating links, old ones become stale snapshots behind a dated banner. A future backend may reuse the snapshot data model — outside v1.
