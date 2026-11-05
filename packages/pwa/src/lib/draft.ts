/**
 * The capture→bill handoff (ticket 10).
 *
 * In memory only. `docs/pwa-design.md` §1.1 fixes that no receipt image byte reaches a store, and
 * ticket 14 owns IndexedDB — so this module is a plain module-level value, not persistence. What it
 * carries is the parse the reviewer accepted: draft items, draft charges and the validation result,
 * exactly the artefacts `validateWorkingBill` (ticket 11) needs to start from.
 *
 * `docs/pwa-design.md` §3's "there is deliberately no store" was about the 10a shell; the transport
 * has to exist before /bill can be more than a placeholder, and it stays a module value so a reload
 * is an empty draft rather than a half-restored one.
 *
 * Ticket 14 adds `retainedImage` (DECISIONS/0023 P6): the checkbox on `/capture` decides whether the
 * accepted working copy is *carried* into this handoff. Carrying it is still not storing it — the byte
 * becomes a `retainedImages` record only when the bill's own record has been written, which is
 * storage's ordering rule, not this module's. A handoff is not a database.
 */

import type { ParseResult, ParseValidationResult, ParsedItem, ParsedOtherCharge } from "@receipt-lens/core";

export interface CaptureDraft {
  readonly items: readonly ParsedItem[];
  readonly charges: readonly ParsedOtherCharge[];
  readonly parse: ParseResult;
  readonly validation: ParseValidationResult;
  /** Present only when the creator opted in. Never part of `parse`, never in a snapshot, never in an export. */
  readonly retainedImage?: { readonly blob: Blob; readonly mediaType: string };
}

let draft: CaptureDraft | null = null;

export function setDraft(next: CaptureDraft): void {
  draft = next;
}

export function getDraft(): CaptureDraft | null {
  return draft;
}

export function clearDraft(): void {
  draft = null;
}
