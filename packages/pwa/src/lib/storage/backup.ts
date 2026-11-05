/**
 * Ticket 14 — the backup read path (DECISIONS/0023 P4, P9, P10).
 *
 * A backup has to be taken at the version the records were written at, which is never the version this build
 * wants to move to: the whole promise is "here is what you had, before the step that might lose it". So this
 * module asks the stored version first, opens *at* it, and copies rows out — no upgrade is requested, so a
 * failed or gated migration cannot corrupt what the export reads.
 *
 * It opens its own short-lived connection rather than borrowing the session's, because the gate and the abort
 * both happen while the session's connection is mid-flight: the gate promise is unresolved inside
 * `onupgradeneeded`'s predecessor, and an aborted upgrade leaves no live handle at all.
 */

import { openDatabase, readStoredVersion } from "./database.js";
import type { ExportEnvelope } from "./records.js";
import { exportJson } from "./repository.js";

export interface BackupOptions {
  readonly factory?: IDBFactory;
  readonly name?: string;
  /** ISO stamp for the envelope. Supplied, never read: `lib/storage/*` reads no clock (0011's rule). */
  readonly exportedAt: string;
}

/** Reads the whole database at its current version and builds the envelope. The connection is closed after. */
export async function buildBackup(options: BackupOptions): Promise<ExportEnvelope> {
  const factory = options.factory ?? globalThis.indexedDB;
  const stored = await readStoredVersion(factory);
  // Opening *at* the stored version is the point: `openDatabase` only upgrades when asked for a higher one,
  // so this path can never be the thing that mutates the data it is trying to preserve.
  const handle = await openDatabase({ factory, targetVersion: stored });
  try {
    return await exportJson(handle, options.exportedAt);
  } finally {
    handle.close();
  }
}
