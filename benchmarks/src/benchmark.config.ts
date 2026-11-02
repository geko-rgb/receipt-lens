/**
 * The pinned benchmark constants — gate G8t (`ROADMAP.md` §4) and §8.6's requirement that
 * `τ_name` and the round-off band are pinned **before** results are reported.
 *
 * These are locks, not settings. Every number this harness publishes was produced under
 * exactly these values and says so in its results JSON; changing one after publication
 * invalidates every published number produced under the old value. That is a new decision
 * record and an owner decision, not an edit here.
 */

/** Bumped whenever scoring or matching semantics change, so a stale number is identifiable. */
export const scorerVersion = "03b.1";

/** Shape version of `benchmarks/results/*.json`, echoed into the file it describes. */
export const resultsSchemaVersion = "1.1";

/** DECISIONS/0006 — the metric name is part of the published pin, not an implementation detail. */
export const nameSimilarityMetric = "normalized-levenshtein";

/**
 * Identity of the §8.1 normalization in `matching/similarity.ts`. A published number is only
 * reproducible if the reader knows which normalization produced it.
 */
export const nameNormalization = "nfc-lowercase-punctuation-to-space-collapse-v1";

/**
 * `τ_name = 0.70`. Measured on `dev/cord-v2` (never `eval/`, per DECISIONS/0004) and pinned by
 * `matching/sweep.ts`: the money-equal surface — the only surface where §8.2 lets a false
 * candidate form — admits **zero** false candidates from 0.60 through 0.85, so tightening past
 * 0.70 buys no safety and only costs tolerance. See DECISIONS/0006.
 */
export const tauName = 0.7;

/** §6 confidence thresholds, still the spec's stated initial defaults (ticket 04 evaluates them). */
export const criticalOcrConfidenceFloor = 0.5;
export const warningOcrConfidenceFloor = 0.7;

/**
 * §6 round-off exception, in integer minor units: the printed `roundOff` must reconcile the
 * total within ₹0.02 (2) and be no larger than ₹1.00 (100) in magnitude. A larger adjustment
 * is a critical contradiction, not a tolerance.
 */
export const roundOff = {
  reconcileToleranceMinorUnits: 2,
  magnitudeCapMinorUnits: 100,
} as const;

/**
 * Tier-2 aggregation. Per-field precision/recall/F1 are **aggregate** (micro) over every
 * counted cell in the dataset; the dataset-level summary is an unweighted **macro** mean over
 * the fields that produced evidence — a field the dataset does not label is never scored, and
 * a field it labels but this receipt set annotates nowhere has no denominator, so it is
 * reported with its zero counts rather than averaged in as a zero.
 */
export const averaging = "per-field-micro; dataset-macro-over-fields-with-scored-cells";

/**
 * The results JSON shape, declared rather than implied by whatever the renderer happened to
 * emit. `scoring/resultsSchema.test.ts` asserts the rendered report has exactly these keys on
 * every level, so a published number cannot change shape without a schema bump here — and a
 * reader of `benchmarks/results/*.json` can tell which protocol produced it.
 */
export const resultsSchema = {
  top: [
    "schemaVersion",
    "scorerVersion",
    "headlineMode",
    "parser",
    "accuracyIsACeiling",
    "ceilingReasons",
    "protocol",
    "strictTier",
    "nullSemantics",
    "datasets",
  ],
  protocol: [
    "nameSimilarityMetric",
    "nameNormalization",
    "tauName",
    "averaging",
    "matching",
    "itemFieldAgreement",
    "roundOffBand",
    "ocrConfidenceFloors",
  ],
  dataset: [
    "dataset",
    "snapshotHash",
    "provider",
    "providerVersion",
    "license",
    "receipts",
    "strict",
    "macro",
    "items",
    "fieldsLabeled",
    "fieldsExcluded",
    "fields",
  ],
  field: [
    "field",
    "tier",
    "tp",
    "fp",
    "fn",
    "precision",
    "recall",
    "f1",
    "absentAgreements",
    "excludedCells",
    "goldCells",
  ],
} as const;

/**
 * Not pinned here on purpose: no accuracy-acceptance threshold exists in `PROJECT(1).md` or
 * `ROADMAP.md`. M1 exit asks whether the strict-metric gap between Tiny and Small is
 * "material" (gate G3) without defining material, so this file records the measurement
 * protocol and leaves the acceptance decision where it belongs.
 */
export const benchmarkConfig = {
  scorerVersion,
  resultsSchemaVersion,
  nameSimilarityMetric,
  nameNormalization,
  tauName,
  criticalOcrConfidenceFloor,
  warningOcrConfidenceFloor,
  roundOff,
  averaging,
  resultsSchema,
} as const;
