# 17b: Re-derive the footprint on the PWA deployment

**What to build:** `pnpm measure:footprint` runs the built PWA instead of the §9 M1 harness, and
`benchmarks/results/footprint.json` plus the generated README table publish cold/warm/repeat bytes and
latency for the deployment users actually receive — the one that has a service worker. Ticket 17 shipped the
worker and measured the headline warm-visit number separately (`DECISIONS/0027` W14.4); this ticket replaces
the table wholesale so the published "measured footprint" claim is the product's, not the scaffold's.

**Blocked by:** 17 (installable, offline, self-updating)
**Status:** ready-for-agent
**Effort:** ~10 h · **Roadmap:** workstream 3A (task 3A.7 completion) · **Milestone:** M3
**Verify:** `pnpm measure:footprint && pnpm verify:footprint` clean, `git diff --exit-code` on the README
block, and the warm-visit row consistent with `benchmarks/results/warm-bytes.json` to within one re-run.

## Why it exists

`DECISIONS/0012` F1 pinned the published numbers to the harness and said so on the artifact's face
(`deployment.scope: "core runtime + harness wrapper; PWA not built"`). F11's trigger 1 makes that measurement
expire when the PWA exists; tickets 10a and 10 merged, and the owner ruling of 2026-11-05 assigned the
reconciliation to ticket 17 in writing: *"the footprint table must be re-derived from that measurement."*

Ticket 17 ran out of session before the table could move, and took `DECISIONS/0027` W14.3's escape hatch
rather than ship a half-updated table. It measured and published the one number the hatch requires
(`warm-bytes.json`: median **6,527 B** warm, against the harness's **14,848,852 B**), and left the rest here.

## Work items, in the order that makes each checkable

- [ ] **Move the measured deployment.** `measure-footprint.mjs` imports `startServer` from
      `benchmarks/scripts/serve-measure-app.mjs` (already exists — it carries the request log F5 needs) instead
      of `harness/serve.mjs`, and drives `packages/pwa/dist/app`.
- [ ] **Re-key `ROLES`.** `/assets/index-*.js` is the entry, `/assets/ort.wasm.bundle.min-*.js` the runtime
      loader, `/assets/ort-wasm-simd-threaded-*.wasm` the runtime WASM, `/assets/models/*` the models. The
      harness's `/dist/main.js` and `/ort/…` rows go.
- [ ] **Amend F9's fail-loud set for a worker-served warm visit** (`DECISIONS/0027` W15): condition 3's "warm
      revalidates nothing and reads no cache" reads the *origin* log, which the worker now legitimately empties;
      the read-from-cache signal moves to page `transferSize === 0` plus zero origin requests. Conditions 1 and
      4 need the same re-reading.
- [ ] **Delete `NOT_RETAINABLE`** in the same commit that moves the deployment — never before. On the harness it
      is still true; deleting it there trips condition 13 as a false alarm, and keeping it after the move makes
      the drift guard decorative. This is the sequencing W15 and W14.4 both call out.
- [ ] **Close ticket 08's finding honestly:** `findings[]` keeps
      `warm_not_zero_ort_wasm_exceeds_cache_entity_limit` with `resolvedBy: "ticket 17"` and adds
      `warm_visit_served_by_service_worker`, measured rather than asserted (`DECISIONS/0027` W16).
- [ ] **Latency against the real UI.** `window.__receiptLensHarness` does not exist in the PWA and ticket 17
      refused to add a test-only hook to the shipped bundle (W15, following `DECISIONS/0023` S1). Drive the
      capture UI as `capture.spec.ts` does; publish `appReadyMs` from the `load` event and report
      `ocrReadyMs` / `modelLoadMs` as **not separable**, with the reason where F1 put the harness caveat.
- [ ] **Name the thread count in the table.** 1 ORT thread, because `serve-app.mjs` sends no COOP/COEP and
      `resolveThreadCount` returns 1 without `crossOriginIsolated`. The harness rows were 4. Generated from
      `measurement.deployment.threads`, per the checkpoint-1 ruling.
- [ ] **Archive the harness artifact** as `footprint-<date>-<rev>.json` before overwriting, and regenerate the
      README block with `render-footprint-table.mjs --write`.
- [ ] **Reconcile the README table into app shell / models+WASM / total**, the owner directive from ticket 11.
- [ ] `maximumFileSizeToCacheInBytes` must stay absent from the config: ticket 17 hand-rolled the worker and
      replaced the ceiling with the build-time completeness guard (`DECISIONS/0027` W1.1, W1.3 Condition 2).

## Open defect this ticket inherits

A service worker never intercepts its own script's imports, and `serve-app.mjs` answers code assets with
`cache-control: no-store`. So the worker re-fetches its 955 B module chunk on every instantiation — one of the
three line items in the 6,527 B warm visit. The fix is an `ETag` on code assets, which `DECISIONS/0012` F10
shows already revalidates correctly for everything under the entity limit. Decided here rather than in 17
because it changes what a published measurement means, and a header change made to move a number is the thing
F12 warns against.

## Comments

**2026-11-06 — opened by ticket 17 under the recorded escape hatch.** Not a silent deferral: ticket 17's file
cross-references this one, `DECISIONS/0027` W14.4 states exactly what was measured and what was not, and
`benchmarks/results/warm-bytes.json` carries the payoff number so it is not left unproven.
