import type { GoldItem, LabeledReceipt } from "../datasets/types.js";
import { tauName } from "../benchmark.config.js";
import { jaro, jaroWinkler, nameSimilarity, normalizeItemName } from "./similarity.js";

/**
 * The committed evidence behind DECISIONS/0006 — the reason `τ_name = 0.70` with
 * normalized Levenshtein is a measurement rather than a claim. It runs over the committed
 * `dev/` fixtures only (never `eval/`, per DECISIONS/0004), needs no raw dataset, and is
 * asserted by `sweep.test.ts` on every push.
 *
 * Nothing here is a property test of the matcher: it measures the *metric choice*, on the
 * surface §8.2 actually admits. A false candidate can only form between two items whose
 * annotated money agrees, so that subset of within-receipt pairs is where a metric can do
 * damage, and it is the subset this file counts.
 *
 * The synthetic "positives" are exhaustive, not sampled: every single substitution of a
 * non-space character by a different character of `a-z0-9`, and every adjacent transposition
 * of two different characters, of each distinct dev name. Exhaustive instead of seeded means
 * a reader can reproduce the retention figures with no PRNG to trust — and no sample size to
 * argue about.
 */

/** The band DECISIONS/0006 measured as flat-safe on the money-equal surface. */
export const tauBand: readonly number[] = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85];

/** Characters an OCR stage plausibly confuses, used to build the exhaustive variants. */
const substitutionAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Codepoints where JavaScript's `toLowerCase()` and full Unicode casefolding disagree.
 * `similarity.ts` documents the deviation, and this is the guard that keeps it a deviation
 * rather than a silent scoring difference against the reference implementation.
 */
const casefoldHazards = ["ß", "ẞ", "İ", "ı", "ﬀ", "ﬁ", "ﬂ", "ﬃ", "ﬄ", "ﬅ", "ﬆ"];

export interface NamePair {
  readonly a: string;
  readonly b: string;
  /** both names normalized, non-empty and different — a genuine pair of distinct menu items */
  readonly sameReceipt: boolean;
}

function amountsAgree(left: GoldItem, right: GoldItem): boolean {
  if (left.unitPrice !== null && right.unitPrice !== null && left.unitPrice !== right.unitPrice) return false;
  if (left.lineTotal !== null && right.lineTotal !== null && left.lineTotal !== right.lineTotal) return false;
  return true;
}

function moneyAgreeOnSomeAnnotatedField(left: GoldItem, right: GoldItem): boolean {
  return (left.unitPrice !== null && left.unitPrice === right.unitPrice) || (left.lineTotal !== null && left.lineTotal === right.lineTotal);
}

/**
 * Pairs of *distinct* gold items on one receipt whose annotated amounts agree — the surface
 * on which a metric with a too-generous score would let §8.2 admit a false candidate.
 * Unordered, and counted once per receipt pair.
 */
export function moneyEqualSurface(receipts: readonly LabeledReceipt[]): NamePair[] {
  const pairs: NamePair[] = [];
  for (const receipt of receipts) {
    const items = receipt.gold.items;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const left = items[i]!;
        const right = items[j]!;
        const a = normalizeItemName(left.name);
        const b = normalizeItemName(right.name);
        if (a === "" || b === "" || a === b) continue;
        if (!moneyAgreeOnSomeAnnotatedField(left, right) || !amountsAgree(left, right)) continue;
        pairs.push({ a, b, sameReceipt: true });
      }
    }
  }
  return pairs;
}

/** Every distinct-name pair on one receipt, with the monetary gate taken away. */
export function distinctNamePairsIgnoringMoney(receipts: readonly LabeledReceipt[]): NamePair[] {
  const pairs: NamePair[] = [];
  for (const receipt of receipts) {
    const items = receipt.gold.items;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = normalizeItemName(items[i]!.name);
        const b = normalizeItemName(items[j]!.name);
        if (a === "" || b === "" || a === b) continue;
        pairs.push({ a, b, sameReceipt: true });
      }
    }
  }
  return pairs;
}

/** Pairs of distinct menu items sharing their leading word — the shape a prefix bonus loves. */
export function sameFirstWordPairs(names: readonly string[]): NamePair[] {
  const pairs: NamePair[] = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i]!;
      const b = names[j]!;
      if (a.split(" ")[0] === b.split(" ")[0]) pairs.push({ a, b, sameReceipt: false });
    }
  }
  return pairs;
}

/** Every distinct non-empty normalized name in the split, in fixture order of first appearance. */
export function distinctNames(receipts: readonly LabeledReceipt[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const receipt of receipts) {
    for (const item of receipt.gold.items) {
      const name = normalizeItemName(item.name);
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function singleSubstitutions(name: string): string[] {
  const out: string[] = [];
  for (let position = 0; position < name.length; position += 1) {
    if (name[position] === " ") continue;
    for (const replacement of substitutionAlphabet) {
      if (replacement === name[position]) continue;
      out.push(`${name.slice(0, position)}${replacement}${name.slice(position + 1)}`);
    }
  }
  return out;
}

/** Names cut from the right to 75% and 50% of their length — a clipped row tail. */
function truncations(name: string): string[] {
  const out: string[] = [];
  for (const fraction of [0.75, 0.5]) {
    const kept = name.slice(0, Math.max(1, Math.floor(name.length * fraction)));
    if (kept !== "" && kept !== name) out.push(kept);
  }
  return out;
}

function adjacentTranspositions(name: string): string[] {
  const out: string[] = [];
  for (let position = 0; position + 1 < name.length; position += 1) {
    const first = name[position];
    const second = name[position + 1];
    if (first === second || first === " " || second === " ") continue;
    out.push(`${name.slice(0, position)}${second}${first}${name.slice(position + 2)}`);
  }
  return out;
}

/**
 * Similarity of every synthetic variant against its source name, computed once per
 * `measureSweep` call and then counted per τ. Without this the band would run the same
 * ~97,000 edit distances six times over, once per τ.
 */
function variantScores(
  names: readonly string[],
  variants: (name: string) => string[],
  similarity: (a: string, b: string) => number = nameSimilarity
): number[] {
  const scores: number[] = [];
  for (const name of names) {
    for (const variant of variants(name)) {
      if (variant === "" || variant === name) continue;
      scores.push(similarity(name, variant));
    }
  }
  return scores;
}

function keptAt(scores: readonly number[], tau: number): { kept: number; total: number } {
  return { kept: scores.filter((score) => score >= tau).length, total: scores.length };
}

export interface MetricCounts {
  readonly levenshtein: number;
  readonly jaro: number;
  readonly jaroWinkler: number;
}

export interface BandRow {
  readonly tau: number;
  /** the surface §8.2 can actually reach: distinct items whose annotated money agrees */
  readonly moneyEqual: MetricCounts;
  /** context: the same receipt pairs with the monetary gate removed */
  readonly ignoringMoney: MetricCounts;
  /** context: distinct menu items sharing their leading word */
  readonly sameFirstWord: MetricCounts;
  readonly substitution: { readonly kept: number; readonly total: number };
  readonly transposition: { readonly kept: number; readonly total: number };
  /**
   * Names cut from the right to 75% and 50% of their length — the one class the rejected
   * metric handles better, so both sides of that trade-off are measured here.
   */
  readonly truncation: { readonly kept: number; readonly total: number; readonly jaroWinklerKept: number };
}

export interface SweepMeasurement {
  readonly tau: number;
  readonly moneyEqualPairs: number;
  /** one row per τ in the safe band, every surface scored under all three metrics */
  readonly band: readonly BandRow[];
  /** how many pairs each surface holds, so a count in a row can be read as a rate */
  readonly sizes: { readonly moneyEqual: number; readonly ignoringMoney: number; readonly sameFirstWord: number };
  /** the pair that decides the metric choice, looked up in the fixtures rather than quoted from memory */
  readonly sameBrandDifferentDish: { readonly a: string; readonly b: string; readonly levenshtein: number; readonly jaroWinkler: number } | null;
  readonly emptyNormalizingNames: number;
  readonly casefoldHazardNames: readonly string[];
}

/** `dev/cord-v2` receipt 079 carries both of these; they are the reason JW was rejected. */
const decisivePair = { a: "jamur enoki", b: "jamur kuping" };

function countsFor(pairs: readonly NamePair[], tau: number): MetricCounts {
  return {
    levenshtein: pairs.filter((pair) => nameSimilarity(pair.a, pair.b) >= tau).length,
    jaro: pairs.filter((pair) => jaro(pair.a, pair.b) >= tau).length,
    jaroWinkler: pairs.filter((pair) => jaroWinkler(pair.a, pair.b) >= tau).length,
  };
}

export function measureSweep(receipts: readonly LabeledReceipt[], tau: number = tauName): SweepMeasurement {
  const surface = moneyEqualSurface(receipts);
  const names = distinctNames(receipts);
  const ignoringMoney = distinctNamePairsIgnoringMoney(receipts);
  const firstWord = sameFirstWordPairs(names);

  let emptyNormalizingNames = 0;
  const hazards = new Set<string>();
  for (const receipt of receipts) {
    for (const item of receipt.gold.items) {
      if (normalizeItemName(item.name) === "") emptyNormalizingNames += 1;
      for (const hazard of casefoldHazards) {
        if (item.name.includes(hazard)) hazards.add(item.name);
      }
    }
  }

  const found = surface.find(
    (pair) => (pair.a === decisivePair.a && pair.b === decisivePair.b) || (pair.a === decisivePair.b && pair.b === decisivePair.a)
  );

  const substitutionScores = variantScores(names, singleSubstitutions);
  const transpositionScores = variantScores(names, adjacentTranspositions);
  const truncationScores = variantScores(names, truncations);
  const truncationScoresJw = variantScores(names, truncations, jaroWinkler);

  return {
    tau,
    moneyEqualPairs: surface.length,
    sizes: { moneyEqual: surface.length, ignoringMoney: ignoringMoney.length, sameFirstWord: firstWord.length },
    band: tauBand.map((bandTau) => ({
      tau: bandTau,
      moneyEqual: countsFor(surface, bandTau),
      ignoringMoney: countsFor(ignoringMoney, bandTau),
      sameFirstWord: countsFor(firstWord, bandTau),
      substitution: keptAt(substitutionScores, bandTau),
      transposition: keptAt(transpositionScores, bandTau),
      truncation: { ...keptAt(truncationScores, bandTau), jaroWinklerKept: keptAt(truncationScoresJw, bandTau).kept },
    })),
    sameBrandDifferentDish: found ? { a: found.a, b: found.b, levenshtein: nameSimilarity(found.a, found.b), jaroWinkler: jaroWinkler(found.a, found.b) } : null,
    emptyNormalizingNames,
    casefoldHazardNames: [...hazards].sort(),
  };
}

/** The row at the pinned τ, which is the one every guarantee below speaks about. */
function atPinnedTau(measured: SweepMeasurement): BandRow {
  const row = measured.band.find((candidate) => candidate.tau === measured.tau);
  if (!row) throw new Error(`the sweep band does not contain the pinned τ=${measured.tau}`);
  return row;
}

/**
 * The guarantees DECISIONS/0006 states. A violation is returned rather than thrown so the
 * test can print every broken one, and so a future change sees the whole picture at once.
 */
export function sweepViolations(measured: SweepMeasurement): string[] {
  const violations: string[] = [];

  if (measured.band.length !== tauBand.length) {
    violations.push(`the sweep must cover every τ in the safe band, saw ${measured.band.length} of ${tauBand.length}`);
  }
  for (const row of measured.band) {
    if (row.moneyEqual.levenshtein !== 0) {
      violations.push(`τ=${row.tau}: ${row.moneyEqual.levenshtein} false candidate(s) on the money-equal surface, expected 0`);
    }
  }

  const pinned = atPinnedTau(measured);
  if (!measured.sameBrandDifferentDish) {
    violations.push(`the decisive pair "${decisivePair.a}" / "${decisivePair.b}" is no longer a money-equal distinct pair in dev/cord-v2 — DECISIONS/0006's evidence would be unreproducible`);
  } else {
    const { levenshtein, jaroWinkler: jw } = measured.sameBrandDifferentDish;
    if (Math.abs(levenshtein - 0.5) > 0.0005) violations.push(`"${decisivePair.a}"/"${decisivePair.b}" scores ${levenshtein} under Levenshtein, expected 0.500`);
    if (Math.abs(jw - 0.891) > 0.0005) violations.push(`"${decisivePair.a}"/"${decisivePair.b}" scores ${jw} under Jaro-Winkler, expected 0.891`);
  }
  if (pinned.moneyEqual.jaro <= 0 || pinned.moneyEqual.jaroWinkler <= 0) {
    violations.push(`at τ=${measured.tau} the rejected metrics admit ${pinned.moneyEqual.jaro} (Jaro) and ${pinned.moneyEqual.jaroWinkler} (Jaro-Winkler) false candidates — DECISIONS/0006 records 3 each, so the rejection needs re-arguing`);
  }
  if (pinned.substitution.total === 0 || pinned.substitution.kept / pinned.substitution.total < 0.95) {
    violations.push(`single-substitution retention ${pinned.substitution.kept}/${pinned.substitution.total} is below the 0.95 floor DECISIONS/0006 pins at τ=${measured.tau}`);
  }
  if (pinned.transposition.total === 0 || pinned.transposition.kept / pinned.transposition.total < 0.85) {
    violations.push(`adjacent-transposition retention ${pinned.transposition.kept}/${pinned.transposition.total} is below the 0.85 floor DECISIONS/0006 pins at τ=${measured.tau}`);
  }
  if (measured.casefoldHazardNames.length > 0) {
    violations.push(`item names contain codepoints where toLowerCase() and Unicode casefolding disagree: ${measured.casefoldHazardNames.join(", ")}`);
  }
  return violations;
}
