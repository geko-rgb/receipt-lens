<script lang="ts">
  /**
   * Ticket 11 — the bill editor. Every rule lives in `lib/bill/*` and is pinned by
   * `tests/bill/pins.test.ts`; this component is a thin shell over them, the same separation ticket 10 set
   * for `Capture.svelte` and `lib/capture/`.
   *
   * The reactivity rule from DECISIONS/0019 S8 is followed literally: a field that reads its value from the
   * committed document is never `bind:`-bound, because the row that renders it is a child of the list that
   * value selects. Values arrive through explicit `onchange` handlers, and a rejected transaction writes the
   * bill's still-true value back into the field, so the screen cannot show a number the data disagrees with.
   */
  import { getDraft } from "../lib/draft.js";
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import { visibleFindings } from "../lib/bill/document.js";
  import { formatPaise, formatPaiseOrNull, parsePaiseInput } from "../lib/bill/paise-input.js";
  import {
    acknowledgeUnassignedUnit,
    addManualCharge,
    addManualItem,
    deleteCharge,
    deleteItem,
    finalizeAllResolvable,
    finalizeItems,
    resolveChargeInclusion,
    reviewAssumedQuantity,
    setChargeAmount,
    setChargeSign,
    setChargeType,
    setGrandTotal,
    setItemName,
    setItemPrice,
    setItemQuantity,
    type TransactionResult,
  } from "../lib/bill/transactions.js";
  import type { LockBlocker } from "../lib/bill/working-bill.js";
  import type { ChargeType } from "../lib/entities.js";

  const CHARGE_TYPES: ChargeType[] = ["tax", "service_charge", "tip", "discount", "round_off", "other"];
  const INCLUSION_COHERENT: ChargeType[] = ["tax", "service_charge", "tip", "other"];

  const draft = getDraft();
  if (draft && !billStore.document) {
    // `createdAt` and the bill id come from the caller, so nothing in `lib/bill/` reads a clock
    // (DECISIONS/0011's determinism rule); the component is the boundary that is allowed to.
    const createdAt = new Date().toISOString();
    billStore.begin(draft, { billId: `bill:${createdAt}`, createdAt });
  }

  // Named `bill`, not `document`: shadowing the DOM global inside a browser component is how the next
  // person to touch this file loses an afternoon.
  const bill = $derived(billStore.document);
  const findings = $derived(bill === null ? [] : visibleFindings(bill));
  const blockers = $derived(bill === null ? null : bill.billValidation.blockers);

  let newItemName = $state("");
  let newItemQty = $state("");
  let newItemPrice = $state("");
  let newChargeLabel = $state("");
  let newChargeAmount = $state("");
  let newChargeType = $state<ChargeType>("tax");

  /** Commits a transaction, and hands a rejected one back so the field can be restored to the bill's value. */
  function apply(result: TransactionResult, restore?: (result: TransactionResult) => void): void {
    const published = billStore.publish(result);
    if (!published.ok && restore) restore(published);
  }

  function priceOf(id: string): number | null {
    if (!bill) return null;
    return bill.working.draftItems.find((entry) => entry.id === id)?.unitPrice ??
      bill.working.items.find((entry) => entry.id === id)?.unitPrice ??
      null;
  }

  function quantityOf(id: string): number | null {
    if (!bill) return null;
    return bill.working.draftItems.find((entry) => entry.id === id)?.qty ??
      bill.working.items.find((entry) => entry.id === id)?.qty ??
      null;
  }

  function onQuantity(event: Event, id: string): void {
    const input = event.currentTarget as HTMLInputElement;
    const text = input.value.trim();
    const qty = text === "" ? null : Number(text);
    apply(setItemQuantity(bill!, id, qty), () => {
      input.value = quantityOf(id) === null ? "" : String(quantityOf(id));
    });
  }

  function onPrice(event: Event, id: string): void {
    const input = event.currentTarget as HTMLInputElement;
    apply(setItemPrice(bill!, id, parsePaiseInput(input.value)), () => {
      const current = priceOf(id);
      input.value = current === null ? "" : formatPaise(current);
    });
  }

  function onName(event: Event, id: string): void {
    const input = event.currentTarget as HTMLInputElement;
    apply(setItemName(bill!, id, input.value));
  }

  function onChargeAmount(event: Event, id: string): void {
    const input = event.currentTarget as HTMLInputElement;
    apply(setChargeAmount(bill!, id, parsePaiseInput(input.value)));
  }

  function onChargeType(event: Event, id: string): void {
    const select = event.currentTarget as HTMLSelectElement;
    apply(setChargeType(bill!, id, select.value as ChargeType));
  }

  function onChargeSign(event: Event, id: string): void {
    const select = event.currentTarget as HTMLSelectElement;
    apply(setChargeSign(bill!, id, select.value as "add" | "subtract" | "unknown"));
  }

  function addLine(): void {
    const result = addManualItem(bill!, {
      name: newItemName,
      qty: newItemQty.trim() === "" ? null : Number(newItemQty),
      unitPrice: parsePaiseInput(newItemPrice),
    });
    if (billStore.publish(result).ok) {
      newItemName = "";
      newItemQty = "";
      newItemPrice = "";
    }
  }

  function addCharge(): void {
    const result = addManualCharge(bill!, {
      label: newChargeLabel,
      type: newChargeType,
      amount: parsePaiseInput(newChargeAmount),
    });
    if (billStore.publish(result).ok) {
      newChargeLabel = "";
      newChargeAmount = "";
    }
  }

  function correctGrandTotal(event: Event): void {
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("grand-total") as HTMLInputElement;
    const value = parsePaiseInput(input.value);
    // A blank field is not a correction: `grandTotal` stays as the receipt printed it (§10 line 743).
    // Anything unparseable is handed to the seam, which rejects it as `invalid_amount` and leaves the bill
    // exactly where it was — the one rejection path the UI is allowed to show rather than re-check.
    if (value === null) return;
    apply(setGrandTotal(bill!, value));
    input.value = "";
  }
  function blockerText(blocker: LockBlocker): string {
    return blocker.refs && blocker.refs.length > 0 ? `${blocker.code} (${blocker.refs.join(", ")})` : blocker.code;
  }
</script>

<h1>Bill</h1>

{#if !bill}
  <p data-testid="bill-empty">No draft yet — capture a receipt first.</p>
{:else}
  {@const working = bill.working}
  {@const derived = bill.derived}

  {#if draft && billStore.importedFrom !== draft}
    <div class="notice" data-testid="reimport-notice">
      A newer accepted parse is available. This bill keeps your edits until you choose to replace it.
    </div>
  {/if}

  <section class="totals" data-testid="totals">
    <h2>Totals</h2>
    <p data-testid="calculated-items">Calculated items: {formatPaise(derived.calculatedItemsTotal)}</p>
    <p data-testid="calculated-payable">Calculated payable: {formatPaise(derived.calculatedPayableTotal)}</p>
    <p data-testid="printed-subtotal">Printed subtotal: {formatPaiseOrNull(derived.printedSubtotal)}</p>
    <p data-testid="printed-grand-total">
      Printed grand total: {formatPaiseOrNull(derived.printedGrandTotal)}
      <span class="provenance" data-testid="grand-total-source">{working.bill.grandTotalSource}</span>
    </p>
    <p data-testid="reconciliation-gap">
      Gap (printed − calculated):
      {derived.reconciliationGap === null ? "unknown" : formatPaise(derived.reconciliationGap)}
    </p>
    <p class="hint" data-testid="draft-count">
      {working.draftItems.length} draft line(s), {working.items.length} item(s),
      {working.draftCharges.length} draft charge(s), {working.charges.length} charge(s).
    </p>

    <form class="inline" data-testid="grand-total-form" onsubmit={(event) => { event.preventDefault(); correctGrandTotal(event); }}>
      <label for="grand-total">Correct the printed grand total</label>
      <input id="grand-total" name="grand-total" type="text" inputmode="decimal" data-testid="grand-total-input" />
      <button type="submit" data-testid="grand-total-apply">Set</button>
    </form>
  </section>

  {#if billStore.rejection}
    <div class="alert alert-error" role="alert" data-testid="transaction-rejected">
      Change not applied: {billStore.rejection.code} — the bill still shows
      {formatPaise(derived.calculatedPayableTotal)}.
    </div>
  {/if}

  <section data-testid="draft-items-section">
    <h2>Draft lines</h2>
    {#if working.draftItems.length === 0}
      <p class="hint" data-testid="no-drafts">No unresolved drafts.</p>
    {:else}
      {#each working.draftItems as line (line.id)}
        <div class="row" data-testid="draft-row" data-line-id={line.id}>
          <input
            type="text"
            class="line-name"
            data-testid="draft-name"
            value={line.name}
            onchange={(event) => onName(event, line.id)}
          />
          <input
            type="text"
            class="line-qty"
            inputmode="numeric"
            data-testid="draft-qty"
            value={line.qty === null ? "" : String(line.qty)}
            onchange={(event) => onQuantity(event, line.id)}
          />
          <input
            type="text"
            class="line-price"
            inputmode="decimal"
            data-testid="draft-price"
            value={line.unitPrice === null ? "" : formatPaise(line.unitPrice)}
            onchange={(event) => onPrice(event, line.id)}
          />
          <span class="provenance" data-testid="draft-provenance">{line.priceSource} · {line.quantitySource}</span>
          {#if line.assumedQtyReviewed}
            <span class="badge badge-ok" data-testid="assumed-reviewed">reviewed</span>
          {:else if line.quantitySource === "assumed"}
            <button type="button" data-testid="review-assumed" onclick={() => apply(reviewAssumedQuantity(bill, line.id))}>
              Review qty 1
            </button>
          {/if}
          <button type="button" data-testid="finalize-line" onclick={() => apply(finalizeItems(bill, [line.id]))}>
            Finalize
          </button>
          <button type="button" data-testid="delete-draft" onclick={() => apply(deleteItem(bill, line.id))}>Delete</button>
        </div>
      {/each}
    {/if}
    <button type="button" data-testid="finalize-all" onclick={() => apply(finalizeAllResolvable(bill))}>
      Finalize all resolved
    </button>
  </section>

  <section data-testid="items-section">
    <h2>Items</h2>
    {#if working.items.length === 0}
      <p class="hint" data-testid="no-items">No finalized items yet.</p>
    {:else}
      {#each working.items as item (item.id)}
        <div class="row" data-testid="item-row" data-line-id={item.id}>
          <input type="text" class="line-name" data-testid="item-name" value={item.name} onchange={(event) => onName(event, item.id)} />
          <input
            type="text"
            class="line-qty"
            inputmode="numeric"
            data-testid="item-qty"
            value={String(item.qty)}
            onchange={(event) => onQuantity(event, item.id)}
          />
          <input
            type="text"
            class="line-price"
            inputmode="decimal"
            data-testid="item-price"
            value={formatPaise(item.unitPrice)}
            onchange={(event) => onPrice(event, item.id)}
          />
          <span data-testid="item-line-total">{formatPaise(item.lineTotal)}</span>
          {#if item.detectedLineTotal !== null}
            <span class="provenance" data-testid="detected-line-total">printed {formatPaise(item.detectedLineTotal)}</span>
          {/if}
          <span class="provenance" data-testid="item-provenance">{item.priceSource} · {item.quantitySource}</span>
          {#if item.assumedQtyReviewed}
            <span class="badge badge-ok" data-testid="item-reviewed">reviewed</span>
          {:else if item.quantitySource === "assumed"}
            <button type="button" data-testid="review-item" onclick={() => apply(reviewAssumedQuantity(bill, item.id))}>
              Review qty 1
            </button>
          {/if}
          <button type="button" data-testid="delete-item" onclick={() => apply(deleteItem(bill, item.id))}>Delete</button>
        </div>
        <div class="units" data-testid="unit-list">
          {#each working.itemUnits.filter((unit) => unit.itemId === item.id) as unit (unit.id)}
            <span class="unit" data-testid="unit">
              {unit.unitIndex}
              {#if unit.confirmedUnassigned}
                <span class="badge badge-ok">unassigned acknowledged</span>
              {:else}
                <button type="button" data-testid="acknowledge-unit" onclick={() => apply(acknowledgeUnassignedUnit(bill, unit.id))}>
                  Mark unassigned
                </button>
              {/if}
            </span>
          {/each}
        </div>
      {/each}
    {/if}
  </section>

  <section data-testid="draft-charges-section">
    <h2>Draft charges</h2>
    {#if working.draftCharges.length === 0}
      <p class="hint" data-testid="no-draft-charges">No unresolved charges.</p>
    {:else}
      {#each working.draftCharges as charge (charge.id)}
        <div class="row" data-testid="draft-charge-row">
          <span class="row-name">{charge.label}</span>
          <select data-testid="charge-type" value={charge.type ?? ""} onchange={(event) => onChargeType(event, charge.id)}>
            <option value="" disabled>type unresolved</option>
            {#each CHARGE_TYPES as type (type)}
              <option value={type}>{type}</option>
            {/each}
          </select>
          <input
            type="text"
            class="line-price"
            inputmode="decimal"
            data-testid="charge-amount"
            value={charge.amount === null ? "" : formatPaise(charge.amount)}
            onchange={(event) => onChargeAmount(event, charge.id)}
          />
          {#if charge.type === "other"}
            <select data-testid="charge-sign" value={charge.otherSign ?? "unknown"} onchange={(event) => onChargeSign(event, charge.id)}>
              <option value="unknown">sign unresolved</option>
              <option value="add">add</option>
              <option value="subtract">subtract</option>
            </select>
          {/if}
          {#if charge.included === null && INCLUSION_COHERENT.includes(charge.type ?? "other")}
            <span data-testid="inclusion-unresolved">inclusion unresolved</span>
            <button type="button" data-testid="inclusion-included" onclick={() => apply(resolveChargeInclusion(bill, charge.id, true))}>
              In prices
            </button>
            <button type="button" data-testid="inclusion-separate" onclick={() => apply(resolveChargeInclusion(bill, charge.id, false))}>
              Separate
            </button>
          {:else}
            <span class="provenance" data-testid="charge-inclusion">included {String(charge.included)}</span>
          {/if}
          <button type="button" data-testid="delete-draft-charge" onclick={() => apply(deleteCharge(bill, charge.id))}>Delete</button>
        </div>
      {/each}
    {/if}
  </section>

  <section data-testid="charges-section">
    <h2>Charges</h2>
    {#if working.charges.length === 0}
      <p class="hint" data-testid="no-charges">No finalized charges.</p>
    {:else}
      {#each working.charges as charge (charge.id)}
        <div class="row" data-testid="charge-row">
          <span class="row-name">{charge.label}</span>
          <span data-testid="charge-type-label">{charge.type}</span>
          <span data-testid="charge-amount-label">{formatPaise(charge.amount)}</span>
          <span class="provenance" data-testid="charge-state">
            included {String(charge.included)} · {charge.source}
          </span>
          {#if INCLUSION_COHERENT.includes(charge.type)}
            <button
              type="button"
              data-testid="toggle-inclusion"
              onclick={() => apply(resolveChargeInclusion(bill, charge.id, !charge.included))}
            >
              {charge.included ? "Charge separately" : "Include in prices"}
            </button>
          {/if}
          <button type="button" data-testid="delete-charge" onclick={() => apply(deleteCharge(bill, charge.id))}>Delete</button>
        </div>
      {/each}
    {/if}
  </section>

  <section data-testid="add-section">
    <h2>Add a line by hand</h2>
    <div class="inline">
      <input type="text" data-testid="new-line-name" placeholder="Name" bind:value={newItemName} />
      <input type="text" data-testid="new-line-qty" placeholder="qty" inputmode="numeric" bind:value={newItemQty} />
      <input type="text" data-testid="new-line-price" placeholder="₹0.00" inputmode="decimal" bind:value={newItemPrice} />
      <button type="button" data-testid="add-line" onclick={addLine}>Add item</button>
    </div>
    <div class="inline">
      <input type="text" data-testid="new-charge-label" placeholder="Charge label" bind:value={newChargeLabel} />
      <select data-testid="new-charge-type" bind:value={newChargeType}>
        {#each CHARGE_TYPES as type (type)}
          <option value={type}>{type}</option>
        {/each}
      </select>
      <input type="text" data-testid="new-charge-amount" placeholder="₹0.00" inputmode="decimal" bind:value={newChargeAmount} />
      <button type="button" data-testid="add-charge" onclick={addCharge}>Add charge</button>
    </div>
  </section>

  <section data-testid="findings-section">
    <h2>Findings</h2>
    {#if findings.length === 0}
      <p class="hint" data-testid="no-findings">Nothing to report.</p>
    {:else}
      <ul data-testid="findings-list">
        {#each findings as finding (finding.code + finding.scope + (finding.itemRefs ?? []).join() + (finding.chargeRefs ?? []).join() + (finding.rowRefs ?? []).join())}
          <li class={finding.severity} data-testid="finding">
            <span data-testid="finding-code">{finding.code}</span>
            <span class="provenance">{finding.severity} · {finding.scope}</span>
            {#if finding.itemRefs?.length}<span class="refs">{finding.itemRefs.join(", ")}</span>{/if}
            {#if finding.chargeRefs?.length}<span class="refs">{finding.chargeRefs.join(", ")}</span>{/if}
            {#if finding.rowRefs?.length}<span class="refs">{finding.rowRefs.join(", ")}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section data-testid="blockers-section">
    <h2>Before this bill can lock</h2>
    {#if blockers === null}
      <p class="hint">No bill.</p>
    {:else if blockers.locking.length === 0}
      <p class="hint" data-testid="no-blockers">No lock blockers — ticket 13 takes it from here.</p>
    {:else}
      <ul data-testid="blockers-list">
        {#each blockers.locking as blocker (blockerText(blocker))}
          <!-- Coded reasons only: §6 line 401 forbids reading the message text to decide anything. -->
          <li data-testid="blocker">{blockerText(blocker)}</li>
        {/each}
      </ul>
      {#if derived.sharesUnavailableFor !== null}
        <p class="hint" data-testid="shares-unavailable">
          Shares are not computed yet: {derived.sharesUnavailableFor}.
        </p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    border-bottom: 1px solid #eee;
    padding: 6px 0;
  }

  .inline {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }

  .line-name {
    flex: 1 1 12rem;
  }

  .line-qty {
    width: 4.5rem;
  }

  .line-price {
    width: 7rem;
  }

  .provenance,
  .hint,
  .refs {
    font-size: 0.8em;
    color: #555;
  }

  .units {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 2px 0 8px 12px;
  }

  .unit {
    font-size: 0.85em;
    color: #333;
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

  .critical {
    color: #842029;
  }

  .minor {
    color: #66519a;
  }

  .alert-error {
    background: #f8d7da;
    color: #842029;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  .notice {
    background: #d1e7dd;
    color: #0f5132;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  section {
    margin-top: 20px;
  }
</style>
