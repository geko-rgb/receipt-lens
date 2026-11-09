/**
 * Ticket 12 — per-unit ownership, in a real browser.
 *
 * `tests/units/pins.test.ts` pins the transaction contract; this file proves the three claims that only exist
 * in a running app: that a checkbox is one transaction with no local copy of the assignment, that a shared
 * unit's division is shown as the exact fraction it is, and that shrinking a line asks first and only then
 * cascades (DECISIONS/0021 A7/A13).
 *
 * The bill starts from one OCR pass, like `bill-editor.spec.ts`, because the document only exists after an
 * accepted capture. The two-unit line is then added by hand, which is deterministic and is the ticket's own
 * partial-receipt case rather than a second parser behaviour to trust.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

const RECEIPT_LINES = ["RECEIPT", "COFFEE 60.00", "TOTAL 60.00"];

let server: AppServer;

test.beforeAll(async () => {
  server = await startAppServer();
});

test.afterAll(() => {
  server?.close();
});

/** Draws the receipt on a canvas in the page and returns PNG bytes, so no receipt image is committed. */
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

async function acceptIntoBill(page: Page): Promise<void> {
  await page.goto(server.url);
  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await receiptPng(page, RECEIPT_LINES) });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("totals")).toBeVisible();
}

/** The row whose name field carries `needle`, looked up by the line id the document gave it. */
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

test("per-unit ownership: roster, assignment, exact division, acknowledgement and the quantity warning", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);
  await page.getByTestId("finalize-all").click();
  await expect(page.getByTestId("unit")).toHaveCount(1);

  // --- the roster is a list of participants, not a second copy of the bill ------------------------------
  await addParticipant(page, "P1");
  await addParticipant(page, "P2");
  await expect(page.getByTestId("participant-row")).toHaveCount(3);

  // --- a two-unit line, added by hand and finalized -----------------------------------------------------
  await page.getByTestId("new-line-name").fill("NAAN");
  await page.getByTestId("new-line-qty").fill("2");
  await page.getByTestId("new-line-price").fill("20.00");
  await page.getByTestId("add-line").click();
  const naanId = await rowIdFor(page, "NAAN");
  await page.locator(`[data-line-id="${naanId}"]`).getByTestId("finalize-line").click();
  await expect(page.getByTestId("item-row")).toHaveCount(2);

  // A two-unit line defaults to the quantity table (the owner's rule), and this spec is about the per-unit
  // interface, including a unit held by two people — which the table refuses by design.
  await page.locator(`[data-testid="mode-unit"][data-item-id="${naanId}"]`).click();
  const naanUnits = page.locator(`[data-testid="unit-list"][data-item-id="${naanId}"] [data-testid="unit"]`);
  await expect(naanUnits).toHaveCount(2);
  const unit = (index: number): Locator => naanUnits.nth(index);
  const tick = (target: Locator, participantId: string): Locator =>
    target.locator(`[data-testid="assign-unit"][data-participant-id="${participantId}"]`);

  // --- one checkbox is one transaction, and the row shows who holds the unit -----------------------------
  await tick(unit(0), "p1").check();
  await expect(tick(unit(0), "p1")).toBeChecked();
  await expect(unit(0).getByTestId("unit-division")).toContainText("P1");

  // --- a shared unit divides its integer paise exactly, and says so -------------------------------------
  await tick(unit(0), "p2").check();
  await expect(unit(0).getByTestId("unit-division")).toContainText("₹20.00 ÷ 2");
  await expect(tick(unit(0), "p1")).toBeChecked();
  await expect(tick(unit(0), "p2")).toBeChecked();

  await tick(unit(1), "p1").check();
  await expect(unit(1).getByTestId("unit-division")).toContainText("P1");

  // --- the one remaining free unit blocks the lock until it is acknowledged or held ----------------------
  await expect(page.getByTestId("blockers-list")).toContainText("units_unassigned");
  await page.getByTestId("acknowledge-unit").click();
  await expect(page.getByTestId("unit-acknowledged")).toHaveCount(1);
  await expect(page.getByTestId("blockers-list")).not.toContainText("units_unassigned");

  // --- growing a line appends pending units; it never touches the existing statements -------------------
  const qtyInput = page.locator(`[data-line-id="${naanId}"]`).getByTestId("item-qty");
  await qtyInput.fill("3");
  await qtyInput.blur();
  await expect(naanUnits).toHaveCount(3);
  await expect(page.getByTestId("blockers-list")).toContainText("units_unassigned");

  // --- shrinking over a held unit warns first, and the field keeps the committed quantity ----------------
  await qtyInput.fill("1");
  await qtyInput.blur();
  const warning = page.getByTestId("quantity-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("P1");
  await expect(qtyInput).toHaveValue("3");

  // Cancelling is a no-op: same quantity, same three units, same assignments.
  await page.getByTestId("quantity-cancel").click();
  await expect(warning).toBeHidden();
  await expect(qtyInput).toHaveValue("3");
  await expect(naanUnits).toHaveCount(3);
  await expect(tick(unit(1), "p1")).toBeChecked();

  // --- confirming applies the previewed cascade in one transaction --------------------------------------
  await qtyInput.fill("1");
  await qtyInput.blur();
  await page.getByTestId("quantity-confirm").click();
  await expect(warning).toBeHidden();
  await expect(qtyInput).toHaveValue("1");
  await expect(naanUnits).toHaveCount(1);
  await expect(tick(unit(0), "p1")).toBeChecked();
  await expect(tick(unit(0), "p2")).toBeChecked();
  await expect(unit(0).getByTestId("unit-division")).toContainText("₹20.00 ÷ 2");

  // --- zero is rejected, not warned about, and the line survives ----------------------------------------
  await qtyInput.fill("0");
  await qtyInput.blur();
  await expect(page.getByTestId("transaction-rejected")).toContainText("invalid_quantity");
  await expect(qtyInput).toHaveValue("1");
});
