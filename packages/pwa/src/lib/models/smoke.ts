/**
 * Ticket 17 — the smoke gate of DECISIONS/0027 W5 step 5.
 *
 * The bar is **at least one line and at least one word**, mirroring `DECISIONS/0012` F9 condition 8. It is
 * deliberately not a specific string: this step asks "do these weights execute and produce a plausible
 * output", not "is Tiny accurate". Accuracy was measured and published by ticket 09b, and making activation
 * depend on it would leave the app un-updatable whenever a receipt is hard to read. A swapped or corrupt model
 * fails at session creation or returns nothing, and both fail here.
 */

/** W5 step 5's bar. */
export const SMOKE_MIN_LINES = 1;
export const SMOKE_MIN_WORDS = 1;

/** A run either produced counts or it failed; a run that did neither is not evidence of a working model. */
export interface SmokeCounts {
  readonly lines?: number;
  readonly words?: number;
  readonly error?: string;
}

/**
 * True when a smoke run proves the candidate set executes. An error, zero lines or zero words all reject it —
 * and so does a run that reported no counts at all, since `?? 0` puts it under the floor rather than through it.
 */
export function acceptsSmokeResult(result: SmokeCounts): boolean {
  if (result.error !== undefined) return false;
  return (result.lines ?? 0) >= SMOKE_MIN_LINES && (result.words ?? 0) >= SMOKE_MIN_WORDS;
}
