/**
 * Ticket 14 — the repository: one transaction per operation (DECISIONS/0023 P1, P5, P6, P7, P9, P10).
 *
 * Every function here takes a `DatabaseHandle` rather than reaching for a global, so the rig can hand it a
 * fresh `IDBFactory` per test and so the transaction boundaries are visible in the signature. There is no
 * "save everything" bulk path: the writes that must be atomic are named as such by taking one handle and one
 * transaction, and the one place two records are written together is the bill delete (P6).
 */

import type { BillDocument } from "../bill/document.js";
import type { CreatorProfile } from "../entities.js";
import type { DatabaseHandle } from "./database.js";
import type { ExportEnvelope, RetainedImageRecord, StoredBillRecord } from "./records.js";
import { notImplemented } from "./schema.js";

/**
 * P5. A save is *deferred*, not rejected, when the stored record is not the one this tab last synced with.
 * This is a storage outcome, not a `TransactionRejectCode`: the transaction committed in memory and stays
 * committed, and the human chooses between overwriting and re-applying through the runner.
 */
export type SaveBillOutcome =
  | { readonly status: "written"; readonly record: StoredBillRecord }
  | { readonly status: "deferred"; readonly stored: { readonly revision: number; readonly savedAt: string } }
  | { readonly status: "failed"; readonly cause: unknown };

export interface SaveBillRequest {
  readonly document: BillDocument;
  /** Persistence metadata, supplied by the caller: `lib/bill/*` and `lib/storage/*` never read a clock. */
  readonly savedAt: string;
  /** The stored `revision` at this tab's last sync, or null when this tab has never written it (P5). */
  readonly syncedRevision: number | null;
  /** P5's explicit overwrite. Without it a divergent save is deferred, never applied. */
  readonly overwrite?: true;
}

/**
 * P6's image. `retainedAt` is supplied by the session's clock, never read here (0011's determinism rule).
 * `bytes` accepts a `Blob` or an `ArrayBuffer` because the capture screen holds a Blob and the rig holds a
 * buffer; the implementation normalizes to `ArrayBuffer` before the put, which is what P2 pins on disk.
 */
export interface RetainedImageRequest {
  readonly billId: string;
  readonly retainedAt: string;
  readonly mediaType: string;
  readonly bytes: Blob | ArrayBuffer;
}

/**
 * P10's storage-full surface keys its copy off the error, not off a message string (§6 line 401's rule,
 * applied one layer down). `quota` is the one the user can act on — free space, or export and delete a bill —
 * and `invalid-state` is the closed/blocked-connection case, which is a bug report rather than advice.
 */
export type SaveFailureKind = "quota" | "invalid-state" | "unknown";

export function saveFailureKind(cause: unknown): SaveFailureKind {
  notImplemented("P10");
}

/** P1. Reads the record and hands `working` + `revision` to `rebuildDocument`; the stored `parseValidation`
 * is discarded, never trusted (the poison test in pins 2). */
export function loadBill(handle: DatabaseHandle, billId: string): Promise<StoredBillRecord | null> {
  notImplemented("P1");
}

/** P7. Greatest `savedAt`, ties broken by `billId` — 0011's determinism rule, applied to storage. */
export function mostRecentBill(handle: DatabaseHandle): Promise<StoredBillRecord | null> {
  notImplemented("P7");
}

/** P7's ledger. Every record, decoded; the view sorts and projects (P2: no indexes, so there is nothing to lean on). */
export function listBills(handle: DatabaseHandle): Promise<StoredBillRecord[]> {
  notImplemented("P2");
}

/** P5. The only write path for a bill. */
export function saveBill(handle: DatabaseHandle, request: SaveBillRequest): Promise<SaveBillOutcome> {
  notImplemented("P5");
}

/**
 * P6. One `readwrite` transaction over both keyPaths: a bill delete that left its photo behind is the leak
 * §15 names. Not a transaction-runner operation — it does not touch the document and is not gated on
 * `bill_locked` (0020 T1's guard is about editing content, and a locked bill may still be deleted).
 */
export function deleteBill(handle: DatabaseHandle, billId: string): Promise<void> {
  notImplemented("P6");
}

export function saveCreatorProfile(
  handle: DatabaseHandle,
  profile: CreatorProfile,
): Promise<void> {
  notImplemented("P2");
}

/** P8. `null` when no profile has been saved yet — which is why `creatorName` keeps its `"Creator"` fallback. */
export function loadCreatorProfile(handle: DatabaseHandle): Promise<CreatorProfile | null> {
  notImplemented("P8");
}

/** P6. Written only after a successful bill write, and never by `exportJson`. */
export function putRetainedImage(
  handle: DatabaseHandle,
  request: RetainedImageRequest,
): Promise<RetainedImageRecord> {
  notImplemented("P6");
}

/** P6. The photo goes; the bill and every number in it stay. */
export function deleteRetainedImage(handle: DatabaseHandle, billId: string): Promise<void> {
  notImplemented("P6");
}

/** P6: presence *is* the state, so there is no flag to read — ask the store. */
export function hasRetainedImage(handle: DatabaseHandle, billId: string): Promise<boolean> {
  notImplemented("P6");
}

/**
 * P4's export. Record-level: one cursor, each value read independently, a record that throws named in
 * `unreadable` while the rest of the file is still produced. Never calls `rebuildDocument` — an unloadable
 * bill is still an exportable row.
 */
export function exportJson(handle: DatabaseHandle, exportedAt: string): Promise<ExportEnvelope> {
  notImplemented("P4");
}
