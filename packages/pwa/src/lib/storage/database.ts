/**
 * Ticket 14 — opening the database, and moving it forward (DECISIONS/0023 P3, P4, P9).
 *
 * The two-phase open is not a style choice. An `onupgradeneeded` transaction auto-commits the moment its
 * IndexedDB request queue drains, so nothing that is not an IndexedDB request can be awaited inside it —
 * which means a user prompt or a file download cannot happen mid-upgrade. "Export before any migration that
 * cannot be made lossless" (§10 line 752) is therefore only implementable *before* the database is opened at
 * the target version: probe the stored version, gate on it, then upgrade.
 */

import type { MigrationFailure, MigrationStep } from "./schema.js";
import { notImplemented } from "./schema.js";

/** The factory seam. Defaults to `globalThis.indexedDB`; the rig passes its own so tests never share state. */
export interface OpenDatabaseOptions {
  readonly factory?: IDBFactory;
  /**
   * P9's rig seam: a test-local chain, used to prove the gate and the abort with steps that ship nowhere.
   * Nothing in `src/` ever passes it — the shipped chain comes from `MIGRATIONS`, and a test asserts that.
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
  readonly now?: () => string;
}

/** What the gate needs to say: which step is lossy, and what is at stake. */
export interface GateNeeded {
  readonly from: number;
  readonly to: number;
  readonly step: MigrationStep;
  readonly billCount: number;
}

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

/** P3: the upgrade aborted. The database is still at `failure.from`, with its data intact. */
export class MigrationFailedError extends Error {
  readonly failure: MigrationFailure;

  constructor(failure: MigrationFailure) {
    super(`migration from ${failure.from} to ${failure.to} aborted: ${String(failure.cause)}`);
    this.name = "MigrationFailedError";
    this.failure = failure;
  }
}

/** P4: the user declined the export, so the upgrade was never requested. Nothing changed. */
export class UpgradeDeclinedError extends Error {
  readonly at: number;

  constructor(at: number) {
    super(`upgrade to a new schema version declined; staying at version ${at}`);
    this.name = "UpgradeDeclinedError";
    this.at = at;
  }
}

/**
 * P3's phase 1: the stored version, read without upgrading anything. Opening with no version argument opens
 * at the current version and creates at version 1 when absent — the behaviour pins 3 and 26 assert in both
 * implementations rather than trusting it.
 */
export function readStoredVersion(factory: IDBFactory, name?: string): Promise<number> {
  notImplemented("P3");
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
    super(`this device holds schema version ${storedVersion}, which is newer than this build's ${requestedVersion}`);
    this.name = "DatabaseVersionTooNewError";
    this.storedVersion = storedVersion;
    this.requestedVersion = requestedVersion;
  }
}

/** P3: probe → gate → upgrade. The only way this module opens a database. */
export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<DatabaseHandle> {
  notImplemented("P3");
}
