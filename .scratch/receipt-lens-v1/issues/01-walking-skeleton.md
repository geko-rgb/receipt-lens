# 01: Walking skeleton — pnpm workspace, CI, and domain docs

**What to build:** A pnpm workspace that installs, typechecks, builds and runs its tests from a clean checkout, holding the three product packages (isomorphic core library, bill-splitting PWA, benchmark harness) with no product behaviour in them yet. Includes the repo under version control and the vocabulary/decision docs every later ticket reads, so the first real slice starts on a working foundation.

**Blocked by:** None (can start immediately)

**Status:** done

**Effort:** ~26 h · **Roadmap:** P0 tasks 0.1–0.8 · **Week:** W1 · **Milestone:** M1 prerequisite
**Verify:** `pnpm install && pnpm -r build && pnpm -r test` green on a fresh clone; typecheck compiles the public API stubs

- [x] Workspace with a core library package, a PWA package and a benchmark package; root scripts install, typecheck, build and test all three, and `pnpm install && pnpm build && pnpm test` succeeds on a fresh clone
- [x] Test runners wired for both environments — Node for pure logic, Playwright for browser workflows — each with one passing smoke test
- [x] Typed public API stubs committed before 03a/04 fan out in parallel: `OcrProvider`, normalized `OcrResult`/`OcrLine`/`OcrWord`, and `ocr()`/`parse()`/`validate()`/`extract()` signatures compile under strict TypeScript — downstream tickets consume this contract and never invent their own shapes (roadmap 0.3)
- [x] CORD v2 and SROIE snapshots acquired and pinned: SHA-256 hashes, licenses and label-coverage notes recorded in a committed manifest — 03a's loaders read the manifest, they do not fetch (roadmap 0.7, gate G4)
- [x] Business doc updated for the normalized unit model (`Item.assigned_to` → `ItemUnit`/`ItemUnitAssignment` per ADR-005 supersession); no stale references remain (roadmap 0.6, gate G7)
- [x] Repository under git with an initial commit; build output, editor artifacts and any locally retained receipt images ignored
- [x] Model-asset storage strategy decided and documented (committed binaries vs. fetched-and-hashed at build), with the det model, rec model and recognition dictionary all accounted for
- [x] `GLOSSARY.md` seeded from the source document's living glossary and ADRs 001–010 seeded from its decision log, marked provisional until the code actually uses the terms
- [x] CI runs install, typecheck, build and the unit tests on every push

## Comments

2026-11-02 — implemented by agent in the working clone at `~/dev/splitt2` (the FAT32 external volume can't host pnpm workspaces; no symlinks). Commits `48e73f3` (baseline) `a7056c0` (skeleton) `+ review fixes`.

**Done and verified:** fresh-clone `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e` — all exit 0 (Chromium smoke included; CI now runs it too). Code review (two-axis) findings addressed: esbuild's postinstall denied via pnpm 12 `allowBuilds` (installs script-free; frozen-lockfile strict-build check satisfied); `ocr()` reverted to a throw-stub — delegating now was ticket 04's work and leaked untyped provider errors past §4's error contract; public barrel no longer exports the PWA-internal `BillCharge`/`ChargeType` (ADR-008/GLOSSARY); model manifest gained §9's provider/version/URL/license fields; `.gitignore` covers editor artifacts.

**CORD v2 (G4): acquired and pinned.** Six parquet files (2.3 GB) downloaded to `benchmarks/datasets/raw/cord-v2/` (git-ignored); every SHA-256 verified byte-exact against the Hugging Face LFS content identifiers recorded in `benchmarks/datasets/dataset-manifest.json`. License CC-BY-4.0, label-coverage note included.

**SROIE (G4): blocked — needs the owner.** Canonical host `cvl.tiensit.com` is unreachable and release requires a signed consent form. A community mirror exists on Hugging Face (`darentang/sroie`) but is NOT pinned: per G4 the canonical snapshot is required and mirror adoption is an owner decision. Manifest records the blocker honestly.

**G7 business doc: not in this repo.** No business document exists here to patch; the supersession is recorded in `docs/adr/0005` + `GLOSSARY.md`, but the external source document still needs its owner.

2026-11-02 (owner follow-up) — both blockers cleared:
- **G7:** owner supplied `business.md`, committed as `docs/business.md` as the business logic reference adopting `ItemUnit`/`ItemUnitAssignment`; recorded in `DECISIONS/0001-source-of-truth.md`. Reviewed against the spec (§5–§13 checked): faithful — golden table, ExactMoney shape, all nine blocker codes, confidence codes and round-off band match; the §9 `pa={creator_upi}` vs non-creator-payer gap is an acknowledged inherited limitation (v1: payer = creator, TODO(spec) note at the UPI builder in ticket 15).
- **SROIE:** owner approved the mirror `jsdnrs/ICDAR2019-SROIE` with provenance caveat (`DECISIONS/0002-sroie-snapshot.md`). Card + LICENSE text + NOTICE verified locally as CC-BY-4.0; primary ICDAR host not used, no primary-source license claim. All six files fetched to `raw/sroie/` (git-ignored); the two parquets and the sample image verified byte-exact against LFS oids; hashes pinned in the manifest. Gate G4 now fully closed.
