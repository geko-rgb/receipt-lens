# 17c: Put an ETag on code assets, and regenerate both footprint artifacts in the same commit

**What to build:** `scripts/serve-app.mjs` answers code assets with an `ETag` instead of a bare
`cache-control: no-store`, so a service worker's own module import revalidates rather than re-downloads. The
visible effect is that the warm visit stops paying for the worker's 955 B module chunk, and the published
numbers move.

**Blocked by:** 17b (re-derive the footprint on the PWA deployment)
**Blocks:** **18** (privacy audit and claims) — ruled at checkpoint 1, 2026-11-06. The earlier "potentially"
hinged on 17c moving one number by ~955 B; the measured range is wider than that (6,527 / 5,572 / 2,700 B, and
6,527 is a live possibility if the worker's `cache: "reload"` precache means no HTTP-cached copy exists to
revalidate). Any of those changes what the README must cite, so 18's per-claim evidence is written against the
post-17c table. 45 minutes of 17c is cheap; README drift is expensive.
**Status:** resolved — merged pending review; see Comments
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
3. **The expected number is not 5,572 B, and the arithmetic here was wrong.** It read
   `6,527 − 955 + ~200 B of 304 headers`. `DECISIONS/0012` F7 excludes header bytes from every total and both
   drivers sum `bodyBytes` at the origin, so a `304` costs **0 B** — the outcomes are discrete:
   **6,527 B** (neither revalidates: the worker's `cache: "reload"` precache never populates the HTTP cache, so
   no `If-None-Match` is ever sent), **5,572 B** (module chunk revalidates, `/sw.js` still downloads), or
   **2,700 B** (both revalidate, leaving only W6's manifest probe). 17c measures which one it is and publishes
   that, amending `DECISIONS/0028` T3 in the same commit if the answer differs from the ticket file's
   prediction. See `DECISIONS/0029` P4.

The one thing 17c must not do is ship the header and leave `warm-bytes.json` and `footprint.json` describing
the pre-change deployment. That is the state 17b exists to leave behind, and a ticket that recreates it in
order to publish a smaller number is the failure ADR-002 was written to end.

## Work items

- [x] `scripts/serve-app.mjs`: emit a strong `ETag` for code assets. `DECISIONS/0027` W17 governs this file —
      additive, opt-in where it can be, default behaviour byte-identical, and it is the server every e2e spec
      and `scripts/storage-fixtures.mjs` already uses, so read W17 before touching it.
- [x] Decide, in a record, whether `no-store` is replaced or `no-cache` + `ETag` is used for code assets.
      Ticket 08's harness server used `cache-control: no-cache` + `ETag` and F10 measured that combination
      revalidating correctly — so the precedent exists, but the shipping server's contract is a privacy- and
      correctness-relevant choice, not a performance knob.
- [x] Re-run `pnpm measure:warm-bytes` and `pnpm measure:footprint` in the **same commit**, and regenerate the
      README table (`pnpm render:footprint`).
- [x] Update the warm-path declaration lists and the ±0 cross-check target in the same commit:
      `measure-warm-bytes.mjs`'s declared three-item warm set and `DECISIONS/0028` T3/T7.
- [x] Close the finding `warm_worker_module_chunk_refetched` in `footprint.json` — with the measurement that
      closes it, not with an assertion.
- [x] Record whether `/sw.js` can be made conditional too (`DECISIONS/0029` P6's new finding; the ticket file's guess was wrong and the run says so). It probably cannot: a worker
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

**2026-11-06 — checkpoint 1 rulings folded in.** Blocker A (the unwired harness baseline in
`measure-warm-bytes.mjs`) lands in this ticket's commit 1, not a separate ticket. The null-result branch is
pre-authorized with its mechanism named (`DECISIONS/0029` P5). `no-cache` is restricted to code and metadata;
`/assets/models/*.onnx`, `/assets/models/*.txt` and `/assets/ort-wasm-simd-threaded-*.wasm` keep `no-store`, so
this ticket never doubles a 21 MB binary footprint to optimize 955 bytes. `17e` now exists as the owner of the
duplicate-fetch/copy-bypass mechanism whether or not 17c's number moves.

## Comments

**2026-11-06 — closed by ticket 17c, and the prediction in this file was wrong in both directions.**

The expected saving was `6,527 − 955 = 5,572 B`. Two errors: the arithmetic added `304` header bytes to a total
from which `DECISIONS/0012` F7 excludes headers, and the ticket's own prediction that `/sw.js` *"probably
cannot"* be made conditional is contradicted by the run. What was measured, on `2782934` with a clean tree:

- warm visit **2,700 B**, not 5,572 — a **5499.6×** reduction against ticket 08's
  14,848,852 B, and both drivers agree at ±0;
- `/assets/cache-names-BCswqTtv.js, /sw.js` both **revalidate to `304` with no body**. The worker script byte-check does send
  `If-None-Match`, which is recorded as a finding rather than a footnote
  (`sw_js_byte_check_conditional`);
- `/assets/models/manifest.json` is the only warm body left, and it is W6's deliberate `cache: "reload"` version probe
  — 2,700 B, the cost of asking what the origin serves, which is by design;
- cold moved too, by **−955 B** (21,718,277 B): a cold visit fetches the worker's module chunk twice and the second
  fetch now revalidates. `DECISIONS/0029` P4 pinned cold at ±0 and the record carries the falsification with
  the mechanism, because a number that moved without a sentence attached to it is how folklore starts;
- `warm_worker_module_chunk_refetched` closes with `resolvedBy: "ticket 17c"` against this measurement, and
  `warm_visit_served_by_service_worker` gained a `history` entry preserving the superseded 6,527 B rather than
  editing it away.

Latency needs an honest caveat rather than a clean bill of health. The committed 17c run's
unthrottled cold median is 1,257 ms against 17b's 1,206 ms, and the two runs' *within-run ranges do not overlap*
(1,186.7–1,226.1 vs 1,228.6–1,310.0), which is the trigger `DECISIONS/0029` P8 set for stopping. What the
same-code evidence says: the identical 17c code measured **1,213 ms** in the earlier pass on this branch and
**1,257 ms** in the committed one, and the committed run's five samples drift monotonically
(1,228.6 → 1,310.0). The candidate mechanism from the header change is one extra conditional round trip over
loopback, which is microseconds, not 51 ms. So the shift is reported as **not attributable to 17c** and
**not smoothed over**: it is published as measured, with the variance evidence in
`DECISIONS/0029`'s checkpoint-3 findings, and every other cell (warm unthrottled 624 ms against 619, warm 4×
2,375 against 2,309, cold 4× 3,818 against 3,671) overlaps its 17b range.

Two things this ticket found that were not in its scope and are recorded rather than fixed here:
`assertColdSample` rejected any `304` in the cold window instead of a first-use one (17b's implementation of F9
condition 1, tighter than the condition it claims), and `verify:warm-bytes` had no CI gate at all, so T7's
both-artifacts condition was enforced only by the author remembering it.
