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

## Next session starting point (2026-11-05)

- Codec merged and green: `packages/pwa/src/lib/share/codec.ts` — `encodeSnapshot`, `decodeSnapshot`, `deriveKey`. 12/12 pins green.
- Not implemented: snapshot assembly (`BillShareSnapshot` from locked bill per §10), `/share` route (decode fragment on load), stale detection UI, bearer-secret disclosure copy, the WhatsApp link placeholder replacement (currently `#v1.<token>` is placeholder until `/share` route lands).
- Read `DECISIONS/0025` (updated with codec deviations) and this file before starting.
- Next ticket subtask: snapshot assembly pins first (snapshot from locked bill, size budget check, excluded content assertions), then `/share` route, then stale detection, then disclosure.
- Split e2e coverage: `/share` route e2e tests (open a link with the network off, tampered link fails closed, stale banner) land with the route, not with the codec.
