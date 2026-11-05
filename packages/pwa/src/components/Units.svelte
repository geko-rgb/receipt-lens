<script lang="ts">
  /**
   * Ticket 12 — participants and per-unit ownership (DECISIONS/0021 A2–A5, A10, A11).
   *
   * The component projects `BillDocument`; it never validates or cascades anything itself. One click is one
   * transaction: a checkbox calls `assignUnit`/`unassignUnit`, the acknowledge button calls
   * `acknowledgeUnassignedUnit`, and the roster's form calls `addParticipant`. There is no drag and drop, no
   * bulk acknowledge and no local copy of the assignments — §6 line 400's rule that the screen must not hold
   * state the document does not.
   */
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import { formatPaise } from "../lib/bill/paise-input.js";
  import {
    acknowledgeUnassignedUnit,
    addParticipant,
    assignUnit,
    removeParticipant,
    setParticipantPaid,
    setPayer,
    unassignUnit,
    type TransactionResult,
  } from "../lib/bill/transactions.js";
  import type { BillDocument } from "../lib/bill/document.js";

  let { bill }: { bill: BillDocument } = $props();

  let newName = $state("");

  /** The participant whose removal is waiting for confirmation (DECISIONS/0022 A16: confirm first). */
  let removing = $state<string | null>(null);

  const participants = $derived(bill.working.participants);
  const items = $derived(
    bill.working.items
      .map((item) => ({
        item,
        units: bill.working.itemUnits.filter((unit) => unit.itemId === item.id),
      }))
      .filter((entry) => entry.units.length > 0),
  );

  function publish(result: TransactionResult): void {
    billStore.publish(result);
  }

  function nameOf(participantId: string): string {
    return participants.find((participant) => participant.id === participantId)?.name ?? participantId;
  }

  function holders(unitId: string) {
    return bill.working.assignments.filter((assignment) => assignment.itemUnitId === unitId);
  }

  function toggle(event: Event, unitId: string, participantId: string, assigned: boolean): void {
    const published = billStore.publish(
      assigned ? unassignUnit(bill, unitId, participantId) : assignUnit(bill, unitId, participantId),
    );
    // `checked` is bound one-way, so a refused transaction would otherwise leave the box showing an
    // assignment the document does not have (§6 line 400). `onPaid` and `onPayer` already roll back.
    if (!published.ok) (event.currentTarget as HTMLInputElement).checked = assigned;
  }

  /**
   * A non-secret, stable marker for the share-link material: the token itself never enters the DOM, but the
   * roster can still show that unlock produced a different generation (DECISIONS/0022 L4, ticket 16's links).
   */
  function fingerprint(token: string): string {
    if (token === "") return "";
    let hash = 0x811c9dc5;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function onPayer(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    const published = billStore.publish(setPayer(bill, select.value === "" ? null : select.value));
    if (!published.ok) select.value = bill.working.bill.payerId;
  }

  function onPaid(event: Event, participantId: string): void {
    const input = event.currentTarget as HTMLInputElement;
    const published = billStore.publish(setParticipantPaid(bill, participantId, input.checked));
    if (!published.ok) input.checked = !input.checked;
  }

  function confirmRemoval(): void {
    if (removing === null) return;
    const published = billStore.publish(removeParticipant(bill, removing));
    if (published.ok) removing = null;
  }

  function addName(): void {
    if (billStore.publish(addParticipant(bill, newName)).ok) newName = "";
  }
</script>

<section data-testid="participants-section">
  <h2>Participants</h2>
  <div class="inline">
    <label for="payer">Payer</label>
    <select id="payer" data-testid="payer-select" value={bill.working.bill.payerId} onchange={onPayer}>
      <option value="">(no payer yet)</option>
      <!-- DECISIONS/0024 S1: only the creator can be the payer in v1, so the selector offers only them. -->
      {#each participants.filter((participant) => participant.id === bill.working.bill.creatorId) as participant (participant.id)}
        <option value={participant.id}>{participant.name}</option>
      {/each}
    </select>
    <span class="provenance" data-testid="payer-rule">
      v1: the creator pays and collects; other payers need a stored UPI id.
    </span>
  </div>
  <ul class="participants" data-testid="participant-list">
    {#each participants as participant (participant.id)}
      <li
        data-testid="participant-row"
        data-participant-id={participant.id}
        data-token-fingerprint={fingerprint(participant.token)}
      >
        {participant.name}
        {#if participant.id === bill.working.bill.payerId}
          <span class="badge badge-ok" data-testid="payer-badge">payer</span>
        {/if}
        <label class="paid">
          <input
            type="checkbox"
            data-testid="paid-toggle"
            data-participant-id={participant.id}
            checked={participant.paid}
            onchange={(event) => onPaid(event, participant.id)}
          />
          paid
        </label>
        {#if participant.id !== bill.working.bill.creatorId && participant.id !== bill.working.bill.payerId}
          <button
            type="button"
            data-testid="remove-participant"
            data-participant-id={participant.id}
            onclick={() => (removing = participant.id)}
          >
            Remove
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  <form class="inline" onsubmit={(event) => { event.preventDefault(); addName(); }}>
    <label for="participant-name">Add someone who shares this bill</label>
    <input id="participant-name" type="text" data-testid="participant-name" bind:value={newName} />
    <button type="submit" data-testid="add-participant">Add participant</button>
  </form>
</section>

{#each items as entry (entry.item.id)}
  <div class="units" data-testid="unit-list" data-item-id={entry.item.id}>
    <h3>{entry.item.name} — {entry.units.length} unit(s) at {formatPaise(entry.item.unitPrice)}</h3>
    {#each entry.units as unit (unit.id)}
      {@const assigned = holders(unit.id)}
      <div class="unit" data-testid="unit" data-unit-id={unit.id}>
        <span class="unit-label">Unit {unit.unitIndex + 1}</span>
        {#each participants as participant (participant.id)}
          <label>
            <input
              type="checkbox"
              data-testid="assign-unit"
              data-participant-id={participant.id}
              checked={assigned.some((assignment) => assignment.participantId === participant.id)}
              onchange={(event) =>
                toggle(
                  event,
                  unit.id,
                  participant.id,
                  assigned.some((assignment) => assignment.participantId === participant.id),
                )}
            />
            {participant.name}
          </label>
        {/each}
        {#if assigned.length === 1}
          <span class="provenance" data-testid="unit-division">held by {nameOf(assigned[0]!.participantId)}</span>
        {:else if assigned.length > 1}
          <span class="provenance" data-testid="unit-division">
            {formatPaise(entry.item.unitPrice)} ÷ {assigned.length}
          </span>
        {/if}
        {#if unit.confirmedUnassigned}
          <span class="badge badge-ok" data-testid="unit-acknowledged">unassigned acknowledged</span>
        {:else if assigned.length === 0}
          <button
            type="button"
            data-testid="acknowledge-unit"
            onclick={() => publish(acknowledgeUnassignedUnit(bill, unit.id))}
          >
            Mark unassigned
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/each}

{#if removing !== null}
  {@const doomed = participants.find((participant) => participant.id === removing)}
  {@const held = bill.working.assignments.filter((assignment) => assignment.participantId === removing)}
  <div class="dialog-backdrop">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title" data-testid="remove-dialog">
      <h2 id="remove-title">Remove {doomed?.name ?? "this participant"}?</h2>
      <p>{held.length} assignment(s) go with them, and those units become pending again.</p>
      <p class="hint">A paid participant cannot be removed: settlement is a completed state.</p>
      <div class="inline">
        <button type="button" data-testid="remove-cancel" onclick={() => (removing = null)}>Keep</button>
        <button type="button" data-testid="remove-confirm" onclick={confirmRemoval}>Remove them</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .paid {
    display: inline-flex;
    gap: 3px;
    align-items: center;
    font-size: 0.8em;
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

  .participants {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    list-style: none;
    padding: 0;
    margin: 6px 0;
  }

  .inline {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }

  .units {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 0 8px 12px;
  }

  .unit {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    font-size: 0.85em;
    color: #333;
  }

  .unit label {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }

  .unit-label {
    font-weight: 600;
  }

  .provenance {
    font-size: 0.85em;
    color: #555;
  }

  .badge {
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.75em;
  }

  .badge-ok {
    background: #d1e7dd;
    color: #0f5132;
  }
</style>
