# 16: Share a bill with no backend

**What to build:** A locked bill becomes a link that opens on any device with no login and no server: the snapshot travels in the URL fragment, compressed, encrypted and authenticated, small enough to stay shareable, and a corrupted or tampered link fails closed with a readable message instead of rendering half a bill.

**Blocked by:** 13 (lock checklist and lifecycle)

**Status:** ready-for-agent

**Effort:** ~46 h · **Roadmap:** workstream 3E (tasks 3E.1–3E.7) · **Week:** W17–18 · **Milestone:** M3
**Verify:** codec seam suite green — round-trip, 8 KB budget boundary, every malformed-input fail-closed case, excluded-content proof

- [ ] The fragment carries a version prefix, token, nonce and ciphertext-with-tag; the payload is compact JSON, compressed with a pinned bundled compressor, encrypted with AES-256-GCM and base64url-encoded
- [ ] The whole fragment is held to the 8 KB budget, budget usage is surfaced to the creator, and exceeding it fails visibly — never truncates
- [ ] The key is derived from the link token, and the interface states plainly that the link is a bearer secret rather than protection against the recipient
- [ ] Decoding validates version, component count, charset, authentication tag, decompressed size and schema, failing closed with a specific message for each
- [ ] The snapshot contains only resolved bill data — never the receipt image, never raw OCR text — and a test proves both are absent
- [ ] The participant view renders a locked bill from a link with no network access, and states that showing one person their share is a view default, not access control
- [ ] Opening a link for a stale snapshot identifies it as stale rather than presenting it as current
- [ ] Round-trip, budget-boundary and malformed-input behaviour is exercised through the codec seam
