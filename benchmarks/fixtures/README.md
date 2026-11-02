# Benchmark fixtures

Derived, PII-redacted text fixtures for the benchmark harness (ticket 03a). These are
**the datasets' own reference OCR plus their annotations**, not output from our OCR — so
every number produced from them is a ceiling on real-world accuracy, never an estimate of
it (DECISIONS/0003).

CI never downloads a dataset. The committed fixtures *are* the CI input.

## Attribution

| | CORD v2 | SROIE |
|---|---|---|
| Purpose | layout-stress bucket, out-of-language (ADR-010) | grand-total-only contract |
| Source | <https://huggingface.co/datasets/naver-clova-ix/cord-v2> | <https://huggingface.co/datasets/jsdnrs/ICDAR2019-SROIE> |
| Revision pinned | `7f0115a4b758a71d6473b8d085751692da2fef98` | `bffe40c26759f3376ec2b3ae9031dbba54cd587c` |
| Snapshot hash | `6cb6555829a62eec26ed953c785d30f4db23b3185fe0111661a5509d32c47054` | `483632b50b77561ec732d35487c8ff790b8c8380fce42305fcaab9ee665cccd4` |
| License | CC-BY-4.0 | CC-BY-4.0 **as declared by the mirror** |
| Rows used | 100 `valid` → dev, 100 `test` → eval | 150 `train` → dev, 361 `test` → eval |

**SROIE provenance caveat, stated plainly:** the mirror `jsdnrs/ICDAR2019-SROIE` declares
`license: cc-by-4.0` in its dataset card, LICENSE and NOTICE. The primary ICDAR host
(`rrc.cvc.uab.es/?ch=13`) requires registration and consent and was **not** used, so
primary-source license verification was **not** performed. Owner decision and fallback
options are in `DECISIONS/0002-sroie-snapshot.md`. Attribution required by both datasets
is carried in the pinned `LICENSE` / `NOTICE` files fetched into
`benchmarks/datasets/raw/sroie/` (git-ignored, re-materializable via `pnpm fetch:datasets`).

## What each dataset proves, and what it cannot

CORD tests: Indonesian label parsing, number-format parsing (`23.000` and `16,500` both
occur), item name matching, quantity inference, price field extraction.

CORD does **not** test row classification or row geometry. The pinned parquet's
`ground_truth` carries only `dontcare, gt_parse, meta, repeating_symbol, roi, valid_line`,
and `valid_line` contains only annotated financial categories — there are no store-name,
address, column-label or wrapped-name continuation lines in the snapshot at all. Row
classification is tested by hand-authored fixtures in ticket 05's own suite
(DECISIONS/0004).

SROIE tests **one field**: `grandTotal`, mapped from the annotated `total` entity. Its
`company`, `date` and `address` annotations are **removed from the fixtures entirely** —
they are unscored and contain non-removable PII (DECISIONS/0005). Fields a dataset does
not label are declared excluded in each provenance header and are never null-scored.

## Layout

```
benchmarks/fixtures/
  dev/    cord-v2.provenance.json  cord-v2/*.json    sroie.provenance.json  sroie/*.json
  eval/   cord-v2.provenance.json  cord-v2/*.json    sroie.provenance.json  sroie/*.json
```

One file per receipt keeps every committed object under the 1 MB ceiling
(`docs/storage.md`); the set totals ~12.4 MB against a 50 MB ceiling. Each provenance
header records snapshot hash, license, row count, labelled/excluded fields, the redaction
tally and digests of any entity the header anchor could not locate. Each receipt file
carries its own redaction log — **shape only** (`beforeLength`, `after`), never the
removed text.

## Regenerating

```
pnpm fetch:datasets     # pinned URLs, verifies every SHA-256, writes raw/ (git-ignored)
pnpm generate:fixtures  # raw/ -> fixtures/, deterministic
pnpm verify:fixtures    # regenerate in memory and fail if committed bytes differ
pnpm scan:pii           # audit of the committed fixtures; see PII-SCAN.md
```

Tuning happens against `dev/` only. `eval/` runs on manual trigger or schedule
(`.github/workflows/evaluate.yml`). A fix prompted by an `eval/` failure is contamination
— stop and report (DECISIONS/0004).

## Accuracy is a ceiling, for two independent reasons

1. Fixtures are reference OCR from the datasets' own annotations, so no OCR error can
   reach these numbers.
2. Development against `dev/` fixes bugs that would otherwise have surfaced on `eval/`.

Machine-readable results live in `benchmarks/results/` and are generated from these
fixtures — never hand-typed.
