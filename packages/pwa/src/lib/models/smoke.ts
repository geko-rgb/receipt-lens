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

export interface SmokeCounts {
  readonly lines: number;
  readonly words: number;
}

/** True when a smoke run proves the candidate set executes. An error, zero lines or zero words all reject it. */
export function acceptsSmokeResult(result: SmokeCounts | { readonly error: string }): boolean {
  throw new Error("not implemented: DECISIONS/0027 W5 step 5 — smoke acceptance bar");
}
