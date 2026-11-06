# 17c: Put an ETag on code assets, and regenerate both footprint artifacts in the same commit

**What to build:** `scripts/serve-app.mjs` answers code assets with an `ETag` instead of a bare
`cache-control: no-store`, so a service worker's own module import revalidates rather than re-downloads. The
visible effect is that the warm visit stops paying for the worker's 955 B module chunk, and the published
numbers move.

**Blocked by:** 17b (re-derive the footprint on the PWA deployment)
**Blocks:** *potentially* 18 (privacy audit and claims) — this needs an owner's sequencing call, not an
assumption. 17b's merge unblocks 18 against the current honest table. 17c would then move one published number
(a warm visit from 6,527 B to about 5,572 B), and any 18 claim quoting the warm figure would have to be
re-cited. Two coherent options: (a) 18 waits for 17c so its claims are written against the final bytes, or
(b) 18 proceeds now and 17c is a deliberate, recorded regeneration of a table 18 already cites. **The
recommendation is (a) only if 17c lands quickly — it is a small change — otherwise 18's privacy audit is the
gating work and should not wait on 955 bytes.**
**Status:** ready-for-agent
**Effort:** ~2 h · **Roadmap:** workstream 3A · **Milestone:** M3

## Why it exists

Ticket 08 measured a warm visit that moved **14,848,852 B** and `DECISIONS/0012` F12 named the remedy: the
service worker's Cache API, not a header fix — *"Do not attempt header fixes."* Ticket 17 shipped that remedy
and measured the payoff: **6,527 B**, five identical samples, `benchmarks/results/warm-bytes.json`.

Three things still move over the wire on a warm visit, and two of them are structural:

| Path | Bytes | Why it is there |
|---|---:|---|
| `/assets/models/manifest.json` | 2,700 | W5 step 1's version probe, deliberately `cache: "reload"` (W6) — the app asking what the origin serves |
| `/sw.js` | 2,872 | the browser's own byte-check of the worker script on navigation |
| `/assets/cache-names-*.js` | 955 | **the defect.** A service worker never intercepts its own script's imports, and `serve-app.mjs` answers code assets with `no-store`, so the worker re-fetches its module graph on every instantiation |

The first two are the design working as intended. The third is a header. `DECISIONS/0012` F10 already
measured that ETag revalidation works correctly on this browser for everything under the HTTP-cache entity
limit, and this asset is 955 bytes.

`DECISIONS/0027` W17.3 left it here on purpose: *"changing a shipping server's headers to move a published
number is the class of fix F12 warns against; the number gets fixed by fixing the header, in a ticket that
says so."* This is that ticket.

## The condition that makes this ticket different from a one-line change

**The header change and the regeneration of both artifacts land in one commit, or they do not land.**
They are coupled by a cross-check 17b establishes (`DECISIONS/0028` T3):

1. `measure-footprint.mjs` fails its run unless its warm median equals `warm-bytes.json`'s **exactly, ±0**.
   Changing the header moves the number, so a header change without regeneration breaks `measure:footprint`
   on the spot.
2. `verify:footprint` additionally compares the two artifacts, so CI catches the same drift without needing a
   browser.
3. The expected number after the change is **6,527 − 955 = 5,572 B**, and 17c must *measure* that rather than
   publish it: if the browser then caches `/sw.js` too, or the probe cost changes, the artifact says so and
   `DECISIONS/0028` T3 is amended in a record before the number moves.

The one thing 17c must not do is ship the header and leave `warm-bytes.json` and `footprint.json` describing
the pre-change deployment. That is the state 17b exists to leave behind, and a ticket that recreates it in
order to publish a smaller number is the failure ADR-002 was written to end.

## Work items

- [ ] `scripts/serve-app.mjs`: emit a strong `ETag` for code assets. `DECISIONS/0027` W17 governs this file —
      additive, opt-in where it can be, default behaviour byte-identical, and it is the server every e2e spec
      and `scripts/storage-fixtures.mjs` already uses, so read W17 before touching it.
- [ ] Decide, in a record, whether `no-store` is replaced or `no-cache` + `ETag` is used for code assets.
      Ticket 08's harness server used `cache-control: no-cache` + `ETag` and F10 measured that combination
      revalidating correctly — so the precedent exists, but the shipping server's contract is a privacy- and
      correctness-relevant choice, not a performance knob.
- [ ] Re-run `pnpm measure:warm-bytes` and `pnpm measure:footprint` in the **same commit**, and regenerate the
      README table (`pnpm render:footprint`).
- [ ] Update the warm-path declaration lists and the ±0 cross-check target in the same commit:
      `measure-warm-bytes.mjs`'s declared three-item warm set and `DECISIONS/0028` T3/T7.
- [ ] Close the finding `warm_worker_module_chunk_refetched` in `footprint.json` — with the measurement that
      closes it, not with an assertion.
- [ ] Record in `DECISIONS/0028` whether `/sw.js` can be made conditional too. It probably cannot: a worker
      script fetch is the browser's, not the page's, and `no-store` on `/sw.js` may be exactly what keeps
      updates prompt. If it cannot, say so in the record and leave the 2,872 B published.

## Non-goals

- Not a model-tier change, not a COOP/COEP change (`DECISIONS/0028` T9: thread count is its own measurement
  with its own record), and not a change to what the worker precaches.
- Not a re-run of latency on the assumption it is free: the warm latency row moves with the warm byte row, so
  it comes from the same regenerated `measure:footprint` run.

## Comments

**2026-11-06 — opened by ticket 17b at checkpoint 1.** Not a deferral of a hard part: 17b's brief scopes it to
measurement only ("not a change to the PWA, service worker, or model tier"), and a shipping-server header is
a change to what users receive. Separating the shipping change from the measurement change is also what keeps
`DECISIONS/0028` T3's ±0 cross-check meaningful — one variable per ticket, which is the rule
`DECISIONS/0012` F3 is built on.
