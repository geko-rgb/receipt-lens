# 14: Bills that survive a schema change

**What to build:** Past bills and the creator's payee profile live in one local database that upgrades itself forward through explicit, tested migrations and exports to JSON before any migration that cannot be lossless — so a future schema change can never silently wipe a user's bills.

**Blocked by:** 11 (bill editor transactions)

**Status:** ready-for-agent

**Effort:** ~32 h · **Roadmap:** workstream 3A (tasks 3A.2–3A.4) · **Week:** W12–13 · **Milestone:** M3
**Verify:** migration rig green from every supported prior schema version, including abort/recovery fixtures

- [ ] One named local database with a monotonic schema version and migrations applied inside a transaction, sequentially, from every version the app still claims to support
- [ ] A failed migration aborts and leaves recoverable state; no store is deleted prematurely and no partial migration is left applied
- [ ] Every schema version has a migration test that starts from a real prior-version fixture and asserts the upgraded data
- [ ] A JSON export is produced before any migration that is not provably lossless, and the user is told where it went
- [ ] Past bills and the payee profile round-trip through storage and are listed on return, with empty-state behaviour defined
- [ ] Receipt images remain absent from storage unless the creator opted into retention, and opting out or deleting removes them

## Forwarded from ticket 13 (owner ruling, 2026-11-05)

Ticket 13's `<Units>` roster is unreachable until finalization (`Bill.svelte:331-369` renders it inside the
`{:else}` of `{#if working.items.length === 0}`), so a creator cannot add participants while a bill is still in
`draft`. Consider whether participants should be addable before any item exists — persistence may require it.
Not a bug, a UX decision worth revisiting at 14.
