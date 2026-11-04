# Storage and commit policy

Owner-set rules (2026-11-02). Every ticket report includes a one-line disk delta:
what was added, where it lives (tracked/ignored/fetched), repo size, free space.

1. **Nothing over 1 MB is committed without explicit approval.** The three PP-OCRv6
   Tiny model assets (`assets/models/`, 6,277,292 B, plus the 2,700 B manifest) are the
   standing exception already approved in ticket 01. Nothing else is.
2. **Datasets are fetched, not committed.** Pinned URL + SHA-256 + license live in
   `benchmarks/datasets/dataset-manifest.json`; bytes are materialized by script into
   the git-ignored `benchmarks/datasets/raw/`. Verified: no dataset bytes in git
   history (`git log --all --name-only` finds no parquet entries; `git status --ignored`
   shows `benchmarks/datasets/raw/`).
3. **`benchmarks/fixtures/` has a 50 MB ceiling** (start value); CI fails if exceeded.
4. **Never commit:** `node_modules`, pnpm store, Playwright browsers, build output
   (`dist/`), `.env`, editor state, receipt images, local retention directories.
   Proven by `git status --ignored` in each ticket report.
5. **Keep at least 5 GB free** on the working volume. If below, stop and report —
   do not download more.
