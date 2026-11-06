/***
 * Ticket 18 — the §9 M3 full-workflow privacy audit.
 *
 * The protocol is DECISIONS/0030; this file is its only implementation. What it claims:
 *
 *   Receipt images and OCR text are processed locally, and the tested inference workflow succeeds after the
 *   app/model assets are available without an inference service. Six split tests read one accumulated request
 *   log from one full workflow run — capture, parse, review, edit, assign, lock, mint share links, open one as
 *   a participant, mark paid — rather than each driving their own OCR pass (P6).
 *
 * Three witnesses, because one alone is not enough (P4). The context event log is what asserts. The context
 * routes enforce. The origin's own request log confirms the event log is not blind — a path the server served
 * that never appeared in the browser-side log fails the audit, and it is the only witness Playwright's
 * interception cannot influence.
 *
 * Requests are classified by scheme (P4.1). `http:`/`https:` are network requests and are subject to every
 * assertion; `blob:`/`data:` are local object URLs — recorded, never counted as egress — and the image-bytes
 * assertion still proves the receipt bytes never appear in an `http(s)` body, URL, query or header. Without that
 * distinction the audit would either false-positive on the app's own image handling or silently ignore the
 * receipt image.
 *
 * The driver asserts its own preconditions (P6.1): a flow that silently shortens — lock refused, share phase
 * empty, participant view never rendered — fails where it shortened, instead of leaving every assertion below to
 * pass vacuously on a short log.
 *
 * LIMITS, STATED HERE BECAUSE THEY ARE PART OF THE CLAIM (P3, P12):
 *   - Service workers run with `serviceWorkers: "allow"`, so the worker's own egress is in scope. Playwright's
 *     interception of service-worker traffic is browser-dependent and Chromium-specific; everything here is
 *     measured on Desktop Chrome and nothing else.
 *   - This is an empirical demonstration, not a mathematical proof. It shows the tested flow, on this browser,
 *     on this deployment, produced no unexpected egress. It cannot show that an untested code path would not —
 *     which is why the static scan (P8) exists and why it is labelled a supplement, never a proof.
 *   - Deliberate share actions are excluded from the local-processing claim (P7) and the exclusions are printed,
 *     so the carve-out is auditable rather than a `continue()` in a loop. Excluded from the *cross-origin*
 *     assertion only: a deliberate payload is still content-scanned as an artifact, not merely aborted.
 *   - No body, header value, or query string is written to the CI log. Hashes, counts and method/origin/path
 *     only (P4): proving user data did not leave must not copy it into a build log to do it.
 *   - The one word that is not scanned inside a payload is the bill's own default title, "Receipt" — bill
 *     wording, not receipt text, and P7's rule 4 records the exclusion rather than leaving it implicit.
 */
import { expect, test, type Browser, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAppServer, type AppServer } from "./app-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* --------------------------------------------------------------- the receipt */

/** P2. `COFFEE 4.50` becomes an item; `NAAN 60.00` stays an excluded ambiguous row. */
const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "NAAN 60.00", "TOTAL 100.00"];

/**
 * Bill wording rather than receipt text, and therefore not a needle anywhere. The word is on the receipt as its
 * header line, but it is also the product's own name — every launcher icon is `/icons/receipt-lens-*.png` — and
 * the bill's default title (`mapping.ts`), so it cannot distinguish receipt text from the deployment's identity in
 * any of the four places P5 names. The lines that carry a printed amount are the discriminators, together with the
 * image digest. DECISIONS/0030 P7 records the exclusion instead of leaving it implicit.
 */
const BILL_WORDING = ["receipt"];

/** P5/P7 — every line string that can only have come from the receipt, lowercased as a decoded payload shows it. */
const RECEIPT_TEXT_NEEDLES = RECEIPT_LINES.map((line) => line.toLowerCase()).filter((line) => !BILL_WORDING.includes(line));

/** Deliberate destinations, pinned rather than heuristically detected (P7). */
const DELIBERATE_ORIGINS = new Set(["https://wa.me", "https://api.whatsapp.com"]);

/** The profile is the payee source (DECISIONS/0024 pin 9) and the UPI intent needs it. */
const PROFILE = { name: "Albus", upi: "albus@okhdfc" };
const PARTICIPANTS = ["P1", "P2"];

/** P5 — the sliding window that catches a partial copy of the image in a body. */
const IMAGE_WINDOW_BYTES = 4096;

/* ------------------------------------------------------------------- records */

type Phase =
  | "profile"
  | "capture"
  | "parse"
  | "review"
  | "edit"
  | "assign"
  | "lock"
  | "share"
  | "participant"
  | "settle"
  | "deliberate";

type DeliberateTag = "whatsapp-intent" | "upi-intent" | "share-link-minted";

interface RecordedRequest {
  phase: Phase;
  method: string;
  /** Kept for the content scan. Never printed — a query may hold user data (P4). */
  url: string;
  origin: string;
  path: string;
  search: string;
  scheme: string;
  /** True only for `http(s)` on the application origin; `blob:` is not "same origin traffic" (P4.1). */
  sameOrigin: boolean;
  resourceType: string;
  /** SHA-256 of `postDataBuffer()`, or null when there is no body. Never the body itself (P4). */
  bodySha256: string | null;
  /** Header *names* whose value matched a receipt signature. Values are never recorded (P5). */
  headerMatches: string[];
  /** Header names whose value carried the image digest. Values are never recorded (P5). */
  imageHeaderMatches: string[];
  /** Kept for the sliding-window scan; never printed. */
  body: Buffer | null;
  /** Set only for a request the audit classified as deliberate (P7). */
  deliberate?: DeliberateTag;
}

interface EnforcedRequest {
  origin: string;
  path: string;
  outcome: "continued" | "aborted";
}

interface AuditLog {
  /** The application origin under test. Every `http(s)` request to anything else is a failure. */
  appOrigin: string;
  /** Witness 1 — the context event log. The assertion surface. */
  requests: RecordedRequest[];
  /** Witness 1's other half: every request Playwright saw fail, which is where an abort lands. */
  failed: { phase: Phase; origin: string; path: string; error: string }[];
  /** Witness 2 — what the routing layer was handed and enforced against. */
  enforced: EnforcedRequest[];
  /** Witness 3 — the origin's own request log, independent of Playwright. */
  served: { path: string; status: number; bodyBytes: number }[];
  /** WebSocket upgrades the routing layer closed (Playwright's `route` does not intercept them). */
  sockets: string[];
  /** The SHA-256 of the exact PNG bytes handed to the file input (P2). */
  imageSha256: string;
  /** The image bytes themselves, held in memory for the 4 KB window scan. Never written anywhere. */
  imageBytes: Buffer;
  /** Deliberate actions seen, printed as excluded-not-exempt (P7). */
  exclusions: { tag: string; destination: string }[];
  /** P7 rule 4 — the fragments read out of the fields, scanned as payloads, never printed. */
  mintedFragments: string[];
  /** P7 rule 4 — the message bodies the WhatsApp links would have carried. */
  whatsappBodies: { destination: string; text: string }[];
  /** P6.1 — the driver's own postconditions, so a shortened flow cannot pass. */
  preconditions: { locked: boolean; shareLinkRows: number; participants: number; settled: boolean; units: number };
}

/* --------------------------------------------------------------- the server */

let server: AppServer;
let baseUrl = "";

test.beforeAll(async () => {
  server = await startAppServer({ recordRequests: true });
  baseUrl = server.url;
});

test.afterAll(() => {
  server?.close();
});

/* ------------------------------------------------------------------ helpers */

const NETWORK_SCHEMES = new Set(["http:", "https:"]);
/** P4.1 — recorded for completeness, never counted as egress. */
const LOCAL_SCHEMES = new Set(["blob:", "data:", "about:"]);
/** P7 — a protocol intent, not an HTTP request. */
const INTENT_SCHEMES = new Set(["upi:"]);

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "invalid:";
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function searchOf(url: string): string {
  try {
    return new URL(url).search;
  } catch {
    return "";
  }
}

/** P5 — decoded once, so `%43OFFEE` is not a miss. */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hashOf(buffer: Buffer | null): string | null {
  return buffer === null ? null : createHash("sha256").update(buffer).digest("hex");
}

function hits(haystack: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => haystack.includes(needle));
}

function deliberateTag(url: string): DeliberateTag | undefined {
  if (DELIBERATE_ORIGINS.has(originOf(url))) return "whatsapp-intent";
  if (INTENT_SCHEMES.has(protocolOf(url))) return "upi-intent";
  return undefined;
}

function emptyLog(appOrigin: string): AuditLog {
  return {
    appOrigin,
    requests: [],
    failed: [],
    enforced: [],
    served: [],
    sockets: [],
    imageSha256: "",
    imageBytes: Buffer.alloc(0),
    exclusions: [],
    mintedFragments: [],
    whatsappBodies: [],
    preconditions: { locked: false, shareLinkRows: 0, participants: 0, settled: false, units: 0 },
  };
}

/** The printed table. Method, origin, path, a body *hash* and header *names* only (P4). */
function report(log: AuditLog): void {
  console.log(`privacy audit — witness 1 recorded ${log.requests.length} request(s); witness 3 served ${log.served.length}`);
  console.log("  phase       method scheme  request                                   body            header-matches");
  for (const request of log.requests) {
    const body = request.bodySha256 === null ? "none" : request.bodySha256.slice(0, 12);
    const headers = request.headerMatches.length > 0 ? `headers=${request.headerMatches.join(",")}` : "";
    const tag = request.deliberate === undefined ? "" : ` [${request.deliberate}]`;
    console.log(
      `  ${request.phase.padEnd(11)} ${request.method.padEnd(6)} ${request.scheme.padEnd(7)} ${request.origin}${request.path}${tag}`.padEnd(96) +
        `${body.padEnd(16)}${headers}`,
    );
  }
  for (const entry of log.enforced) {
    if (entry.outcome === "aborted") console.log(`  witness 2 aborted: ${entry.origin}${entry.path}`);
  }
  for (const socket of log.sockets) console.log(`  witness 2 closed a WebSocket: ${socket}`);
}

/**
 * Witness 1's recorder. It is attached to every context the workflow uses — the creator's and the participant's
 * — because a request from either is a request the claim covers.
 */
function attachWitnesses(context: BrowserContext, phase: () => Phase, log: AuditLog): void {
  context.on("request", (request: Request) => {
    const url = request.url();
    const headers = request.headers();
    const body = request.postDataBuffer();
    const digest = hashOf(body);
    const headerMatches: string[] = [];
    const imageHeaderMatches: string[] = [];
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") continue;
      const lowered = value.toLowerCase();
      if (digest !== null && lowered.includes(digest)) imageHeaderMatches.push(name);
      if (hits(lowered, RECEIPT_TEXT_NEEDLES).length > 0) headerMatches.push(name);
    }
    log.requests.push({
      phase: phase(),
      method: request.method(),
      url,
      origin: originOf(url),
      path: pathOf(url),
      search: searchOf(url),
      scheme: protocolOf(url),
      sameOrigin: originOf(url) === log.appOrigin && NETWORK_SCHEMES.has(protocolOf(url)),
      resourceType: request.resourceType(),
      bodySha256: digest,
      headerMatches,
      imageHeaderMatches,
      body,
      deliberate: deliberateTag(url),
    });
  });
  context.on("requestfailed", (request) => {
    log.failed.push({
      phase: phase(),
      origin: originOf(request.url()),
      path: pathOf(request.url()),
      error: request.failure()?.errorText ?? "unknown failure",
    });
  });
}

/**
 * Witness 2. Same-origin and local traffic continues; everything else is recorded and aborted, so a canary or an
 * unexpected endpoint never reaches a socket and CI stays hermetic (P7 rule 1, P9).
 */
async function installEnforcement(context: BrowserContext, log: AuditLog): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const url = route.request().url();
    const origin = originOf(url);
    const target = pathOf(url);
    if (deliberateTag(url) !== undefined) {
      log.enforced.push({ origin, path: target, outcome: "aborted" });
      await route.abort("blockedbyclient");
      return;
    }
    if (!NETWORK_SCHEMES.has(protocolOf(url)) || origin === log.appOrigin) {
      log.enforced.push({ origin, path: target, outcome: "continued" });
      await route.continue();
      return;
    }
    log.enforced.push({ origin, path: target, outcome: "aborted" });
    await route.abort("blockedbyclient");
  });
  // `route` does not intercept WebSocket upgrades (DECISIONS/0013 T3), so they are recorded and closed here.
  await context.routeWebSocket("**/*", (socket) => {
    log.sockets.push(originOf(socket.url()));
    socket.close();
  });
}

/* ------------------------------------------------------------- the driver */

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

/** The row whose name field carries `needle`, looked up by the line id the document gave it. */
async function rowFor(page: Page, needle: string) {
  const id = await page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-line-id]"));
    const hit = rows.find((row) => (row.querySelector("input")?.value ?? "").toUpperCase().includes(text));
    return hit?.dataset.lineId ?? null;
  }, needle.toUpperCase());
  if (id === null) throw new Error(`audit: no bill line carries "${needle}"`);
  return page.locator(`[data-line-id="${id}"]`);
}

/**
 * P6 — drives the whole workflow once and returns the accumulated log.
 *
 * Every step asserts its own postcondition. That is P6.1, not thoroughness for its own sake: an audit of
 * *absence* is only worth the flow that produced the traffic, and a flow that quietly stopped early produces a
 * short log on which every assertion below passes.
 */
async function runFullWorkflow(context: BrowserContext): Promise<AuditLog> {
  const browser = context.browser();
  if (browser === null) throw new Error("audit: the workflow needs a browser handle to open the participant's context");

  const log = emptyLog(new URL(baseUrl).origin);
  server.reset();

  let phase: Phase = "profile";
  const at = (): Phase => phase;

  attachWitnesses(context, at, log);
  await installEnforcement(context, log);
  const page = await context.newPage();

  // --- profile ---------------------------------------------------------------------------------------
  phase = "profile";
  await page.goto(`${baseUrl}bills`);
  await page.getByTestId("profile-name").fill(PROFILE.name);
  await page.getByTestId("profile-upi").fill(PROFILE.upi);
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("profile-saved")).toBeVisible();

  // --- capture: the image is hashed at the moment of handover (P2) ------------------------------------
  phase = "capture";
  await page.goto(`${baseUrl}capture`);
  const image = await receiptPng(page, RECEIPT_LINES);
  log.imageBytes = image;
  log.imageSha256 = hashOf(image) ?? "";
  await page.getByTestId("file-input").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: image });
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 180_000 });

  // --- parse / review ---------------------------------------------------------------------------------
  phase = "parse";
  await expect(page.getByTestId("items-section")).toContainText("COFFEE");
  await expect(page.getByTestId("zero-items-state")).toHaveCount(0);

  phase = "review";
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill$/);
  await expect(page.getByTestId("totals")).toBeVisible();
  await page.getByTestId("finalize-all").click();
  await expect(page.getByTestId("unit").first()).toBeVisible();

  // The ambiguous line is excluded. This is what makes "NAAN is absent from every payload" a measurement
  // rather than a property of a row nobody looked at (P2, P7 rule 4).
  await expect(page.getByTestId("unclassified-row")).toContainText("NAAN");
  const exclude = page.getByTestId("exclude-row").first();
  await exclude.check();
  // Excluding does not delete the row: it stays visible, marked, so the user can put it back. What changes is
  // that the money it carried stops being part of the bill — which is what makes its absence from a payload mean
  // something (P2, P7 rule 4).
  await expect(exclude).toBeChecked();
  await expect(page.getByTestId("row-excluded").first()).toBeVisible();

  // --- edit: rename, add a line, delete it ------------------------------------------------------------
  phase = "edit";
  const itemName = page.getByTestId("item-name").first();
  await itemName.fill("COFFEE LATTE");
  await itemName.dispatchEvent("change");
  await expect(page.getByTestId("item-name").first()).toHaveValue("COFFEE LATTE");

  await page.getByTestId("new-line-name").fill("TIP");
  await page.getByTestId("new-line-qty").fill("1");
  await page.getByTestId("new-line-price").fill("1.00");
  await page.getByTestId("add-line").click();
  const tip = await rowFor(page, "TIP");
  await expect(tip).toHaveCount(1);
  // A draft is not yet a bill amount (§10), so deletion is the transaction a finalized line owns: finalize it,
  // then delete it. The receipt's own item is the one that stays.
  await tip.getByTestId("finalize-line").click();
  await expect(page.getByTestId("item-row")).toHaveCount(2);
  await tip.getByTestId("delete-item").click();
  await expect(tip).toHaveCount(0);

  // The printed total is reconciled with what the user kept, which is the ordinary path to a lockable bill.
  const itemsTotal = (await page.getByTestId("calculated-items").innerText()).replace(/[^0-9.]/g, "");
  if (itemsTotal === "") throw new Error("audit: the editor shows no item total to reconcile against");
  await page.getByTestId("grand-total-input").fill(itemsTotal);
  await page.getByTestId("grand-total-apply").click();
  await expect(page.getByTestId("grand-total-source")).toContainText("user_confirmed");

  // --- participants and assignment --------------------------------------------------------------------
  phase = "assign";
  for (const participant of PARTICIPANTS) {
    await page.getByTestId("participant-name").fill(participant);
    await page.getByTestId("add-participant").click();
    await expect(page.getByTestId("participant-row").filter({ hasText: participant })).toHaveCount(1);
  }
  log.preconditions.participants = await page.getByTestId("participant-row").count();
  if (log.preconditions.participants < PARTICIPANTS.length) {
    throw new Error(`audit: only ${log.preconditions.participants} participant(s) on the roster — the share phase would be short`);
  }

  const units = await page.getByTestId("unit").count();
  if (units === 0) throw new Error("audit: the bill has no units after finalization, so nothing can be assigned");
  log.preconditions.units = units;
  for (const name of [PROFILE.name, ...PARTICIPANTS]) {
    for (let index = 0; index < units; index += 1) {
      const box = page.getByTestId("unit").nth(index).locator("label", { hasText: name }).locator('input[type="checkbox"]');
      if (!(await box.isChecked())) await box.check();
    }
  }
  // §7's tentative quantity survives finalization, so the checklist only empties once every line is reviewed.
  for (const testId of ["review-assumed", "review-item"]) {
    for (;;) {
      const pending = page.getByTestId(testId);
      if ((await pending.count()) === 0) break;
      await pending.first().click();
    }
  }
  await expect(page.getByTestId("no-blockers")).toBeVisible();

  // --- lock (P6.1: the driver asserts the transition, not the intent) ---------------------------------
  phase = "lock";
  await page.getByTestId("lock-button").click();
  await expect(page.getByTestId("lifecycle-state")).toHaveText("locked");
  log.preconditions.locked = true;

  const shareRows = page.getByTestId("share-link-row");
  log.preconditions.shareLinkRows = await shareRows.count();
  if (log.preconditions.shareLinkRows === 0) {
    throw new Error("audit: the bill locked but minted no share link — the share phase would be empty (DECISIONS/0030 P6.1)");
  }

  // --- share: the fragment is read out of the field, because the field is the product ------------------
  phase = "share";
  for (const row of await shareRows.all()) {
    const url = await row.getByTestId("share-link-url").inputValue();
    if (!url.startsWith(`${baseUrl}share#v1.`)) {
      throw new Error("audit: a minted link is not a v1 fragment link on this origin");
    }
    log.mintedFragments.push(url.slice(url.indexOf("#") + 1));
    log.exclusions.push({ tag: "share-link-minted", destination: `${log.appOrigin}/share` });
  }

  // --- participant: a device with no ledger of its own opens one link ---------------------------------
  phase = "participant";
  const participantContext = await browser.newContext({ serviceWorkers: "allow" });
  attachWitnesses(participantContext, at, log);
  await installEnforcement(participantContext, log);
  const participantPage = await participantContext.newPage();
  await participantPage.goto(`${baseUrl}share#${log.mintedFragments[0]}`);
  await expect(participantPage.getByTestId("share-view")).toBeVisible();
  // The bill's own title, which is why P7 rule 4 does not scan for that word inside a payload.
  await expect(participantPage.getByTestId("share-title")).toHaveText("Receipt");
  expect(await participantPage.getByTestId("share-view").innerText()).not.toContain("NAAN");

  // --- settle ------------------------------------------------------------------------------------------
  phase = "settle";
  await page.bringToFront();
  const payerRow = page.getByTestId("settlement-row").filter({ hasText: PARTICIPANTS[0]! });
  await expect(payerRow).toHaveCount(1);
  // Every holder marks paid, not one: the bill settles when nobody is still owed (DECISIONS/0022's lifecycle),
  // and a flow that stopped at the first tick would leave the settle phase unproven.
  for (const participant of PARTICIPANTS) {
    const row = page.getByTestId("settlement-row").filter({ hasText: participant });
    await expect(row, `no settlement row for ${participant}`).toHaveCount(1);
    await row.getByTestId("settlement-paid").check();
  }
  await expect(page.getByTestId("lifecycle-state")).toHaveText("settled");
  log.preconditions.settled = true;

  // --- deliberate: seen, tagged, aborted, and printed as excluded-not-exempt ---------------------------
  phase = "deliberate";
  const whatsapp = await payerRow.getByTestId("whatsapp-link").getAttribute("href");
  const upi = await payerRow.getByTestId("upi-link").getAttribute("href");
  if (whatsapp === null || upi === null) {
    throw new Error("audit: the settlement row offers no share intents, so the deliberate set would be empty");
  }
  log.whatsappBodies.push({ destination: originOf(whatsapp), text: new URL(whatsapp).searchParams.get("text") ?? "" });

  // The intent is recorded from the anchor, not from a request: `upi:` is handed to a protocol handler and never
  // becomes HTTP, so there is nothing on the wire to observe (P7). The attempt is still made, silently.
  log.exclusions.push({ tag: "upi-intent", destination: "upi://pay (parameters not logged)" });
  await page.evaluate((href) => {
    try {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.click();
    } catch {
      /* the platform refusing the intent is not a failure of the audit */
    }
  }, upi);

  // The WhatsApp hand-off is a real egress attempt: the routing layer aborts it, and witness 1 must still see it,
  // or the audit would be excluding something it never observed (P7 rule 1, P9).
  log.exclusions.push({ tag: "whatsapp-intent", destination: "https://wa.me" });
  await page.evaluate((href) => void window.open(href, "_blank"), whatsapp);
  await expect
    .poll(() => log.requests.filter((request) => request.deliberate === "whatsapp-intent").length, {
      message: "the deliberate WhatsApp action produced no request at all — the exclusion would be unobserved",
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  await participantContext.close();

  // Witness 3, snapshotted last. Witness 1 records a request when it is issued and the origin logs it when it is
  // answered, so nothing the origin served can be missing from witness 1 by ordering alone.
  log.served = server.requests.map(({ path: servedPath, status, bodyBytes }) => ({
    path: servedPath,
    status,
    bodyBytes,
  }));
  return log;
}

/* ------------------------------------------------------------- assertions */

/** P4.1/P6 — no unexpected cross-origin request anywhere in the flow, first load included. */
async function assertNoCrossOriginEgress(log: AuditLog): Promise<void> {
  report(log);
  const network = log.requests.filter((request) => NETWORK_SCHEMES.has(request.scheme));
  if (network.length === 0) {
    throw new Error("audit: no network request was observed at all, so \"no cross-origin request\" would pass vacuously");
  }
  const crossOrigin = log.requests
    .filter((request) => NETWORK_SCHEMES.has(request.scheme))
    .filter((request) => request.origin !== log.appOrigin)
    .filter((request) => request.deliberate === undefined)
    .map((request) => `${request.method} ${request.origin}${request.path}`);
  expect(crossOrigin, "the audit observed http(s) traffic to an origin that is not the application").toEqual([]);

  const local = log.requests.filter((request) => LOCAL_SCHEMES.has(request.scheme));
  console.log(
    `  classified local (recorded, never counted as egress, P4.1): ${local.length} request(s)` +
      (local.length === 0
        ? " — no blob:/data: request was observed in this flow, so that branch of the classifier is unexercised here rather than passed"
        : ` — ${[...new Set(local.map((request) => request.scheme))].join(", ")}`),
  );
}

/** P4 witness 3 — the origin served nothing that witness 1 failed to see. */
async function assertWitness1IsNotBlind(log: AuditLog): Promise<void> {
  if (log.served.length === 0) {
    throw new Error("audit: the origin's own log is empty, so there is nothing to check witness 1 against");
  }
  const observed = new Set(log.requests.map((request) => request.path));
  const blind = [...new Set(log.served.map((entry) => entry.path).filter((servedPath) => !observed.has(servedPath)))];
  expect(blind, "the origin served paths that never appeared in the browser-side log — witness 1 is blind to them").toEqual([]);
}

/** P2/P5 — the receipt image, byte-for-byte by hash and by 4 KB window, in no network request. */
async function assertNoImageBytes(log: AuditLog): Promise<void> {
  if (log.imageSha256 === "" || log.imageBytes.byteLength === 0) {
    throw new Error("audit: no receipt image was hashed, so this assertion would pass vacuously");
  }
  const windows: Buffer[] = [];
  const stride = Math.max(1, Math.floor(log.imageBytes.byteLength / 64));
  for (let offset = 0; offset + IMAGE_WINDOW_BYTES <= log.imageBytes.byteLength; offset += stride) {
    windows.push(log.imageBytes.subarray(offset, offset + IMAGE_WINDOW_BYTES));
  }

  const problems: string[] = [];
  for (const request of log.requests) {
    if (!NETWORK_SCHEMES.has(request.scheme)) continue;
    const where = `${request.phase} ${request.method} ${request.origin}${request.path}`;
    if (request.bodySha256 === log.imageSha256) {
      problems.push(`${where}: the request body IS the receipt image, byte for byte`);
    }
    if (request.body !== null && windows.some((window) => request.body!.includes(window))) {
      problems.push(`${where}: the request body contains a ${IMAGE_WINDOW_BYTES} B window of the receipt image`);
    }
    if (decodeOnce(request.url).toLowerCase().includes(log.imageSha256)) {
      problems.push(`${where}: the image digest appears in the request URL`);
    }
    if (request.imageHeaderMatches.length > 0) {
      problems.push(`${where}: the image digest appears in header value(s) ${request.imageHeaderMatches.join(", ")} (values not recorded)`);
    }
  }
  expect(problems, "the receipt image reached a network request").toEqual([]);
}

/** P5 — no OCR line string in any URL, query, header value or body, decoded where a decoder is defined. */
async function assertNoOcrText(log: AuditLog): Promise<void> {
  const problems: string[] = [];
  for (const request of log.requests) {
    if (!NETWORK_SCHEMES.has(request.scheme)) continue;
    const where = `${request.phase} ${request.method} ${request.origin}${request.path}`;
    const inUrl = hits(decodeOnce(request.url).toLowerCase(), RECEIPT_TEXT_NEEDLES);
    if (inUrl.length > 0) problems.push(`${where}: the request URL carries the OCR line(s) ${inUrl.join(", ")}`);
    if (request.search !== "" && hits(decodeOnce(request.search).toLowerCase(), RECEIPT_TEXT_NEEDLES).length > 0) {
      problems.push(`${where}: the query string carries an OCR line`);
    }
    if (request.body !== null) {
      const inBody = hits(decodeOnce(request.body.toString("utf8")).toLowerCase(), RECEIPT_TEXT_NEEDLES);
      if (inBody.length > 0) problems.push(`${where}: the request body carries the OCR line(s) ${inBody.join(", ")}`);
    }
    if (request.headerMatches.length > 0) {
      // The recorded matches are header *names*; the values that matched are never written anywhere (P4).
      problems.push(`${where}: header value(s) matched an OCR line — header(s) ${request.headerMatches.join(", ")} (values not recorded)`);
    }
  }
  expect(problems, "OCR text from the receipt reached a network request").toEqual([]);
}

/** P7 — deliberate share actions tagged and printed, and each minted fragment content-scanned as an artifact. */
async function assertDeliberateShareIsScopedAndScanned(log: AuditLog): Promise<void> {
  const tags = [...new Set(log.exclusions.map((entry) => entry.tag))].sort();
  expect(tags, "the carve-out must name every deliberate action it excludes").toEqual([
    "share-link-minted",
    "upi-intent",
    "whatsapp-intent",
  ]);
  console.log("  excluded from the local-processing claim — excluded, NOT exempt from the content scan:");
  for (const entry of log.exclusions) console.log(`    excluded-not-exempt ${entry.tag} → ${entry.destination}`);

  expect(log.mintedFragments.length, "no link was minted, so the payload scan has nothing to scan").toBeGreaterThan(0);

  for (const fragment of log.mintedFragments) {
    // Clear, percent-decoded, and the base64url transport layer of each part. The DEFLATE plaintext beneath the
    // codec's own encryption is not reachable without reimplementing the codec, which P8's "invoke, don't
    // reimplement" rule forbids; the participant's rendered view covers the decoded payload instead (asserted in
    // the driver: no "NAAN" on the screen at all).
    const payloads = [
      fragment,
      decodeOnce(fragment),
      ...fragment.split(".").map((part) => Buffer.from(part, "base64url").toString("latin1")),
    ];
    for (const payload of payloads) {
      const text = payload.toLowerCase();
      expect(hits(text, RECEIPT_TEXT_NEEDLES), "a minted fragment carries a raw receipt line").toEqual([]);
      expect(text.includes(log.imageSha256), "a minted fragment carries the receipt image digest").toBe(false);
      expect(text.includes("data:")).toBe(false);
      expect(text.includes("base64,")).toBe(false);
    }

    // The fragment is a value in a field, not a request (P7 rule 3): it may only appear on the wire as the
    // participant's own document navigation, and never in a query or a body.
    const fingerprint = fragment.slice(-32);
    const elsewhere = log.requests
      .filter((request) => !(request.phase === "participant" && request.path === "/share"))
      .filter((request) => request.url.includes(fingerprint) || (request.body?.toString("latin1").includes(fingerprint) ?? false))
      .map((request) => `${request.phase} ${request.method} ${request.origin}${request.path}`);
    expect(elsewhere, "a minted fragment travelled outside the participant's own navigation").toEqual([]);
    expect(
      log.requests.filter((request) => request.search.includes(fingerprint)).map((request) => request.origin + request.path),
      "a minted fragment appeared in a query string",
    ).toEqual([]);
  }

  expect(log.whatsappBodies.length, "no WhatsApp body was read, so the message scan has nothing to scan").toBeGreaterThan(0);
  for (const body of log.whatsappBodies) {
    const text = body.text.toLowerCase();
    expect(hits(text, RECEIPT_TEXT_NEEDLES), "the WhatsApp message carries a raw receipt line").toEqual([]);
    expect(text.includes(log.imageSha256), "the WhatsApp message carries the receipt image digest").toBe(false);
    expect(text.includes("data:image")).toBe(false);
    expect(text.includes("base64,")).toBe(false);
  }

  // P7 rule 1 — every deliberate destination was actually aborted, so CI never reached the internet.
  const deliberate = log.requests.filter((request) => request.deliberate !== undefined);
  expect(deliberate.length, "no deliberate request was observed at all").toBeGreaterThan(0);
  for (const request of deliberate) {
    const aborted = log.failed.some((entry) => entry.origin === request.origin && entry.path === request.path);
    expect(aborted, `${request.deliberate} was recorded but not aborted — CI would have reached the internet`).toBe(true);
  }
}

/**
 * P8 — invokes the existing first-party scanner and asserts its exit code; supplement, not proof.
 *
 * The command is read out of `package.json`'s `scan:egress` script rather than restated, so there is exactly one
 * definition of what the scan is, and the log prints the command it ran. It is spawned with `process.execPath`
 * rather than through `pnpm` because `spawnSync("pnpm", …)` answers `ENOEXEC` where this was developed — a check
 * that only runs where a package-manager binary happens to be directly spawnable fails for a reason that has
 * nothing to do with egress (DECISIONS/0030 P8's checkpoint-3 amendment).
 */
async function assertStaticScanClean(): Promise<void> {
  const declared = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts?.["scan:egress"];
  if (typeof declared !== "string" || !/^node \S+$/.test(declared)) {
    throw new Error(`audit: the scan:egress script is ${JSON.stringify(declared)}, which this test only knows how to run as "node <file>"`);
  }
  const script = declared.slice("node ".length);
  console.log(`  scan:egress → ${declared}`);
  const scanned = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
  if (scanned.error !== undefined) throw new Error(`audit: could not run \`${declared}\` (${scanned.error.message})`);
  console.log(scanned.stdout.trimEnd());
  if (scanned.stderr.trim() !== "") console.log(scanned.stderr.trimEnd());
  expect(scanned.status, "the static egress scan reported a violation").toBe(0);
  expect(scanned.stdout).toContain("supplement to the runtime test, not a proof");
}

/**
 * P9 — two injected canaries must make the helpers above throw, and the real log must pass. Both canaries are
 * issued by a real page, so this proves the detectors against traffic Playwright actually observed rather than
 * against a hand-built object: a canary the audit misses is a broken audit, and this is the test that notices.
 */
async function assertCanariesAreCaught(browser: Browser, real: AuditLog): Promise<void> {
  const canary = emptyLog(new URL(baseUrl).origin);
  const context = await browser.newContext();
  attachWitnesses(context, () => "deliberate", canary);
  await installEnforcement(context, canary);
  const page = await context.newPage();
  // An opaque origin: everything it fetches is cross-origin, and no app traffic pollutes the canary log.
  await page.goto("about:blank");
  await page.evaluate(async () => {
    for (const target of ["https://example.com/canary-cross-origin"]) {
      try {
        await fetch(target);
      } catch {
        /* the abort is the point */
      }
    }
  });
  await page.evaluate(async () => {
    try {
      // A loopback port nothing listens on: a genuine egress attempt that the routing layer aborts first (P9).
      await fetch("http://127.0.0.1:49152/canary-ocr-text", { method: "POST", body: "NAAN 60.00" });
    } catch {
      /* the abort is the point */
    }
  });
  await expect
    .poll(() => canary.requests.filter((request) => NETWORK_SCHEMES.has(request.scheme)).length, { timeout: 10_000 })
    .toBe(2);

  const crossOriginCanary = canary.requests.find((request) => !request.url.includes("canary-ocr-text"));
  const ocrCanary = canary.requests.find((request) => request.url.includes("canary-ocr-text"));
  expect(crossOriginCanary?.origin, "the cross-origin canary was not observed").toBe("https://example.com");
  expect(ocrCanary?.body?.toString("utf8"), "the OCR-text canary was not observed with its body").toBe("NAAN 60.00");

  await expect(assertNoCrossOriginEgress(canary)).rejects.toThrow(/not the application/);
  await expect(assertNoOcrText(canary)).rejects.toThrow(/OCR line/);

  // And the real log is not red for the same reason — otherwise the two assertions above prove nothing.
  await assertNoCrossOriginEgress(real);
  await assertNoOcrText(real);
  await context.close();
}

/* ------------------------------------------------------------------- tests */

/**
 * Serial, and one workflow: P6 pins one accumulated log read by six split tests, rather than six OCR passes. The
 * hook owns the flow, so the split tests stay assertions rather than drivers.
 */
test.describe("privacy: the §9 M3 full-workflow audit", () => {
  test.use({ serviceWorkers: "allow" });
  test.describe.configure({ mode: "serial" });

  let log: AuditLog;
  let context: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    context = await browser.newContext({ serviceWorkers: "allow" });
    log = await runFullWorkflow(context);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("privacy: no cross-origin request during the full workflow @offline", async () => {
    test.setTimeout(240_000);
    await assertNoCrossOriginEgress(log);
    await assertWitness1IsNotBlind(log);
  });

  test("privacy: no receipt-image bytes appear in any request @offline", async () => {
    test.setTimeout(240_000);
    await assertNoImageBytes(log);
  });

  test("privacy: no OCR text appears in any request @offline", async () => {
    test.setTimeout(240_000);
    await assertNoOcrText(log);
  });

  test("privacy: deliberate share actions are identified, excluded and scanned @offline", async () => {
    test.setTimeout(240_000);
    await assertDeliberateShareIsScopedAndScanned(log);
  });

  test("privacy: static scan finds no banned egress primitives (supplement, not proof) @offline", async () => {
    test.setTimeout(240_000);
    await assertStaticScanClean();
  });

  test("privacy: an injected canary egress fails the audit @offline", async ({ browser }) => {
    test.setTimeout(240_000);
    await assertCanariesAreCaught(browser, log);
  });
});
