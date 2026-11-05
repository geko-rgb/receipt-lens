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

/** The keyPath of each store, so creation and the repository never disagree about a key. */
export const STORE_KEY_PATHS: Record<StoreName, string> = {
  bills: "billId",
  creatorProfile: "id",
  retainedImages: "billId",
};

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

/** The shipped chain: create the three stores. It reads nothing, so all four clauses hold trivially. */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 0,
    description: "create the bills, creatorProfile and retainedImages stores (DECISIONS/0023 P2)",
    lossless: { lossless: true, clauses: ["L1", "L2", "L3", "L4"] },
    up: (_transaction, database) => {
      for (const name of STORE_NAMES) {
        if (database.objectStoreNames.contains(name)) continue;
        database.createObjectStore(name, { keyPath: STORE_KEY_PATHS[name] });
      }
    },
  },
];

/** P3's failure, carried to the UI so the recoverable surface can name the step that broke. */
export interface MigrationFailure {
  readonly from: number;
  readonly to: number;
  readonly cause: unknown;
}

/** The steps that would run between two versions, in order. A gap is a chain bug, never a silent no-op. */
export function chainSteps(
  before: number,
  target: number,
  chain: readonly MigrationStep[] = MIGRATIONS,
): readonly MigrationStep[] {
  const steps: MigrationStep[] = [];
  for (let version = before; version < target; version += 1) {
    const step = chain.find((candidate) => candidate.from === version);
    if (!step) throw new Error(`no migration registered from schema version ${version} to ${version + 1}`);
    steps.push(step);
  }
  return steps;
}

/**
 * P4's gate question, answered from the chain alone: does this range contain a step that is not provably
 * lossless? Whether the range holds any *data* is a second question, asked at the gate site in
 * `database.ts` — a fresh install has nothing to export, and blocking it on a modal would be a bug.
 */
export function requiresExport(
  before: number,
  target: number,
  chain: readonly MigrationStep[] = MIGRATIONS,
): boolean {
  return chainSteps(before, target, chain).some((step) => step.lossless.lossless === false);
}

/** A value's storage kind. A change here is P4's L2 (a field's meaning moved). */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "binary";
  return typeof value;
}

/**
 * P4's mechanical half: the key paths a step dropped or retyped, computed from one record before and after.
 * A declared-lossless step must return nothing here for every committed fixture it is run against, which is
 * what makes `lossless` a checked property rather than a comment.
 *
 * L3 and L4 are counts, and counts are read off the migrated store itself — a test asserts
 * `after.length === before.length` with one output per input. A helper that took a step and a list would have
 * to run the step outside a transaction to count its output, which is the semantics P3 pins as impossible.
 *
 * A path absent from `before` is not a violation: adding a field is lossless by definition.
 */
export function droppedFieldPaths(before: unknown, after: unknown): string[] {
  const dropped: string[] = [];

  function walk(source: unknown, target: unknown, path: string): void {
    if (source === undefined) return;
    if (target === undefined) {
      dropped.push(path);
      return;
    }
    const sourceKind = kindOf(source);
    if (sourceKind !== kindOf(target)) {
      dropped.push(path);
      return;
    }
    if (sourceKind === "object") {
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        walk(value, (target as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    if (sourceKind === "array") {
      const beforeItems = source as readonly unknown[];
      const afterItems = target as readonly unknown[];
      // A shortened array is a dropped record, not a re-shaped one, and L1 reads it as a loss.
      if (afterItems.length < beforeItems.length) dropped.push(`${path}[length]`);
      beforeItems.forEach((item, index) => walk(item, afterItems[index], `${path}[${index}]`));
    }
  }

  walk(before, after, "");
  return dropped.sort();
}
