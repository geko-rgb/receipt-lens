import type { CaptureDraft } from "../draft.js";
import type { BillDocument } from "./document.js";
import type { NewBillOptions } from "./mapping.js";
import { beginFrom, type TransactionResult } from "./transactions.js";

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

/**
 * Detaches the capture handoff from whoever owns it. `structuredClone` cannot do it — the parse arrives as a
 * Svelte `$state` proxy and proxies are not cloneable — and a JSON round trip is the right tool anyway: it is
 * exactly the guarantee DECISIONS/0019 S6 pins for the committed document, so anything the bill could not
 * persist or snapshot fails here, at the one boundary, instead of in ticket 14's migration. Aliasing the
 * component's graph instead would let a view write behind the document that is also ticket 14's persistence
 * record and ticket 16's snapshot source.
 */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

  /** Revision 0 from a capture handoff — the parse enters the bill through `detach`, and never by reference. */
  begin(draft: CaptureDraft, options: NewBillOptions): void {
    imported = draft;
    rejection = null;
    current = beginFrom(detach(draft.parse), detach(draft.validation), options);
  },

  /** Publishes a transaction's outcome: the new document when it committed, the reason when it did not. */
  publish(result: TransactionResult): TransactionResult {
    if (result.ok) {
      current = result.document;
      rejection = null;
    } else {
      rejection = { code: result.reject.code, message: result.reject.message };
    }
    return result;
  },

  clear(): void {
    current = null;
    imported = null;
    rejection = null;
  },
};
