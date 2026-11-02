# ADR-003: Two-tier, dataset-scoped benchmark

Status: **locked** (seeded from `PROJECT(1).md` §14; exercised by tickets 03a/03b).

Publish strict exact-match metrics alongside field-level precision/recall/F1 diagnostics. Annotate dataset coverage; do not score fields a dataset does not provide.

Requirements: deterministic one-to-one item matching; pinned normalization/tolerance; a permanent null-parser bootstrap (a parser producing nothing must score exactly zero); README numbers generated from committed CI results, never hand-typed.
