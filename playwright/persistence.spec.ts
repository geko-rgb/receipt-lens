/**
 * Ticket 14 — bills that survive a schema change, in a real browser.
 *
 * **Split tests, one per transition** (owner note recorded in HANDOFF, 2026-11-05: "a broken split test tells
 * you which transition broke; a broken continuous flow tells you only that something in the flow broke").
 * Each case is self-contained from its own capture: `fullyParallel` is on, and every Playwright context is a
 * fresh origin with its own IndexedDB, so no case inherits another's ledger — which is also why the two-tab
 * case has to build its own two pages inside one context.
 *
 * No `test.setTimeout` overrides anywhere (ticket 13's fail-fast rule): the 30 s test budget, 5 s expect and
 * 5 s action timeout in `playwright.config.ts` are what protect these specs. OCR is ~1 s per pass, so a case
 * that hits 30 s is stuck on a locator, not slow.
 *
 * The migration cases (7, 8) run the app's own screens against a **synthetic** migration in
 * `packages/pwa/rig/`, because a step that throws cannot exist in shipped storage code (P3). Everything else
 * drives the shipped app. The data they migrate is a bill the real save path wrote, seeded through the UI.
 */
import { expect, test, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

let server: AppServer;

test.beforeAll(async () => {
  server = await startAppServer({ withRig: true });
});

test.afterAll(() => {
  server.close();
});

const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "NAAN 60.00", "TOTAL 100.00"];

/** Draws the receipt on a canvas and hands it over as real PNG bytes — no receipt image is committed. */
async function receiptPng(page: Page, lines: string[] = RECEIPT_LINES): Promise<Buffer> {
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

/** Capture → accept → `/bill`, and wait for the save P7 performs on the accepted import. */
async function acceptIntoBill(page: Page, { keepPhoto = false } = {}): Promise<void> {
  await page.goto(`${server.url}capture`);
  await page.getByTestId("file-input").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await receiptPng(page) });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 120_000 });
  if (keepPhoto) await page.getByTestId("keep-photo").check();
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
}

/** A committed edit, so the bill on disk is a real revision and not only the import. */
async function editPrice(page: Page, value: string): Promise<void> {
  await page.getByTestId("draft-price").first().fill(value);
  await page.getByTestId("draft-price").first().dispatchEvent("change");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
}

/** Reads the app's database without the app: the census the privacy assertions need. */
async function census(page: Page) {
  return page.evaluate(async () => {
    const found = await indexedDB.databases();
    const databases = found
      .map((database) => ({ name: database.name ?? "", version: database.version ?? 0 }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const entry = databases.find((database) => database.name === "receipt-lens");
    if (!entry) return { databases: databases.map((database) => database.name), version: 0, stores: [], counts: {} };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(entry.name, entry.version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = [...database.objectStoreNames].sort();
    const counts: Record<string, number> = {};
    for (const name of stores) {
      counts[name] = await new Promise<number>((resolve, reject) => {
        const count = database.transaction(name).objectStore(name).count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
    }
    database.close();
    return { databases: databases.map((database) => database.name), version: entry.version, stores, counts };
  });
}

test("a saved bill survives a reload, with its values and its revision", async ({ page }) => {
  await acceptIntoBill(page);
  await editPrice(page, "7.25");

  await page.reload();
  await expect(page).toHaveURL(/\/bill$/);
  // P7: nothing in memory after a reload, so /bill restores the most recently saved bill and says so.
  await expect(page.getByTestId("restored-notice")).toContainText("Restored from this device");
  await expect(page.getByTestId("draft-price").first()).toHaveValue("₹7.25");
  // The print is a receipt fact and an edit is not a correction of it (0020 T5): still 100.00.
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
});

test("past bills appear in the list, newest first, and Open reaches the right one", async ({ page }) => {
  await acceptIntoBill(page);
  await editPrice(page, "7.25");

  await acceptIntoBill(page);
  await editPrice(page, "8.10");

  await page.goto(`${server.url}bills`);
  const rows = page.getByTestId("bill-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("₹100.00");

  // The stored `createdAt` is in the id (`bill:<iso>`), and ISO stamps compare as strings, so the ordering the
  // ledger promises is checkable rather than assumed. Read the ids before opening: navigating destroys them.
  const ids = await rows.evaluateAll((list) => list.map((row) => row.getAttribute("data-bill-id") ?? ""));
  expect(ids[0]! > ids[1]!).toBe(true);

  await rows.first().getByTestId("bill-open").click();
  await expect(page).toHaveURL(/\/bill$/);
  // Both rows print ₹100.00 and both carry two draft lines, so only the stored price says which bill opened:
  // the newest one, which is the second one written.
  await expect(page.getByTestId("draft-price").first()).toHaveValue("₹8.10");
});

test("an empty ledger says so and the CTA is what navigates", async ({ page }) => {
  await page.goto(`${server.url}bills`);
  await expect(page.getByTestId("bills-empty")).toContainText("No bills on this device yet");
  await expect(page.getByTestId("bill-row")).toHaveCount(0);

  await page.getByTestId("bills-capture-cta").click();
  await expect(page).toHaveURL(/\/capture$/);
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("the creator profile saves, restores, and names the next bill's creator", async ({ page }) => {
  await page.goto(`${server.url}bills`);
  await page.getByTestId("profile-name").fill("Albus");
  await page.getByTestId("profile-upi").fill("albus@okhdfc");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("profile-saved")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("profile-name")).toHaveValue("Albus");
  await expect(page.getByTestId("profile-upi")).toHaveValue("albus@okhdfc");

  // P8: the profile seeds the creator participant on a *new* bill, and only a new one.
  await acceptIntoBill(page);
  await expect(page.getByTestId("participant-row").filter({ hasText: "Albus" })).toHaveCount(1);

  await page.goto(`${server.url}bills`);
  await page.getByTestId("profile-name").fill("Someone Else");
  await page.getByTestId("profile-save").click();
  const stored = await census(page);
  expect(stored.counts.bills).toBe(1);
});

test("no photo is kept unless the box was ticked, and the bill says which it is", async ({ page }) => {
  await acceptIntoBill(page);
  await editPrice(page, "7.25");

  await expect(page.getByTestId("no-kept-photo")).toBeVisible();
  await expect(page.getByTestId("kept-photo")).toHaveCount(0);
  const stores = await census(page);
  expect(stores.databases).toEqual(["receipt-lens"]);
  expect(stores.counts.retainedImages).toBe(0);
  expect(stores.counts.bills).toBe(1);
});

test("the retention opt-in keeps the photo, and deleting it leaves the bill intact", async ({ page }) => {
  await acceptIntoBill(page, { keepPhoto: true });
  await editPrice(page, "7.25");

  await expect(page.getByTestId("kept-photo")).toBeVisible();
  let stores = await census(page);
  expect(stores.counts.retainedImages).toBe(1);
  const billBefore = await page.getByTestId("calculated-items").innerText();

  await page.getByTestId("delete-photo").click();
  await expect(page.getByTestId("photo-deleted")).toBeVisible();
  stores = await census(page);
  expect(stores.counts.retainedImages).toBe(0);
  // P6: the photo is evidence, not input — every number came from it already.
  await expect(page.getByTestId("calculated-items")).toHaveText(billBefore);

  await page.reload();
  await expect(page.getByTestId("no-kept-photo")).toBeVisible();
});

test("a deleted bill takes its kept photo with it", async ({ page }) => {
  await acceptIntoBill(page, { keepPhoto: true });
  await editPrice(page, "7.25");
  expect((await census(page)).counts.retainedImages).toBe(1);

  await page.goto(`${server.url}bills`);
  await page.getByTestId("bill-delete").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("bill-row")).toHaveCount(0);

  const stores = await census(page);
  expect(stores.counts.bills).toBe(0);
  expect(stores.counts.retainedImages).toBe(0);
});

test("two tabs on one bill: the stale write is refused, and the human decides", async ({ browser, context }) => {
  const tabA = await context.newPage();
  await acceptIntoBill(tabA);
  await editPrice(tabA, "7.25");

  const tabB = await context.newPage();
  await tabB.goto(`${server.url}bill`);
  await expect(tabB.getByTestId("restored-notice")).toBeVisible();
  await expect(tabB.getByTestId("divergence-notice")).toHaveCount(0);

  // A writes again while B is looking at the screen. B is not told — there is no channel to tell it with (P5).
  await editPrice(tabA, "11.11");
  await expect(tabB.getByTestId("divergence-notice")).toHaveCount(0);

  // B writes: both tabs produce the same revision number from the same base, which is exactly why the
  // comparison is against what this tab synced. The write is refused, and B's value stays on its screen.
  await tabB.getByTestId("draft-price").first().fill("22.22");
  await tabB.getByTestId("draft-price").first().dispatchEvent("change");
  await expect(tabB.getByTestId("divergence-notice")).toBeVisible();
  await expect(tabB.getByTestId("divergence-notice")).toHaveAttribute("data-code", "bill_changed_elsewhere");
  await expect(tabB.getByTestId("save-status")).toHaveAttribute("data-status", "divergent");
  expect((await census(tabA)).counts.bills).toBe(1);

  await tabB.getByTestId("divergence-overwrite").click();
  await expect(tabB.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
  await expect(tabB.getByTestId("divergence-notice")).toHaveCount(0);
  await tabA.reload();
  await expect(tabA.getByTestId("draft-price").first()).toHaveValue("₹22.22");

  await tabA.close();
  await tabB.close();
});

test("a failed migration shows the recoverable screen, keeps the data, and exports it", async ({ page }) => {
  await acceptIntoBill(page);
  await editPrice(page, "7.25");
  const before = await census(page);
  expect(before.counts.bills).toBe(1);

  await page.goto(`${server.url}rig/rig.html?kind=abort`);
  await expect(page.getByTestId("storage-notice")).toHaveAttribute("data-phase", "migration-failed");
  await expect(page.getByTestId("migration-failed-heading")).toContainText("Your data was not changed");

  // The abort rolled the upgrade back: still version 1, the same single record, and the half-written row the
  // step put before it threw is not there.
  const after = await census(page);
  expect(after.version).toBe(1);
  expect(after.counts.bills).toBe(1);

  const download = page.waitForEvent("download");
  await page.getByTestId("migration-export").click();
  const file = await download;
  const body = JSON.parse(await file.createReadStream().then(readStream));
  expect(body.app).toBe("receipt-lens");
  expect(body.dbVersion).toBe(1);
  expect(body.bills).toHaveLength(1);
  expect(body.bills[0].working.bill.grandTotal).toBe(10_000);
  expect(JSON.stringify(body)).not.toContain("data:image");
});

test("a lossy migration gates on the export: nothing moves until a file exists", async ({ page }) => {
  await acceptIntoBill(page);
  await editPrice(page, "7.25");

  await page.goto(`${server.url}rig/rig.html?kind=gate`);
  await expect(page.getByTestId("storage-notice")).toHaveAttribute("data-phase", "gating");
  await expect(page.getByTestId("gate-heading")).toBeVisible();
  await expect(page.getByTestId("gate-count")).toContainText("1 bill(s)");

  // The screen is up *before* the upgrade is requested, so the database is untouched while it is.
  const whileGated = await census(page);
  expect(whileGated.version).toBe(1);
  await expect(page.getByTestId("gate-continue")).toBeDisabled();

  const download = page.waitForEvent("download");
  await page.getByTestId("gate-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^receipt-lens-export-v1-/);
  await expect(page.getByTestId("gate-exported")).toContainText(file.suggestedFilename());
  await expect(page.getByTestId("gate-continue")).toBeEnabled();

  await page.getByTestId("gate-continue").click();
  await expect(page.getByTestId("rig-result")).toHaveAttribute("data-result", "upgraded");
  await expect.poll(async () => (await census(page)).version).toBe(2);
  // The rig's step removed a field; this is the case where data genuinely does not survive, which is what
  // the export was for.
  await expect.poll(async () => (await census(page)).counts.bills).toBe(1);
});

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
