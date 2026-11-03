# HANDOFF — session log and next steps (2026-11-02)

## Where everything lives
- **Working repo (authoritative):** `/home/albus/dev/splitt2` — git, `main` = `44678e7` (PR #5,
  ticket 03a merged), clean tree. Fetch before reading `origin/main`: a stale local ref made a
  fresh session think 03a was unmerged.
- **GitHub remote (private, origin):** `https://github.com/geko-rgb/receipt-lens`. Branch
  protection on `main`: PR required, status check `unit` required, force-push/deletion denied,
  admins included. **The repo is `receipt-lens`, not `Recipt-lens`** — see the correction below;
  session briefs that still say `Recipt-lens` are stale.
- **Correction (2026-11-02, ticket 03a kickoff):** the line above previously read `Recipt-lens` and claimed the remote was private. **That claim was wrong.** The repo was created `2026-11-02T14:04:35Z` and was **public** from creation until it was set to private at `~2026-11-02T16:00Z` during the 03a kickoff — roughly two hours, covering PRs #1–#4 and all of ticket 01/02 content (dataset pins, model hashes; no receipt text was ever committed). Renamed `Recipt-lens` → `receipt-lens` by owner instruction after collision checks came back clear (`@receipt-lens/core`, `receipt-lens` on npm, and `geko-rgb/receipt-lens` all unclaimed; old URL still redirects). No Pages, no forks, so the rename/visibility change had no downstream effect. Recorded here rather than in past commits — history is not rewritten. The leaked fine-grained PAT has since been rotated by the owner.
- **The FAT32 drive folder (`/run/media/albus/C9B4-64FD/splitt2`):* original vault only — `PROJECT(1).md` (spec, source of truth), `ROADMAP.md`, model ONNX originals, agent docs. Never implement here (FAT32: pnpm needs symlinks).
- **Fetched datasets (home repo only, git-ignored):** `benchmarks/datasets/raw/` — CORD v2 (2.3 GB, 6 parquets) + SROIE mirror (487 MB). Re-materializable: hashes pinned in `benchmarks/datasets/dataset-manifest.json`.

## What happened (chronological)
1. Ticket set reviewed vs ROADMAP; 9 fixes applied (03→03a/03b split, 09→09a/09b, new 10a PWA-shell/G1, new 19 M2-decision, Effort/Roadmap/Milestone/Verify fields on all tickets, OCR-contract ownership in 01, dataset pinning in 01, charge-taxonomy ownership in 02, real-receipt criterion in 04, settlement box splits in 02).
2. **Ticket 01 done:** pnpm workspace (core/pwa/benchmarks), strict-TS public API stubs (§4 transcribed; `BillCharge`/`ChargeType` kept OUT of core — PWA-owned), vitest+Playwright runners, CI, git repo, model assets → `assets/models/` with §9-shaped content-hashed manifest (`node scripts/model-manifest.mjs`), esbuild postinstall denied via pnpm-12 `allowBuilds` (script-free frozen installs), CORD pinned + verified.
3. Owner directives (`next.md`): business.md → `docs/business.md` closed G7 (reviewed vs spec: faithful; `pa={creator_upi}` gap acknowledged → TODO at ticket 15's UPI builder); SROIE approved via mirror `jsdnrs/ICDAR2019-SROIE`, 6 files hash-pinned + verified, license CC-BY-4.0 *as declared by the mirror* — primary ICDAR host never used, caveat recorded in `DECISIONS/0002`; storage policy in `docs/storage.md`; standing safety/reporting rules in force.
4. **Ticket 02 done:** `packages/pwa/src/lib/{entities,exact-money,splitting,settlement}.ts` + 27 tests — BigInt reduced rationals; golden ₹664.00 table exact (24635/3, 72710/3, 24635/3, 870, 24870 → 66400); largest-remainder settlement (8212/24237/8211/870/24870); sum-invariance property tests (mulberry32 seed 20261102, no deps); unacknowledged-unit and negative/empty settlement guards (both carry `TODO(ticket 13)`). Two-axis code review run; findings fixed (Final* sources per §10; duplicate charge shape removed from core; tests now typechecked in CI).
5. GitHub setup: PAT permission saga resolved (fine-grained PAT needed Contents+Workflows read/write); PRs #1 (01-closeout), #2 (02 incl. CI-order fix: **build before typecheck** — fresh checkouts need core `dist/index.d.ts` for pwa's `import type`), #3 (tracker status) — all merged; every merge waited for green `unit` CI, protection verified by it actually blocking a queued-check merge.

## CHECKPOINT — ticket 03b in progress (2026-11-03, branch `ticket/03b-item-matching-and-scorers`)

**What landed:** deterministic item matching, the field-level scorers, the two-tier report,
`benchmarks/src/benchmark.config.ts` (gate G8t) and the committed τ-sweep. 184 tests pass
(core 4, pwa 27, benchmarks 153). `pnpm verify:results` is byte-identical, `pnpm verify:fixtures`
still regenerates 717 fixtures exactly, `pnpm scan:pii` idempotence clean, budget 12.0 MB / 50 MB.

- **DECISIONS/0006** — name similarity is **normalized Levenshtein**, `τ_name = 0.70`. The
  brief's prior (Jaro-Winkler as the alternative) was tested and rejected on the dev money-equal
  surface: JW admits 3 of 16 false candidates at τ=0.70, Levenshtein 0.
- **Owner rulings this ticket** (see DECISIONS/0006 "What this record does not decide"): money
  compatibility is **Option A** — a gold cell the dataset did not annotate never blocks pairing
  and is *excluded* from that field (neither hit nor miss); a gold value with no prediction is a
  recall miss. `dev/cord-v2` gold has no `unitPrice` on 205 of 254 items, so this is the normal
  case, not an edge case.
- **Convention added, flag for review:** macro averaging skips a *labeled* field whose cells are
  all excluded in the sample (no denominator ⇒ its 0/0 ratios are a convention, not a
  measurement). Dataset-level exclusions were already never scored. No published number changes
  today — every CORD/SROIE labeled field has real cells.
- **The sweep is the evidence**, not a claim: `matching/sweep.ts` + `sweep.test.ts` assert zero
  false candidates across τ 0.60–0.85, the Jamur Enoki/Kuping pair at 0.500 / 0.891, the surface
  sizes (16 / 406 / 60) and the exhaustive variant counts. Runs in per-push CI, needs no raw data.
- **Bootstrap unchanged and still exact:** every metric 0 on both dev splits, no NaN.
  `dev-null-bootstrap.json` was regenerated (schema 1.1: adds `protocol`, `macro`, `items`,
  `excludedCells`/`goldCells`, `license`, provider + version).

**Not pushed.** No PR yet. Owner decisions still open from 03a's second ruling are unchanged
(`benchmarks/fixtures/PII-SCAN.md` advisories; the 51 `long-digit-run` advisory hits are
reported, not redacted).

**How to resume cold:** read `AGENTS.md`, this file, `DECISIONS/0003`–`0006`, then
`.scratch/receipt-lens-v1/issues/03b-item-matching-and-scorers.md`. Code: `benchmarks/src/`
`benchmark.config.ts`, `matching/{similarity,matcher,sweep}.ts`, `scoring/{itemScores,report}.ts`,
one test file per seam (S5 matching, S6 field scorers, plus `scoring/resultsSchema.test.ts`).
Housekeeping: **03a's ticket file is still `Status: ready-for-agent` with unticked boxes** even
though PR #5 merged — its state was never written back.

## CHECKPOINT — ticket 03a (merged 2026-11-02 via PR #5, `44678e7`)

**Was** not push-ready while the fixture commit waited on the owner's PII ruling; that ruling
landed the same day (DECISIONS/0005 second ruling) and the fixtures + results are now committed
and CI-gated.

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

**How it was resumed cold at the time:** `AGENTS.md`, this file, `DECISIONS/0003`–`0005`,
`benchmarks/fixtures/{README,PII-SCAN}.md`, then `.scratch/receipt-lens-v1/issues/03a-*.md`.
Code lived in `benchmarks/src/{fixtures,datasets,scoring}/*`, one test file per seam:
S1 redact, S2 loaders, S3 serialize/generate, S4 bootstrap. (03b has since replaced the
"throws rather than scoring items" placeholder with the real matcher and item scorers.)

## Next: ticket 04 — on-device OCR provider (start fresh session, in the home repo)
03b is the current ticket; after it: 04 → 05 → 06 → 07 → 08 → 09a → 09b → 10a → 10 → … Ticket 05 measures row classes **through the 03b scorers**, and its τ/threshold work must not reopen DECISIONS/0006 — `benchmark.config` is locked unless a new decision record supersedes it.
Read first for 04: its own ticket file `.scratch/receipt-lens-v1/issues/04-on-device-ocr-provider.md`,
`docs/model-assets.md`, `PROJECT(1).md` §3/§7 (OCR contract), `DECISIONS/0001`. Blocked-by lines are
authoritative; `Week:`/`Milestone:` labels are planning hints and several are wrong (e.g. 02 was
M1/week-2 despite W17/M3). Branch + PR, never direct-push `main`, and expect the onnxruntime-web
postinstall question the standing rules already anticipate.

## Open items / owner decisions pending
- Rename repo `Recipt-lens` → `receipt-lens` (`gh repo rename`) or keep.
- Rotate the fine-grained PAT (its first ~26 chars leaked into a session transcript; value still live).
- Ticket 13: map `otherSign:"unknown"` charges + `hasNegativeShare` + unacknowledged-unit throw to real `LockBlockerCode`s (no §13 code exists for unknown-sign today — do not invent silently).
- Ticket 15: `// TODO(spec): payer≠creator payee gap` at the UPI builder (DECISIONS/0001); G5 NPCI limits verification.
- ROADMAP 3D.3 typo: "P5 24870/10" — spec §11 says 24870 paise; spec wins, roadmap untouched.

## Standing rules (from owner next.md — still in force)
Branches+PRs only; no force-push/history rewrite without approval; no `--no-verify`/`.skip`/`test.only`; CI wrong → fix CI in its own explained commit; no PROJECT(1).md edits; no new runtime network calls (deps checked for telemetry/CDN/auto-update); runtime assets fully self-hosted; fixtures PII-clean; postinstalls reviewed before allowing; nothing >1 MB committed (models = approved exception); ≥5 GB free or stop; no destructive shell outside the repo; six-section ≤1-page report per ticket incl. disk delta; if ambiguous, stop and ask — silence is not approval.
