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
  import { onMount } from "svelte";
  import { getDraft } from "../lib/draft.js";
  import { storage } from "../lib/storage/storage-state.svelte.js";
  import { billStore } from "../lib/bill/bill-document.svelte.js";
  import Units from "../components/Units.svelte";
  import Lock from "../components/Lock.svelte";
  import { visibleFindings } from "../lib/bill/document.js";
  import { previewQuantityChange, type QuantityChangePreview } from "../lib/bill/units.js";
  import { formatPaise, formatPaiseOrNull, parsePaiseInput } from "../lib/bill/paise-input.js";
  import {
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
  import type { ChargeType } from "../lib/entities.js";

  const CHARGE_TYPES: ChargeType[] = ["tax", "service_charge", "tip", "discount", "round_off", "other"];
  const INCLUSION_COHERENT: ChargeType[] = ["tax", "service_charge", "tip", "other"];

  const draft = getDraft();
  const session = storage.session();
  /** P7: what was read back from this device, so the screen can say which bill it is and when it was saved. */
  let restored = $state<{ billId: string; revision: number; savedAt: string } | null>(null);
  /** P6: whether a photo is kept for this bill — presence is the state, so this is a store question. */
  let keptPhoto = $state(false);
  let photoDeleted = $state(false);

  /**
   * The one entry point, in the order the rules require.
   *
   * The profile is read *first*: `creatorName` is a synchronous argument to `billStore.begin` (0011: nothing
   * in `lib/bill/*` reads a clock or a store), so P8's seeding only works if the value is already in hand
   * when the bill is built. Reading it after the import would seed a bill that already has a name.
   *
   * A fresh capture wins over a restore: the handoff is the thing the user just did, and P7's restore exists
   * for the case where there is no handoff — a reload, a shared route, ticket 17's offline start.
   */
  async function start(): Promise<void> {
    if (billStore.document) return;
    await storage.guard(() => session.loadProfile());
    if (draft) {
      // `createdAt` and the bill id come from the caller, so nothing in `lib/bill/` reads a clock
      // (DECISIONS/0011's determinism rule); the component is the boundary that is allowed to.
      const createdAt = new Date().toISOString();
      billStore.begin(draft, { billId: `bill:${createdAt}`, createdAt });
      return;
    }
    const document = await storage.guard(() => session.restore());
    if (!document) return;
    const billId = document.working.bill.id;
    billStore.attachRestored(document);
    // `savedAt` is asked for, not carried: it is storage metadata and never bill content (P1).
    const savedAt = (await storage.guard(() => session.savedAtOf(billId))) ?? "";
    restored = { billId, revision: document.revision, savedAt };
  }

  onMount(() => {
    void start();
  });

  // P6: the panel asks the store, because presence *is* the state — there is no flag on the bill to read.
  // It re-asks whenever a save lands, which is also the moment a freshly accepted retention becomes visible.
  $effect(() => {
    const billId = bill?.working.bill.id;
    if (!billId || billStore.saveStatus !== "saved") return;
    void refreshPhoto(billId);
  });

  function refreshPhoto(billId: string): Promise<void> {
    return storage.guard(() => session.hasRetainedImage(billId)).then((kept) => {
      keptPhoto = kept === true;
    });
  }

  /** P6: deleting the photo is not deleting the bill. Every number came from the photo already. */
  function deletePhoto(): void {
    const billId = billStore.document?.working.bill.id;
    if (!billId) return;
    void storage.guard(() => session.deleteRetainedImage(billId)).then(() => {
      keptPhoto = false;
      photoDeleted = true;
    });
  }

  // Named `bill`, not `document`: shadowing the DOM global inside a browser component is how the next
  // person to touch this file loses an afternoon.
  const bill = $derived(billStore.document);
  const findings = $derived(bill === null ? [] : visibleFindings(bill));

  let newItemName = $state("");
  let newItemQty = $state("");
  let newItemPrice = $state("");
  let newChargeLabel = $state("");
  let newChargeAmount = $state("");
  let newChargeType = $state<ChargeType>("tax");

  /**
   * A shrink that would discard assignments or acknowledgements waits here until the creator accepts it
   * (DECISIONS/0021 A7/A13). It holds the input too, because the field has to keep showing the committed
   * quantity while the dialog asks — cancelling then has nothing to undo.
   */
  let pendingQuantity = $state.raw<{
    itemId: string;
    qty: number;
    fromQty: number;
    preview: QuantityChangePreview;
    input: HTMLInputElement;
  } | null>(null);

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

    // A shrink that would remove held or acknowledged units is confirmed first (0021 A7). The preview is the
    // same calculation the transaction will run, and a draft has no units, so only finalized lines reach it.
    if (bill && qty !== null && Number.isInteger(qty) && qty > 0) {
      const item = bill.working.items.find((entry) => entry.id === id);
      if (item && qty < item.qty) {
        const preview = previewQuantityChange(bill.working, id, qty);
        if (preview.removedAssignments.length > 0 || preview.removedAcknowledgedUnitIds.length > 0) {
          input.value = String(item.qty);
          pendingQuantity = { itemId: id, qty, fromQty: item.qty, preview, input };
          return;
        }
      }
    }

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

  /** Accepting runs exactly the transaction the warning described — one commit, one revision (0021 A7/A13). */
  function confirmQuantity(): void {
    if (!pendingQuantity || !bill) return;
    const { itemId, qty, fromQty, input } = pendingQuantity;
    pendingQuantity = null;
    const published = billStore.publish(setItemQuantity(bill, itemId, qty));
    input.value = published.ok ? String(qty) : String(fromQty);
  }

  function cancelQuantity(): void {
    // The field already shows the committed quantity, so a cancel is nothing but closing the dialog.
    pendingQuantity = null;
  }

  function participantName(participantId: string): string {
    return bill?.working.participants.find((entry) => entry.id === participantId)?.name ?? participantId;
  }
</script>

<h1>Bill</h1>

{#if !bill}
  <div data-testid="bill-empty">
    <p>No bill open.</p>
    <button
      type="button"
      data-testid="empty-capture-cta"
      onclick={() => {
        window.history.pushState({}, "", "/capture");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      Capture a receipt
    </button>
    <button
      type="button"
      data-testid="empty-ledger-cta"
      onclick={() => {
        window.history.pushState({}, "", "/bills");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      Open a past bill
    </button>
  </div>
{:else}
  {@const working = bill.working}
  {@const derived = bill.derived}

  {#if restored}
    <p class="notice" data-testid="restored-notice">
      Restored from this device — revision {restored.revision}, saved {restored.savedAt}.
    </p>
  {/if}

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

  {#if pendingQuantity}
    {@const preview = pendingQuantity.preview}
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="quantity-warning-title" data-testid="quantity-warning">
        <h2 id="quantity-warning-title">Remove assigned units?</h2>
        <p>
          Changing this line from {preview.fromQty} to {preview.toQty} removes
          {preview.removedUnitIds.length} unit(s) and the work recorded on them:
        </p>
        <ul>
          {#each preview.removedAssignments as assignment (assignment.itemUnitId + assignment.participantId)}
            <li class="refs" data-testid="quantity-warning-assignment">
              {assignment.itemUnitId} held by {participantName(assignment.participantId)}
            </li>
          {/each}
          {#each preview.removedAcknowledgedUnitIds as unitId (unitId)}
            <li class="refs" data-testid="quantity-warning-acknowledged">{unitId} acknowledged unassigned</li>
          {/each}
        </ul>
        <p class="hint">Nothing changes until you continue.</p>
        <div class="inline">
          <button type="button" data-testid="quantity-cancel" onclick={cancelQuantity}>Keep {preview.fromQty}</button>
          <button type="button" data-testid="quantity-confirm" onclick={confirmQuantity}>
            Set {preview.toQty} and continue
          </button>
        </div>
      </div>
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
    <!--
      DECISIONS/0023 P8, answering ticket 13's forwarded note: the roster renders whenever a bill does, not
      only once something has been finalized. A zero-item participant is a meaningful participant (§11 rule 5,
      ADR-001), the payer selector lives in here (0022 L13) and `payer_missing` is a lock blocker, and after
      P7 a bill can legitimately arrive as a restored draft-only import. What stays gated is the *grid*: units
      materialize at finalization only (0021 A1), so it says so instead of pretending to be empty.
    -->
    <Units {bill} />
    {#if working.items.length === 0}
      <p class="hint" data-testid="no-items">No finalized items yet — finalize a line to assign its units.</p>
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
      {/each}
    {/if}
  </section>

  <section class="retention" data-testid="retention-panel">
    <h2>Receipt photo</h2>
    {#if keptPhoto}
      <p data-testid="kept-photo">A photo of this receipt is kept on this device.</p>
      <button type="button" data-testid="delete-photo" onclick={deletePhoto}>Delete the photo</button>
    {:else if photoDeleted}
      <p class="badge badge-ok" data-testid="photo-deleted">Photo deleted. The bill and its numbers are unchanged.</p>
    {:else}
      <p class="hint" data-testid="no-kept-photo">
        No photo is kept for this bill. Keeping one is chosen per capture on the photo screen, and never by
        default.
      </p>
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

  <Lock {bill} />
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
