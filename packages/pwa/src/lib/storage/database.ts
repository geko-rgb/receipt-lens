/**
 * Ticket 14 — opening the database, and moving it forward (DECISIONS/0023 P3, P4, P9).
 *
 * The two-phase open is not a style choice. An `onupgradeneeded` transaction auto-commits the moment its
 * IndexedDB request queue drains, so nothing that is not an IndexedDB request can be awaited inside it —
 * which means a user prompt or a file download cannot happen mid-upgrade. "Export before any migration that
 * cannot be made lossless" (§10 line 752) is therefore only implementable *before* the database is opened at
 * the target version: probe the stored version, gate on it, then upgrade.
 *
 * The probe is also where the three failure surfaces are told apart, because each has to be answered before
 * any write is attempted: a version newer than this build (`DatabaseVersionTooNewError`), a lossy step the
 * user has not yet exported against (`UpgradeDeclinedError`), and a step that failed on the way through
 * (`MigrationFailedError`, with the database left exactly as it was).
 */

import { countOf, run } from "./idb.js";
import type { MigrationFailure, MigrationStep } from "./schema.js";
import { DB_NAME, DB_SCHEMA_VERSION, MIGRATIONS, chainSteps } from "./schema.js";

/** The factory seam. Defaults to `globalThis.indexedDB`; the rig passes its own so tests never share state. */
export interface OpenDatabaseOptions {
  readonly factory?: IDBFactory;
  /**
   * P9's rig seam: a test-local chain, used to prove the gate and the abort with steps that ship nowhere.
   * Nothing in `src/` ever passes it — the shipped chain comes from `MIGRATIONS`, and a pin asserts that.
   */
  readonly migrations?: readonly MigrationStep[];
  /**
   * The version to open at. Defaults to `DB_SCHEMA_VERSION`; a rig that exercises a v1→v2 step has to ask
   * for 2, because the shipped constant is 1 and P9 forbids bumping it to make a test pass.
   */
  readonly targetVersion?: number;
  /** P4's gate. Resolves once the user has produced an export, or declines. */
  readonly onGate?: (needed: GateNeeded) => Promise<"exported" | "declined">;
  /** P3's `blocked` surface: another connection is holding the database. */
  readonly onBlocked?: (waitingMs: number) => void;
  /** P9's counter: fired once per `onupgradeneeded` dispatch, with what it executed. */
  readonly onUpgrade?: (info: UpgradeDispatch) => void;
  /** P3: this connection was asked to yield because something is upgrading. The session marks itself stale. */
  readonly onVersionChange?: () => void;
}

/** What the gate needs to say: which step is lossy, and what is at stake. */
export interface GateNeeded {
  readonly from: number;
  readonly to: number;
  readonly step: MigrationStep;
  readonly billCount: number;
}

/** One `onupgradeneeded` dispatch: the versions it crossed, and how many shipped steps it ran. */
export interface UpgradeDispatch {
  readonly oldVersion: number;
  readonly newVersion: number;
  readonly stepsExecuted: number;
}

/** An opened database, plus the version it is actually at. */
export interface DatabaseHandle {
  readonly database: IDBDatabase;
  readonly version: number;
  readonly factory: IDBFactory;
  close(): void;
}

/** P3: the upgrade aborted. The database is still at its old version, with its data intact. */
export class MigrationFailedError extends Error {
  readonly failure: MigrationFailure;

  constructor(failure: MigrationFailure) {
    super(`migration from ${failure.from} to ${failure.to} aborted: ${describeCause(failure.cause)}`);
    this.name = "MigrationFailedError";
    this.failure = failure;
  }
}

/** P4: the export was declined or unanswered, so the upgrade was never requested. Nothing changed. */
export class UpgradeDeclinedError extends Error {
  readonly at: number;

  constructor(at: number) {
    super(`upgrade to a new schema version declined; staying at version ${at}`);
    this.name = "UpgradeDeclinedError";
    this.at = at;
  }
}

/**
 * P3's `VersionError`: the database on disk is at a *higher* version than this build knows. The data is
 * newer than the app, so nothing is opened and nothing is changed — the reverse of a migration failure, and
 * the reason "just open it anyway" is not available.
 */
export class DatabaseVersionTooNewError extends Error {
  readonly storedVersion: number;
  readonly requestedVersion: number;

  constructor(storedVersion: number, requestedVersion: number) {
    super(
      `this device holds schema version ${storedVersion}, which is newer than this build's ${requestedVersion}`,
    );
    this.name = "DatabaseVersionTooNewError";
    this.storedVersion = storedVersion;
    this.requestedVersion = requestedVersion;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function resolveFactory(factory: IDBFactory | undefined): IDBFactory {
  const chosen = factory ?? globalThis.indexedDB;
  if (!chosen) throw new Error("IndexedDB is not available in this environment");
  return chosen;
}

/**
 * One `open()` call, with the upgrade chain run inline and every failure surfaced by name. A `version` of
 * `undefined` means "open at whatever version is stored, creating at version 1 if absent" — the probe.
 */
function openAt(
  factory: IDBFactory,
  version: number | undefined,
  chain: readonly MigrationStep[],
  options: OpenDatabaseOptions,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(DB_NAME) : factory.open(DB_NAME, version);
    const requestedAt = Date.now();
    let stepFailure: MigrationFailure | null = null;

    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (!transaction) return;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion ?? request.result.version;
      try {
        const steps = chainSteps(oldVersion, newVersion, chain);
        for (const step of steps) step.up(transaction, request.result);
        options.onUpgrade?.({ oldVersion, newVersion, stepsExecuted: steps.length });
      } catch (cause) {
        // P3: the step failed, so the version-change transaction must not stand. `abort()` discards the data
        // writes *and* the schema writes made inside it, which is the guarantee the rollback pins assert.
        stepFailure = { from: oldVersion, to: newVersion, cause };
        try {
          transaction.abort();
        } catch {
          reject(new MigrationFailedError(stepFailure));
        }
      }
    };
    request.onblocked = () => options.onBlocked?.(Date.now() - requestedAt);
    request.onsuccess = () => {
      const database = request.result;
      // P3: a connection that survives an upgrade from another tab would keep writing against the old schema.
      database.addEventListener("versionchange", () => {
        options.onVersionChange?.();
        database.close();
      });
      resolve(database);
    };
    request.onerror = () => {
      if (stepFailure) reject(new MigrationFailedError(stepFailure));
      else reject(request.error ?? new Error(`opening ${DB_NAME} failed`));
    };
  });
}

/** How much data the database holds, for P4's "is there anything to lose" half of the gate. */
function countEverything(database: IDBDatabase): Promise<{ total: number; bills: number }> {
  const names = [...database.objectStoreNames];
  if (names.length === 0) return Promise.resolve({ total: 0, bills: 0 });
  return run(database, names, "readonly", (transaction) =>
    Promise.all(names.map((name) => countOf(transaction, name))),
  ).then((counts) => {
    const pairs = names.map((name, index) => [name, counts[index] ?? 0] as const);
    return {
      total: pairs.reduce((sum, [, count]) => sum + count, 0),
      bills: pairs.find(([name]) => name === "bills")?.[1] ?? 0,
    };
  });
}

/** P3's phase 1 on its own: the stored version, read without upgrading beyond store creation. */
export async function readStoredVersion(factory?: IDBFactory): Promise<number> {
  const database = await openAt(resolveFactory(factory), undefined, MIGRATIONS, {});
  const version = database.version;
  database.close();
  return version;
}

/**
 * P3's two phases and P4's gate, in one call.
 *
 * The probe is opened *first* so the stored version and the record counts can be read at the old schema —
 * that is what makes an export taken before a lossy migration a backup of what the app actually wrote rather
 * than of whatever the step left behind. The probe is closed before the target version is requested, because
 * a connection from the same page would otherwise block its own upgrade.
 */
export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<DatabaseHandle> {
  const factory = resolveFactory(options.factory);
  const chain = options.migrations ?? MIGRATIONS;
  const target = options.targetVersion ?? DB_SCHEMA_VERSION;

  const probe = await openAt(factory, undefined, chain, options);
  const stored = probe.version;

  if (stored > target) {
    probe.close();
    throw new DatabaseVersionTooNewError(stored, target);
  }
  if (stored === target) {
    return { database: probe, version: stored, factory, close: () => probe.close() };
  }

  const lossy = chain.find(
    (step) => step.from >= stored && step.from < target && step.lossless.lossless === false,
  );
  if (lossy) {
    const counts = await countEverything(probe);
    // P4: an empty database has nothing to lose, so a fresh install is never blocked on a backup modal.
    if (counts.total > 0) {
      const needed: GateNeeded = { from: stored, to: target, step: lossy, billCount: counts.bills };
      // No gate callback means nobody is there to tell the user: fail closed and stay at the old version.
      const choice = options.onGate ? await options.onGate(needed) : "declined";
      if (choice !== "exported") {
        probe.close();
        throw new UpgradeDeclinedError(stored);
      }
    }
  }

  probe.close();
  const database = await openAt(factory, target, chain, options);
  return { database, version: database.version, factory, close: () => database.close() };
}
