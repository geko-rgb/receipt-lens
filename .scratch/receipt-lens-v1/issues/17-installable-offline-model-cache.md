# 17: Installable, offline, self-updating

**What to build:** The app installs, reopens and works with no network at all, and when the model set changes on the server it downloads and verifies the new set before switching, keeping the old one usable if verification fails — so an offline device never silently runs against a mismatched or broken model mix.

**Blocked by:** 04 (on-device OCR provider), 10 (capture, review and reprocess)

**Status:** ready-for-agent

**Effort:** ~32 h · **Roadmap:** workstream 3A (tasks 3A.5–3A.7) · **Week:** W12–13 · **Milestone:** M3
**Verify:** Playwright service-worker scenarios green — version bump, hash mismatch, partial download, offline start — cleanup only after verified activation

> **Remedy scoped by ticket 08's measurement.** Warm≠0: the 14.85 MB `ort-wasm-simd-threaded.wasm`
> exceeds Chromium's HTTP cache per-entity limit and re-fetches as `200` on every reload, while 7 of 8
> assets revalidate (`benchmarks/results/footprint.json`, `findings[]`; `DECISIONS/0012` F10/F12).
> **The Cache API is the intended remedy — its storage is not subject to the same per-entity limit.**
> The service worker must precache `ort-wasm-simd-threaded.wasm` and all other assets on install, not
> just the shell.
>
> After 17 lands: re-run `pnpm measure:footprint`, confirm `secondVisitBytesOverTheWire` drops, update
> the README caveat, and **remove the warm exception set in `measure-footprint.mjs`** — it is the drift
> guard, and it is designed to fail once the WASM is served from the Cache API. Re-measurement trigger
> is recorded in `DECISIONS/0012` F11.

- [ ] A service worker precaches the application shell and caches model assets keyed on provider version plus manifest hash
- [ ] A model update downloads fully, verifies against the manifest, and only then runs a smoke inference before activation; the previous cache is retained until that succeeds
- [ ] A failed update leaves the app working on the old set and shows a visible model-update-pending state
- [ ] Superseded caches are removed only after verified activation
- [ ] Installing, going offline, reloading and running a full capture-to-draft flow succeeds without network, verified in a real browser
- [ ] An upgrade from a previously cached model version is exercised end to end, including the pending state and its recovery

## Comments

**2026-11-05 — owner directive from ticket 11: reconcile the footprint table.**

> Reconcile the footprint table. Ticket 08's 21.3 MB / 14.8 MB measured app shell at ticket-10a state
> (34 kB entry). Ticket 11 made core eager in the editor (144.69 kB entry). These are not contradictory —
> the 144.69 kB is a subset of the 21.3 MB cold total — but the README must break out **app shell /
> models+WASM / total**, not cite a single stale number. Ticket 17's service-worker precache definition
> determines the caching story; the footprint table must be re-derived from that measurement.

Why ticket 11 caused it: §6 line 400 makes every bill edit run core `validate()` synchronously, so
`@receipt-lens/core` is a static import of the entry chunk now — the consequence DECISIONS/0017 D4 recorded
in advance ("core itself cannot split out; only what sits behind core's own internal
`await import("onnxruntime-web/wasm")` does"). `playwright/smoke.spec.ts` no longer asserts the runtime's
*chunk name* is absent from the entry source; it asserts the runtime is `isDynamicEntry` in
`.vite/manifest.json`, is **not** in the entry's `imports`, **is** in its `dynamicImports`, and that the
first-paint request walk still fetches no `.wasm`/`onnx`/`ort` asset. That is the claim that has to stay
true when you write the service worker.

Inputs already on disk for the re-derivation: entry `index-*.js` **144.69 kB raw / 48.15 kB gzip**,
`index-*.css` 3.27 kB / 1.06 kB, `ort.wasm.bundle.min-*.js` 74.32 kB / 24.38 kB,
`ort-wasm-simd-threaded*.wasm` 14,848,852 B, models 1,780,590 + 4,462,639 + 34,063 B
(`DECISIONS/0012` F1, `DECISIONS/0017` D1/D4/D5, `pnpm measure:footprint`). DECISIONS/0017 D9.1's
remeasurement trigger is now unambiguously live, and D5's ceiling warning travels with it: `maximumFileSizeToCacheInBytes`
is sized for Tiny, and any tier change re-opens the config.
