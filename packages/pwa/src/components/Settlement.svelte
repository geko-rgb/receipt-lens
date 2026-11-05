<script lang="ts">
  /**
   * Ticket 15 — settlement presentation (DECISIONS/0024). Every number comes from `buildSettlement`, and the
   * only write on this screen is the existing `setParticipantPaid` transaction. A UPI intent can start a
   * payment; it cannot report one, so the paid checkbox is the creator's own statement and the copy says so.
   */
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import { buildSettlement } from "../lib/settlement-links.js";
  import { setParticipantPaid } from "../lib/bill/transactions.js";
  import type { BillDocument } from "../lib/bill/document.js";
  import type { CreatorProfile } from "../lib/entities.js";

  let { bill, profile }: { bill: BillDocument; profile: CreatorProfile | null } = $props();

  const view = $derived(buildSettlement(bill, profile, { origin: window.location.origin }));

  function onPaid(event: Event, participantId: string, paid: boolean): void {
    const input = event.currentTarget as HTMLInputElement;
    const published = billStore.publish(setParticipantPaid(bill, participantId, paid));
    // One-way binding: a refused settlement write must not leave the box claiming a state the bill lacks.
    if (!published.ok) input.checked = !paid;
  }
</script>

<section data-testid="settlement-section">
  <h2>Payments</h2>
  <p class="hint">
    A UPI link opens a payment app with the amount prefilled. It never proves a payment happened — the creator
    marks each person paid by hand.
  </p>

  {#if !view.ok}
    <p class="alert-error" data-testid="settlement-unavailable">{view.code}</p>
  {:else}
    <ul class="rows">
      {#each view.rows as row (row.participantId)}
        <li
          class="row"
          data-testid="settlement-row"
          data-participant-id={row.participantId}
          data-state={row.state}
        >
          <span class="name">{row.name}</span>

          {#if row.state === "payer"}
            <span class="badge" data-testid="payer-retained">
              your share is retained — you collect from the others
            </span>
            <span class="amount" data-testid="settlement-exact">Exact share: {row.exactText}</span>
          {:else if row.differs}
            <span class="amount" data-testid="settlement-exact">Exact share: {row.exactText}</span>
            <span class="amount" data-testid="settlement-payment">
              UPI payment amount: {row.paymentText}
            </span>
          {:else}
            <span class="amount" data-testid="settlement-payment">Share: {row.paymentText}</span>
          {/if}

          {#if row.state === "payable"}
            <a data-testid="upi-link" href={row.upiUrl!}>Pay {row.paymentText} with UPI</a>
            {#if row.whatsappUrl}
              <a data-testid="whatsapp-link" href={row.whatsappUrl} target="_blank" rel="noopener">
                Send on WhatsApp
              </a>
            {/if}
          {:else if row.state === "nothing_to_pay"}
            <span class="badge" data-testid="nothing-to-pay">nothing to pay</span>
          {:else if row.state === "refused"}
            <span class="badge badge-bad" data-testid="link-refused">{row.refusal}</span>
          {/if}

          <label class="paid">
            <input
              type="checkbox"
              data-testid="settlement-paid"
              data-participant-id={row.participantId}
              checked={row.paid}
              onchange={(event) =>
                onPaid(event, row.participantId, (event.currentTarget as HTMLInputElement).checked)}
            />
            paid
          </label>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .rows {
    list-style: none;
    padding: 0;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    border-bottom: 1px solid #eee;
    padding: 6px 0;
  }

  .name {
    font-weight: 600;
    min-width: 6rem;
  }

  .amount {
    font-variant-numeric: tabular-nums;
  }

  .paid {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    font-size: 0.8em;
    margin-left: auto;
  }

  .badge {
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.78em;
    background: #e2e3e5;
  }

  .badge-bad {
    background: #f8d7da;
    color: #842029;
  }

  .hint {
    font-size: 0.8em;
    color: #555;
  }

  .alert-error {
    background: #f8d7da;
    color: #842029;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  section {
    margin-top: 20px;
  }
</style>
