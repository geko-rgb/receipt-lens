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
