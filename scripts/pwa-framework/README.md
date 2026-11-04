# Ticket 10a framework probe (gate G1 evidence)

Throwaway build harness. It is **not** a workspace package: `pnpm install`, `pnpm build` and CI at the
repo root never touch this directory, and nothing here ships. What lives here exists so that every number
in `DECISIONS/0017-pwa-framework.md` is a measurement rather than an opinion (DECISIONS/0008: artifacts
are checked, not claimed).

## What it builds

The same three-view shell (`capture` / `bill` / `share`, nav plus layout, no product behaviour) four ways,
each importing the real `@receipt-lens/core` — `parse()`/`validate()` eagerly, the OCR provider behind a
dynamic import:

| app | stack under test |
|---|---|
| `apps/svelte` | Svelte 5 + svelte-spa-router (hash routing) |
| `apps/svelte-history` | Svelte 5 + svelte-routing (path routing) |
| `apps/react` | React 19 + react-router (hash and path builds, `VARIANT` selects) |
| `apps/vanilla` | no framework: hand-rolled path router, same views and same lazy OCR call |

Per app, `VARIANT` builds `bare-*` (no service worker), `pwa-history` (vite-plugin-pwa at its default file
size limit) and `pwa-big` (limit raised to 20 MiB).

## Re-deriving the numbers

```sh
pnpm build                                    # repo root: core must be built first
cd scripts/pwa-framework
pnpm install --ignore-scripts                 # registry access needed; no package has an install hook
node measure.mjs --browser                    # writes results/framework-evidence.json
node verify-evidence.mjs                      # fails if DECISIONS/0017's published table drifts
```

`measure.mjs` without `--browser` does the build/static half only. The browser phase needs Playwright's
Chromium (`pnpm exec playwright install chromium`) and the git-ignored SROIE sample at
`benchmarks/datasets/raw/sroie/assets/ex.jpg`, served at `/sample.jpg` by `probe-server.mjs`.

## Committed vs ignored

Committed: the app sources, `package.json`, `pnpm-lock.yaml` (exact pins), `measure.mjs`,
`probe-server.mjs`, `verify-evidence.mjs`, and `results/framework-evidence.json`.
Ignored: `node_modules/` (~120 MB) and `apps/*/dist/` (~44 MB each, including the 14.85 MB
`ort-wasm-simd-threaded.wasm` copy the bundler hoists — see DECISIONS/0017 D4).

Byte counts are deterministic for a given lockfile and emitted bundle. The `threads: 4` inference field is
host-dependent (`navigator.hardwareConcurrency`) and is recorded but not asserted; `verify-evidence.mjs`
asserts `crossOriginIsolated`, line/word counts and byte totals instead.
