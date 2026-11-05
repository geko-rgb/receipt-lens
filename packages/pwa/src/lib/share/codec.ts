import type { ChargeType, ExactMoney } from "../entities.js";

/**
 * Ticket 16 — the fragment share-link codec (DECISIONS/0025). Framework-free, no clock and no random source:
 * the token is supplied and the nonce is generated here only inside `encodeSnapshot`'s `crypto.getRandomValues`
 * call, which is the boundary. The codec is the only place the fragment format exists.
 */

export type ShareFailureCode =
  | "unsupported_link_version"
  | "link_budget_exceeded"
  | "link_corrupt_or_tampered"
  | "link_schema_invalid";

export class ShareCodecError extends Error {
  readonly code: ShareFailureCode;

  constructor(code: ShareFailureCode, message: string) {
    super(message);
    this.name = "ShareCodecError";
    this.code = code;
  }
}

/** §10's snapshot shape, resolved data only. */
export interface BillShareSnapshot {
  readonly snapshotVersion: 1;
  readonly snapshotCreatedAt: string;
  readonly bill: {
    readonly id: string;
    readonly title: string;
    readonly creatorId: string;
    readonly payerId: string;
    readonly createdAt: string;
    readonly grandTotal: number;
    readonly taxIncluded: boolean | null;
    readonly taxIncludedSource: string;
  };
  readonly participants: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly tokenExpiresAt: string;
  }>;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly qty: number;
    readonly unitPrice: number;
    readonly unitAssignments: ReadonlyArray<{
      readonly unitIndex: number;
      readonly participantIds: readonly string[];
      readonly confirmedUnassigned: boolean;
    }>;
  }>;
  readonly charges: ReadonlyArray<{
    readonly type: ChargeType;
    readonly label: string;
    readonly amount: number;
    readonly included: boolean;
    readonly rate?: number | null;
    readonly otherSign?: "add" | "subtract";
  }>;
  readonly adjustmentLines: ReadonlyArray<{
    readonly reason: "unassigned";
    readonly amount: number;
    readonly assignedToParticipantId: string;
  }>;
  readonly computedShares: ReadonlyArray<{
    readonly participantId: string;
    readonly exactAmount: ExactMoney;
    readonly settlementSharePaise: number | null;
  }>;
}

/** DECISIONS/0025 P5: the whole fragment after `#`, encoded, is capped at 8192 bytes. */
export const SHARE_FRAGMENT_MAX_BYTES = 8192;
export const SHARE_LINK_VERSION = "v1";
export const SHARE_HKDF_INFO = "receipt-lens-share-v1";

/**
 * Raw HKDF-SHA-256 output. `billId` is accepted for call-site symmetry with the snapshot, but the key is
 * derived from the token and the pinned context only: a decoder has no bill id before it has decrypted the
 * payload (0025 P3).
 */
export async function deriveKeyBytes(_token: string, _billId?: string): Promise<Uint8Array> {
  throw new Error("not implemented: DECISIONS/0025 P3 HKDF");
}

export async function deriveKey(_token: string, _billId?: string): Promise<CryptoKey> {
  throw new Error("not implemented: DECISIONS/0025 P3 HKDF key");
}

/** `v1.<token>.<nonce>.<ciphertextAndTag>`, without the leading `#`. */
export async function encodeSnapshot(_snapshot: BillShareSnapshot, _token: string): Promise<string> {
  throw new Error("not implemented: DECISIONS/0025 P2 encode");
}

export async function decodeSnapshot(_fragment: string, _token: string): Promise<BillShareSnapshot> {
  throw new Error("not implemented: DECISIONS/0025 P6 decode");
}
