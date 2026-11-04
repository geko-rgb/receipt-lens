# 09a: Offline inference proven

**What to build:** The browser proof behind milestone one's headline claim: once assets are cached, receipt inference runs with all outbound network blocked, every attempted request is recorded, and anything unexpected fails the job — plus a minimal harness page that stands alone, independent of the PWA.

**Blocked by:** 04 (on-device OCR provider)

**Status:** ready-for-agent

**Effort:** ~14 h · **Roadmap:** workstream 1F (tasks 1F.1–1F.3) · **Week:** W9 · **Milestone:** M1
**Verify:** `pnpm exec playwright test offline` passes with context-level egress blocked and fails when an unexpected request is injected; `privacy.yml` red on any violation

> **Warm≠0 finding from ticket 08 (must shape this test).** Chromium's HTTP cache cannot hold the
> 14.85 MB ONNX Runtime WASM (per-entity limit ~6–8 MiB; see `DECISIONS/0012` F10/F12 and
> `benchmarks/results/footprint.json` `findings[]`), so it re-fetches in full on every reload. 09a's
> offline run must use the load-then-block approach: **load once with network, wait for sessions
> ready, block network at the context level, then run inference without reloading.** The WASM is
> already in memory, so inference succeeds — that is exactly §9 M1's "block network during
> processing" wording. **Do not use `page.reload()` with network blocked: the WASM will fail to
> reload and the test will fail for the wrong reason.** Offline *reload* is ticket 17's Cache API
> to solve; 09a does not need to prove that claim.

- [ ] A minimal harness page exercises the full core pipeline (load → infer) standalone, independent of the PWA
- [ ] A Playwright run precaches the assets, blocks outbound requests at the context level, performs inference on a real receipt image, and succeeds
- [ ] Attempted requests during that run are recorded and any unexpected egress fails the job
- [ ] Static first-party scanning supplements the runtime check and is labelled as a supplement, not a proof
- [ ] The privacy workflow is wired so a violation turns the pipeline red on the PR
