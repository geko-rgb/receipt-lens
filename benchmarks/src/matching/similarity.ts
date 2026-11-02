/**
 * §8.1 name normalization and the DECISIONS/0006 similarity metric. Everything here is a
 * pure function of its input: no locale-dependent collation, no clock, no environment.
 * The scorer version in `benchmark.config` covers these functions — changing one invalidates
 * every published number, which is the point of pinning it.
 */

/**
 * NFC, casefold, punctuation replaced by a space, whitespace collapsed.
 *
 * Punctuation becomes a **space**, not nothing: `"A.B"` must not normalize to `"ab"`, which
 * would let it match a genuinely different item. Digits and word characters are kept, per
 * §8.1's "do not discard meaningful words or digits".
 *
 * `toLowerCase()` is locale-independent (unlike `toLocaleLowerCase`), so `İ` and `ı` behave
 * the same on every machine. It is not full Unicode CaseFolding: `ß` stays `ß` rather than
 * becoming `ss`, and ligatures like `ﬁ` stay single. Neither occurs in either pinned
 * snapshot — `matching/sweep.ts` asserts that, so a future fixture carrying one fails the
 * gate instead of silently scoring differently from the reference implementation.
 */
export function normalizeItemName(raw: string): string {
  const folded = raw.normalize("NFC").toLowerCase();
  const withoutPunctuation = folded.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ");
  return withoutPunctuation.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Unit-cost Levenshtein distance, computed exactly — no early exit, no band truncation. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * DECISIONS/0006: `1 − lev / max(len)`, over already-normalized names.
 *
 * `("", "")` is defined as 1.0 rather than left as the ratio's 0/0: an empty name carries no
 * name evidence, so it may only pair with another empty name, and no similarity computation
 * in this harness can ever return NaN. Every caller must pass normalized input.
 */
export function nameSimilarity(normalizedA: string, normalizedB: string): number {
  const longer = Math.max(normalizedA.length, normalizedB.length);
  if (longer === 0) return 1;
  return 1 - levenshtein(normalizedA, normalizedB) / longer;
}

/**
 * Jaro-Winkler exists in this file only as the counterfactual DECISIONS/0006 rejected, and
 * only `matching/sweep.ts` calls it. The matcher must never import it: if the rejected metric
 * ever reached a score, the pinned τ would mean something else entirely.
 */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  if (j <= 0.7) return j;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return j + prefix * 0.1 * (1 - j);
}

export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - window); j < Math.min(i + window + 1, b.length); j += 1) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  return (matches / a.length + matches / b.length + (matches - Math.floor(transpositions / 2)) / matches) / 3;
}
