# HANDOFF — session log and next steps (2026-11-02)

## Where everything lives
- **Working repo (authoritative):** `/home/albus/dev/splitt2` — git, `main` = `3319054`, clean tree.
- **GitHub remote (private, origin):** `https://github.com/geko-rgb/receipt-lens`. Branch protection on `main`: PR required, status check `unit` required, force-push/deletion denied, admins included.
- **Correction (2026-11-02, ticket 03a kickoff):** the line above previously read `Recipt-lens` and claimed the remote was private. **That claim was wrong.** The repo was created `2026-11-02T14:04:35Z` and was **public** from creation until it was set to private at `~2026-11-02T16:00Z` during the 03a kickoff — roughly two hours, covering PRs #1–#4 and all of ticket 01/02 content (dataset pins, model hashes; no receipt text was ever committed). Renamed `Recipt-lens` → `receipt-lens` by owner instruction after collision checks came back clear (`@receipt-lens/core`, `receipt-lens` on npm, and `geko-rgb/receipt-lens` all unclaimed; old URL still redirects). No Pages, no forks, so the rename/visibility change had no downstream effect. Recorded here rather than in past commits — history is not rewritten. The leaked fine-grained PAT has since been rotated by the owner.
- **The FAT32 drive folder (`/run/media/albus/C9B4-64FD/splitt2`):* original vault only — `PROJECT(1).md` (spec, source of truth), `ROADMAP.md`, model ONNX originals, agent docs. Never implement here (FAT32: pnpm needs symlinks).
- **Fetched datasets (home repo only, git-ignored):** `benchmarks/datasets/raw/` — CORD v2 (2.3 GB, 6 parquets) + SROIE mirror (487 MB). Re-materializable: hashes pinned in `benchmarks/datasets/dataset-manifest.json`.

## What happened (chronological)
1. Ticket set reviewed vs ROADMAP; 9 fixes applied (03→03a/03b split, 09→09a/09b, new 10a PWA-shell/G1, new 19 M2-decision, Effort/Roadmap/Milestone/Verify fields on all tickets, OCR-contract ownership in 01, dataset pinning in 01, charge-taxonomy ownership in 02, real-receipt criterion in 04, settlement box splits in 02).
2. **Ticket 01 done:** pnpm workspace (core/pwa/benchmarks), strict-TS public API stubs (§4 transcribed; `BillCharge`/`ChargeType` kept OUT of core — PWA-owned), vitest+Playwright runners, CI, git repo, model assets → `assets/models/` with §9-shaped content-hashed manifest (`node scripts/model-manifest.mjs`), esbuild postinstall denied via pnpm-12 `allowBuilds` (script-free frozen installs), CORD pinned + verified.
3. Owner directives (`next.md`): business.md → `docs/business.md` closed G7 (reviewed vs spec: faithful; `pa={creator_upi}` gap acknowledged → TODO at ticket 15's UPI builder); SROIE approved via mirror `jsdnrs/ICDAR2019-SROIE`, 6 files hash-pinned + verified, license CC-BY-4.0 *as declared by the mirror* — primary ICDAR host never used, caveat recorded in `DECISIONS/0002`; storage policy in `docs/storage.md`; standing safety/reporting rules in force.
4. **Ticket 02 done:** `packages/pwa/src/lib/{entities,exact-money,splitting,settlement}.ts` + 27 tests — BigInt reduced rationals; golden ₹664.00 table exact (24635/3, 72710/3, 24635/3, 870, 24870 → 66400); largest-remainder settlement (8212/24237/8211/870/24870); sum-invariance property tests (mulberry32 seed 20261102, no deps); unacknowledged-unit and negative/empty settlement guards (both carry `TODO(ticket 13)`). Two-axis code review run; findings fixed (Final* sources per §10; duplicate charge shape removed from core; tests now typechecked in CI).
5. GitHub setup: PAT permission saga resolved (fine-grained PAT needed Contents+Workflows read/write); PRs #1 (01-closeout), #2 (02 incl. CI-order fix: **build before typecheck** — fresh checkouts need core `dist/index.d.ts` for pwa's `import type`), #3 (tracker status) — all merged; every merge waited for green `unit` CI, protection verified by it actually blocking a queued-check merge.

## CHECKPOINT — ticket 03a in progress (2026-11-02, branch `ticket/03a-benchmark-foundation`)

**Not pushed, no PR yet, and deliberately not push-ready**: the bootstrap test reads the
committed dev fixtures, and the fixtures are **uncommitted** pending an owner ruling on
five PII items (below). Fresh-clone `pnpm test` fails until they land.

Done and committed on the branch (5 commits): decision records 0003–0005 + the
privacy correction here; `pnpm fetch:datasets` with corrected dataset pins (hyparquet
devDep, `allowBuilds: hyparquet: false`); redaction over all ten PII classes; CORD +
SROIE loaders + harness money parsing; fixture serialization, the generation driver, the
results CLI, the PII scan, the scoring/report module, the null-parser bootstrap test,
`fixtures/README.md`, `fixtures/PII-SCAN.md`, CI gates and two new workflows.

Verified locally: `pnpm build` ✓ `pnpm typecheck` ✓ `pnpm test` 110 passing (core 4, pwa
27, benchmarks 79) ✓ `pnpm verify:fixtures` = 715 files byte-identical on regeneration ✓
`pnpm verify:results` ✓ `pnpm scan:pii` idempotence clean ✓ budget 11.9 MB / 50 MB,
largest file 51 KB ✓ disk 57 GB free.

Generated but **uncommitted**: `benchmarks/fixtures/` (717 files: dev = CORD valid 100 +
SROIE train 150, eval = CORD test 100 + SROIE test 361) and `benchmarks/results/dev-null-bootstrap.json`.
Regenerate with `pnpm generate:fixtures` (needs `pnpm fetch:datasets`; raw/ is present
and hash-verified). Redaction volumes: dev/sroie 817, eval/sroie 1913, CORD 5 total.
Bootstrap result: strict 0, every field 0, no NaN, on both datasets.

**Owner decisions blocking the fixture commit** (full detail in `benchmarks/fixtures/PII-SCAN.md`):
unlabeled proprietor names on line 1; business tax registration numbers (GST/SST/ROC);
16 unlabeled local-format phone numbers; 197 unlabeled digit runs (139 PAN-length); and
18 receipts whose company/address annotation could not be located in the token stream, so
some header business/address words survive verbatim. Per DECISIONS/0005 these were
reported, not redacted on initiative.

**Also pending:** whether the byte-identical regeneration gate can live in per-push CI at
all (it needs the 2.7 GB snapshot, which was rejected for CI) — currently it is a
scheduled + manual `fixtures-check.yml`, not a push gate. And: `gh repo rename`/visibility
corrections are done, the repo is now `geko-rgb/receipt-lens`, private, PAT rotated.

**How to resume cold:** read `AGENTS.md`, this file, `DECISIONS/0003`–`0005`,
`benchmarks/fixtures/{README,PII-SCAN}.md`, then `.scratch/receipt-lens-v1/issues/03a-*.md`.
Code lives in `benchmarks/src/{fixtures,datasets,scoring}/*` with one test file per seam:
S1 redact, S2 loaders, S3 serialize/generate, S4 bootstrap. 03b adds the matcher and the
item-level scorers — `report.ts` throws rather than scoring items without it.

## Next: ticket 03a — benchmark foundation (start fresh session, in the home repo)
Read first: `AGENTS.md`, `.scratch/receipt-lens-v1/spec.md` (Testing Decisions), `issues/03a-benchmark-foundation.md`, `benchmarks/datasets/dataset-manifest.json`, `DECISIONS/0002`, `GLOSSARY.md`, `docs/adr/0003`, `docs/storage.md`.
Owner-prioritized first tasks: SROIE loader against the pinned snapshot scoring **grandTotal only** (`total → grandTotal`, no item-level fields exist) and CORD loader (layout-stress bucket, Indonesian labels, excluded fields never null-scored). Both read the manifest — **no runtime fetching**. Null-parser bootstrap (exactly 0, no NaN, CI-enforced), fixture cache keyed snapshot+provider+model-hash, byte-identical reports, machine-readable committed results. Call `/tdd` at the pre-agreed benchmark seams; branch `ticket/03a-…` + PR, never direct-push `main`.
Order after: 03b → 04 → 05 → 06 → 07 → 08 → 09a → 09b → 10a → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19. Blocked-by lines are authoritative; `Week:`/`Milestone:` labels are planning hints (several wrong, e.g. 02 was M1/week-2 despite W17/M3).

## Open items / owner decisions pending
- Rename repo `Recipt-lens` → `receipt-lens` (`gh repo rename`) or keep.
- Rotate the fine-grained PAT (its first ~26 chars leaked into a session transcript; value still live).
- Ticket 13: map `otherSign:"unknown"` charges + `hasNegativeShare` + unacknowledged-unit throw to real `LockBlockerCode`s (no §13 code exists for unknown-sign today — do not invent silently).
- Ticket 15: `// TODO(spec): payer≠creator payee gap` at the UPI builder (DECISIONS/0001); G5 NPCI limits verification.
- ROADMAP 3D.3 typo: "P5 24870/10" — spec §11 says 24870 paise; spec wins, roadmap untouched.

## Standing rules (from owner next.md — still in force)
Branches+PRs only; no force-push/history rewrite without approval; no `--no-verify`/`.skip`/`test.only`; CI wrong → fix CI in its own explained commit; no PROJECT(1).md edits; no new runtime network calls (deps checked for telemetry/CDN/auto-update); runtime assets fully self-hosted; fixtures PII-clean; postinstalls reviewed before allowing; nothing >1 MB committed (models = approved exception); ≥5 GB free or stop; no destructive shell outside the repo; six-section ≤1-page report per ticket incl. disk delta; if ambiguous, stop and ask — silence is not approval.
