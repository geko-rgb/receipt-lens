/**
 * Ticket 16 — share links in a running browser, one split test per user-visible promise.
 *
 * The seam is pinned in `packages/pwa/tests/share/snapshot.test.ts` and `…/view.test.ts`; this file proves the
 * things only a browser can: that the route the shell hands the raw fragment to actually renders a bill, that a
 * damaged link shows a sentence rather than half a number, that an over-budget bill offers no link at all, that
 * a stale link keeps showing what it was sent, and that nothing on the participant screen came from the receipt
 * rather than from the bill.
 *
 * Split tests, each self-contained from its own capture: `fullyParallel` is on and every context is a fresh
 * origin, so no case inherits another's ledger or links. No `test.setTimeout` overrides — a case that reaches
 * the 30 s budget is stuck on a locator, not slow.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

/** ₹100 on one unit, held by three people: ₹33.3333… exact against a ₹33.33 transfer (DECISIONS/0024 S2). */
const RECEIPT = ["RECEIPT", "PLATTER 100.00", "TOTAL 100.00"];
/**
 * The same receipt with a second, ambiguous line. The printed `TOTAL` is what makes `NAAN 60.00` an
 * unclassified row rather than a second item — the recipe `lock-lifecycle.spec.ts` established — so "NAAN" is
 * a string that exists on the receipt and in the bill's local state and must never reach a link.
 */
const AMBIGUOUS = ["RECEIPT", "COFFEE 60.00", "NAAN 60.00", "TOTAL 120.00"];
const PROFILE = { name: "Albus", upi: "albus@okhdfc" };
const FRAGMENT_CAP = 8192;
/** `mapping.ts`'s default bill title: the capture flow names no title of its own. */
const BILL_TITLE = "Receipt";

let server: AppServer;

test.beforeAll(async () => {
  server = await startAppServer();
});

test.afterAll(() => {
  server?.close();
});

async function receiptPng(page: Page, lines: readonly string[]): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (rows) => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "bold 56px monospace";
    rows.forEach((line, index) => context.fillText(line, 60, 220 + index * 160));
    return canvas.toDataURL("image/png");
  }, lines);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function setProfile(page: Page): Promise<void> {
  await page.goto(`${server.url}bills`);
  await page.getByTestId("profile-name").fill(PROFILE.name);
  await page.getByTestId("profile-upi").fill(PROFILE.upi);
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("profile-saved")).toBeVisible();
}

async function accept(page: Page, lines: readonly string[]): Promise<void> {
  await page.goto(`${server.url}capture`);
  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await receiptPng(page, lines) });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("totals")).toBeVisible();
}

async function reviewAllAssumed(page: Page): Promise<void> {
  for (const testId of ["review-assumed", "review-item"]) {
    for (;;) {
      const pending = page.getByTestId(testId);
      if ((await pending.count()) === 0) break;
      await pending.first().click();
    }
  }
}

async function finalizeAll(page: Page): Promise<void> {
  if ((await page.getByTestId("finalize-all").count()) === 0) return;
  await page.getByTestId("finalize-all").click();
  await expect(page.getByTestId("unit").first()).toBeVisible();
}

/** The roster and the finalized parse, with every unit still unassigned. */
async function prepare(page: Page, lines: readonly string[], participants: readonly string[]): Promise<void> {
  await accept(page, lines);
  await finalizeAll(page);
  for (const name of participants) {
    await page.getByTestId("participant-name").fill(name);
    await page.getByTestId("add-participant").click();
    await expect(page.getByTestId("participant-row").filter({ hasText: name })).toHaveCount(1);
  }
  await reviewAllAssumed(page);
}

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
}

/**
 * The creator's panel is where a fragment is born, so the link under test is one a person could actually copy.
 * The value is read out of the field rather than rebuilt, because the field is the product.
 */
async function shareLinkFor(page: Page, participantName: string): Promise<string> {
  const row = page.getByTestId("share-link-row").filter({ hasText: participantName });
  await expect(row).toHaveCount(1);
  const url = await row.getByTestId("share-link-url").inputValue();
  expect(url.startsWith(`${server.url}share#v1.`)).toBe(true);
  return url.slice(url.indexOf("#") + 1);
}

/** Opens a link on a device with no ledger of its own: the ordinary recipient, not the creator looking again. */
async function openLink(browser: Browser, fragment: string): Promise<{ page: Page; outbound: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const outbound: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(server.url)) outbound.push(request.url());
  });
  await page.goto(`${server.url}share#${fragment}`);
  return { page, outbound };
}

test("share: opening a valid link renders the participant view", async ({ page, browser }) => {
  await setProfile(page);
  await prepare(page, RECEIPT, ["P1", "P2"]);
  await assign(page, [PROFILE.name, "P1", "P2"]);
  await lock(page);

  // DECISIONS/0026 A4's meter, on the creator's side: one link per participant, each measured from the string
  // that was actually produced, each inside the cap.
  const rows = page.getByTestId("share-link-row");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    const bytes = Number(await row.getByTestId("share-budget").getAttribute("data-bytes"));
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(FRAGMENT_CAP);
  }

  const fragment = await shareLinkFor(page, "P1");
  const { page: view, outbound } = await openLink(browser, fragment);

  await expect(view.getByTestId("share-view")).toBeVisible();
  await expect(view.getByTestId("share-title")).toHaveText(BILL_TITLE);
  await expect(view.getByTestId("share-row")).toHaveCount(3);
  // ₹100 between three holders is ₹33.3333… exact, and the one spare paise goes to the participant id the
  // largest-remainder tie-break chooses (DECISIONS/0024 S2, §12) — so the rows are asserted by person.
  const p1Row = view.getByTestId("share-row").filter({ hasText: "P1" });
  await expect(p1Row.getByTestId("share-exact")).toContainText("₹33.3333…");
  await expect(p1Row.getByTestId("share-payment")).toContainText("₹33.33");
  await expect(view.getByTestId("share-payment").first()).not.toHaveText("not computable");
  await expect(view.getByTestId("share-failure")).toHaveCount(0);

  // DECISIONS/0026 A10: the pinned bearer-secret sentence is on the screen that shows the bill.
  const disclosure = view.getByTestId("share-disclosure");
  await expect(disclosure).toContainText("This link is the key.");
  await expect(disclosure).toContainText("It is a bearer secret, not protection from the person you send it to.");
  await expect(disclosure).toContainText("is a display default, not access control.");

  // DECISIONS/0026 A9: this device holds no copy of the bill, so it may only say it might have changed.
  await expect(view.getByTestId("share-created")).toContainText("The bill may have changed since.");
  await expect(view.getByTestId("share-epoch")).toHaveCount(0);

  // The fragment is never fetched, and nothing else leaves the device (ADR-007, §9).
  expect(outbound).toEqual([]);

  // DECISIONS/0026 G1: the viewer names themselves. Their row moves to the top and is marked, and nothing is
  // hidden, because the recipient already holds the whole bill.
  await view.getByTestId("which-one-are-you").selectOption({ label: "P1" });
  await expect(view.getByTestId("share-mine")).toBeVisible();
  await expect(view.getByTestId("share-row")).toHaveCount(3);
  const mine = view.getByTestId("share-row").first();
  await expect(mine).toHaveAttribute("data-mine", "true");
  await expect(mine.locator(".name")).toHaveText("P1");
  await expect(mine.getByTestId("share-expiry-hint")).toContainText("no expiry set");

  await view.getByTestId("share-toggle").click();
  await expect(view.getByTestId("share-full-bill")).toBeVisible();
  await expect(view.getByTestId("share-item-row")).toContainText("PLATTER × 1");
  await expect(view.getByTestId("share-unit-row")).toContainText(PROFILE.name);
});

test("share: tampered fragment fails closed with link_corrupt_or_tampered", async ({ page, browser }) => {
  await setProfile(page);
  await prepare(page, RECEIPT, ["P1"]);
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const fragment = await shareLinkFor(page, "P1");
  const parts = fragment.split(".");
  const ciphertext = parts[3]!;
  parts[3] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;

  const { page: view } = await openLink(browser, parts.join("."));

  await expect(view.getByTestId("share-failure-code")).toHaveText("link_corrupt_or_tampered");
  await expect(view.getByTestId("share-failure")).toContainText("Nothing was read from it.");
  // Fail closed means half a bill is not on the screen either: no title, no rows, no amounts.
  await expect(view.getByTestId("share-view")).toHaveCount(0);
  await expect(view.getByTestId("share-row")).toHaveCount(0);
  await expect(view.getByTestId("share-title")).toHaveCount(0);
});

test("share: wrong version fails with unsupported_link_version", async ({ page, browser }) => {
  await setProfile(page);
  await prepare(page, RECEIPT, ["P1"]);
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const fragment = await shareLinkFor(page, "P1");
  const { page: view } = await openLink(browser, `v9.${fragment.slice(fragment.indexOf(".") + 1)}`);

  await expect(view.getByTestId("share-failure-code")).toHaveText("unsupported_link_version");
  await expect(view.getByTestId("share-failure")).toContainText("newer receipt-lens");
  await expect(view.getByTestId("share-view")).toHaveCount(0);
});

test("share: a length-1-mod-4 fragment fails closed with the codec's own words", async ({ page, browser }) => {
  // DECISIONS/0026 A15 end to end. One leftover base64url character encodes no byte, and a link truncated to
  // exactly that shape used to escape `decodeSnapshot` as a DOMException. The message asserted below is the
  // codec's, which is what distinguishes "classified at the charset step" from "the view caught something".
  await setProfile(page);
  await prepare(page, RECEIPT, ["P1"]);
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const parts = (await shareLinkFor(page, "P1")).split(".");
  parts[3] = "A";

  const { page: view } = await openLink(browser, parts.join("."));

  await expect(view.getByTestId("share-failure-code")).toHaveText("link_corrupt_or_tampered");
  await expect(view.getByTestId("share-failure")).toContainText("impossible length");
  await expect(view.getByTestId("share-view")).toHaveCount(0);
});

test("share: over-budget assembly is refused at lock time, and no link is offered", async ({ page }) => {
  await setProfile(page);
  await prepare(page, RECEIPT, ["P1", "P2"]);

  // An incompressible 20 KB label, so the refusal is about the encoded fragment's size rather than a character
  // count DEFLATE might have shrunk (0025 P5, 0026 A4). The name is edited on the finalized line, which keeps
  // its units and assignments: nothing about the money moves.
  const huge = await page.evaluate(() =>
    Array.from({ length: 20_000 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 94))).join("")
  );
  await page.getByTestId("item-name").first().fill(huge);
  await page.getByTestId("item-name").first().dispatchEvent("change");
  await assign(page, [PROFILE.name, "P1", "P2"]);
  await lock(page);

  const refusal = page.getByTestId("share-refusal");
  await expect(refusal).toBeVisible();
  await expect(refusal).toHaveAttribute("data-code", "link_budget_exceeded");
  await expect(refusal).toContainText("Shorten or remove non-essential");
  await expect(page.getByTestId("share-link-row")).toHaveCount(0);

  // DECISIONS/0026 A11: the settlement row loses the bill link and the WhatsApp hand-off, and says so, rather
  // than sending a URL that decodes to nothing.
  await expect(page.getByTestId("share-link-missing").first()).toBeVisible();
  await expect(page.getByTestId("whatsapp-link")).toHaveCount(0);
});

test("share: stale snapshot shows banner, not current values", async ({ page }) => {
  await setProfile(page);
  await prepare(page, RECEIPT, ["P1", "P2"]);
  await assign(page, [PROFILE.name, "P1", "P2"]);
  await lock(page);

  const fragment = await shareLinkFor(page, "P1");

  // Unlock through 0022 L4's dialog, edit the price, re-lock. The re-lock mints fresh tokens and L6 stamps the
  // cutoff, so the captured fragment belongs to the earlier lock in both ways.
  await page.getByTestId("unlock-button").click();
  await expect(page.getByTestId("unlock-dialog")).toBeVisible();
  await page.getByTestId("unlock-confirm").click();
  await expect(page.getByTestId("lifecycle-state")).not.toHaveText("locked");

  const cutoff = await page.getByTestId("stale-links-notice").locator("time").getAttribute("datetime");
  expect(cutoff).not.toBeNull();

  await page.getByTestId("item-price").first().fill("150.00");
  await page.getByTestId("item-price").first().dispatchEvent("change");
  await expect(page.getByTestId("calculated-items")).toContainText("₹150.00");
  // The printed total moves with it, so the settlement allocation stays computable and the creator's own
  // numbers are visible for the comparison below (0024 S8-4 refuses rather than misallocating).
  await page.getByTestId("grand-total-input").fill("150.00");
  await page.getByTestId("grand-total-apply").click();
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹150.00");

  await lock(page);
  // The creator's own numbers moved: ₹33.3333… of ₹100 became ₹50.00 of ₹150, exactly.
  await expect(
    page.getByTestId("settlement-row").filter({ hasText: "P1" }).getByTestId("settlement-payment")
  ).toContainText("₹50.00");

  // The old link still opens — this model has no revocation — and is labelled as the earlier freeze it is.
  await page.goto(`${server.url}share#${fragment}`);
  const banner = page.getByTestId("share-stale");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Bill updated on");
  await expect(banner.locator("time")).toHaveAttribute("datetime", cutoff!);
  await expect(page.getByTestId("share-view")).toHaveAttribute("data-staleness", "stale");

  // The frozen values, not the live bill's.
  const staleP1 = page.getByTestId("share-row").filter({ hasText: "P1" });
  await expect(staleP1.getByTestId("share-exact")).toContainText("₹33.3333…");
  await expect(staleP1.getByTestId("share-payment")).toContainText("₹33.33");
  await expect(page.getByTestId("share-view").getByText("₹50.00")).toHaveCount(0);
  await expect(page.getByTestId("share-epoch")).toHaveCount(0);
});

test("share: receipt image and OCR text are absent from the fragment", async ({ page, browser }) => {
  await setProfile(page);
  await prepare(page, AMBIGUOUS, ["P1"]);

  // "NAAN 60.00" is on the receipt, stays visible in the bill's local state, and is excluded from the bill —
  // the content 0022 L1 says must not travel and ADR-007 says never ships.
  await expect(page.getByTestId("unclassified-row")).toContainText("NAAN");
  await page.getByTestId("exclude-row").first().check();
  await assign(page, [PROFILE.name, "P1"]);
  await lock(page);

  const fragment = await shareLinkFor(page, "P1");
  expect(fragment).not.toContain("NAAN");
  expect(fragment).not.toContain("data:image");
  expect(fragment).not.toContain("base64");

  const { page: view } = await openLink(browser, fragment);
  await expect(view.getByTestId("share-view")).toBeVisible();
  expect(await view.getByTestId("share-view").innerText()).not.toContain("NAAN");

  // The excluded row is not hiding behind a toggle either: the whole bill is the other half of the check.
  await view.getByTestId("share-toggle").click();
  await expect(view.getByTestId("share-full-bill")).toBeVisible();
  expect(await view.getByTestId("share-view").innerText()).not.toContain("NAAN");

  // A share view is not a photo viewer (§10: receipt images are never persisted, let alone linked).
  await expect(view.locator("img")).toHaveCount(0);
});
