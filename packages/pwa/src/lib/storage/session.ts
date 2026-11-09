/**
 * Ticket 14 — the session: one live connection and the save choreography around it
 * (DECISIONS/0023 P1, P5, P6, P7, P10).
 *
 * Framework-free on purpose (0019 S1): it returns outcomes, and the reactive slot decides what is `$state`.
 * `createSession` exists because P5's concurrency pin needs two of these over one factory — two tabs, one
 * database — and a module singleton would make that behaviour untestable rather than merely awkward.
 * `appSession()` is the one the browser uses.
 *
 * The clock: `lib/bill/*` and `lib/storage/repository.ts` never read one (0011's determinism rule), so
 * `savedAt` comes from `options.now`. The session is the boundary allowed to default it, exactly as
 * `Bill.svelte:46` is for `createdAt`.
 */

import type { BillDocument } from "../bill/document.js";
import { rebuildDocument, type TransactionResult } from "../bill/transactions.js";
import type { CreatorProfile } from "../entities.js";
import type { DatabaseHandle, GateNeeded, OpenDatabaseOptions } from "./database.js";
import { openDatabase } from "./database.js";
import type { ExportEnvelope, StoredBillRecord } from "./records.js";
import {
  deleteBill as deleteBillRecord,
  deleteRetainedImage as deleteRetainedImageRecord,
  exportJson,
  hasRetainedImage as storeHasRetainedImage,
  readRetainedImage as readRetainedImageRecord,
  listBills as listBillRecords,
  loadBill,
  loadCreatorProfile,
  mostRecentBill,
  putRetainedImage,
  saveBill,
  saveCreatorProfile,
  type SaveBillOutcome,
} from "./repository.js";

/** P10's save chip states. `not saved` is the only one that may coexist with an edit still on screen. */
export type SaveStatus = "idle" | "saving" | "saved" | "not saved" | "divergent";

/**
 * P5's replayable thunk: the operation and its arguments, captured at publish time. Held in memory only —
 * never in the document, never on disk, so 0019 S6's JSON-safety is untouched. One thunk, replaced by the
 * next commit and discarded when a save lands: a queue of replays would be an undo stack wearing P5's
 * clothes (0019 "does not decide" — v1 has no history).
 */
export type ReplayableOperation = (document: BillDocument) => TransactionResult;

/** What a save reports to the slot. The UI reads `status`, never a message string (§6 line 401's rule). */
export interface PersistReport {
  readonly status: SaveStatus;
  readonly outcome: SaveBillOutcome;
  /** P5's divergence detail, present exactly when `status === "divergent"`. */
  readonly stored?: { readonly revision: number; readonly savedAt: string };
  /**
   * P5: the runner's answer to re-running the held thunk, present only on the report from `reapply`. A
   * rejection there is the runner's own — `bill_locked`, `unknown_entity` — and the standard rejection
   * surface shows it. P5 invents no code of its own, and must not report a save that never happened.
   */
  readonly replay?: TransactionResult;
}

/** What a caller hands an image over with. `retainedAt` is the session's clock, not the caller's (0011). */
export interface RetainedImageInput {
  readonly billId: string;
  readonly mediaType: string;
  readonly bytes: Blob | ArrayBuffer;
}

export interface SessionOptions extends OpenDatabaseOptions {
  readonly now?: () => string;
  /**
   * P10: an open that fails — a migration aborted, an export declined, a database newer than this build —
   * is a lifecycle event, not merely a failed save. The session still reports the save as `not saved`; this
   * is how the screen that explains it gets told. Never called for a write error on an open database
   * (quota and the closed-handle case are P10's storage-full surface, and they belong to the chip).
   */
  readonly onOpenFailure?: (cause: unknown) => void;
}

/** Everything the slot and the routes need, behind one object so two tabs are two of these. */
export interface StorageSession {
  readonly connect: () => Promise<DatabaseHandle>;
  readonly handle: () => DatabaseHandle | null;
  readonly disconnect: () => void;
  /** P7: write the document the root just published. `flush` awaits the queue of these. */
  readonly persist: (document: BillDocument, replay?: ReplayableOperation) => Promise<PersistReport>;
  /** P6: the second write, attempted only after the bill write succeeded. */
  readonly persistRetainedImage: (input: RetainedImageInput) => Promise<SaveStatus>;
  /** P5's first action: this tab's version wins, deliberately. */
  readonly overwrite: (document: BillDocument) => Promise<PersistReport>;
  /** P5's second action: rebuild the stored bill and re-run the held thunk through the runner. */
  readonly reapply: () => Promise<PersistReport>;
  readonly flush: () => Promise<void>;
  /** P7: the most recently saved bill, rebuilt, or null when this device holds nothing. */
  readonly restore: () => Promise<BillDocument | null>;
  /** P7's ledger row: one named bill, rebuilt. */
  readonly restoreBill: (billId: string) => Promise<BillDocument | null>;
  /**
   * P7's notice: when a record was written. `savedAt` is persistence metadata and deliberately not on the
   * document (P1), so a screen that wants to say "saved at…" asks the store rather than carrying a second
   * copy of it in memory.
   */
  readonly savedAtOf: (billId: string) => Promise<string | null>;
  readonly listBills: () => Promise<StoredBillRecord[]>;
  readonly deleteBill: (billId: string) => Promise<void>;
  readonly saveProfile: (profile: CreatorProfile) => Promise<void>;
  /** P8: read synchronously after `loadProfile()`, so a synchronous `billStore.begin` can seed the name. */
  readonly profile: () => CreatorProfile | null;
  readonly loadProfile: () => Promise<CreatorProfile | null>;
  readonly hasRetainedImage: (billId: string) => Promise<boolean>;
  /** P6's read half: the kept photo itself, as a `Blob` the caller wraps and revokes. */
  readonly readRetainedImage: (billId: string) => Promise<{ readonly blob: Blob; readonly mediaType: string } | null>;
  readonly deleteRetainedImage: (billId: string) => Promise<void>;
  /** P4: the envelope, ready for the browser to download. */
  readonly envelope: () => Promise<ExportEnvelope>;
  readonly status: () => SaveStatus;
  readonly divergence: () => { readonly revision: number; readonly savedAt: string } | null;
  /** P4: the gate the session last raised, or null. The screen renders from this, never from a guess. */
  readonly gate: () => GateNeeded | null;
}

/** P3/P4/P5/P7: the whole storage lifecycle, over a factory the caller owns. */
export function createSession(options: SessionOptions = {}): StorageSession {
  const now = options.now ?? ((): string => new Date().toISOString());

  let live: DatabaseHandle | null = null;
  let opening: Promise<DatabaseHandle> | null = null;
  let disconnected = false;
  /** P5: per bill, the stored revision this tab last read or last wrote. The whole divergence test is here. */
  const synced = new Map<string, number>();
  let pendingReplay: ReplayableOperation | null = null;
  let currentStatus: SaveStatus = "idle";
  let diverged: { revision: number; savedAt: string } | null = null;
  let raisedGate: GateNeeded | null = null;
  let cachedProfile: CreatorProfile | null = null;
  let queue: Promise<unknown>[] = [];

  async function ensureOpen(): Promise<DatabaseHandle> {
    // A disconnected session stays disconnected until `connect()` is called again: writes then fail against
    // the closed handle, which is the only honest route to P10's "your change is still on screen and was NOT
    // saved", and it is also what a `versionchange` close looks like from the writing side.
    if (disconnected) throw new Error("this session was disconnected; call connect() first");
    if (live) return live;
    opening ??= openDatabase({
      ...options,
      onGate: async (needed) => {
        raisedGate = needed;
        return options.onGate ? options.onGate(needed) : "declined";
      },
      onVersionChange: () => {
        currentStatus = "not saved";
      },
    });
    try {
      live = await opening;
    } catch (cause) {
      // A failed open is retryable: the next attempt must not re-play the rejected promise forever.
      opening = null;
      options.onOpenFailure?.(cause);
      throw cause;
    }
    opening = null;
    return live;
  }

  /** Records and reports one save outcome. `saved` is only ever set by a write that actually landed. */
  function report(outcome: SaveBillOutcome): PersistReport {
    if (outcome.status === "written") {
      currentStatus = "saved";
      diverged = null;
      pendingReplay = null;
      return { status: "saved", outcome };
    }
    if (outcome.status === "deferred") {
      currentStatus = "divergent";
      diverged = outcome.stored;
      return { status: "divergent", outcome, stored: outcome.stored };
    }
    currentStatus = "not saved";
    return { status: "not saved", outcome };
  }

  async function write(document: BillDocument, force: boolean): Promise<PersistReport> {
    // P10: storage being unavailable is a *failed save*, never a lost edit. The in-memory commit stands and
    // the chip carries the truth; nothing here reaches `TransactionRejectCode`, which has no such condition.
    let handle: DatabaseHandle;
    try {
      handle = await ensureOpen();
    } catch (cause) {
      return report({ status: "failed", cause });
    }
    const billId = document.working.bill.id;
    const outcome = await saveBill(handle, {
      document,
      savedAt: now(),
      syncedRevision: synced.get(billId) ?? null,
      ...(force ? { overwrite: true as const } : {}),
    });
    if (outcome.status === "written") synced.set(billId, outcome.record.revision);
    return report(outcome);
  }

  /** Queues a side effect so `flush()` can await it, and keeps its rejection out of the unhandled list. */
  function track<T>(work: Promise<T>): Promise<T> {
    const settled = work.catch(() => undefined);
    queue.push(settled);
    return work;
  }

  async function reapply(): Promise<PersistReport> {
    const operation = pendingReplay;
    const handle = await ensureOpen();
    if (!operation) {
      currentStatus = "not saved";
      return { status: "not saved", outcome: { status: "failed", cause: new Error("nothing pending to re-apply") } };
    }
    const stored = await mostRecentBill(handle);
    if (!stored) {
      currentStatus = "not saved";
      return { status: "not saved", outcome: { status: "failed", cause: new Error("the bill is no longer stored") } };
    }
    const base = rebuildDocument(stored.working, stored.revision);
    synced.set(stored.billId, stored.revision);
    const result = operation(base);
    if (!result.ok) {
      // P5: the runner refused the replay, so nothing is written and the caller shows its rejection. This is
      // the divergence test's second half — a stale tab must not be able to smuggle an edit past a lock.
      pendingReplay = null;
      currentStatus = "not saved";
      return { status: "not saved", outcome: { status: "failed", cause: result.reject }, replay: result };
    }
    pendingReplay = null;
    const written = await write(result.document, false);
    return { ...written, replay: result };
  }

  return {
    connect: () => {
      disconnected = false;
      return ensureOpen();
    },

    handle: () => live,

    disconnect: () => {
      live?.close();
      live = null;
      opening = null;
      disconnected = true;
    },

    persist: (document, replay) => {
      pendingReplay = replay ?? null;
      currentStatus = "saving";
      return track(write(document, false));
    },

    persistRetainedImage: (input) =>
      track(
        (async () => {
          const handle = await ensureOpen();
          try {
            await putRetainedImage(handle, {
              billId: input.billId,
              retainedAt: now(),
              mediaType: input.mediaType,
              bytes: input.bytes,
            });
            return "saved" as const;
          } catch {
            // P6: a photo that would not store is reported as such, and never as a failed bill.
            return "not saved" as const;
          }
        })(),
      ),

    overwrite: (document) => {
      currentStatus = "saving";
      return track(write(document, true));
    },

    reapply: () => track(reapply()),

    flush: async () => {
      while (queue.length > 0) {
        const inFlight = queue;
        queue = [];
        await Promise.all(inFlight);
      }
    },

    restore: async () => {
      const stored = await mostRecentBill(await ensureOpen());
      if (!stored) return null;
      synced.set(stored.billId, stored.revision);
      return rebuildDocument(stored.working, stored.revision);
    },

    restoreBill: async (billId) => {
      const stored = await loadBill(await ensureOpen(), billId);
      if (!stored) return null;
      synced.set(billId, stored.revision);
      return rebuildDocument(stored.working, stored.revision);
    },

    savedAtOf: async (billId) => (await loadBill(await ensureOpen(), billId))?.savedAt ?? null,

    listBills: async () => listBillRecords(await ensureOpen()),

    deleteBill: async (billId) => {
      await deleteBillRecord(await ensureOpen(), billId);
      synced.delete(billId);
    },

    saveProfile: async (profile) => {
      await saveCreatorProfile(await ensureOpen(), profile);
      cachedProfile = profile;
    },

    profile: () => cachedProfile,

    loadProfile: async () => {
      cachedProfile = await loadCreatorProfile(await ensureOpen());
      return cachedProfile;
    },

    hasRetainedImage: async (billId) => storeHasRetainedImage(await ensureOpen(), billId),

    readRetainedImage: async (billId) => {
      const record = await readRetainedImageRecord(await ensureOpen(), billId);
      if (!record) return null;
      return { blob: new Blob([record.bytes], { type: record.mediaType }), mediaType: record.mediaType };
    },

    deleteRetainedImage: async (billId) => {
      await deleteRetainedImageRecord(await ensureOpen(), billId);
    },

    envelope: async () => exportJson(await ensureOpen(), now()),

    status: () => currentStatus,

    divergence: () => diverged,

    gate: () => raisedGate,
  };
}

let app: StorageSession | null = null;

/**
 * The browser's session, created on first use. Lazy rather than a module-level `createSession()` so that
 * importing this module costs nothing and starts nothing: a session does no work until something asks it to
 * connect, which is what keeps P7's promise that a capture-only visit opens no database at all.
 *
 * The options come from that first caller — the reactive storage-state module, loaded by `main.ts` — so the
 * gate, the blocked notice and the named open failures have somewhere to go other than an exception thrown
 * inside a save.
 */
export function appSession(options: SessionOptions = {}): StorageSession {
  app ??= createSession(options);
  return app;
}
