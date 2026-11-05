import type { CaptureDraft } from "../draft.js";
import type { BillDocument } from "./document.js";
import type { NewBillOptions } from "./mapping.js";
import { creatorNameFor } from "./mapping.js";
import { beginFrom, type TransactionResult } from "./transactions.js";
import type { PersistReport, ReplayableOperation, SaveStatus, StorageSession } from "../storage/session.js";

/**
 * The one mutable cell in the app (DECISIONS/0019 S1/S3). It holds a whole committed `BillDocument` —
 * working bill, derived totals, both validation results — and a mutation replaces all four at once, which is
 * what makes §6 line 400's "persist atomically … do not display derived state from the failed mutation" a
 * structural property rather than a convention: a transaction that fails simply does not produce a document,
 * so there is nothing here to retract.
 *
 * No rule lives in this file. Every operation is a pure function in `lib/bill/`, tested through the seam in
 * `tests/bill/pins.test.ts`; this module is reactivity and nothing else, which is also why the React fallback
 * in `DECISIONS/0017` D7 would only have to rewrite these lines.
 *
 * Ticket 14 widens the same sentence: the root is also the only *trigger* of disk writes (DECISIONS/0023 P7).
 * That is one call per publish and the two read-only fields the save chip and the divergence notice render —
 * the mechanics all live in `lib/storage/`, so this stays a slot and not a second implementation.
 */

/**
 * `$state.raw`, not `$state`, for the same reason the document is frozen: a deep proxy would wrap the bill in
 * a second object graph, and an operation handed that proxy hands it back — and freezing a `$state` proxy
 * throws `state_descriptors_fixed`. Ticket 11 found this in a browser, not in the unit suite, because the
 * suite never reads the document through a reactive cell. The document is immutable and replaced by
 * identity, so there is nothing for fine-grained reactivity to track: `$state.raw` is both correct and
 * cheaper.
 */
let current: BillDocument | null = $state.raw(null);

/** Which accepted capture this document came from, compared by identity: a second one is a user act (0020 T5). */
let imported: CaptureDraft | null = $state.raw(null);

/** The last rejected transaction, or null. View state — never part of the committed document. */
let rejection: { code: string; message: string } | null = $state(null);

/** P10's chip. `not saved` may coexist with an edit on screen, and that is precisely what it is for. */
let status: SaveStatus = $state.raw("idle");

/** P5's divergence: the record another tab wrote, or null. Read by the notice, never inferred from a message. */
let diverged: { revision: number; savedAt: string } | null = $state(null);

/** The session this root writes through. Unattached in tests that do not care about storage. */
let session: StorageSession | null = null;

/**
 * Detaches the capture handoff from whoever owns it. `structuredClone` cannot do it — the parse arrives as a
 * Svelte `$state` proxy and proxies are not cloneable — and a JSON round trip is the right tool anyway: it is
 * exactly the guarantee DECISIONS/0019 S6 pins for the committed document, so anything the bill could not
 * persist or snapshot fails here, at the one boundary, instead of in ticket 14's migration. Aliasing the
 * component's graph instead would let a view write behind the document that is also ticket 14's persistence
 * record and ticket 16's snapshot source.
 *
 * Note what does *not* go through it: `draft.retainedImage.blob` is a `Blob`, and a JSON round trip would turn
 * it into `{}` silently, without throwing. It is handed to storage straight from the draft (P6).
 */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Publishes a save report into the two reactive fields. One direction, so the chip cannot lie. */
function record(report: PersistReport): void {
  status = report.status;
  diverged = report.stored ?? null;
}

export const billStore = {
  get document(): BillDocument | null {
    return current;
  },

  get rejection(): { code: string; message: string } | null {
    return rejection;
  },

  get importedFrom(): CaptureDraft | null {
    return imported;
  },

  get present(): boolean {
    return current !== null;
  },

  get saveStatus(): SaveStatus {
    return status;
  },

  /** P5: the divergence a deferred save produced, or null. */
  get divergence(): { revision: number; savedAt: string } | null {
    return diverged;
  },

  /** Wiring, not state: `main.ts` attaches the app's session; a test attaches its own over a fake factory. */
  attach(next: StorageSession | null): void {
    session = next;
  },

  /** Revision 0 from a capture handoff — the parse enters the bill through `detach`, and never by reference. */
  begin(draft: CaptureDraft, options: NewBillOptions): void {
    imported = draft;
    rejection = null;
    diverged = null;
    // P8: the creator's participant name comes from the stored profile when the caller did not name one —
    // and only when a session is attached at all, so an unattached root keeps `mapping.ts`'s own "Creator"
    // default rather than reaching into storage for a value that is not there yet.
    const seeded: NewBillOptions =
      session && options.creatorName === undefined
        ? { ...options, creatorName: creatorNameFor(session.profile()) }
        : options;
    current = beginFrom(detach(draft.parse), detach(draft.validation), seeded);
    const writing = session;
    if (!writing || !current) return;
    // P7: an accepted import is written even at revision 0, and P6's image is attempted only after that
    // write succeeded — so a bill with no bill row cannot exist, and a photo cannot be retained alone.
    const billId = current.working.bill.id;
    void writing.persist(current).then((report) => {
      record(report);
      if (report.status !== "saved" || !draft.retainedImage) return;
      void writing
        .persistRetainedImage({ billId, mediaType: draft.retainedImage.mediaType, bytes: draft.retainedImage.blob })
        .then((imageStatus) => {
          status = imageStatus;
        });
    });
  },

  /**
   * Publishes a transaction's outcome: the new document when it committed, the reason when it did not.
   *
   * `replay` is P5's thunk — the operation and its arguments, which only the caller knows. The session holds
   * at most one, replaces it on the next commit and discards it when a save lands.
   */
  publish(result: TransactionResult, replay?: ReplayableOperation): TransactionResult {
    if (result.ok) {
      current = result.document;
      rejection = null;
      if (session && current) void session.persist(current, replay).then(record);
    } else {
      rejection = { code: result.reject.code, message: result.reject.message };
    }
    return result;
  },

  /** P5's first action: this tab's version wins, deliberately, and the notice says what it replaced. */
  overwrite(): void {
    if (session && current) void session.overwrite(current).then(record);
  },

  /** P5's second action: rebuild the stored bill and re-run the pending operation through the runner. */
  reapply(): void {
    if (session) void session.reapply().then(record);
  },

  /**
   * Clears memory. It does **not** touch storage: "close this view" must never be "delete the user's bill"
   * (P7), and deletion is an explicit ledger action with its own confirmation.
   */
  clear(): void {
    current = null;
    imported = null;
    rejection = null;
    diverged = null;
    status = "idle";
  },
};
