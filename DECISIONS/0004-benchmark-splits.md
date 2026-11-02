# DECISIONS/0004 — Benchmark splits and what CORD can actually prove

Date: 2026-11-02 · Owner decision (ticket 03a kickoff). Counts verified from parquet
metadata the same day — they match the owner's quoted numbers, so this table is the
operating one.

## Split discipline

| Dataset | Split | Rows | Path | Runs when |
|---|---|---|---|---|
| CORD v2 | `valid` | 100 | `benchmarks/fixtures/dev/` | CI on every push |
| SROIE | `train` subset (first 150 by dataset order) | 150 | `benchmarks/fixtures/dev/` | CI on every push |
| CORD v2 | `test` | 100 | `benchmarks/fixtures/eval/` | Release/schedule only |
| SROIE | `test` | 361 | `benchmarks/fixtures/eval/` | Release/schedule only |

Available rows in the pinned snapshot: CORD train 800 (4 shards × 200), valid 100,
test 100; SROIE train 626, test 361.

- **Both sets are committed**, both PII-redacted per DECISIONS/0005, both carry
  attribution. The distinction is *which job reads which* — not what is committed.
- **Tuning happens against `dev/` only**: τ_name, confidence floors, the round-off band,
  label-dictionary additions. If a fix is prompted by an `eval/` failure, that is
  contamination — stop and report instead of applying it.
- `eval/` runs on manual trigger or schedule (`.github/workflows/evaluate.yml`) and
  writes `benchmarks/results/eval-<date>-<sha>.json`.
- SROIE `train` is reused as the dev split because this snapshot has no separate
  validation split for SROIE, and `dev/` must not overlap `eval/`. Only the grand-total
  field is scored from SROIE at all, so no itemized field is being tuned on it.
- The null-parser bootstrap (03a) runs against `dev/` only.

## CORD's role, narrowed and stated — not narrowed silently

`ground_truth` in the pinned HF parquet carries exactly
`dontcare, gt_parse, meta, repeating_symbol, roi, valid_line` for all 100 test receipts,
and `valid_line` contains **only annotated financial categories**
(`menu.nm`, `menu.price`, `menu.cnt`, `menu.unitprice`, `menu.sub.*`, `menu.num`,
`sub_total.{subtotal_price,tax_price,service_price,discount_price,etc}`,
`total.{total_price,cashprice,changeprice,creditcardprice,emoneyprice,menutype_cnt,…}`).

Store name, address, column labels, table furniture and wrapped-name continuation lines
are **not present in the snapshot at all**.

**CORD tests:** Indonesian label parsing, number-format parsing (`23.000` and `16,500`
both occur), item name matching, quantity inference, price field extraction.

**CORD does NOT test row classification or row geometry** — the snapshot has no
non-financial lines to classify, so a CORD-derived fixture cannot contain a
noise-header or continuation row.

**Row classification is tested by hand-authored fixtures in ticket 05's own test suite**,
not by CORD. Do not chase CORD's original full-`lines` release to fix this; the owner
closed that option.

## Honesty limitation that ships with every published number

All benchmark numbers here are **ceilings**, for two independent reasons that both go in
`benchmarks/fixtures/README.md` beside the published table:

1. Fixtures are reference OCR from dataset annotations, so no OCR error reaches them
   (DECISIONS/0003).
2. Development against `dev/` fixes bugs that would otherwise have appeared on `eval/`.
