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
    unassignUnit,
    type TransactionResult,
  } from "../lib/bill/transactions.js";
  import type { BillDocument } from "../lib/bill/document.js";

  let { bill }: { bill: BillDocument } = $props();

  let newName = $state("");

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

  function toggle(unitId: string, participantId: string, assigned: boolean): void {
    publish(assigned ? unassignUnit(bill, unitId, participantId) : assignUnit(bill, unitId, participantId));
  }

  function addName(): void {
    if (billStore.publish(addParticipant(bill, newName)).ok) newName = "";
  }
</script>

<section data-testid="participants-section">
  <h2>Participants</h2>
  <ul class="participants" data-testid="participant-list">
    {#each participants as participant (participant.id)}
      <li data-testid="participant-row" data-participant-id={participant.id}>{participant.name}</li>
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
              onchange={() =>
                toggle(
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

<style>
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
