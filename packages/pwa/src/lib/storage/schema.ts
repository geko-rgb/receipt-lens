/**
 * Ticket 14 — the database identity and its migration chain (DECISIONS/0023 P2, P3, P4).
 *
 * The version number is the whole schema contract: one named database, a monotonic version, and a
 * sequential chain in which every step from every supported prior version exists as its own entry.
 * A released step is never edited in place (§10 line 749), so this array only ever grows.
 *
 * Today it holds one step — the store-creation step that runs when the database does not exist yet —
 * because `DB_SCHEMA_VERSION` is 1. The chain-shape test in `tests/persistence/pins.test.ts` is what
 * stops a future bump from landing without its step.
 */

/** §10 line 749: one named database. */
export const DB_NAME = "receipt-lens";

/** §10 line 749: monotonic, starting at 1. A schema change increments it and adds a step; nothing else moves it. */
export const DB_SCHEMA_VERSION = 1;

/** P2's store list. Nothing here holds a receipt image unless the creator opted into that one row. */
export const STORE_NAMES = ["bills", "creatorProfile", "retainedImages"] as const;

export type StoreName = (typeof STORE_NAMES)[number];

/** P4's four clauses. A step declares the ones it satisfies; declaring fewer than all four makes it lossy. */
export type LosslessClause = "L1" | "L2" | "L3" | "L4";

/**
 * P4: `lossless` is an assertion a mechanical check can refute, not a comment. A step that cannot name all
 * four clauses is `{ lossless: false }` — fail-closed by default, because the cost of guessing wrong is the
 * user's bills.
 */
export type LosslessProof =
  | { readonly lossless: true; readonly clauses: readonly LosslessClause[] }
  | { readonly lossless: false; readonly reason: string };

/**
 * P3: a step runs inside IndexedDB's `versionchange` transaction and issues request chains only. Nothing
 * non-IDB may be awaited here — the transaction auto-commits when its request queue drains, which is why the
 * export gate (P4) runs before `open()` is called at the target version rather than in here.
 */
export interface MigrationStep {
  readonly from: number;
  readonly description: string;
  readonly lossless: LosslessProof;
  readonly up: (transaction: IDBTransaction, database: IDBDatabase) => void;
}

/** P4's gate question, answered from the chain alone: does this range need the user to export first? */
export function requiresExport(before: number, target: number): boolean {
  notImplemented("P4");
}

/**
 * P4's mechanical half: the key paths a step dropped or retyped, computed from a record before and after it.
 * A declared-lossless step must return nothing here for every committed fixture it is run against, which is
 * what makes `lossless` a checked property rather than a comment. A path present in `before` and absent from
 * `after` is an L1/L2 violation; a path whose `typeof` or array/object tag changed is one too.
 *
 * L3 and L4 are counts, and counts are read off the migrated store itself — the test asserts
 * `after.length === before.length` and one output per input. A helper that took a step and a list would have
 * to run the step outside a transaction to count its output, which is exactly the semantics P3 pins as
 * impossible.
 */
export function droppedFieldPaths(before: unknown, after: unknown): string[] {
  notImplemented("P4");
}


/**
 * The shipped chain. Exactly one step today: creating the three stores. It reads nothing, so it satisfies
 * all four clauses trivially — there is no prior data to lose.
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 0,
    description: "create the bills, creatorProfile and retainedImages stores (DECISIONS/0023 P2)",
    lossless: { lossless: true, clauses: ["L1", "L2", "L3", "L4"] },
    up: () => notImplemented("P3"),
  },
];

/** P3's failure, carried to the UI so the recoverable surface can name the step that broke. */
export interface MigrationFailure {
  readonly from: number;
  readonly to: number;
  readonly cause: unknown;
}

export function notImplemented(pin: string): never {
  throw new Error(`not implemented: DECISIONS/0023 ${pin}`);
}
