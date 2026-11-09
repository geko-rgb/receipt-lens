<script lang="ts">
  /**
   * Ticket 13 — the lock checklist and lifecycle (DECISIONS/0022 L1–L12).
   *
   * The badge is `lifecycleOf(bill)`: there is no local state to disagree with the document. A lock is one
   * transaction, and a refusal is shown by the bill's existing rejection alert rather than disabled controls,
   * so the user learns *why* the lock did not happen and the runner's guard is what actually decides. Draft
   * items surface the finalize-first path (L3); they are never finalized as a side effect of locking.
   */
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import { lifecycleOf } from "../lib/bill/lifecycle.js";
  import {
    acknowledgeRows,
    finalizeAllResolvable,
    lockBill,
    setUnclassifiedRowAcknowledged,
    setUnclassifiedRowExcluded,
    unlockBill,
    type TransactionResult,
  } from "../lib/bill/transactions.js";
  import {
    acknowledgeableRows,
    effectiveAcknowledgements,
    recordOf,
    rowCarriesAnAmount,
  } from "../lib/bill/acknowledge.js";
  import type { BillDocument } from "../lib/bill/document.js";
  import type { LockBlocker } from "../lib/bill/working-bill.js";

  let { bill }: { bill: BillDocument } = $props();

  let confirmingUnlock = $state(false);

  const working = $derived(bill.working);
  const blockers = $derived(bill.billValidation.blockers.locking);
  const lifecycle = $derived(lifecycleOf(bill));
  const excluded = $derived(new Set(working.excludedRowIds));
  // Ticket 23. Two sets, not one: `acknowledged` is what is *in force* (a row that has since started carrying an
  // amount is voided and blocks again), and `pending` is what the bulk action would record right now.
  const acknowledged = $derived(new Set(effectiveAcknowledgements(working).map((entry) => entry.row.id)));
  const pending = $derived(acknowledgeableRows(working));

  function apply(result: TransactionResult): void {
    billStore.publish(result);
  }

  /** `lib/bill/*` reads no clock and no random source, so this component supplies both (0011's rule). */
  function mintToken(): string {
    return crypto.randomUUID();
  }

  function lock(): void {
    apply(lockBill(bill, { mintToken }));
  }

  /**
   * Ticket 23: one click acknowledges every preserved row a human may acknowledge. The rows are the same ones the
   * per-row control would offer — a row carrying an amount is not in the list, so this can never wave arithmetic
   * through (the transaction refuses it too, which is why the refusal is not a UI-only rule).
   */
  function acknowledgeAll(): void {
    if (pending.length === 0) return;
    apply(
      acknowledgeRows(
        bill,
        pending.map((row) => row.id),
        { now: new Date().toISOString() },
      ),
    );
  }

  function unlock(): void {
    apply(unlockBill(bill, { confirmed: true, now: new Date().toISOString(), mintToken }));
    confirmingUnlock = false;
  }

  function blockerText(blocker: LockBlocker): string {
    return blocker.refs && blocker.refs.length > 0
      ? `${blocker.code} (${blocker.refs.join(", ")})`
      : blocker.code;
  }
</script>

<section data-testid="lock-section">
  <h2>Lock</h2>
  <p>
    State: <span class="badge" data-testid="lifecycle-state">{lifecycle}</span>
  </p>

  {#if working.staleLinkCutoffAt !== null}
    <p class="notice" data-testid="stale-links-notice">
      Links sent before <time datetime={working.staleLinkCutoffAt}>{working.staleLinkCutoffAt}</time> show the
      amounts frozen at that lock. Re-send them once the bill is final again.
    </p>
  {/if}

  {#if working.unclassifiedRows.length > 0}
    <div data-testid="unclassified-rows">
      <h3>Rows the receipt could not classify</h3>
      <p class="hint">
        An excluded row stays on screen, excluded from the bill's arithmetic. Nothing above changes when you
        exclude it — this is a decision about what the receipt said, not an edit.
      </p>
      <ul>
        {#each working.unclassifiedRows as row (row.id)}
          <li data-testid="unclassified-row" data-row-id={row.id}>
            <span class="row-text">{row.text}</span>
            {#if excluded.has(row.id)}
              <span class="badge badge-ok" data-testid="row-excluded">excluded</span>
            {/if}
            {#if acknowledged.has(row.id)}
              <span class="badge badge-ok" data-testid="row-acknowledged">
                acknowledged{recordOf(working, row.id)?.acknowledgedAt
                  ? ` at ${recordOf(working, row.id)!.acknowledgedAt}`
                  : ""}
              </span>
            {:else if rowCarriesAnAmount(row.text)}
              <!-- The refusal edge, stated on the row: a row that prints money must be resolved in the bill. -->
              <span class="badge badge-warn" data-testid="row-carries-amount">carries an amount</span>
            {/if}
            <label class="inline">
              <input
                type="checkbox"
                data-testid="acknowledge-row"
                data-row-id={row.id}
                checked={acknowledged.has(row.id)}
                disabled={rowCarriesAnAmount(row.text)}
                onchange={(event) =>
                  apply(
                    setUnclassifiedRowAcknowledged(
                      bill,
                      row.id,
                      (event.currentTarget as HTMLInputElement).checked,
                      { now: new Date().toISOString() },
                    ),
                  )}
              />
              I read this row and accept it
            </label>
            <label class="inline">
              <input
                type="checkbox"
                data-testid="exclude-row"
                data-row-id={row.id}
                checked={excluded.has(row.id)}
                onchange={(event) =>
                  apply(
                    setUnclassifiedRowExcluded(
                      bill,
                      row.id,
                      (event.currentTarget as HTMLInputElement).checked,
                    ),
                  )}
              />
              Exclude from this bill
            </label>
          </li>
        {/each}
      </ul>
      <button
        type="button"
        data-testid="acknowledge-all-rows"
        disabled={pending.length === 0}
        onclick={acknowledgeAll}
      >
        Acknowledge {pending.length} row{pending.length === 1 ? "" : "s"} I have read
      </button>
      <p class="hint" data-testid="acknowledge-hint">
        Acknowledging is a human decision, not a parser class: it records that you read the row and accept it as
        it is. It excludes nothing from the bill's arithmetic and it is reversible until the bill locks. A row
        that carries an amount cannot be acknowledged — resolve it in the bill instead.
      </p>
    </div>
  {/if}

  <h3>Before this bill can lock</h3>
  {#if blockers.length === 0}
    <p class="hint" data-testid="no-blockers">No lock blockers.</p>
  {:else}
    <ul data-testid="blockers-list">
      {#each blockers as blocker (blockerText(blocker))}
        <!-- Coded reasons only: §6 line 401 forbids reading the message text to decide anything. -->
        <li data-testid="blocker">{blockerText(blocker)}</li>
      {/each}
    </ul>
  {/if}
  {#if effectiveAcknowledgements(working).length > 0}
    <!-- Ticket 23: transparency at lock time, not deletion. An acknowledged row no longer blocks, but it is still
         named here — with the moment a human accepted it — so locking cannot hide what the bill could not read. -->
    <div data-testid="acknowledged-rows-summary">
      <h3>Rows you acknowledged</h3>
      <p class="hint">
        These rows are on the bill, unchanged and outside its arithmetic. You told the bill you read them; it did
        not decide that for you.
      </p>
      <ul>
        {#each effectiveAcknowledgements(working) as entry (entry.row.id)}
          <li data-testid="acknowledged-summary-row" data-row-id={entry.row.id}>
            <span class="row-text">{entry.row.text}</span>
            <span class="hint">user-acknowledged at {entry.acknowledgedAt}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if bill.derived.sharesUnavailableFor !== null}
    <p class="hint" data-testid="shares-unavailable">
      Shares are not computed yet: {bill.derived.sharesUnavailableFor}.
    </p>
  {/if}

  {#if working.draftItems.length > 0}
    <p class="hint" data-testid="draft-finalize-hint">
      {working.draftItems.length} draft line(s) must be finalized before a lock: locking cannot create units
      on your behalf.
      <button type="button" data-testid="finalize-drafts" onclick={() => apply(finalizeAllResolvable(bill))}>
        Finalize {working.draftItems.length} draft item(s)
      </button>
    </p>
  {/if}

  {#if working.bill.isLocked}
    <p class="hint" data-testid="locked-note">
      This bill is locked. Unlocking starts a new revision and makes every link already sent stale.
    </p>
    <button type="button" data-testid="unlock-button" onclick={() => (confirmingUnlock = true)}>
      Unlock…
    </button>
  {:else}
    <button type="button" data-testid="lock-button" onclick={lock}>Lock bill</button>
  {/if}

  {#if confirmingUnlock}
    <div class="dialog-backdrop">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-title"
        data-testid="unlock-dialog"
      >
        <h2 id="unlock-title">Unlock this bill?</h2>
        <p>
          Unlocking starts a new revision. Every share link already sent stops working: the participants'
          tokens are regenerated, and a link from before this moment shows the amounts frozen at the last lock.
        </p>
        <p class="hint" data-testid="unlock-warning">Paid flags are kept. Nothing changes until you confirm.</p>
        <div class="inline">
          <button type="button" data-testid="unlock-cancel" onclick={() => (confirmingUnlock = false)}>
            Keep it locked
          </button>
          <button type="button" data-testid="unlock-confirm" onclick={unlock}>
            Unlock and regenerate links
          </button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .inline {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }

  .row-text {
    margin-right: 8px;
  }

  .badge {
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.75em;
    background: #e2e3e5;
  }

  .badge-ok {
    background: #d1e7dd;
    color: #0f5132;
  }

  .badge-warn {
    background: #fff3cd;
    color: #664d03;
  }

  .hint {
    font-size: 0.8em;
    color: #555;
  }

  .notice {
    background: #fff3cd;
    border: 1px solid #ffecb5;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }

  .dialog {
    background: #fff;
    border-radius: 6px;
    padding: 16px 20px;
    max-width: 32rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }

  section {
    margin-top: 20px;
  }
</style>
