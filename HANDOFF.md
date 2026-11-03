# HANDOFF — session log and next steps (2026-11-03)

## Where everything lives
- **Working repo (authoritative):** `/home/albus/dev/splitt2` — git, `main` = `9e482e9` (PR #7,
  tickets 01/02/03a/03b/04 merged). Fetch before reading `origin/main`: a stale local ref made a
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

**Merged** 2026-11-03 via PR #6 (`bb787b9`) — this note previously read "not pushed". Owner decisions
still open from 03a's second ruling are unchanged
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

## CHECKPOINT — ticket 04 complete (2026-11-03, branch `ticket/04-on-device-ocr-provider`)

**What landed:** the browser OCR provider. `packages/core/src/ocr/pp-ocrv6.ts` (provider:
load → det → rec → words → lines) over `ocr/pp-ocrv6/{detect,recognize,lines,image}.ts`, plus
`ocr/model-manifest.ts`. `ocr()` in `provider.ts` now delegates to the provider; `parse()` and
`validate()` are still ticket 01 stubs, which is exactly what ticket 05 needs.

**Contract unchanged.** `OcrProvider`/`OcrResult` were not reshaped or extended. `version` is
`1.0.0-tiny+sha256.<manifestHashPrefix>`; `PPOCRv6Provider.manifestHash`/`assetBytes`/
`sessionInfo` are additive class members, not part of the interface.

**Two upstream facts are wrong, and the manifest now records the measured truth.** Both were
traps that produce plausible-but-wrong output rather than errors:
- detection output is **full resolution** `[N,1,H,W]`, not `H/4` (probed at 96×160 and 480×640);
- recognition output is **already softmax** (every row sums to 1.000), not `ctc_logits`. Applying
  softmax again gave every word a confidence of ~0.0003 on the first real run.
The provider reads channel order, mean/std, DB thresholds, recognition sizing and the decoder's
`outputActivation` from `assets/models/manifest.json`, and `ctcGreedyDecode` rejects output whose
rows contradict the declared activation, so this class of drift fails loudly next time.

**Postinstall:** `onnxruntime-web` has none; the blocked hook was `protobufjs`'s (a version-scheme
warning that no-ops in pnpm's virtual store). Denied in `pnpm-workspace.yaml` with the reason.
`pnpm install --frozen-lockfile` verified green.

**New workspace package:** `harness/` (esbuild bundle + COOP/COEP static server + acceptance
driver). `pnpm build` builds it last; `pnpm -r typecheck` covers it; it has no `test` script so
`pnpm -r test` skips it. Run `node harness/run-acceptance.mjs [image]`; output goes to
`harness/out/` (git-ignored). Default image is the SROIE sample
`benchmarks/datasets/raw/sroie/assets/ex.jpg`.

**Verified locally:** `pnpm install --frozen-lockfile` ✓ `pnpm build` ✓ `pnpm typecheck` ✓
`pnpm test` 198 passing (core 15, pwa 27, benchmarks 156) ✓ `pnpm scan:pii` idempotence clean ✓
`pnpm verify:results` byte-identical ✓ fixture budget 12.0 MB / 50 MB ✓ `node
scripts/model-manifest.mjs --check` clean ✓ real-receipt run: 29 lines / 75 words, 327 ms load,
503 ms inference, 6,277,292 asset bytes, same-origin requests only.

**Known gap:** OCR runs on the main thread; `PROJECT(1).md` §3 sketches `ocr/worker.ts`, which no
ticket has needed yet. The pipeline is pure functions so a worker can wrap it (09a/10). Recorded as
`DECISIONS/0007`, which also fixes a conflation: the provider's **0.5 × median word height**
(`manifest.readingOrder.toleranceRatio` → `groupWordsIntoLines`) is the reading-order line view, **not**
§5's **0.4 × median word height** parser y-band. Different values *and* different computations (the
provider uses an unweighted median against a running band mean; §5 wants a word-count-weighted
median). Ticket 05 tunes §5's constant and must not "align" the provider's.

**Accuracy finding for 09b:** on the SROIE sample, item text and item prices read correctly, but
the faint right-hand amount column misreads characters (`Total 9.00` → `Total 1.00`,
`Cash 10.00` → `Cash 000`). Same glyphs decode correctly elsewhere on the page, so this is Tiny's
accuracy on a 463 px thermal scan, not a decode/preprocessing defect. Do not "fix" it by tuning
constants here. 09b must measure **price-field** accuracy per integer-paise equality, separately from
aggregate character error — a tolerable CER can still carry a price wrong by an order of magnitude.

**Pushed, not merged.** `origin/ticket/04-on-device-ocr-provider` — `1455363` plus the review
close-out below. **No PR yet; the owner opens it after review.** Ticket file updated with the evidence
and all boxes ticked.

### Close-out (2026-11-03, second session) — the browser-vs-Node review item

The one open item was whether `harness/run-acceptance.mjs` drives a **browser page** or runs ORT in
**Node**. It is a browser: the driver imports `chromium` from `@playwright/test`, launches headless
Chromium against `harness/serve.mjs`, sets the file on `#file`, waits for `window.__receiptLensHarness`,
and captures `page.screenshot()` + JSON. Inference executes in the page (`executionProviders: ["wasm"]`,
`onnxruntime-web/wasm`, `performance.now()` in `harness/src/main.ts`). **`onnxruntime-node` is not a
dependency anywhere.** Recorded proof: `session.numThreads: 4`, reachable only under the COOP/COEP
isolation that `serve.mjs` sends. So §9 M1.1, §3 line 117 and §8's runtime note are satisfied as
written; §18 turned out to be *Owner Decisions — Resolved* and carries no browser claim. Still open
from §9 M1, and belonging to **09a**: precache → block outbound network → assert inference still
succeeds. The driver today records origins (one, same-origin) but asserts no blocking.

**The previous session's evidence prose was overstated and has been corrected.** It quoted tidied
strings (`Rounding Adjustment 0.00`, `95569040-40118 KP MODELLING CLAY KIDDY HSH`,
`Rounded Total (RM): 9.00`, `GOODS SOLD ARE NOT RETURNABLE OR EXCHANGEABLE`) as verbatim OCR and
labelled 15 of them "recognized correctly and legibly"; only 5 were verbatim. The actual output is
`Rour ing Adustment 0.00`, `95569390-40118 KF MODELLNGCLAY KIDDY HSH`, `Round d Total (RM): 9.00`,
`GOODS SOLID ARE NOT REIURNABTEOK` / `FXCHANGEABLE`. The ticket now carries the full 29-line verbatim
block. **The gate still passes** — header identity is clean, item text is recognizable, item and
rounded prices are present with `9.00` exact — but do not restore the tidied quoting; it was the error.
Also withdrawn: the "same glyphs decode correctly elsewhere" proof used `Rounding`/`Adjustment`, which
do **not** decode correctly; the corrected proof uses `0.00`/`9.00`/`Total (RM):` and the 0.996 lines.
Re-ran the harness this session: line text and confidences came back **byte-identical** (29/75,
mean 0.849, range 0.414–0.996), so OCR output is deterministic across runs; wall-clock is not
(327/503 ms → 582/952 ms here). `harness/out/` is git-ignored and was regenerated.

## CHECKPOINT — ticket 05 complete (2026-11-03, branch `ticket/05-row-geometry-and-classification`)

**What landed:** the parser's first stage. `packages/core/src/parse/` is now
`constants.ts` (the pinned numbers), `geometry.ts` (weighted median, y-band clustering, price
column), `patterns.ts` (the four header/noise families, the charge-label boolean, the all-caps
test), `classify.ts` (§5's single forward pass and the continuation merge) and `index.ts`
(`parse()`). `validate()` and `extract()` are still ticket-01 stubs — that is ticket 07.
Fixtures shared with later tickets live in `parse/fixtures.ts`.

**`DECISIONS/0008` pins the seven Tier-3 constants before the classifier was written**, and
`benchmarks/src/parser/rowClassification.test.ts` re-derives every number in it from the committed
dev fixtures — the same discipline as the committed τ-sweep, so the record cannot drift from the
artifact that produced it. Headline (post rule 3): 5,604 provider lines → 5,199 parser rows; 713
items, 43 continuations, 3,583 noise_header, 860 ambiguous; 1,364 priced rows (26.2%), 3 separator
rows, 0 empty-name items; 0 byte-identity failures over 250 fixtures.

**Three things a fresh session should not rediscover the hard way:**

1. **The word-count-weighted median is count-weighted, not height-mass-weighted.** An earlier draft
   of the implementation accumulated `sum(heights)` and crossed half the total *mass*; §5's phrase
   is about word *count*, and the difference changes the tolerance and therefore the rows. Pinned in
   P4 as the lower crossing of the cumulative count. The two statistics diverge on 38 of 250
   receipts, which is how the mistake was caught.
2. **P4 also corrects a claim in DECISIONS/0007.** That record separated the provider's banding from
   the parser's by value (0.5 vs 0.4 — true) *and* by statistic (unweighted vs word-count-weighted
   median). The second is narrower than it reads: the provider's `heights[floor(n/2)]` is the upper
   middle, P4's crossing is the lower middle, so they agree on odd word counts and differ on 38 of
   250 dev receipts. The *membership* rules are genuinely different (radius-against-band-mean vs
   consecutive-centre chain). The provider was not touched and the tolerances were not aligned.
3. **The identifier family fires per row, not per token, and the reason is visible rows rather than
   rescued items.** 30 dev rows carry an identifier-shaped token; exactly 1 is identifier-only
   (`09/03/2018 21:28 0001`), and that is the phantom suppressed. A token-anywhere rule would have
   swept the other 29 into `noise_header` — 22 were already there, but **8 were `ambiguous`**, i.e.
   preserved for review, and deleting them is the wrong direction. Two rows first looked like
   casualties (`F/CASTELL 187057-75 TACK-IT 2 SR 12.00`, `2 HH ASAHI 1+1/2 SR 77.80`) and are not:
   SROIE's reference OCR publishes those lines as a **single whole-line word**, and any token holding
   letters fails the shape test before the row test is reached. No dev item carries a token today.
   The money guard is separately load-bearing: without it the family fires on `1.234.567`, which is
   2,276 dev words.

**Rule 3, added after the pre-merge verification (owner ruling Q1=(a)):** an item row needs ≥1
lettered non-price word as well as a price candidate, because a row that is only a number (`1,818`
alone) was becoming an item with an empty name — 49 in CORD, 34 in SROIE, now 0. This raised CORD's
ambiguous rate 16.9% → 21.2%, which is the right direction: those rows are preserved with their money
instead of being silently dropped. It also corrected a published metric — gold-name recovery was
**56.1% (142/253)**, not the 70% first reported: the earlier substring test let every empty name match
every gold name. Recovery is identical before and after; only the labelling of the failures changed.

**Owner rulings taken during this ticket:** telephone-shaped rows go into the pattern table (they
did: family 4, with the measured finding that dev's population is dates, not phones); the footer
`noise_header` clause is an explicit deviation recorded in P7 (post-item price-less rows are
`ambiguous`, i.e. visible, rather than deleted); the split name/price layout was **verified not to
merge** before being accepted — rows 14/15 on ticket 04's receipt are 26.4 px apart against an 8.60
px band, so 05 classifies them separately (the name row is `noise_header`, the amount row is an item
named `PC 9.00 0.00`) and the lost name is ticket 06's to reattach.

**Housekeeping:** core tests are now typechecked in CI (`packages/core/tsconfig.test.json`, added to
`packages/core`'s `typecheck` script) — pwa and benchmarks already did this, and it caught two
broken test helpers on the first run. `parse()` is exported as before; `classifyRows` and the pattern
predicates are exported as measurement seams for the benchmark gate, in the same spirit as ticket 04's
provider seams. `api.test.ts` no longer expects `parse()` to throw: §4 makes blank OCR a valid
zero-word result that parses to zero items.

**Verified locally:** `pnpm install --frozen-lockfile` ✓ `pnpm build` ✓ `pnpm typecheck` ✓
`pnpm test` **264 passing** (core 73, pwa 27, benchmarks 164) ✓ `pnpm scan:pii` idempotence clean,
51 advisories unchanged ✓ `pnpm verify:results` byte-identical ✓ fixtures 12.0 MB / 50 MB ✓
`node scripts/model-manifest.mjs --check` ✓. Disk: 56 GB free; added ~34 KB of tracked source.

## Next: ticket 06 — items, quantities, provenance and labelled charges
After 05: 06 → 07 → 08 → 09a → 09b → 10a → 10 → …
Read first for 06: its ticket file `.scratch/receipt-lens-v1/issues/06-items-quantities-and-charges.md`,
`PROJECT(1).md` §5 (quantity rules, number-format contract, label dictionary), `docs/business.md` §11,
then `packages/core/src/parse/`. What 05 hands over, unchanged and deliberately not done here:

- items arrive with `qty/unitPrice/lineTotal` null and `"unresolved"` sources. 06 owns §5's quantity
  column rule (≥60% integers ≤20), the locale profiles (`id-ID`, `en`, `en-IN` with lakh grouping)
  and the integer-paise boundary. Money parsing must not use binary float equality (§5 Safeguards).
- `noise_header` rows include every charge-labelled row (`CGST 2.50`, `SUBTOTAL …`, `ROUND OFF`),
  classified as noise so they never become items, and left in `classifyRows()` output for 06 to turn
  into `ParsedTax`/`ParsedOtherCharge`. `parse()` currently returns empty charge fields; the shapes
  are ticket 02's and must be consumed, not redefined.
- 05 strips the single price-column word from an item's name (`parse/index.ts`); 06 decides which
  remaining token is the quantity. `priceCandidatesForRow` and `isAmountShaped` are the seams.
- the split name/price layout (name row price-less above a priced row) is 06's to reattach — recorded
  as a limitation in DECISIONS/0008 P7, not solved in 05.
`eval/` stays unread; tuning is dev-only (DECISIONS/0004). DECISIONS/0006 stays shut: the parser
consumes no τ, and `benchmark.config` is locked unless a new record supersedes it. Blocked-by lines
are authoritative; `Week:`/`Milestone:` labels are planning hints and several are wrong. Branch + PR,
never direct-push `main`.

## Open items / owner decisions pending
- **`.agents/skills/` tracking is undecided — TODO.** Write `DECISIONS/0009-skills-tracking.md`
  choosing one: (a) tracked, with a `pnpm check:skills` that verifies each `SKILL.md` against
  `skills-lock.json`'s computed hashes, or (b) gitignored, with `skills-lock.json` as the
  verification artifact. Today they are tracked and keep getting deleted in the worktree by
  something outside the ticket flow — a prior session's 79 unstaged deletions sat in the tree through
  ticket 04 and had to be investigated and restored during ticket 05's pre-merge verification.
  **Tracked-and-frequently-deleted is the worst of both worlds; verify the state, don't track the
  content.** Standing rule until 0009 lands: no `.agents/` worktree changes without explicit approval.
- Rename repo `Recipt-lens` → `receipt-lens` (`gh repo rename`) or keep.
- Rotate the fine-grained PAT (its first ~26 chars leaked into a session transcript; value still live).
- Ticket 13: map `otherSign:"unknown"` charges + `hasNegativeShare` + unacknowledged-unit throw to real `LockBlockerCode`s (no §13 code exists for unknown-sign today — do not invent silently).
- Ticket 15: `// TODO(spec): payer≠creator payee gap` at the UPI builder (DECISIONS/0001); G5 NPCI limits verification.
- ROADMAP 3D.3 typo: "P5 24870/10" — spec §11 says 24870 paise; spec wins, roadmap untouched.

## Standing rules (from owner next.md — still in force)
Branches+PRs only; no force-push/history rewrite without approval; no `--no-verify`/`.skip`/`test.only`; CI wrong → fix CI in its own explained commit; no PROJECT(1).md edits; no new runtime network calls (deps checked for telemetry/CDN/auto-update); runtime assets fully self-hosted; fixtures PII-clean; postinstalls reviewed before allowing; nothing >1 MB committed (models = approved exception); ≥5 GB free or stop; no destructive shell outside the repo; six-section ≤1-page report per ticket incl. disk delta; if ambiguous, stop and ask — silence is not approval.
