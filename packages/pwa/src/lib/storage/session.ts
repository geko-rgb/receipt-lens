/**
 * Ticket 14 — the session: one live connection and the save choreography around it
 * (DECISIONS/0023 P1, P5, P6, P7, P10).
 *
 * This module is framework-free on purpose (0019 S1): it returns outcomes and the reactive slot decides what
 * is `$state`. `createSession` exists because P5's concurrency pin needs two of these over one factory — two
 * tabs, same database — and a hard module singleton would make the behaviour untestable rather than merely
 * awkward to test. `appSession` is the one the browser uses.
 *
 * The clock: `lib/bill/*` and `lib/storage/repository.ts` never read one (0011's determinism rule), so
 * `savedAt` arrives through `options.now`. The session is the boundary allowed to default it, exactly as
 * `Bill.svelte:46` is for `createdAt`.
 */

import type { BillDocument } from "../bill/document.js";
import type { TransactionResult } from "../bill/transactions.js";
import type { CreatorProfile } from "../entities.js";
import type { DatabaseHandle, OpenDatabaseOptions } from "./database.js";
import type { ExportEnvelope, StoredBillRecord } from "./records.js";
import type { SaveBillOutcome } from "./repository.js";
import { notImplemented } from "./schema.js";

/** P10's save chip states. `not saved` is the only one that may coexist with an edit still on screen. */
export type SaveStatus = "idle" | "saving" | "saved" | "not saved" | "divergent";

/** What a save reports to the slot. The UI reads `status`, never a message string (§6 line 401's rule). */
export interface PersistReport {
  readonly status: SaveStatus;
  readonly outcome: SaveBillOutcome;
  /** P5's divergence detail, present exactly when `status === "divergent"`. */
  readonly stored?: { readonly revision: number; readonly savedAt: string };
  /**
   * P5: the runner's answer to re-running the held thunk, present only on the report from `reapply`. A
   * rejection there is the runner's own — `bill_locked`, `unknown_entity` — and the standard rejection
   * surface shows it. P5 invents no code of its own, and the caller must not report a save that never
   * happened.
   */
  readonly replay?: TransactionResult;
}

/**
 * P5's replayable thunk: the operation and its arguments, captured at publish time. Held in memory only —
 * never in the document, never on disk, so 0019 S6's JSON-safety is untouched. One thunk, replaced by the
 * next commit and discarded on a successful save: a queue of replays would be an undo stack wearing P5's
 * clothes (0019 "does not decide" — v1 has no history).
 */
export type ReplayableOperation = (document: BillDocument) => TransactionResult;

/** What a caller hands an image over with. `retainedAt` is the session's clock, not the caller's (0011). */
export interface RetainedImageInput {
  readonly billId: string;
  readonly mediaType: string;
  readonly bytes: Blob | ArrayBuffer;
}

export interface SessionOptions extends OpenDatabaseOptions {
  readonly now?: () => string;
}

/** Everything the slot and the routes need, behind one object so two tabs are two of these. */
export interface StorageSession {
  readonly handle: () => DatabaseHandle | null;
  readonly connect: () => Promise<DatabaseHandle>;
  readonly disconnect: () => void;
  /** P7: write the document the root just published. Resolves when the write settles; `flush` awaits the queue. */
  readonly persist: (document: BillDocument, replay?: ReplayableOperation) => Promise<PersistReport>;
  /** P6: the second write, attempted only after the bill write succeeded. */
  readonly persistRetainedImage: (input: RetainedImageInput) => Promise<SaveStatus>;
  readonly overwrite: (document: BillDocument) => Promise<PersistReport>;
  /** P5: no argument — the session already holds the thunk it is re-running, and the stored record to run it on. */
  readonly reapply: () => Promise<PersistReport>;
  readonly flush: () => Promise<void>;
  /** P7: the most recently saved bill, rebuilt, or null when this device holds nothing. */
  readonly restore: () => Promise<BillDocument | null>;
  readonly listBills: () => Promise<StoredBillRecord[]>;
  readonly deleteBill: (billId: string) => Promise<void>;
  readonly saveProfile: (profile: CreatorProfile) => Promise<void>;
  /** P8: read synchronously after `connect()`, so a synchronous `billStore.begin` can seed the creator's name. */
  readonly profile: () => CreatorProfile | null;
  readonly loadProfile: () => Promise<CreatorProfile | null>;
  readonly hasRetainedImage: (billId: string) => Promise<boolean>;
  readonly deleteRetainedImage: (billId: string) => Promise<void>;
  /** P4: the envelope, ready for the browser to download. */
  readonly envelope: () => Promise<ExportEnvelope>;
  readonly status: () => SaveStatus;
  /** P5's notice, as the session sees it. The slot mirrors it into `$state`. */
  readonly divergence: () => { readonly revision: number; readonly savedAt: string } | null;
}

/** P3/P4/P5: the whole storage lifecycle, over a factory the caller owns. */
export function createSession(options: SessionOptions = {}): StorageSession {
  notImplemented("P3");
}

let app: StorageSession | null = null;

/**
 * The browser's session, created on first use. Lazy rather than a module-level `createSession()` because the
 * constructor would then run at *import* time — and a session that has not been connected cannot read from or
 * write to anything, so there is nothing to build until `main.ts` (or a test) asks for it.
 */
export function appSession(): StorageSession {
  app ??= createSession();
  return app;
}
