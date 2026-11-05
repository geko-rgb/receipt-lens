import { deflateSync, inflateSync } from "fflate";
import type { ChargeType, ExactMoney } from "../entities.js";

/**
 * Ticket 16 — the fragment share-link codec (DECISIONS/0025). Framework-free: the token is supplied by the
 * caller, the only randomness is the 12-byte GCM nonce minted inside `encodeSnapshot`, and the only clock is
 * the `snapshotCreatedAt` the caller already put in the payload.
 *
 * Pipeline: compact JSON UTF-8 → DEFLATE (fflate, pinned release) → AES-256-GCM → base64url components.
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
const SHARE_INFLATED_MAX_BYTES = 64 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const corrupt = (reason: string): ShareCodecError =>
  new ShareCodecError("link_corrupt_or_tampered", `the share link is corrupt or was tampered with: ${reason}`);

/**
 * DECISIONS/0025 P6 as amended by DECISIONS/0026 A15: the charset and the length are one check. Unpadded
 * base64url is constrained to lengths {0, 2, 3} mod 4 — one leftover character encodes no byte at all — so a
 * component of length 1 mod 4 is not a smaller valid encoding of anything. Left to `atob` it throws a
 * DOMException outside the decryption guard, which is exactly the escape ADR-007's fail-closed rule forbids.
 */
function isBase64urlComponent(value: string): boolean {
  return BASE64URL.test(value) && value.length % 4 !== 1;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  if (!isBase64urlComponent(value)) throw corrupt("a component is not base64url or has an impossible length");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Raw HKDF-SHA-256 output. `billId` is accepted for call-site symmetry, but the derivation uses the token and
 * the pinned context only: a decoder has no bill id before it has decrypted the payload (0025 P3).
 */
export async function deriveKeyBytes(token: string, _billId?: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(token), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(SHARE_HKDF_INFO),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

export async function deriveKey(token: string, billId?: string): Promise<CryptoKey> {
  const bytes = await deriveKeyBytes(token, billId);
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `v1.<token>.<nonce>.<ciphertextAndTag>`, without the leading `#`. */
export async function encodeSnapshot(snapshot: BillShareSnapshot, token: string): Promise<string> {
  if (!isBase64urlComponent(token)) throw corrupt("the share token is not URL-safe or has an impossible length");

  const key = await deriveKey(token);
  const plaintext = encoder.encode(JSON.stringify(snapshot));
  const compressed = deflateSync(plaintext, { level: 9, mem: 9 });
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      key,
      compressed as BufferSource
    )
  );

  const payload = `${SHARE_LINK_VERSION}.${token}.${base64url(nonce)}.${base64url(ciphertext)}`;
  if (payload.length > SHARE_FRAGMENT_MAX_BYTES) {
    throw new ShareCodecError(
      "link_budget_exceeded",
      `the share link is ${payload.length} encoded bytes; the budget is ${SHARE_FRAGMENT_MAX_BYTES}`
    );
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

const CHARGE_TYPES: ReadonlySet<string> = new Set([
  "tax",
  "service_charge",
  "tip",
  "discount",
  "round_off",
  "other",
]);

const TOP_LEVEL_KEYS = new Set([
  "snapshotVersion",
  "snapshotCreatedAt",
  "bill",
  "participants",
  "items",
  "charges",
  "adjustmentLines",
  "computedShares",
]);

function failSchema(reason: string): never {
  throw new ShareCodecError("link_schema_invalid", `the snapshot is not a v1 BillShareSnapshot: ${reason}`);
}

function requireString(value: unknown, field: string): string {
  if (!isString(value)) failSchema(`${field} must be a string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!isInteger(value)) failSchema(`${field} must be a whole number`);
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) failSchema(`${field} must be an array`);
  return value;
}

function validateExactMoney(value: unknown, field: string): void {
  if (!isRecord(value)) failSchema(`${field} must be an exact-money object`);
  if (!isString(value.numeratorPaise) || !/^-?\d+$/.test(value.numeratorPaise)) {
    failSchema(`${field}.numeratorPaise must be a decimal string`);
  }
  if (!isString(value.denominator) || !/^\d+$/.test(value.denominator) || value.denominator === "0") {
    failSchema(`${field}.denominator must be a positive decimal string`);
  }
}

/** The schema check of P6 step 6, after successful decryption and inflation. */
function validateSnapshot(value: unknown): BillShareSnapshot {
  if (!isRecord(value)) failSchema("the payload is not an object");
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) failSchema(`unknown top-level field ${key}`);
  }
  if (value.snapshotVersion !== 1) failSchema("snapshotVersion must be 1");
  requireString(value.snapshotCreatedAt, "snapshotCreatedAt");

  if (!isRecord(value.bill)) failSchema("bill must be an object");
  const bill = value.bill;
  for (const field of ["id", "title", "creatorId", "payerId", "createdAt", "taxIncludedSource"] as const) {
    requireString(bill[field], `bill.${field}`);
  }
  requireInteger(bill.grandTotal, "bill.grandTotal");
  if (bill.taxIncluded !== null && typeof bill.taxIncluded !== "boolean") {
    failSchema("bill.taxIncluded must be boolean or null");
  }

  for (const [index, entry] of requireArray(value.participants, "participants").entries()) {
    if (!isRecord(entry)) failSchema(`participants[${index}] must be an object`);
    requireString(entry.id, `participants[${index}].id`);
    requireString(entry.name, `participants[${index}].name`);
    requireString(entry.tokenExpiresAt, `participants[${index}].tokenExpiresAt`);
  }

  for (const [index, entry] of requireArray(value.items, "items").entries()) {
    if (!isRecord(entry)) failSchema(`items[${index}] must be an object`);
    requireString(entry.id, `items[${index}].id`);
    requireString(entry.name, `items[${index}].name`);
    if (requireInteger(entry.qty, `items[${index}].qty`) <= 0) failSchema(`items[${index}].qty must be positive`);
    if (requireInteger(entry.unitPrice, `items[${index}].unitPrice`) < 0) {
      failSchema(`items[${index}].unitPrice must be non-negative`);
    }
    for (const [unitIndex, unit] of requireArray(entry.unitAssignments, `items[${index}].unitAssignments`).entries()) {
      if (!isRecord(unit)) failSchema(`items[${index}].unitAssignments[${unitIndex}] must be an object`);
      requireInteger(unit.unitIndex, `items[${index}].unitAssignments[${unitIndex}].unitIndex`);
      for (const participantId of requireArray(
        unit.participantIds,
        `items[${index}].unitAssignments[${unitIndex}].participantIds`
      )) {
        if (!isString(participantId)) failSchema(`items[${index}].unitAssignments[${unitIndex}] has a non-string id`);
      }
      if (typeof unit.confirmedUnassigned !== "boolean") {
        failSchema(`items[${index}].unitAssignments[${unitIndex}].confirmedUnassigned must be boolean`);
      }
    }
  }

  for (const [index, entry] of requireArray(value.charges, "charges").entries()) {
    if (!isRecord(entry)) failSchema(`charges[${index}] must be an object`);
    if (!isString(entry.type) || !CHARGE_TYPES.has(entry.type)) failSchema(`charges[${index}].type is not a charge type`);
    requireString(entry.label, `charges[${index}].label`);
    requireInteger(entry.amount, `charges[${index}].amount`);
    if (typeof entry.included !== "boolean") failSchema(`charges[${index}].included must be boolean`);
    if (entry.rate !== undefined && entry.rate !== null && !isInteger(entry.rate) && typeof entry.rate !== "number") {
      failSchema(`charges[${index}].rate must be a number or null`);
    }
    if (entry.otherSign !== undefined && entry.otherSign !== "add" && entry.otherSign !== "subtract") {
      failSchema(`charges[${index}].otherSign must be add or subtract`);
    }
  }

  for (const [index, entry] of requireArray(value.adjustmentLines, "adjustmentLines").entries()) {
    if (!isRecord(entry)) failSchema(`adjustmentLines[${index}] must be an object`);
    if (entry.reason !== "unassigned") failSchema(`adjustmentLines[${index}].reason must be unassigned`);
    requireInteger(entry.amount, `adjustmentLines[${index}].amount`);
    requireString(entry.assignedToParticipantId, `adjustmentLines[${index}].assignedToParticipantId`);
  }

  for (const [index, entry] of requireArray(value.computedShares, "computedShares").entries()) {
    if (!isRecord(entry)) failSchema(`computedShares[${index}] must be an object`);
    requireString(entry.participantId, `computedShares[${index}].participantId`);
    validateExactMoney(entry.exactAmount, `computedShares[${index}].exactAmount`);
    if (entry.settlementSharePaise !== null) requireInteger(entry.settlementSharePaise, `computedShares[${index}].settlementSharePaise`);
  }

  return value as unknown as BillShareSnapshot;
}

export async function decodeSnapshot(fragment: string, token: string): Promise<BillShareSnapshot> {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const parts = raw.split(".");

  // P6 order: version, budget, components, decrypt, inflate, schema.
  const version = parts[0] ?? "";
  if (version !== SHARE_LINK_VERSION) {
    if (/^v\d+$/.test(version)) {
      throw new ShareCodecError(
        "unsupported_link_version",
        `this link uses share format ${version}; this build reads ${SHARE_LINK_VERSION}`
      );
    }
    throw corrupt("the version prefix is missing");
  }
  if (raw.length > SHARE_FRAGMENT_MAX_BYTES) {
    throw new ShareCodecError(
      "link_budget_exceeded",
      `the share link is ${raw.length} encoded bytes; the budget is ${SHARE_FRAGMENT_MAX_BYTES}`
    );
  }
  if (parts.length !== 4) throw corrupt("the fragment does not have four components");

  const [, linkToken, noncePart, cipherPart] = parts as [string, string, string, string];
  if (!isBase64urlComponent(linkToken) || !isBase64urlComponent(noncePart) || !isBase64urlComponent(cipherPart)) {
    throw corrupt("a component is not base64url or has an impossible length");
  }
  const nonce = fromBase64url(noncePart);
  const ciphertext = fromBase64url(cipherPart);
  if (nonce.length !== NONCE_BYTES) throw corrupt("the nonce is not 12 bytes");
  if (ciphertext.length < TAG_BYTES) throw corrupt("the ciphertext is shorter than its authentication tag");

  let compressed: Uint8Array;
  try {
    const key = await deriveKey(token);
    compressed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
        key,
        ciphertext as BufferSource
      )
    );
  } catch {
    throw corrupt("the authentication tag did not verify");
  }

  let inflated: Uint8Array;
  try {
    inflated = inflateSync(compressed);
  } catch {
    throw corrupt("the DEFLATE stream could not be inflated");
  }
  if (inflated.length > SHARE_INFLATED_MAX_BYTES) throw corrupt("the inflated payload exceeds 64 KiB");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(inflated));
  } catch {
    throw new ShareCodecError("link_schema_invalid", "the payload is not valid JSON");
  }
  return validateSnapshot(parsed);
}
