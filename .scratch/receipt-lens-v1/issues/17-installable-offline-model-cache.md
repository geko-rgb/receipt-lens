# 17: Installable, offline, self-updating

**What to build:** The app installs, reopens and works with no network at all, and when the model set changes on the server it downloads and verifies the new set before switching, keeping the old one usable if verification fails — so an offline device never silently runs against a mismatched or broken model mix.

**Blocked by:** 04 (on-device OCR provider), 10 (capture, review and reprocess)

**Status:** mostly-done — worker, offline reload, installability and the warm-visit measurement shipped; the full table re-derivation moved to [17b](17b-footprint-remeasure.md)

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

- [x] A service worker precaches the application shell and caches model assets keyed on provider version plus manifest hash  <!-- shell + runtime WASM precached on install (W2); model assets cached under `receipt-lens-models:<providerVersion>:<manifestHash>` by W5's verified activation, on navigation to `/capture` per the checkpoint-1 ruling — see the 2026-11-06 note on why the model bytes are not precached -->
- [x] A model update downloads fully, verifies against the manifest, and only then runs a smoke inference before activation; the previous cache is retained until that succeeds  <!-- W5's eight steps; `offline-reload.spec.ts` tests 5 and 6 -->
- [x] A failed update leaves the app working on the old set and shows a visible model-update-pending state  <!-- five reason codes, W7; test 6 keeps reading a receipt on the retained set -->
- [x] Superseded caches are removed only after verified activation  <!-- W7.1's two selectors; the pointer cache is never a target -->
- [x] Installing, going offline, reloading and running a full capture-to-draft flow succeeds without network, verified in a real browser  <!-- `offline-reload.spec.ts` tests 2 and 3: origin refuses everything, zero requests answered, OCR still reads the receipt -->
- [x] An upgrade from a previously cached model version is exercised end to end, including the pending state and its recovery  <!-- test 5 bumps and activates; test 6 fails a hash and recovers on the retained set -->

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

**2026-11-06 — checkpoint 3 outcome, and the remedy note's second half.**

The remedy this file scoped is shipped and measured: warm visit on the PWA deployment is **6,527 B median
across 5 independent samples**, against ticket 08's published 14,848,852 B — 2,275x less, and the runtime WASM
is not among the three things a warm visit now costs. `benchmarks/results/warm-bytes.json` is that artifact;
`pnpm measure:warm-bytes` regenerates it, `pnpm verify:warm-bytes` fails on drift.

Two parts of the note above were written against an assumption that did not survive implementation, and are
recorded rather than quietly reinterpreted:

1. **"remove the warm exception set in `measure-footprint.mjs`" — not done, deliberately.** That set guards
   the *harness* measurement, and ticket 17 did not move the measurement (the session ran out first; the
   escape hatch in `DECISIONS/0027` W14.3 was taken and is documented). The harness still has no service
   worker, so the WASM still re-downloads there and the declaration is still true. Deleting it now would trip
   F9 condition 13 as a false alarm, not as the designed signal. It is 17b's job, in the same commit that
   moves the deployment.
2. **"precaches `ort-wasm-simd-threaded.wasm` and all other assets on install"** — the WASM and every shell
   asset are precached ✓; the three model bytes are *not*, because §9 requires them to be hash-verified and
   smoke-tested before anything may read them, and `docs/pwa-design.md` §2.1 draws the same line. They are
   cached on first navigation to `/capture` (owner ruling, W2.1), which also means a `/share` recipient never
   downloads them.

Also amended by the browser: W6's probe bypass cannot be `Request.cache === "reload"` — Chromium propagates a
reload's bypass mode to the reloaded document's own `fetch` calls, so the app's model reads looked like probes.
The bypass is marked by an explicit `x-receipt-lens-probe` header instead, and every URL stays byte-identical.
