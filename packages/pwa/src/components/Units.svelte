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
    allocateItemQuantity,
    assignUnit,
    removeParticipant,
    setParticipantPaid,
    setPayer,
    unassignUnit,
    type TransactionResult,
  } from "../lib/bill/transactions.js";
  import { planQuantityAllocation } from "../lib/bill/units.js";
  import type { BillDocument } from "../lib/bill/document.js";

  let { bill }: { bill: BillDocument } = $props();

  let newName = $state("");

  /** The participant whose removal is waiting for confirmation (DECISIONS/0022 A16: confirm first). */
  let removing = $state<string | null>(null);

  /**
   * Owner request (`next.md` Phase 4): two explicit assignment modes per item.
   *
   * `unit` is the shipped per-unit mode (each checkbox is one `assignUnit`, shared units allowed). `quantity` is
   * the count-entry mode for large quantities: type how many each person had, see the remainder, confirm once.
   * They are different meanings, so the mode is a choice the creator makes per item rather than a heuristic.
   */
  let mode = $state<Record<string, "unit" | "quantity">>({});
  /** The typed counts per item, keyed `itemId:participantId`; a string so a half-typed value is representable. */
  let counts = $state<Record<string, string>>({});
  /** The item whose allocation is waiting for confirmation, plus the numbers it would write. */
  let pendingAllocation = $state<{ itemId: string; total: number; remaining: number } | null>(null);

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

  /**
   * The owner's rule, in one line: a one-unit line keeps the shipped checkbox, and anything larger opens on the
   * quantity table. A table for "how many of your one chapati" is strictly more work than the tick it replaces,
   * and six checkbox rows for six chapatis is the friction this feature exists to remove. The creator can still
   * switch either way — this is the default, not a restriction.
   */
  function modeOf(itemId: string): "unit" | "quantity" {
    return mode[itemId] ?? (unitCountOf(itemId) > 1 ? "quantity" : "unit");
  }

  function unitCountOf(itemId: string): number {
    return bill.working.itemUnits.filter((unit) => unit.itemId === itemId).length;
  }

  function countKey(itemId: string, participantId: string): string {
    return `${itemId}:${participantId}`;
  }

  /** The parsed, validated counts for one item, in participant order, and the remainder they leave. */
  function allocationOf(itemId: string): { entries: { participantId: string; quantity: number }[]; total: number; remaining: number; invalid: string[] } {
    const total = unitCountOf(itemId);
    const entries: { participantId: string; quantity: number }[] = [];
    const invalid: string[] = [];
    for (const participant of participants) {
      const raw = (counts[countKey(itemId, participant.id)] ?? "").trim();
      if (raw === "") continue;
      const value = Number(raw);
      // Requirement 6: negative or non-integer input is invalid input, never silently coerced to 0 or 1.
      if (!Number.isInteger(value) || value < 0) {
        invalid.push(participant.name);
        continue;
      }
      entries.push({ participantId: participant.id, quantity: value });
    }
    const allocated = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    return { entries, total, remaining: total - allocated, invalid };
  }

  /** Requirement 8: the write waits for confirmation. Requirement 4/5 are shown right here, before the dialog. */
  function requestAllocation(itemId: string): void {
    const allocation = allocationOf(itemId);
    if (allocation.invalid.length > 0) return;
    pendingAllocation = { itemId, total: allocation.total, remaining: allocation.remaining };
  }

  function confirmAllocation(): void {
    if (pendingAllocation === null) return;
    const { itemId } = pendingAllocation;
    const allocation = allocationOf(itemId);
    const published = billStore.publish(allocateItemQuantity(bill, itemId, allocation.entries));
    // The dialog closes either way. A rejection is reported by the document's own rejection surface — the same
    // one every other edit uses — and leaving a modal over the page would hide it and block the next attempt.
    // The typed counts survive a rejection, so the creator can adjust rather than retype.
    pendingAllocation = null;
    if (published.ok) {
      // Requirement 10: the screen reads the committed document, so it updates in the same turn the write lands.
      const next = { ...counts };
      for (const participant of participants) delete next[countKey(itemId, participant.id)];
      counts = next;
    }
  }

  /** Prefill from the units already held, so switching mode shows the assignment that exists rather than zeros. */
  function prefillFromUnits(itemId: string): void {
    const next = { ...counts };
    for (const participant of participants) {
      const held = bill.working.assignments.filter(
        (assignment) =>
          assignment.participantId === participant.id &&
          bill.working.itemUnits.some((unit) => unit.id === assignment.itemUnitId && unit.itemId === itemId),
      ).length;
      next[countKey(itemId, participant.id)] = held === 0 ? "" : String(held);
    }
    counts = next;
  }

  function switchMode(itemId: string, next: "unit" | "quantity"): void {
    mode = { ...mode, [itemId]: next };
    if (next === "quantity") prefillFromUnits(itemId);
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

    <!--
      Owner request (`next.md` Phase 4): the two modes are named, not inferred. `By quantity` is the fast path for a
      large count; `Per unit` keeps the shipped behaviour, including holding one unit between several people.
    -->
    <div class="inline mode" data-testid="assignment-mode" data-item-id={entry.item.id}>
      <span class="provenance">Assign</span>
      <button
        type="button"
        class:active={modeOf(entry.item.id) === "quantity"}
        data-testid="mode-quantity"
        data-item-id={entry.item.id}
        onclick={() => switchMode(entry.item.id, "quantity")}
      >
        By quantity
      </button>
      <button
        type="button"
        class:active={modeOf(entry.item.id) === "unit"}
        data-testid="mode-unit"
        data-item-id={entry.item.id}
        onclick={() => switchMode(entry.item.id, "unit")}
      >
        Per unit
      </button>
    </div>

    {#if modeOf(entry.item.id) === "quantity"}
      {@const allocation = allocationOf(entry.item.id)}
      <div class="quantity-panel" data-testid="quantity-panel" data-item-id={entry.item.id}>
        <table class="quantity-table">
          <thead>
            <tr><th scope="col">Person</th><th scope="col">Quantity</th><th scope="col">Cost</th></tr>
          </thead>
          <tbody>
            {#each participants as participant (participant.id)}
              {@const raw = counts[countKey(entry.item.id, participant.id)] ?? ""}
              {@const parsed = Number(raw)}
              <tr data-testid="quantity-row" data-participant-id={participant.id}>
                <th scope="row">{participant.name}</th>
                <td>
                  <input
                    type="text"
                    inputmode="numeric"
                    class="quantity-input"
                    data-testid="quantity-input"
                    data-participant-id={participant.id}
                    value={raw}
                    aria-label={`How many of ${entry.item.name} ${participant.name} had`}
                    oninput={(event) => {
                      counts = { ...counts, [countKey(entry.item.id, participant.id)]: (event.currentTarget as HTMLInputElement).value };
                    }}
                  />
                </td>
                <td class="provenance">
                  {Number.isInteger(parsed) && parsed > 0 ? formatPaise(parsed * entry.item.unitPrice) : "—"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <p data-testid="quantity-total" data-item-id={entry.item.id}>
          Allocated: {allocation.total - allocation.remaining} / {allocation.total}
          · {formatPaise(entry.item.unitPrice)} per unit
        </p>
        {#if allocation.remaining > 0}
          <p class="hint" data-testid="quantity-remaining">
            {allocation.remaining} unit(s) still unallocated. They stay unassigned unless you enter them.
          </p>
        {:else if allocation.remaining < 0}
          <p class="alert alert-error" role="alert" data-testid="quantity-excess">
            That is {Math.abs(allocation.remaining)} more than was bought.
          </p>
        {/if}
        {#if allocation.invalid.length > 0}
          <p class="alert alert-error" role="alert" data-testid="quantity-invalid">
            {allocation.invalid.join(", ")}: enter a whole number, zero or more.
          </p>
        {/if}

        <button
          type="button"
          data-testid="quantity-confirm"
          data-item-id={entry.item.id}
          disabled={allocation.remaining < 0 || allocation.invalid.length > 0 || allocation.entries.length === 0}
          onclick={() => requestAllocation(entry.item.id)}
        >
          Confirm allocation
        </button>
      </div>
    {:else}
    <div data-testid="per-unit-panel">
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
    {/if}
  </div>
{/each}

{#if pendingAllocation !== null}
  {@const entry = items.find((candidate) => candidate.item.id === pendingAllocation!.itemId)}
  {@const allocation = allocationOf(pendingAllocation.itemId)}
  <div class="dialog-backdrop">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="allocation-title" data-testid="allocation-dialog">
      <h2 id="allocation-title">Confirm this allocation?</h2>
      <p data-testid="allocation-summary">
        {entry?.item.name ?? "This line"}: {allocation.total - allocation.remaining} of {allocation.total} unit(s).
      </p>
      <ul>
        {#each allocation.entries.filter((row) => row.quantity > 0) as row (row.participantId)}
          <li data-testid="allocation-line">
            {nameOf(row.participantId)} — {row.quantity} × {formatPaise(entry?.item.unitPrice ?? 0)}
            = {formatPaise(row.quantity * (entry?.item.unitPrice ?? 0))}
          </li>
        {/each}
      </ul>
      {#if pendingAllocation.remaining > 0}
        <p class="hint" data-testid="allocation-remaining">
          {pendingAllocation.remaining} unit(s) stay unassigned. The bill will ask about them before it can lock.
        </p>
      {/if}
      <p class="hint">Nothing changes until you confirm.</p>
      <div class="inline">
        <button type="button" data-testid="allocation-cancel" onclick={() => (pendingAllocation = null)}>Keep as is</button>
        <button type="button" data-testid="allocation-save" onclick={confirmAllocation}>Save allocation</button>
      </div>
    </div>
  </div>
{/if}

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

  .mode button {
    font-size: 0.8em;
    padding: 2px 8px;
  }

  .mode button.active {
    font-weight: 600;
    background: #e7f1ff;
    border-color: #0d6efd;
  }

  .quantity-panel {
    font-size: 0.85em;
  }

  .quantity-table {
    border-collapse: collapse;
    margin: 4px 0 8px;
  }

  .quantity-table th,
  .quantity-table td {
    text-align: left;
    padding: 2px 10px 2px 0;
    font-weight: 400;
  }

  .quantity-table thead th {
    font-size: 0.85em;
    color: #555;
    font-weight: 600;
  }

  .quantity-input {
    width: 5rem;
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
