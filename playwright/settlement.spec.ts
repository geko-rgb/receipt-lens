/**
 * Ticket 15 — settlement in a running browser, one split test per user-visible promise.
 *
 * The seam is pinned in `packages/pwa/tests/settlement/pins.test.ts`; this file proves the parts only a browser
 * can: that the exact and payment values are both on screen when they differ, that the payer gets no link, that
 * the intent an anchor would open carries the right parameters, and that the manual paid flag survives a reload
 * through the real IndexedDB save path.
 *
 * Split tests, each self-contained from its own capture: `fullyParallel` is on and every context is a fresh
 * origin, so no case inherits another's ledger or profile. No `test.setTimeout` overrides — a case that reaches
 * the 30 s budget is stuck on a locator, not slow.
 */
import { expect, test, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

/** One ₹100 line: the unit can then be shared by up to three holders, which is where fractional paise appear. */
const RECEIPT = ["RECEIPT", "PLATTER 100.00", "TOTAL 100.00"];
const PROFILE = { name: "Albus", upi: "albus@okhdfc" };

let server: AppServer;

test.beforeAll(async () => {
  server = await startAppServer();
});

test.afterAll(() => {
  server?.close();
});

async function receiptPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (lines) => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "bold 56px monospace";
    lines.forEach((line, index) => context.fillText(line, 60, 220 + index * 160));
    return canvas.toDataURL("image/png");
  }, RECEIPT);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** The profile is the payee source (DECISIONS/0024 pin 9), and ticket 14's form is where it is stored. */
async function setProfile(page: Page): Promise<void> {
  await page.goto(`${server.url}bills`);
  await page.getByTestId("profile-name").fill(PROFILE.name);
  await page.getByTestId("profile-upi").fill(PROFILE.upi);
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("profile-saved")).toBeVisible();
}

async function accept(page: Page): Promise<void> {
  await page.goto(`${server.url}capture`);
  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await receiptPng(page) });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("totals")).toBeVisible();
}

/** Every fixture's quantity is tentative until reviewed, so each case clears that blocker the same way. */
async function reviewAllAssumed(page: Page): Promise<void> {
  for (const testId of ["review-assumed", "review-item"]) {
    for (;;) {
      const pending = page.getByTestId(testId);
      if ((await pending.count()) === 0) break;
      await pending.first().click();
    }
  }
}

async function prepare(page: Page, participants: readonly string[]): Promise<void> {
  await accept(page);
  await page.getByTestId("finalize-all").click();
  await expect(page.getByTestId("unit").first()).toBeVisible();
  for (const name of participants) {
    await page.getByTestId("participant-name").fill(name);
    await page.getByTestId("add-participant").click();
    await expect(page.getByTestId("participant-row").filter({ hasText: name })).toHaveCount(1);
  }
  await reviewAllAssumed(page);
}

/** Checks the one unit's holder box for each named participant; a unit may have several holders. */
async function assign(page: Page, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await page
      .getByTestId("unit")
      .first()
      .locator("label", { hasText: name })
      .locator('input[type="checkbox"]')
      .check();
  }
}

async function lock(page: Page): Promise<void> {
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");
  await expect(page.getByTestId("settlement-section")).toBeVisible();
}

function settlementRow(page: Page, name: string) {
  return page.getByTestId("settlement-row").filter({ hasText: name });
}

/**
 * The stored record, read without the app. The save chip is asynchronous, so "saved" can still describe the
 * previous write; the pin is about what is on disk, so it asks the disk.
 */
async function storedPaid(page: Page, participantId: string): Promise<boolean | null> {
  return page.evaluate(async (id) => {
    const databases = await indexedDB.databases();
    const entry = databases.find((database) => database.name === "receipt-lens");
    if (!entry?.name) return null;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(entry.name!, entry.version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<Array<{ working?: { participants?: Array<{ id: string; paid: boolean }> } }>>(
      (resolve, reject) => {
        const request = database.transaction("bills").objectStore("bills").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }
    );
    database.close();
    const latest = records[records.length - 1];
    return latest?.working?.participants?.find((participant) => participant.id === id)?.paid ?? null;
  }, participantId);
}

test("settlement: participant sees exact and payment amounts when they differ", async ({ page }) => {
  await setProfile(page);
  await prepare(page, ["P1", "P2"]);
  // Three holders of one ₹100 unit: each exact share is ₹33.3333…, so the whole-paise transfer must differ.
  await assign(page, [PROFILE.name, "P1", "P2"]);
  await lock(page);

  const p1 = settlementRow(page, "P1");
  await expect(p1).toHaveAttribute("data-state", "payable");
  await expect(p1.getByTestId("settlement-exact")).toContainText("Exact share: ₹33.3333…");
  await expect(p1.getByTestId("settlement-payment")).toContainText("UPI payment amount: ₹33.33");
  expect(await p1.getByTestId("settlement-exact").innerText()).not.toBe(
    await p1.getByTestId("settlement-payment").innerText()
  );
});

test("settlement: zero-share participant sees nothing to pay, no link", async ({ page }) => {
  await setProfile(page);
  await prepare(page, ["P1", "P2"]);
  // P2 holds nothing, so their exact share and their allocated transfer are both zero.
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const p2 = settlementRow(page, "P2");
  await expect(p2).toHaveAttribute("data-state", "nothing_to_pay");
  await expect(p2.getByTestId("nothing-to-pay")).toBeVisible();
  await expect(p2.getByTestId("upi-link")).toHaveCount(0);
  await expect(p2.getByTestId("whatsapp-link")).toHaveCount(0);
});

test("settlement: creator sees no self-payment link", async ({ page }) => {
  await setProfile(page);
  await prepare(page, ["P1"]);
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const creator = settlementRow(page, PROFILE.name);
  await expect(creator).toHaveAttribute("data-state", "payer");
  await expect(creator.getByTestId("payer-retained")).toContainText("retained");
  await expect(creator.getByTestId("upi-link")).toHaveCount(0);
  await expect(creator.getByTestId("whatsapp-link")).toHaveCount(0);
  // The only payment link on the screen belongs to the other participant.
  await expect(page.getByTestId("upi-link")).toHaveCount(1);
});

test("settlement: UPI link opens correct intent on click", async ({ page }) => {
  await setProfile(page);
  await prepare(page, ["P1"]);
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const link = settlementRow(page, "P1").getByTestId("upi-link");
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^upi:\/\/pay\?/);

  const query = new URLSearchParams(href!.slice(href!.indexOf("?") + 1));
  expect(query.get("pa")).toBe(PROFILE.upi);
  expect(query.get("pn")).toBe(PROFILE.name);
  expect(query.get("am")).toBe("50.00");
  expect(query.get("cu")).toBe("INR");
  // The token-derived reference is deterministic and within the pinned charset and length.
  expect(query.get("tr")).toMatch(/^[0-9a-f]{16}$/);

  // Assert what the anchor would open without handing a upi: intent to the browser's protocol handler.
  const clicked = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const anchor = document.querySelector('[data-testid="upi-link"]') as HTMLAnchorElement;
        anchor.addEventListener(
          "click",
          (event) => {
            event.preventDefault();
            resolve(anchor.href);
          },
          { once: true }
        );
        anchor.click();
      })
  );
  expect(clicked).toBe(href);
});

test("settlement: WhatsApp share contains exact + payment + link", async ({ page }) => {
  await setProfile(page);
  await prepare(page, ["P1", "P2"]);
  await assign(page, [PROFILE.name, "P1", "P2"]);
  await lock(page);

  const href = await settlementRow(page, "P1").getByTestId("whatsapp-link").getAttribute("href");
  expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);

  const text = decodeURIComponent(href!.slice("https://wa.me/?text=".length));
  expect(text).toContain("Exact share: ₹33.3333…");
  expect(text).toContain("UPI payment amount: ₹33.33");
  expect(text).toContain("/share#v1.");
});

test("settlement: creator marks paid, status persists across reload", async ({ page }) => {
  await setProfile(page);
  await prepare(page, ["P1", "P2"]);
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const p1 = settlementRow(page, "P1");
  await p1.getByTestId("settlement-paid").check();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("settled");
  // Wait for the write itself: the chip can still read "saved" from the previous revision.
  await expect.poll(() => storedPaid(page, "p1")).toBe(true);

  await page.reload();
  await expect(page.getByTestId("restored-notice")).toContainText("Restored from this device");
  const restored = settlementRow(page, "P1");
  await expect(restored.getByTestId("settlement-paid")).toBeChecked();
  // Settlement is metadata, not a lock: the bill is still locked and the payment link still exists.
  await expect(restored).toHaveAttribute("data-state", "payable");
  await expect(restored.getByTestId("upi-link")).toBeVisible();
});
