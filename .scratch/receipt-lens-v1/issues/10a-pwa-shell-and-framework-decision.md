# 10a: PWA shell and the framework decision (G1)

**What to build:** The gate G1 decision written down and committed — the PWA framework — plus a deployable app shell the later PWA tickets build on, so ticket 10 is not simultaneously choosing a framework and proving the first end-to-end path. One-page note, minimal scaffold, no product logic.

**Blocked by:** 01 (walking skeleton)

**Status:** done — gate G1 committed and owner-approved (Svelte 5 + Vite + in-house path router); shell, design note and CI landed on the approved decision

**Effort:** ~8 h · **Roadmap:** workstream 3A (task 3A.1) · **Week:** W12 · **Milestone:** M3
**Verify:** `pnpm --filter pwa build` passes and the shell preview deploys; the decision note is committed

- [x] A one-page decision record commits the framework (roadmap default: Svelte 5 + Vite + TypeScript; React 19 as the documented fallback if ecosystem evidence overrides) — later tickets cite the note instead of re-arguing (gate G1)
- [x] The shell deploys with routing between placeholder capture, bill, and share views — navigation and layout only, no product behaviour
      (`packages/pwa`, served by `vite dev`/`vite preview`; no hosting step exists yet — the deployable artifact is
      `packages/pwa/dist/app`, and `playwright/shell.spec.ts` proves it over a real server)
- [x] A design note documents the intended IndexedDB schema plan and service-worker precache approach; the implementations themselves land in 14 and 17 (`docs/pwa-design.md`)
- [x] CI builds the shell on every push alongside the other packages (`pnpm -r build` now runs `tsc -p . && vite build` for `@receipt-lens/pwa`; `playwright/smoke.spec.ts` asserts the built shell's shape)
