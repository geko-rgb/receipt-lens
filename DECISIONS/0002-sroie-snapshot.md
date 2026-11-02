# DECISIONS/0002 — SROIE v1 snapshot

Date: 2026-11-02 · Owner decision (approves gate G4 closure for SROIE).

**Source:** Hugging Face community mirror `jsdnrs/ICDAR2019-SROIE`
(https://huggingface.co/datasets/jsdnrs/ICDAR2019-SROIE), chosen by the owner after
the canonical host became unreachable.

**License:** CC-BY-4.0. The mirror's dataset card declares `license: cc-by-4.0`, and
the fetched `LICENSE` file contains the CC-BY-4.0 legal code with an attribution
`NOTICE` (both hash-pinned in `benchmarks/datasets/dataset-manifest.json`).
**Caveat — do not claim more than this:** this is mirror-declared licensing. The
primary ICDAR host (rrc.cvc.uab.es/?ch=13) requires registration/consent and was
**not** used, so primary-source license verification was **not** performed.

**Provenance:** community mirror. If the license is later contested, the fallback is
to replace this snapshot with the official host's release and re-pin the manifest.

**Pins:** SHA-256 for every fetched file recorded in
`benchmarks/datasets/dataset-manifest.json`; both parquet files and the sample image
verified byte-exact against the mirror's LFS content identifiers at acquisition time.
Nothing was silently substituted.

**Loader contract (03a):** score `grandTotal` only, mapped from the annotated
`total` entity. Company/date/address are not scored (not part of the parser's
contract); item-level fields are not annotated and are never null-scored.

**License fallback (owner, 2026-11-02).** If the mirror's licensing is ever contested,
neither option is to be discovered mid-project:

- **(a)** run CI on CORD-only committed fixtures, and publish SROIE numbers from an
  owner-run local job with the provenance gap disclosed beside them; or
- **(b)** replace this snapshot with a fully licensed SROIE source and re-pin the
  manifest.
