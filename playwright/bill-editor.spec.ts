/**
 * Ticket 11 — the bill editor, in a real browser.
 *
 * `tests/bill/pins.test.ts` is where the transaction contract is pinned; this file proves the two claims that
 * only exist in a running app: that an edit recomputes what is on screen while the printed total stays as
 * printed, and that a rejected transaction leaves the screen showing the state the bill is actually in.
 * DECISIONS/0019 S8's reactivity trap is exactly this shape — rows are gated by the values their own inputs
 * carry — so if a `bind:` loop comes back, this spec hangs instead of the reviewer's browser.
 *
 * The receipt is deliberately one the shipped parser reads *incompletely*: `parse()` produces one item and
 * preserves the second line as an ambiguous row (its `ambiguous_row` finding is asserted below). That is the
 * ticket's own acceptance case — "so a partial receipt can still become a complete bill" — and the hand-added
 * line has to obey every rule an extracted one does. One OCR pass drives the walk, because the bill lives in
 * the committed document and a reload would reset it.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "NAAN 60.00", "TOTAL 100.00"];

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

/**
 * The row whose name field carries `needle`. `hasText` cannot see an `<input>`'s value, and a row's identity is
 * the line id the document gave it — the same id core's findings use in `itemRefs` (§10, DECISIONS/0011 V9) —
 * so the lookup reads the DOM and returns that id.
 */
async function rowFor(page: Page, needle: string): Promise<Locator> {
  const id = await page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-line-id]"));
    const hit = rows.find((row) => (row.querySelector("input")?.value ?? "").toUpperCase().includes(text));
    return hit?.dataset.lineId ?? null;
  }, needle.toUpperCase());
  if (id === null) throw new Error(`no bill line carries "${needle}"`);
  return page.locator(`[data-line-id="${id}"]`);
}

/** The name field of every row of one tier. */
async function namesIn(page: Page, rowTestId: string): Promise<string[]> {
  return page.evaluate((testid) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));
    return rows.map((row) => row.querySelector("input")?.value ?? "");
  }, rowTestId);
}

/** Clicks every "Review qty 1" control; each click removes that row's button, so the loop drains. */
async function clickEveryReview(page: Page): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    if ((await page.getByTestId("review-item").count()) === 0) return;
    await page.getByTestId("review-item").first().click();
  }
  throw new Error("review controls did not drain — the acknowledgement is not clearing its blocker");
}

test("the bill view without an accepted parse says so instead of inventing a bill", async ({ page }) => {
  await page.goto(`${server.url}bill`);
  await expect(page.getByTestId("bill-empty")).toContainText("capture a receipt");
});

test("capture → editor: drafts finalize, edits recompute, the print survives, a rejection rolls back", async ({ page }) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);

  // --- the draft tier arrives, with the parse's own incompleteness preserved --------------------------
  expect(await namesIn(page, "draft-row")).toHaveLength(1);
  expect((await namesIn(page, "draft-row"))[0]).toContain("COFFEE");
  await expect(page.getByTestId("draft-count")).toContainText("1 draft line(s), 0 item(s)");
  // Drafts are not bill amounts yet (§10 line 764), so the honest starting total is zero — shown beside the
  // draft count and the gap, never as "the bill is ₹0".
  await expect(page.getByTestId("calculated-items")).toContainText("₹0.00");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
  await expect(page.getByTestId("grand-total-source")).toContainText("detected");
  await expect(page.getByTestId("reconciliation-gap")).toContainText("₹100.00");
  // The line the parser could not make an item is still on screen, as a coded finding, not silently dropped.
  await expect(page.getByTestId("findings-list")).toContainText("ambiguous_row");
  await expect(page.getByTestId("findings-list")).toContainText("qty_assumed");

  // --- resolve the draft: an item and its unit appear together, in one transaction -------------------
  await page.getByTestId("finalize-all").click();
  await expect(page.getByTestId("no-drafts")).toBeVisible();
  await expect(page.getByTestId("item-row")).toHaveCount(1);
  await expect(page.getByTestId("unit-list")).toHaveCount(1);
  await expect(page.getByTestId("unit")).toHaveCount(1);
  await expect(page.getByTestId("calculated-items")).toContainText("₹4.50");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
  await expect(page.getByTestId("reconciliation-gap")).toContainText("₹95.50");

  // Coded blockers, not prose (§6 line 401); and shares decline to compute rather than throw (0020 T7).
  await expect(page.getByTestId("blockers-list")).toContainText("units_unassigned");
  await expect(page.getByTestId("shares-unavailable")).toContainText("units_unassigned");
  await expect(page.getByTestId("blockers-list")).toContainText("assumed_qty_unreviewed");

  // --- an item edit recomputes the totals and leaves the printed fact printed ------------------------
  const coffee = await rowFor(page, "COFFEE");
  const coffeePrice = coffee.getByTestId("item-price");
  await coffeePrice.fill("70.00");
  await coffeePrice.blur();
  await expect(coffeePrice).toHaveValue("₹70.00");
  await expect(coffee.getByTestId("item-line-total")).toContainText("₹70.00");
  await expect(coffee.getByTestId("detected-line-total")).toContainText("₹4.50");
  await expect(coffee.getByTestId("item-provenance")).toContainText("user_confirmed");
  await expect(page.getByTestId("calculated-items")).toContainText("₹70.00");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
  await expect(page.getByTestId("grand-total-source")).toContainText("detected");
  // The gap is shown as a disagreement the creator has to resolve, not reconciled away (§10 line 792).
  await expect(page.getByTestId("reconciliation-gap")).toContainText("₹30.00");
  await expect(page.getByTestId("findings-list")).toContainText("line_total_mismatch");

  // --- a malformed value is rejected, and the screen keeps showing what the bill actually says -------
  await coffeePrice.fill("not a price");
  await coffeePrice.blur();
  await expect(page.getByTestId("transaction-rejected")).toContainText("invalid_amount");
  await expect(coffeePrice).toHaveValue("₹70.00");
  await expect(page.getByTestId("calculated-items")).toContainText("₹70.00");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");

  // --- reviewing an assumed quantity clears its blocker and changes no amount ------------------------
  await clickEveryReview(page);
  await expect(page.getByTestId("blockers-list")).not.toContainText("assumed_qty_unreviewed");
  await expect(page.getByTestId("calculated-items")).toContainText("₹70.00");

  // --- a hand-added line completes the partial receipt, under the same rules -------------------------
  await page.getByTestId("new-line-name").fill("NAAN");
  await page.getByTestId("new-line-qty").fill("3");
  await page.getByTestId("new-line-price").fill("20.00");
  await page.getByTestId("add-line").click();
  const naan = await rowFor(page, "NAAN");
  await expect(naan.getByTestId("draft-provenance")).toHaveText("user_confirmed · user_confirmed");
  await expect(page.getByTestId("calculated-items")).toContainText("₹70.00");

  await naan.getByTestId("finalize-line").click();
  await expect(page.getByTestId("item-row")).toHaveCount(2);
  await expect(page.getByTestId("unit")).toHaveCount(4);
  // ₹70.00 + 3 × ₹20.00 = ₹130.00 calculated against a ₹100.00 print.
  await expect(page.getByTestId("calculated-items")).toContainText("₹130.00");
  await expect(page.getByTestId("reconciliation-gap")).toContainText("-₹30.00");
  await expect(page.getByTestId("draft-count")).toContainText("0 draft line(s), 2 item(s), 0 draft charge(s), 0 charge(s)");

  // --- deleting an item cascades, recomputes, and can even close the gap it opened -------------------
  await coffee.getByTestId("delete-item").click();
  await expect(page.getByTestId("item-row")).toHaveCount(1);
  await expect(page.getByTestId("unit-list")).toHaveCount(1);
  await expect(page.getByTestId("unit")).toHaveCount(3);
  await expect(page.getByTestId("calculated-items")).toContainText("₹60.00");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
  await expect(page.getByTestId("reconciliation-gap")).toContainText("₹40.00");
  // The transaction that deleted the item is a success carrying a critical finding, not a failure: the print
  // and the bill disagree on purpose (§6 line 464, DECISIONS/0020 T1).
  await expect(page.getByTestId("findings-list")).toContainText("arithmetic_total");
  await expect(page.getByTestId("findings-list")).not.toContainText("line_total_mismatch");

  // --- acknowledging a unit as unassigned lands its cost on the creator, visibly ---------------------
  await page.getByTestId("acknowledge-unit").first().click();
  await expect(page.getByTestId("unit").filter({ hasText: "unassigned acknowledged" })).toHaveCount(1);
  await expect(page.getByTestId("blockers-list")).toContainText("units_unassigned");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
});

test("correcting the printed grand total is the only thing that moves it", async ({ page }) => {
  test.setTimeout(420_000);
  await acceptIntoBill(page);

  await page.getByTestId("grand-total-input").fill("88.00");
  await page.getByTestId("grand-total-apply").click();
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹88.00");
  await expect(page.getByTestId("grand-total-source")).toContainText("user_confirmed");

  // Then a draft edit still cannot rewrite it (§10 line 743): the bill's own total is still ₹0.00, so the gap
  // reopens against the corrected print rather than the print moving to meet the bill.
  const coffee = await rowFor(page, "COFFEE");
  const price = coffee.getByTestId("draft-price");
  await price.fill("1.00");
  await price.blur();
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹88.00");
  await expect(page.getByTestId("grand-total-source")).toContainText("user_confirmed");
  await expect(page.getByTestId("calculated-payable")).toContainText("₹0.00");
  await expect(page.getByTestId("reconciliation-gap")).toContainText("₹88.00");
});
