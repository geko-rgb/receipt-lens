/**
 * Owner request (`next.md` Phases 2 and 4) — the review screen shows typed charges, and quantity allocation works
 * in a real browser.
 *
 * `tests/units/quantity-allocation.test.ts` pins the transaction. What only exists in a running app is that the
 * screen shows the remainder live, refuses to save an over-allocation, requires one confirmation, and leaves the
 * per-unit mode intact afterwards.
 */
import { expect, test, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

const RECEIPT_LINES = ["RECEIPT", "COFFEE 60.00", "GST 6.00", "TOTAL 60.00"];

let server: AppServer;

test.beforeAll(async () => {
  server = await startAppServer();
});

test.afterAll(() => {
  server?.close();
});

async function receiptPng(page: Page, lines: string[]): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (drawLines) => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "bold 56px monospace";
    drawLines.forEach((line, index) => context.fillText(line, 60, 220 + index * 160));
    return canvas.toDataURL("image/png");
  }, lines);

  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function openReview(page: Page): Promise<void> {
  await page.goto(server.url);
  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await receiptPng(page, RECEIPT_LINES) });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 150_000 });
}

async function acceptIntoBill(page: Page): Promise<void> {
  await openReview(page);
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("totals")).toBeVisible();
}

async function rowIdFor(page: Page, needle: string): Promise<string> {
  const id = await page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-line-id]"));
    const hit = rows.find((row) => (row.querySelector("input")?.value ?? "").toUpperCase().includes(text));
    return hit?.dataset.lineId ?? null;
  }, needle.toUpperCase());
  if (id === null) throw new Error(`no bill line carries "${needle}"`);
  return id;
}

async function addParticipant(page: Page, name: string): Promise<void> {
  await page.getByTestId("participant-name").fill(name);
  await page.getByTestId("add-participant").click();
  await expect(page.getByTestId("participant-row").filter({ hasText: name })).toHaveCount(1);
}

test("the review screen shows the typed charges the parse read, taxes included", async ({ page }) => {
  test.setTimeout(420_000);
  await openReview(page);

  // Phase 2's UI half: the section used to iterate `otherCharges` only, so an extracted GST never appeared here.
  await expect(page.getByTestId("charges-section")).toBeVisible();
  await expect(page.getByTestId("charge-row").first()).toBeVisible();
  await expect(page.getByTestId("charge-row").filter({ hasText: "gst" }).first()).toBeVisible();

  // Phase 1's visible outcome: each item shows its quantity, rate and line total rather than a name alone.
  const itemRow = page.getByTestId("item-row").first();
  await expect(itemRow.getByTestId("item-rate")).toBeVisible();
  await expect(itemRow.getByTestId("item-line-total")).toBeVisible();
});

test("quantity allocation: live remainder, blocked excess, one confirmation, and the per-unit mode intact", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);
  await page.getByTestId("finalize-all").click();

  // A three-unit line, so 2 + 1 is the owner's own "large quantity" case at a size a test can drive.
  await page.getByTestId("new-line-name").fill("CHAPATI");
  await page.getByTestId("new-line-qty").fill("3");
  await page.getByTestId("new-line-price").fill("8.00");
  await page.getByTestId("add-line").click();
  const chapatiId = await rowIdFor(page, "CHAPATI");
  await page.locator(`[data-line-id="${chapatiId}"]`).getByTestId("finalize-line").click();

  await addParticipant(page, "P1");
  await addParticipant(page, "P2");

  const panel = page.locator(`[data-testid="quantity-panel"][data-item-id="${chapatiId}"]`);
  const input = (participantId: string) =>
    panel.locator(`[data-testid="quantity-input"][data-participant-id="${participantId}"]`);

  // --- the mode is named, not guessed ---------------------------------------------------------------
  await page.locator(`[data-testid="mode-quantity"][data-item-id="${chapatiId}"]`).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("quantity-total")).toContainText("Allocated: 0 / 3");

  // --- the remainder updates as you type (requirement 4) --------------------------------------------
  await input("p1").fill("2");
  await expect(panel.getByTestId("quantity-total")).toContainText("Allocated: 2 / 3");
  await expect(panel.getByTestId("quantity-remaining")).toContainText("1 unit(s) still unallocated");

  // --- exceeding the purchase blocks the save and says so (requirement 5) ---------------------------
  await input("p1").fill("4");
  await expect(panel.getByTestId("quantity-excess")).toBeVisible();
  await expect(panel.getByTestId("quantity-confirm")).toBeDisabled();

  // --- invalid input is refused, not coerced (requirement 6) ----------------------------------------
  await input("p1").fill("-1");
  await expect(panel.getByTestId("quantity-invalid")).toBeVisible();
  await expect(panel.getByTestId("quantity-confirm")).toBeDisabled();

  // --- a valid split: 2 + 1, then one confirmation (requirement 8) -----------------------------------
  await input("p1").fill("2");
  await input("p2").fill("1");
  await expect(panel.getByTestId("quantity-total")).toContainText("Allocated: 3 / 3");
  await panel.getByTestId("quantity-confirm").click();

  const dialog = page.getByTestId("allocation-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("3 of 3 unit(s)");
  await expect(dialog.getByTestId("allocation-line")).toHaveCount(2);

  // Cancelling writes nothing at all.
  await page.getByTestId("allocation-cancel").click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByTestId("quantity-total")).toContainText("Allocated: 3 / 3");

  await panel.getByTestId("quantity-confirm").click();
  await page.getByTestId("allocation-save").click();
  await expect(dialog).toBeHidden();

  // --- the per-unit mode shows the same assignment, so the two views cannot disagree (requirement 10) --
  await page.locator(`[data-testid="mode-unit"][data-item-id="${chapatiId}"]`).click();
  const units = page.locator(`[data-testid="unit-list"][data-item-id="${chapatiId}"] [data-testid="unit"]`);
  await expect(units).toHaveCount(3);
  const ticked = (index: number, participantId: string) =>
    units.nth(index).locator(`[data-testid="assign-unit"][data-participant-id="${participantId}"]`);
  await expect(ticked(0, "p1")).toBeChecked();
  await expect(ticked(1, "p1")).toBeChecked();
  await expect(ticked(2, "p2")).toBeChecked();

  // --- and a per-unit click still works on top of an allocation, one transaction each ----------------
  await ticked(2, "p1").check();
  await expect(ticked(2, "p1")).toBeChecked();
  // Sharing a unit is the other meaning, and it is still reachable: two holders divide the unit's cost.
  await expect(units.nth(2).getByTestId("unit-division")).toContainText("÷ 2");

  // --- switching back to quantity refuses to flatten that shared unit ------------------------------
  await page.locator(`[data-testid="mode-quantity"][data-item-id="${chapatiId}"]`).click();
  // The mode prefills from the holders that exist — p1 holds all three units and p2 shares one of them — so the
  // counts are set explicitly here. 2 + 1 is within the three units, which is what makes the refusal below about
  // the *shared* unit rather than about the total.
  await input("p1").fill("2");
  await input("p2").fill("1");
  await expect(panel.getByTestId("quantity-total")).toContainText("Allocated: 3 / 3");
  await panel.getByTestId("quantity-confirm").click();
  await page.getByTestId("allocation-save").click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("shared_units_present");
  // Nothing was written by the failed attempt: the shared unit is still shared.
  await page.locator(`[data-testid="mode-unit"][data-item-id="${chapatiId}"]`).click();
  await expect(ticked(2, "p2")).toBeChecked();
});

test("a partial allocation leaves the rest unassigned and blocks the lock, never filling it in", async ({ page }) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);
  await page.getByTestId("finalize-all").click();

  await page.getByTestId("new-line-name").fill("NAAN");
  await page.getByTestId("new-line-qty").fill("4");
  await page.getByTestId("new-line-price").fill("10.00");
  await page.getByTestId("add-line").click();
  const naanId = await rowIdFor(page, "NAAN");
  await page.locator(`[data-line-id="${naanId}"]`).getByTestId("finalize-line").click();
  await addParticipant(page, "P1");

  const panel = page.locator(`[data-testid="quantity-panel"][data-item-id="${naanId}"]`);
  await page.locator(`[data-testid="mode-quantity"][data-item-id="${naanId}"]`).click();
  await panel.locator(`[data-testid="quantity-input"][data-participant-id="p1"]`).fill("1");
  await panel.getByTestId("quantity-confirm").click();
  await expect(page.getByTestId("allocation-remaining")).toContainText("3 unit(s) stay unassigned");
  await page.getByTestId("allocation-save").click();

  // Requirement 7: the remaining three are still nobody's, so the lock checklist says so.
  await expect(page.getByTestId("blockers-list")).toContainText("units_unassigned");
  await page.locator(`[data-testid="mode-unit"][data-item-id="${naanId}"]`).click();
  const units = page.locator(`[data-testid="unit-list"][data-item-id="${naanId}"] [data-testid="unit"]`);
  await expect(
    units.nth(1).locator(`[data-testid="assign-unit"][data-participant-id="p1"]`),
  ).not.toBeChecked();
});

test("the allocation survives a reload, so the two views agree with what was saved", async ({ page }) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);
  await page.getByTestId("finalize-all").click();

  await page.getByTestId("new-line-name").fill("IDLI");
  await page.getByTestId("new-line-qty").fill("3");
  await page.getByTestId("new-line-price").fill("6.00");
  await page.getByTestId("add-line").click();
  const idliId = await rowIdFor(page, "IDLI");
  await page.locator(`[data-line-id="${idliId}"]`).getByTestId("finalize-line").click();
  await addParticipant(page, "P1");
  await addParticipant(page, "P2");

  const panel = page.locator(`[data-testid="quantity-panel"][data-item-id="${idliId}"]`);
  await page.locator(`[data-testid="mode-quantity"][data-item-id="${idliId}"]`).click();
  await panel.locator(`[data-testid="quantity-input"][data-participant-id="p1"]`).fill("2");
  await panel.locator(`[data-testid="quantity-input"][data-participant-id="p2"]`).fill("1");
  await panel.getByTestId("quantity-confirm").click();
  await page.getByTestId("allocation-save").click();

  // The write is a persistence round trip, not a redraw: wait for the saved bill to carry the three units.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const databases = await indexedDB.databases();
        const name = databases.map((entry) => entry.name).find((entry) => entry && entry.includes("receipt"));
        if (!name) return null;
        return new Promise<number | null>((resolve) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => {
            const database = request.result;
            const store = database.transaction("bills").objectStore("bills");
            const all = store.getAll();
            all.onsuccess = () => {
              const records = all.result as { working?: string }[];
              database.close();
              // Units are what an allocation creates; count them across every stored bill.
              const text = JSON.stringify(records);
              resolve((text.match(/"itemUnits"/g) ?? []).length > 0 ? (text.match(/"unitIndex"/g) ?? []).length : null);
            };
          };
          request.onerror = () => resolve(null);
        });
      }),
    )
    .toBeGreaterThanOrEqual(3);

  await page.reload();
  await expect(page.getByTestId("restored-notice")).toContainText("Restored from this device");
  // Three units is more than one, so the restored screen opens on the quantity table; the units are one click away.
  await page.locator(`[data-testid="mode-unit"][data-item-id="${idliId}"]`).click();
  const units = page.locator(`[data-testid="unit-list"][data-item-id="${idliId}"] [data-testid="unit"]`);
  await expect(units).toHaveCount(3);
  await expect(
    units.nth(0).locator(`[data-testid="assign-unit"][data-participant-id="p1"]`),
  ).toBeChecked();
  await expect(
    units.nth(2).locator(`[data-testid="assign-unit"][data-participant-id="p2"]`),
  ).toBeChecked();
  // And the mode survives as the *stored* assignment, not as remembered UI state: the quantity panel reads it back.
  const restoredPanel = page.locator(`[data-testid="quantity-panel"][data-item-id="${idliId}"]`);
  await page.locator(`[data-testid="mode-quantity"][data-item-id="${idliId}"]`).click();
  await expect(
    restoredPanel.locator(`[data-testid="quantity-input"][data-participant-id="p1"]`),
  ).toHaveValue("2");
  await expect(
    restoredPanel.locator(`[data-testid="quantity-input"][data-participant-id="p2"]`),
  ).toHaveValue("1");
});

test("a one-unit line opens on the original checkbox panel, with no table in sight", async ({ page }) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);

  // The extracted line is one COFFEE, so the panel the creator lands on is the shipped per-unit one.
  const coffeeId = await rowIdFor(page, "COFFEE");
  await page.locator(`[data-line-id="${coffeeId}"]`).getByTestId("finalize-line").click();
  await addParticipant(page, "P1");

  const list = page.locator(`[data-testid="unit-list"][data-item-id="${coffeeId}"]`);
  await expect(list).toBeVisible();
  await expect(list.getByTestId("per-unit-panel")).toBeVisible();
  await expect(list.getByTestId("quantity-panel")).toHaveCount(0);
  await expect(list.getByTestId("unit")).toHaveCount(1);

  // And the single checkbox is the whole interaction for a one-unit line.
  await list.locator(`[data-testid="assign-unit"][data-participant-id="p1"]`).check();
  await expect(list.locator(`[data-testid="assign-unit"][data-participant-id="p1"]`)).toBeChecked();
  // Repetition is refused by the model itself, so a double click cannot create a duplicate either.
  await expect(list.getByTestId("unit-division")).toContainText("held by P1");

  // The table is reachable *by choice* on a one-unit line, and it agrees with the checkbox.
  await page.locator(`[data-testid="mode-quantity"][data-item-id="${coffeeId}"]`).click();
  const panel = page.locator(`[data-testid="quantity-panel"][data-item-id="${coffeeId}"]`);
  await expect(
    panel.locator(`[data-testid="quantity-input"][data-participant-id="p1"]`),
  ).toHaveValue("1");
});

test("the boundary is one: a two-unit line opens on the table, a one-unit line does not", async ({ page }) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);
  await page.getByTestId("finalize-all").click();

  // One unit: the shipped checkbox, unchanged.
  const coffeeId = await rowIdFor(page, "COFFEE");
  const coffee = page.locator(`[data-testid="unit-list"][data-item-id="${coffeeId}"]`);
  await expect(coffee.getByTestId("per-unit-panel")).toBeVisible();
  await expect(coffee.getByTestId("quantity-panel")).toHaveCount(0);

  // Two units: the owner's rule puts the table first — the smallest quantity that is not one checkbox.
  await page.getByTestId("new-line-name").fill("ROTI");
  await page.getByTestId("new-line-qty").fill("2");
  await page.getByTestId("new-line-price").fill("5.00");
  await page.getByTestId("add-line").click();
  const rotiId = await rowIdFor(page, "ROTI");
  await page.locator(`[data-line-id="${rotiId}"]`).getByTestId("finalize-line").click();
  const roti = page.locator(`[data-testid="unit-list"][data-item-id="${rotiId}"]`);
  await expect(roti.getByTestId("quantity-panel")).toBeVisible();
  await expect(roti.getByTestId("per-unit-panel")).toHaveCount(0);
  await expect(roti.getByTestId("quantity-total")).toContainText("Allocated: 0 / 2");

  // And the checkbox interface is still one click away, with both units intact.
  await page.locator(`[data-testid="mode-unit"][data-item-id="${rotiId}"]`).click();
  await expect(roti.getByTestId("unit")).toHaveCount(2);
});
