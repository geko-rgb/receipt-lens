# 10a: PWA shell and the framework decision (G1)

**What to build:** The gate G1 decision written down and committed — the PWA framework — plus a deployable app shell the later PWA tickets build on, so ticket 10 is not simultaneously choosing a framework and proving the first end-to-end path. One-page note, minimal scaffold, no product logic.

**Blocked by:** 01 (walking skeleton)

**Status:** in progress — checkpoint: gate G1 decided and committed (`DECISIONS/0017`); shell, design note and CI wait for owner approval of the framework

**Effort:** ~8 h · **Roadmap:** workstream 3A (task 3A.1) · **Week:** W12 · **Milestone:** M3
**Verify:** `pnpm --filter pwa build` passes and the shell preview deploys; the decision note is committed

- [x] A one-page decision record commits the framework (roadmap default: Svelte 5 + Vite + TypeScript; React 19 as the documented fallback if ecosystem evidence overrides) — later tickets cite the note instead of re-arguing (gate G1)
- [ ] The shell deploys with routing between placeholder capture, bill, and share views — navigation and layout only, no product behaviour
- [ ] A design note documents the intended IndexedDB schema plan and service-worker precache approach; the implementations themselves land in 14 and 17
- [ ] CI builds the shell on every push alongside the other packages
