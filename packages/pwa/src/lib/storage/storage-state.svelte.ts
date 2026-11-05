/**
 * Ticket 14 — the reactive half of storage: the lifecycle screens and the operations the views call
 * (DECISIONS/0023 P3, P4, P7, P10).
 *
 * `lib/storage/*.ts` is framework-free and returns outcomes; this module is the only place storage becomes
 * `$state`, for the same reason `bill-document.svelte.ts` is the only place the document does (0019 S1): the
 * rules have to stay testable without a component tree. Nothing here decides a storage behaviour — it routes
 * outcomes to screens and routes screens' buttons back to the session.
 *
 * Four surfaces live here, and they are deliberately different because four things went differently wrong:
 * a migration aborted (P3), a lossy upgrade waiting on an export (P4), a database newer than this build (P3),
 * and a write that could not land (P10). Each says what it did not do — nothing was deleted — and each can
 * produce a backup.
 */

import type { GateNeeded } from "./database.js";
import { DatabaseVersionTooNewError, MigrationFailedError, UpgradeDeclinedError } from "./database.js";
import { downloadEnvelope } from "./download.js";
import type { StorageSession } from "./session.js";
import { appSession, createSession } from "./session.js";
import type { SessionOptions } from "./session.js";
import { buildBackup } from "./backup.js";

export type StoragePhase = "ready" | "gating" | "migration-failed" | "version-too-new" | "declined";

/** What a screen may say, and nothing else: a code, the versions involved, and the reason text. */
export interface StorageNotice {
  readonly phase: StoragePhase;
  readonly from: number;
  readonly to: number;
  readonly step: string;
  readonly reason: string;
  readonly billCount: number;
  /** P4: the file this session has already produced. The upgrade cannot proceed without one. */
  readonly exportedTo: string | null;
}

let notice: StorageNotice | null = $state.raw(null);
let blocked: { waitingMs: number } | null = $state.raw(null);
let created: StorageSession | null = null;

function classify(cause: unknown): StorageNotice | null {
  if (cause instanceof MigrationFailedError) {
    return {
      phase: "migration-failed",
      from: cause.failure.from,
      to: cause.failure.to,
      step: String(cause.failure.to - 1),
      reason: cause.message,
      billCount: 0,
      exportedTo: null,
    };
  }
  if (cause instanceof DatabaseVersionTooNewError) {
    return {
      phase: "version-too-new",
      from: cause.storedVersion,
      to: cause.requestedVersion,
      step: "",
      reason: cause.message,
      billCount: 0,
      exportedTo: null,
    };
  }
  if (cause instanceof UpgradeDeclinedError) {
    return {
      phase: "declined",
      from: cause.at,
      to: cause.at + 1,
      step: "",
      reason: cause.message,
      billCount: 0,
      exportedTo: null,
    };
  }
  return null;
}

/** The options the app's session is created with. A rig session never uses this path. */
function appOptions(): SessionOptions {
  return {
    onGate: (needed: GateNeeded) =>
      new Promise<"exported" | "declined">((resolve) => {
        // P4: the gate is a screen, not a toast. The promise stays pending until the user chooses, and the
        // upgrade has not been requested yet, so "Not yet" leaves the app running at the old version.
        notice = {
          phase: "gating",
          from: needed.from,
          to: needed.to,
          step: needed.step.description,
          reason: needed.step.lossless.lossless === false ? needed.step.lossless.reason : "",
          billCount: needed.billCount,
          exportedTo: null,
        };
        gateResolve = resolve;
      }),
    onBlocked: (waitingMs: number) => {
      blocked = { waitingMs };
    },
    onOpenFailure: (cause: unknown) => {
      const found = classify(cause);
      if (found) notice = found;
    },
  };
}

let gateResolve: ((choice: "exported" | "declined") => void) | null = null;

export const storage = {
  get notice(): StorageNotice | null {
    return notice;
  },

  /** P3: another tab is holding the database while this one waits to upgrade. */
  get blocked(): { waitingMs: number } | null {
    return blocked;
  },

  clearBlocked(): void {
    blocked = null;
  },

  /** The app's session, created on first use so importing this module opens no database (P7). */
  session(): StorageSession {
    created ??= appSession(appOptions());
    return created;
  },

  /** A rig session over a caller's own factory, with no lifecycle screen attached. */
  forTesting(options: SessionOptions): StorageSession {
    return createSession(options);
  },

  /**
   * P4/P10: produce the backup and remember that it happened. The export reads at the *stored* version, so
   * the file is what this app wrote — before the step, and after an abort.
   */
  async exportBackup(): Promise<string | null> {
    try {
      // The clock is read here, at the boundary, exactly as `Bill.svelte:46` reads it for `createdAt`.
      const envelope = await buildBackup({ exportedAt: new Date().toISOString() });
      const name = downloadEnvelope(envelope);
      notice = notice ? { ...notice, exportedTo: name } : notice;
      return name;
    } catch {
      return null;
    }
  },

  /** P4: the only way forward past a gate is a file this session actually produced. */
  continueAfterExport(): void {
    if (!notice || notice.phase !== "gating" || notice.exportedTo === null) return;
    gateResolve?.("exported");
    gateResolve = null;
    notice = null;
  },

  /** P4: "Not yet" — no transaction, no upgrade, the app keeps working at the version it is at. */
  declineGate(): void {
    if (notice?.phase !== "gating") return;
    gateResolve?.("declined");
    gateResolve = null;
    notice = { ...notice, phase: "declined" };
  },

  /** P3: after an abort the database is untouched, so a retry is a real option — the second one usually is. */
  async retryUpgrade(): Promise<boolean> {
    if (!notice) return false;
    notice = null;
    try {
      await storage.session().connect();
      return true;
    } catch (cause) {
      const found = classify(cause);
      if (found) notice = found;
      return false;
    }
  },

  /** P4: the declined state is not permanent; the next launch, or this button, asks again. */
  async offerUpgradeAgain(): Promise<boolean> {
    return storage.retryUpgrade();
  },

  /** Every view operation runs through here, so a lifecycle failure always reaches a screen. */
  async guard<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (cause) {
      const found = classify(cause);
      if (found) notice = found;
      else throw cause;
      return null;
    }
  },

  /** Test seam: the screens' state, reset between cases. */
  reset(): void {
    notice = null;
    blocked = null;
    gateResolve = null;
  },
};
