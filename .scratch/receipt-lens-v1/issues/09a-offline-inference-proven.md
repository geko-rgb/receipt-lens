# 09a: Offline inference proven

**What to build:** The browser proof behind milestone one's headline claim: once assets are cached, receipt inference runs with all outbound network blocked, every attempted request is recorded, and anything unexpected fails the job — plus a minimal harness page that stands alone, independent of the PWA.

**Blocked by:** 04 (on-device OCR provider)

**Status:** ready-for-agent

**Effort:** ~14 h · **Roadmap:** workstream 1F (tasks 1F.1–1F.3) · **Week:** W9 · **Milestone:** M1
**Verify:** `pnpm exec playwright test offline` passes with context-level egress blocked and fails when an unexpected request is injected; `privacy.yml` red on any violation

- [ ] A minimal harness page exercises the full core pipeline (load → infer) standalone, independent of the PWA
- [ ] A Playwright run precaches the assets, blocks outbound requests at the context level, performs inference on a real receipt image, and succeeds
- [ ] Attempted requests during that run are recorded and any unexpected egress fails the job
- [ ] Static first-party scanning supplements the runtime check and is labelled as a supplement, not a proof
- [ ] The privacy workflow is wired so a violation turns the pipeline red on the PR
