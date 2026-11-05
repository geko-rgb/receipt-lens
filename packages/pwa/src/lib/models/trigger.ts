/**
 * Ticket 17 — the model-download trigger of DECISIONS/0027 W2.1, as ruled at checkpoint 1.
 *
 * > Model set download triggers on navigation to `/capture` (not app boot, not first-OCR). … the population
 * > that navigates to `/share` (participants viewing a bill) or browses the ledger without capturing should
 * > never download the model.
 *
 * The rule is expressed as a pure predicate over a phase, not as an effect, so W2.1's four consequences —
 * `/share` stays silent, no second download while one is in flight, a failed attempt may be retried — are all
 * assertable without a browser.
 */

/** Where the last attempt for this document got to. */
export type PreparationPhase = "idle" | "in-flight" | "succeeded" | "failed";

/** The router's route names, from `src/lib/router.ts`. */
export type CaptureRoute = "capture" | "bill" | "bills" | "share" | "not-found";

export interface TriggerInput {
  readonly route: CaptureRoute;
  readonly phase: PreparationPhase;
}

/**
 * True exactly when a model preparation should start (W2.1).
 *
 * Note what is *not* an input: whether a verified set already exists. The probe is how the app learns the
 * served version, so suppressing it on a local guess would break the once-per-version early exit at W5 step 1
 * and leave a stale set active forever.
 */
export function shouldPrepareModelSet(input: TriggerInput): boolean {
  throw new Error(`not implemented: DECISIONS/0027 W2.1 — capture-route trigger (${input.route}/${input.phase})`);
}
