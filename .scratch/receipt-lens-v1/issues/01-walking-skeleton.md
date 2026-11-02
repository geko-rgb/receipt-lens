# 01: Walking skeleton — pnpm workspace, CI, and domain docs

**What to build:** A pnpm workspace that installs, typechecks, builds and runs its tests from a clean checkout, holding the three product packages (isomorphic core library, bill-splitting PWA, benchmark harness) with no product behaviour in them yet. Includes the repo under version control and the vocabulary/decision docs every later ticket reads, so the first real slice starts on a working foundation.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Effort:** ~26 h · **Roadmap:** P0 tasks 0.1–0.8 · **Week:** W1 · **Milestone:** M1 prerequisite
**Verify:** `pnpm install && pnpm -r build && pnpm -r test` green on a fresh clone; typecheck compiles the public API stubs

- [ ] Workspace with a core library package, a PWA package and a benchmark package; root scripts install, typecheck, build and test all three, and `pnpm install && pnpm build && pnpm test` succeeds on a fresh clone
- [ ] Test runners wired for both environments — Node for pure logic, Playwright for browser workflows — each with one passing smoke test
- [ ] Typed public API stubs committed before 03a/04 fan out in parallel: `OcrProvider`, normalized `OcrResult`/`OcrLine`/`OcrWord`, and `ocr()`/`parse()`/`validate()`/`extract()` signatures compile under strict TypeScript — downstream tickets consume this contract and never invent their own shapes (roadmap 0.3)
- [ ] CORD v2 and SROIE snapshots acquired and pinned: SHA-256 hashes, licenses and label-coverage notes recorded in a committed manifest — 03a's loaders read the manifest, they do not fetch (roadmap 0.7, gate G4)
- [ ] Business doc updated for the normalized unit model (`Item.assigned_to` → `ItemUnit`/`ItemUnitAssignment` per ADR-005 supersession); no stale references remain (roadmap 0.6, gate G7)
- [ ] Repository under git with an initial commit; build output, editor artifacts and any locally retained receipt images ignored
- [ ] Model-asset storage strategy decided and documented (committed binaries vs. fetched-and-hashed at build), with the det model, rec model and recognition dictionary all accounted for
- [ ] `GLOSSARY.md` seeded from the source document's living glossary and ADRs 001–010 seeded from its decision log, marked provisional until the code actually uses the terms
- [ ] CI runs install, typecheck, build and the unit tests on every push
