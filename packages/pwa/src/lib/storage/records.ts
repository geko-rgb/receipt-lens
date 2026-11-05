/**
 * Ticket 14 — the on-disk shapes, their encode/decode, and the export envelope
 * (DECISIONS/0023 P1, P2, P4, P9).
 *
 * These types are the disk format. A field added here is a schema version bump, and a field removed is a
 * lossy migration that must export first — which is why they are declared next to the version they belong to
 * and not inferred from the in-memory model.
 *
 * `CreatorProfile` is *not* redefined here: its home is `lib/entities.ts` (P2), and `CreatorProfileRow` below
 * adds the `id` keyPath field and nothing else. Ticket 15 imports the same type for the UPI builder, so the
 * stored shape and its consumer cannot drift.
 */

import type { WorkingBill } from "../bill/working-bill.js";
import type { BillDocument } from "../bill/document.js";
import type { CreatorProfile } from "../entities.js";

/**
 * P1. One record per bill, keyed by `billId`. `working` is §10's whole mutable state — drafts, finalized
 * entities, units, assignments, participants, unclassified rows, `excludedRowIds`, `staleLinkCutoffAt` and
 * the retained `parseResult` — and it is the only bill content on disk.
 *
 * `derived`, `billValidation` and the `BillDocument` wrapper are not stored: they are re-derived on load by
 * the same code a transaction runs (§10 line 745, 0019 S5). `savedAt` is persistence metadata, never read by
 * a bill rule.
 */
export interface StoredBillRecord {
  readonly billId: string;
  readonly revision: number;
  readonly savedAt: string;
  readonly working: WorkingBill;
}

/** P2. One row, keyPath `id`, always `"self"` — the creator has exactly one profile on this device. */
export interface CreatorProfileRow extends CreatorProfile {
  readonly id: string;
}

/**
 * P6. The opt-in receipt image, keyed by the bill it belongs to. `bytes` is an `ArrayBuffer` rather than a
 * `Blob` because it is the most portable structured-clone value on every target this app claims, and it makes
 * "no image bytes in any store" a length check instead of a type inspection. The UI wraps it back:
 * `new Blob([record.bytes], { type: record.mediaType })`.
 */
export interface RetainedImageRecord {
  readonly billId: string;
  readonly retainedAt: string;
  readonly mediaType: string;
  readonly bytes: ArrayBuffer;
}

/** P4. A record the export could not read. Named in the file, never skipped quietly. */
export interface UnreadableRecord {
  readonly billId: string;
  readonly reason: string;
}

/**
 * P4's envelope. `exportVersion` is the file's own format number — a fourth compatibility surface, kept
 * distinct from `DB_SCHEMA_VERSION`, `BillShareSnapshot.snapshotVersion` and the link format (§10 line 751
 * separates the first three; an export is a file a user keeps, so its format has to survive app upgrades).
 *
 * `dbVersion` is the version the records were written at, and `bills` holds them verbatim: the export copies
 * rows and never re-derives them, so an unloadable bill still exports and the file means "what this app
 * wrote". Image bytes are never in it (P4's privacy reasoning) — `retainedImageBillIds` says which bills had
 * one, so nothing is hidden about what the backup does not cover.
 */
export interface ExportEnvelope {
  readonly app: "receipt-lens";
  readonly exportVersion: 1;
  readonly dbVersion: number;
  readonly exportedAt: string;
  readonly creatorProfile: CreatorProfile | null;
  readonly bills: readonly StoredBillRecord[];
  readonly unreadable: readonly UnreadableRecord[];
  readonly retainedImageBillIds: readonly string[];
}

/** The `"self"` keyPath value of the one profile row. */
export const CREATOR_PROFILE_ID = "self";

/** P1: the record a document becomes. Metadata only — `savedAt` is supplied, never read from a clock here. */
export function encodeBillRecord(document: BillDocument, savedAt: string): StoredBillRecord {
  return {
    billId: document.working.bill.id,
    revision: document.revision,
    savedAt,
    working: document.working,
  };
}

/**
 * P1: the stored record, decoded back to `working` + `revision`. Performs no re-derivation — that is
 * `rebuildDocument`'s job — and refuses a row that is not a record, which is what makes P4's record-level
 * export able to name an unreadable row instead of producing a half-file.
 */
export function decodeBillRecord(record: unknown): { working: WorkingBill; revision: number } {
  const candidate = record as Partial<StoredBillRecord> | null | undefined;
  if (!candidate || typeof candidate !== "object") throw new Error("stored bill record is not an object");
  if (typeof candidate.billId !== "string" || candidate.billId.length === 0) {
    throw new Error("stored bill record has no billId");
  }
  if (typeof candidate.revision !== "number" || !Number.isSafeInteger(candidate.revision)) {
    throw new Error(`stored bill record ${candidate.billId} has no safe integer revision`);
  }
  if (!candidate.working || typeof candidate.working !== "object") {
    throw new Error(`stored bill record ${candidate.billId} has no working bill`);
  }
  if (candidate.working.bill?.id !== candidate.billId) {
    throw new Error(`stored bill record ${candidate.billId} names a different bill in its working state`);
  }
  if (typeof candidate.savedAt !== "string") throw new Error(`stored bill record ${candidate.billId} has no savedAt`);
  return { working: candidate.working, revision: candidate.revision };
}

/** The profile row, from §10's two fields. Nothing else may be stored beside them (P2). */
export function encodeProfileRow(profile: CreatorProfile): CreatorProfileRow {
  return { id: CREATOR_PROFILE_ID, displayName: profile.displayName, upiId: profile.upiId };
}

/** Reads §10's two fields back out, ignoring the keyPath field. */
export function decodeProfileRow(row: CreatorProfileRow | undefined): CreatorProfile | null {
  if (!row) return null;
  return { displayName: row.displayName, upiId: row.upiId };
}
