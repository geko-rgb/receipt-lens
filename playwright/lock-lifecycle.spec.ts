/**
 * Ticket 13 — the lock lifecycle in a running browser, one test per state transition.
 *
 * `tests/lock/pins.test.ts` pins the seam; this file proves the things only a browser can: that the checklist a
 * user reads is the one the runner enforces, that an unlock dialog stands between the button and the write,
 * and that the UI's own paths (finalize-first, exclusion, payer, removal) reach the rules at all.
 *
 * Split tests, not one flow: a continuous script would make a failure say "the bill broke" instead of which
 * transition broke. Each test starts from its own OCR pass, and the bill's position in the lifecycle is
 * asserted from `lifecycle-state`, which is `lifecycleOf(document)` and nothing else.
 *
 * Every blocker gets four legs: shown while present (and the only thing present), refused at the runner with
 * `lock_blocked` while its code sits in the checklist, cleared by the user action that owns it, and locked once
 * clear. Legs 3 and 4 are the point — a blocker with no clear path is a dead end for the user, not a test gap.
 */
import { expect, test, type Page } from "@playwright/test";
import { startAppServer, type AppServer } from "./app-server.js";

const RECEIPT = ["RECEIPT", "COFFEE 60.00", "TOTAL 60.00"];
/**
 * The printed `TOTAL` row is what makes the second line ambiguous: with it, `parse()` promotes `COFFEE 60.00`
 * and preserves `NAAN 60.00` as `u1`; without it both lines align to the price column and both become items.
 * So `AMBIGUOUS` can never yield `grand_total_missing` and `NO_TOTAL` can never yield an unclassified row, and
 * the two blockers are proved by separate captures rather than one fixture that stacks every code at once.
 */
const AMBIGUOUS = ["RECEIPT", "COFFEE 60.00", "NAAN 60.00", "TOTAL 120.00"];
const NO_TOTAL = ["RECEIPT", "COFFEE 60.00", "NAAN 60.00"];
const HEADER_ONLY = ["RECEIPT"];

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

async function accept(page: Page, lines: string[]): Promise<void> {
  await page.goto(server.url);
  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await receiptPng(page, lines) });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 150_000 });
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("totals")).toBeVisible();
}

async function addParticipant(page: Page, name: string): Promise<void> {
  await page.getByTestId("participant-name").fill(name);
  await page.getByTestId("add-participant").click();
  await expect(page.getByTestId("participant-row").filter({ hasText: name })).toHaveCount(1);
}

async function finalizeAll(page: Page): Promise<void> {
  await page.getByTestId("finalize-all").click();
  await expect(page.getByTestId("unit").first()).toBeVisible();
}

/**
 * Clears `assumed_qty_unreviewed`, which every fixture here carries: §7's tentative 1 survives finalization, so
 * the code stays listed after the line becomes an item and only a review transaction removes it. Drafts and
 * items use separate buttons, so both are walked; a reviewed line renders neither, which makes this idempotent.
 */
async function reviewAllAssumed(page: Page): Promise<void> {
  for (const testId of ["review-assumed", "review-item"]) {
    for (;;) {
      const pending = page.getByTestId(testId);
      if ((await pending.count()) === 0) break;
      await pending.first().click();
    }
  }
  await expect(page.getByTestId("blocker").filter({ hasText: "assumed_qty_unreviewed" })).toHaveCount(0);
}

/** The `index`th unit's checkbox for the participant whose roster row carries `name`. */
function assignmentBox(page: Page, name: string, index = 0) {
  return page.getByTestId("unit").nth(index).locator("label", { hasText: name }).locator('input[type="checkbox"]');
}

async function assignTo(page: Page, name: string): Promise<void> {
  await assignmentBox(page, name).check();
}

/** Assigns every unit, which is what actually empties `units_unassigned`: one tick clears one unit only. */
async function assignAllUnitsTo(page: Page, name: string): Promise<void> {
  const units = await page.getByTestId("unit").count();
  for (let index = 0; index < units; index += 1) {
    const box = assignmentBox(page, name, index);
    if (!(await box.isChecked())) await box.check();
  }
}

async function fingerprints(page: Page): Promise<string[]> {
  return page
    .getByTestId("participant-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-token-fingerprint") ?? ""));
}

/** The creator is the first roster row, so this works without knowing the captured name. */
function firstAssignmentBox(page: Page) {
  return page.getByTestId("unit").first().getByRole("checkbox").first();
}

/** Captures, finalizes, staffs the roster and reviews every assumed quantity. */
async function makeReady(page: Page, lines: string[] = RECEIPT): Promise<void> {
  await accept(page, lines);
  // The roster lives inside the items branch: a bill still in `draft` has no participant input at all, so
  // finalizing first is not a preference here — it is the only order the screen allows.
  await expect(page.getByTestId("participant-name")).toHaveCount(0);
  await finalizeAll(page);
  await addParticipant(page, "P1");
  await reviewAllAssumed(page);
}

/** Leg 1, isolated: this code is on the checklist, and it is the only thing on the checklist. */
async function expectOnlyBlocker(page: Page, code: string): Promise<void> {
  const blockers = page.getByTestId("blocker");
  await expect(blockers).toHaveCount(1);
  await expect(blockers.first()).toContainText(code);
}

/** Leg 2: the runner refuses for the reason the checklist already gave, and the bill stays unlocked. */
async function refuseLock(page: Page, code: string): Promise<void> {
  await expect(page.getByTestId("blocker").filter({ hasText: code })).toHaveCount(1);
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("lock_blocked");
  await expect(page.getByTestId("lifecycle-state")).not.toHaveText("locked");
}

/** Legs 3 and 4: once the blocker is cleared from this screen, the same button is enough. */
async function expectLockSucceeds(page: Page): Promise<void> {
  await expect(page.getByTestId("no-blockers")).toBeVisible();
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");
}

test("lock: a clear checklist locks, freezes the numbers and mints a token per participant", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");
  await expect(page.getByTestId("no-blockers")).toBeVisible();

  const payable = await page.getByTestId("calculated-payable").textContent();
  await page.getByTestId("lock-button").click();

  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");
  await expect(page.getByTestId("unlock-button")).toBeVisible();
  await expect(page.getByTestId("lock-button")).toHaveCount(0);
  // Locking is not a settlement: the payable total is the same before and after.
  await expect(page.getByTestId("calculated-payable")).toHaveText(payable ?? "");

  const tokens = await fingerprints(page);
  expect(tokens).toHaveLength(2);
  expect(tokens.every((token) => token.length > 0)).toBe(true);
  expect(new Set(tokens).size).toBe(2);
});

test("lock: grand_total_missing is shown, refuses the lock and clears on a typed total", async ({ page }) => {
  await makeReady(page, NO_TOTAL);
  await assignAllUnitsTo(page, "P1");

  await expectOnlyBlocker(page, "grand_total_missing");
  await refuseLock(page, "grand_total_missing");

  await page.getByTestId("grand-total-input").fill("120.00");
  await page.getByTestId("grand-total-apply").click();
  await expectLockSucceeds(page);
});

test("lock: unclassified_rows_unreviewed is shown, refuses the lock and clears on exclusion", async ({ page }) => {
  await makeReady(page, AMBIGUOUS);
  await assignAllUnitsTo(page, "P1");

  await expectOnlyBlocker(page, "unclassified_rows_unreviewed");
  await refuseLock(page, "unclassified_rows_unreviewed");

  await page.getByTestId("exclude-row").first().check();
  await expectLockSucceeds(page);
});

test("lock: payer_missing is shown, refuses the lock and clears when a payer is chosen", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");

  await page.getByTestId("payer-select").selectOption("");
  await expectOnlyBlocker(page, "payer_missing");
  await refuseLock(page, "payer_missing");

  await page.getByTestId("payer-select").selectOption({ index: 1 });
  await expectLockSucceeds(page);
});

test("lock: units_unassigned is shown, refuses the lock and clears on assignment", async ({ page }) => {
  await makeReady(page, RECEIPT);

  await expectOnlyBlocker(page, "units_unassigned");
  await refuseLock(page, "units_unassigned");

  await assignTo(page, "P1");
  await expectLockSucceeds(page);
});

test("lock: an unassigned unit clears by acknowledgement instead of assignment", async ({ page }) => {
  await makeReady(page, NO_TOTAL);
  // This fixture prints no total, so that code rides along until it is typed; this test is about the unit.
  await page.getByTestId("grand-total-input").fill("120.00");
  await page.getByTestId("grand-total-apply").click();

  // Two units, one holder offered: assigning is not the only way out, so the other path gets its own leg 3.
  await assignTo(page, "P1");
  await refuseLock(page, "units_unassigned");
  await page.getByTestId("acknowledge-unit").last().click();

  await expectLockSucceeds(page);
});

test("lock: assumed_qty_unreviewed is shown, refuses the lock and clears on review", async ({ page }) => {
  await accept(page, RECEIPT);
  await finalizeAll(page);
  await addParticipant(page, "P1");
  await assignAllUnitsTo(page, "P1");

  // The only blocker left is the quantity nobody confirmed.
  await expectOnlyBlocker(page, "assumed_qty_unreviewed");
  await refuseLock(page, "assumed_qty_unreviewed");

  await reviewAllAssumed(page);
  await expectLockSucceeds(page);
});

test("lock: draft_charges_unresolved is shown, refuses the lock and clears on a sign", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");

  // A manual "other" charge starts sign-unknown, which is the code's only UI path.
  await page.getByTestId("new-charge-label").fill("SVC");
  await page.getByTestId("new-charge-type").selectOption("other");
  await page.getByTestId("new-charge-amount").fill("5.00");
  await page.getByTestId("add-charge").click();

  await refuseLock(page, "draft_charges_unresolved");

  await page.getByTestId("charge-sign").selectOption("add");
  await page.getByTestId("inclusion-separate").click();
  await expectLockSucceeds(page);
});

test("lock: draft items surface the finalize-first path instead of locking atomically", async ({ page }) => {
  await accept(page, RECEIPT);
  await expect(page.getByTestId("draft-finalize-hint")).toBeVisible();

  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("items_unfinalized");
  await expect(page.getByTestId("lifecycle-state")).not.toHaveText("locked");

  await page.getByTestId("finalize-drafts").click();
  await expect(page.getByTestId("unit").first()).toBeVisible();

  // The runner refuses with the checklist invariant, whose refs are the codes the list already shows.
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("lock_blocked");
  await expect(page.getByTestId("blocker").filter({ hasText: "units_unassigned" })).toHaveCount(1);
  await expect(page.getByTestId("lifecycle-state")).not.toHaveText("locked");

  // The hint's own promise: what it refused is clearable without leaving the screen.
  await reviewAllAssumed(page);
  await firstAssignmentBox(page).check();
  await expectLockSucceeds(page);
});

test("locked bill rejects edits: price, assignment and removal each surface bill_locked", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");

  // leg 1 — price
  const price = page.getByTestId("item-price").first();
  await price.fill("70.00");
  await price.press("Tab");
  await expect(page.getByTestId("transaction-rejected")).toContainText("bill_locked");
  await expect(price).toHaveValue(/60\.00/);

  // leg 2 — assignment (the creator's checkbox, unchecked before the click)
  const box = firstAssignmentBox(page);
  await box.click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("bill_locked");
  await expect(box).not.toBeChecked();

  // leg 3 — participant removal
  await page.getByTestId("remove-participant").first().click();
  await page.getByTestId("remove-confirm").click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("bill_locked");
  await expect(page.getByTestId("participant-row").filter({ hasText: "P1" })).toHaveCount(1);
});

test("unlock: the dialog blocks, and cancelling changes nothing", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");

  const before = await fingerprints(page);
  const payable = await page.getByTestId("calculated-payable").textContent();

  await page.getByTestId("unlock-button").click();
  const dialog = page.getByTestId("unlock-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("stops working");
  await expect(page.getByTestId("unlock-warning")).toContainText("Paid flags are kept");

  await page.getByTestId("unlock-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");
  expect(await fingerprints(page)).toEqual(before);
  await expect(page.getByTestId("stale-links-notice")).toHaveCount(0);
  await expect(page.getByTestId("calculated-payable")).toHaveText(payable ?? "");
});

test("unlock: confirming regenerates every token, records the cutoff and keeps paid flags", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");
  await page.getByTestId("paid-toggle").last().check();
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("settled");
  const before = await fingerprints(page);

  await page.getByTestId("unlock-button").click();
  await page.getByTestId("unlock-confirm").click();

  await expect(page.getByTestId("lifecycle-state")).toHaveText("ready_to_lock");
  await expect(page.getByTestId("lock-button")).toBeVisible();
  await expect(page.getByTestId("stale-links-notice")).toContainText("Links sent before");

  const after = await fingerprints(page);
  expect(after).toHaveLength(before.length);
  expect(after).not.toEqual(before);
  expect(after.every((fingerprint) => fingerprint.length > 0)).toBe(true);
  await expect(page.getByTestId("paid-toggle").last()).toBeChecked();
});

test("excluded rows: the blocker clears, the row stays visible and no number moves", async ({ page }) => {
  await accept(page, AMBIGUOUS);
  await expect(page.getByTestId("unclassified-row")).toHaveCount(1);
  await expect(page.getByTestId("blocker").filter({ hasText: "unclassified_rows_unreviewed" })).toHaveCount(1);
  const items = await page.getByTestId("calculated-items").textContent();

  await page.getByTestId("exclude-row").first().check();

  await expect(page.getByTestId("blocker").filter({ hasText: "unclassified_rows_unreviewed" })).toHaveCount(0);
  await expect(page.getByTestId("unclassified-row")).toHaveCount(1);
  await expect(page.getByTestId("row-excluded")).toBeVisible();
  await expect(page.getByTestId("calculated-items")).toHaveText(items ?? "");
});

test("removeParticipant: a paid participant is refused, an unpaid one cascades", async ({ page }) => {
  await makeReady(page, RECEIPT);
  await assignAllUnitsTo(page, "P1");

  await page.getByTestId("paid-toggle").last().check();
  await page.getByTestId("remove-participant").click();
  await page.getByTestId("remove-confirm").click();
  await expect(page.getByTestId("transaction-rejected")).toContainText("participant_paid");
  await expect(page.getByTestId("participant-row")).toHaveCount(2);
  // A refused removal leaves the dialog open on purpose, so it has to be dismissed before anything else
  // on the screen can be touched — its backdrop swallows every pointer event until then.
  await expect(page.getByTestId("remove-dialog")).toBeVisible();
  await page.getByTestId("remove-cancel").click();
  await expect(page.getByTestId("remove-dialog")).toHaveCount(0);

  await page.getByTestId("paid-toggle").last().uncheck();
  await page.getByTestId("remove-participant").click();
  await expect(page.getByTestId("remove-dialog")).toContainText("assignment(s) go with them");
  await page.getByTestId("remove-confirm").click();

  await expect(page.getByTestId("participant-row")).toHaveCount(1);
  await expect(page.getByTestId("blocker").filter({ hasText: "units_unassigned" })).toHaveCount(1);
  await expect(page.getByTestId("acknowledge-unit")).toBeVisible();
});

test("zero items: a hand-built bill locks once its total and lines are confirmed", async ({ page }) => {
  await accept(page, HEADER_ONLY);
  await expect(page.getByTestId("finding-code").filter({ hasText: "zero_items" })).toHaveCount(1);

  await page.getByTestId("grand-total-input").fill("60.00");
  await page.getByTestId("grand-total-apply").click();
  await expect(page.getByTestId("grand-total-source")).toHaveText("user_confirmed");

  await page.getByTestId("new-line-name").fill("COFFEE");
  await page.getByTestId("new-line-qty").fill("1");
  await page.getByTestId("new-line-price").fill("60.00");
  await page.getByTestId("add-line").click();
  await finalizeAll(page);
  await reviewAllAssumed(page);
  await firstAssignmentBox(page).check();
  await expect(page.getByTestId("no-blockers")).toBeVisible();

  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");
  // `zero_items` is a parse finding, never a lock blocker (DECISIONS/0022 L9).
  await expect(page.getByTestId("finding-code").filter({ hasText: "zero_items" })).toHaveCount(1);
});
