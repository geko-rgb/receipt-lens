/**
 * Ticket 14 — the repository: one transaction per operation (DECISIONS/0023 P1, P4, P5, P6, P7, P9, P10).
 *
 * Every function takes a `DatabaseHandle` rather than reaching for a global, so the rig can hand it a fresh
 * `IDBFactory` per test and so the transaction boundaries are visible in the signature. There is no bulk
 * "save everything" path: the writes that must be atomic are named as such by taking one handle and one
 * transaction, and the one place two records are written together is the bill delete (P6).
 *
 * `savedAt` and `retainedAt` arrive from the caller: `lib/storage/*` reads no clock, exactly as `lib/bill/*`
 * does not (0011's determinism rule). The session is the boundary that owns one.
 */

import type { BillDocument } from "../bill/document.js";
import type { CreatorProfile } from "../entities.js";
import type { DatabaseHandle } from "./database.js";
import { countOf, put, readAll, readOne, remove, run } from "./idb.js";
import type { CreatorProfileRow, ExportEnvelope, RetainedImageRecord, StoredBillRecord, UnreadableRecord } from "./records.js";
import {
  CREATOR_PROFILE_ID,
  decodeBillRecord,
  decodeProfileRow,
  encodeBillRecord,
  encodeProfileRow,
} from "./records.js";
import { DB_NAME } from "./schema.js";

/**
 * P5. A save is *deferred*, not rejected, when the stored record is not the one this tab last synced with.
 * This is a storage outcome, not a `TransactionRejectCode`: the transaction committed in memory and stays
 * committed, and the human chooses between overwriting and re-applying through the runner.
 */
export type SaveBillOutcome =
  | { readonly status: "written"; readonly record: StoredBillRecord }
  | {
      readonly status: "deferred";
      readonly code: "bill_changed_elsewhere";
      readonly stored: { readonly revision: number; readonly savedAt: string };
    }
  | { readonly status: "failed"; readonly cause: unknown };

export interface SaveBillRequest {
  readonly document: BillDocument;
  /** Persistence metadata, supplied by the caller (0011's determinism rule). */
  readonly savedAt: string;
  /** The stored `revision` at this tab's last sync, or null when this tab has never read or written it (P5). */
  readonly syncedRevision: number | null;
  /** P5's explicit overwrite. Without it a divergent save is deferred, never applied. */
  readonly overwrite?: true;
}

/**
 * P6's image. `retainedAt` is supplied by the session's clock, never read here. `bytes` accepts a `Blob` or
 * an `ArrayBuffer` because the capture screen holds a Blob and the rig holds a buffer; the row is written as
 * an `ArrayBuffer`, which is what P2 pins on disk.
 */
export interface RetainedImageRequest {
  readonly billId: string;
  readonly retainedAt: string;
  readonly mediaType: string;
  readonly bytes: Blob | ArrayBuffer;
}

/** P10's copy switch. The UI reacts to a kind, never to a message string (§6 line 401's rule, one layer down). */
export type SaveFailureKind = "quota" | "invalid-state" | "unknown";

export function saveFailureKind(cause: unknown): SaveFailureKind {
  const name = cause instanceof DOMException || cause instanceof Error ? cause.name : "";
  if (name === "QuotaExceededError") return "quota";
  if (name === "InvalidStateError") return "invalid-state";
  // Some surfaces carry the name only in the text; the classification must not depend on the instance.
  const text = `${name} ${cause instanceof Error ? cause.message : String(cause)}`;
  if (text.includes("QuotaExceededError")) return "quota";
  if (text.includes("InvalidStateError")) return "invalid-state";
  return "unknown";
}

/** P1. The stored record for one bill — its `working` and its `revision`, and nothing re-derived. */
export async function loadBill(handle: DatabaseHandle, billId: string): Promise<StoredBillRecord | null> {
  const record = await run(handle.database, ["bills"], "readonly", (transaction) =>
    readOne<StoredBillRecord>(transaction, "bills", billId),
  );
  if (!record) return null;
  decodeBillRecord(record);
  return record;
}

/** P7. Greatest `savedAt`, ties broken by `billId` — 0011's determinism rule, applied to storage. */
export async function mostRecentBill(handle: DatabaseHandle): Promise<StoredBillRecord | null> {
  const records = await listBills(handle);
  if (records.length === 0) return null;
  return records.reduce((best, candidate) => {
    if (candidate.savedAt > best.savedAt) return candidate;
    if (candidate.savedAt === best.savedAt && candidate.billId > best.billId) return candidate;
    return best;
  }, records[0]!);
}

/**
 * P7's ledger. Every record, in key order; the view sorts and projects. No rebuild runs per bill — the list
 * shows stored fields, not re-derived state (§10 line 745, P7).
 */
export async function listBills(handle: DatabaseHandle): Promise<StoredBillRecord[]> {
  return run(handle.database, ["bills"], "readonly", (transaction) => readAll<StoredBillRecord>(transaction, "bills"));
}

/**
 * P5. The only write path for a bill. The stored record is read inside the same transaction as the write, so
 * "what was on disk when we decided" cannot drift between the check and the put.
 */
export async function saveBill(handle: DatabaseHandle, request: SaveBillRequest): Promise<SaveBillOutcome> {
  const record = encodeBillRecord(request.document, request.savedAt);
  try {
    return await run(handle.database, ["bills"], "readwrite", async (transaction) => {
      const stored = await readOne<StoredBillRecord>(transaction, "bills", record.billId);
      // `syncedRevision` of null means this tab never read the record; if one is on disk, that is evidence
      // of another writer, and P5 defers rather than overwriting on evidence the tab cannot explain.
      if (stored && !request.overwrite && stored.revision !== request.syncedRevision) {
        return {
          status: "deferred" as const,
          code: "bill_changed_elsewhere" as const,
          stored: { revision: stored.revision, savedAt: stored.savedAt },
        };
      }
      await put(transaction, "bills", record);
      return { status: "written" as const, record };
    });
  } catch (cause) {
    return { status: "failed", cause };
  }
}

/**
 * P6. One `readwrite` transaction over both keyPaths: a bill delete that left its photo behind is the leak
 * business.md §15 names. Not a transaction-runner operation — it does not touch the document and is not
 * gated on `bill_locked` (0020 T1's guard is about editing content, and a locked bill may still be deleted).
 */
export async function deleteBill(handle: DatabaseHandle, billId: string): Promise<void> {
  await run(handle.database, ["bills", "retainedImages"], "readwrite", async (transaction) => {
    await remove(transaction, "bills", billId);
    await remove(transaction, "retainedImages", billId);
  });
}

/** P2. §10's two fields and the key, written as one row. */
export async function saveCreatorProfile(handle: DatabaseHandle, profile: CreatorProfile): Promise<void> {
  await run(handle.database, ["creatorProfile"], "readwrite", (transaction) =>
    put(transaction, "creatorProfile", encodeProfileRow(profile)),
  );
}

/** P8. `null` when no profile has been saved yet — which is why `creatorName` keeps its `"Creator"` fallback. */
export async function loadCreatorProfile(handle: DatabaseHandle): Promise<CreatorProfile | null> {
  const row = await run(handle.database, ["creatorProfile"], "readonly", (transaction) =>
    readOne<CreatorProfileRow>(transaction, "creatorProfile", CREATOR_PROFILE_ID),
  );
  return decodeProfileRow(row);
}

/**
 * P6. The image row, written only for a bill that exists: the bill key is read in the same transaction, so an
 * orphan photo cannot be produced even by a caller that skipped the session's ordering.
 */
export async function putRetainedImage(
  handle: DatabaseHandle,
  request: RetainedImageRequest,
): Promise<RetainedImageRecord> {
  const bytes =
    request.bytes instanceof ArrayBuffer ? request.bytes : new Uint8Array(await request.bytes.arrayBuffer()).buffer;
  const record: RetainedImageRecord = {
    billId: request.billId,
    retainedAt: request.retainedAt,
    mediaType: request.mediaType,
    bytes,
  };
  return run(handle.database, ["bills", "retainedImages"], "readwrite", async (transaction) => {
    const bill = await readOne<StoredBillRecord>(transaction, "bills", request.billId);
    if (!bill) throw new Error(`no bill ${request.billId} to retain an image for`);
    await put(transaction, "retainedImages", record);
    return record;
  });
}

/** P6. The photo goes; the bill and every number in it stay. */
export async function deleteRetainedImage(handle: DatabaseHandle, billId: string): Promise<void> {
  await run(handle.database, ["retainedImages"], "readwrite", (transaction) =>
    remove(transaction, "retainedImages", billId),
  );
}

/**
 * P6's read half. The editor shows the photo the creator chose to keep, so the byte has to come back out of the
 * store — `hasRetainedImage` alone can only say it is there. Nothing here writes, and the caller owns the
 * `Blob` it builds (and so owns revoking its object URL).
 */
export async function readRetainedImage(
  handle: DatabaseHandle,
  billId: string,
): Promise<RetainedImageRecord | undefined> {
  return run(handle.database, ["retainedImages"], "readonly", (transaction) =>
    readOne<RetainedImageRecord>(transaction, "retainedImages", billId),
  );
}

/** P6: presence *is* the state, so there is no flag to read — ask the store. */
export async function hasRetainedImage(handle: DatabaseHandle, billId: string): Promise<boolean> {
  const record = await run(handle.database, ["retainedImages"], "readonly", (transaction) =>
    readOne<RetainedImageRecord>(transaction, "retainedImages", billId),
  );
  return record !== undefined;
}

/** The row count of one store — what P4's L3/L4 counts and P6's emptiness assertions read. */
export function countRecords(handle: DatabaseHandle, store: string): Promise<number> {
  return run(handle.database, [store], "readonly", (transaction) => countOf(transaction, store));
}

/**
 * P4's export. Record-level: each row is decoded independently, so a row that cannot be read is named in
 * `unreadable` while the rest of the file is still produced. `rebuildDocument` is never called here — an
 * unloadable bill is still an exportable row, which is the asymmetry P10 depends on.
 */
export async function exportJson(handle: DatabaseHandle, exportedAt: string): Promise<ExportEnvelope> {
  const read = await run(
    handle.database,
    ["bills", "creatorProfile", "retainedImages"],
    "readonly",
    async (transaction) => ({
      rows: await readAll<StoredBillRecord>(transaction, "bills"),
      profile: decodeProfileRow(await readOne<CreatorProfileRow>(transaction, "creatorProfile", CREATOR_PROFILE_ID)),
      imageIds: (await readAll<RetainedImageRecord>(transaction, "retainedImages")).map((record) => record.billId),
    }),
  );

  const bills: StoredBillRecord[] = [];
  const unreadable: UnreadableRecord[] = [];
  for (const row of read.rows as readonly unknown[]) {
    const named = row as { billId?: unknown };
    try {
      decodeBillRecord(row);
      bills.push(row as StoredBillRecord);
    } catch (cause) {
      unreadable.push({
        billId: typeof named?.billId === "string" ? named.billId : "unknown",
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return {
    app: DB_NAME,
    exportVersion: 1,
    dbVersion: handle.version,
    exportedAt,
    creatorProfile: read.profile,
    bills,
    unreadable,
    retainedImageBillIds: read.imageIds,
  };
}
