/***
 * Ticket 10 — capture to draft, in a real browser.
 *
 * Why a browser: `pins.test.ts` pins the transforms with a recording surface, but the flow this ticket
 * exists for is file intake → on-device OCR → a reviewable draft → accept/discard. That needs decoding,
 * a canvas, the WASM runtime and real model weights, and none of those can be faked honestly.
 *
 * The server serves the BUILT shell and the model assets from this repository (same-origin only, §9).
 * The receipt is drawn on a canvas in the page and handed to `setInputFiles()` as real PNG bytes, so
 * no receipt image is committed.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "packages/pwa/dist/app");
const modelDir = path.join(repoRoot, "assets/models");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

let child: ChildProcess | undefined;
let baseUrl = "";

/** Static server for the built shell, with `/assets/models/` mapped onto the repo's model assets. */
async function startServer(): Promise<{ url: string; child: ChildProcess }> {
  if (!existsSync(path.join(appDir, "index.html"))) {
    throw new Error("missing packages/pwa/dist/app/index.html — run `pnpm build` before Playwright");
  }

  const spawned = spawn(
    process.execPath,
    [
      "-e",
      `
      const http = require("node:http");
      const fs = require("node:fs");
      const path = require("node:path");
      const appDir = ${JSON.stringify(appDir)};
      const modelDir = ${JSON.stringify(modelDir)};
      const mime = ${JSON.stringify(MIME)};
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        let file;
        if (url.pathname.startsWith("/assets/models/")) {
          file = path.join(modelDir, url.pathname.slice("/assets/models/".length));
        } else if (url.pathname === "/" || url.pathname === "/capture" || url.pathname === "/bill" || url.pathname === "/share") {
          file = path.join(appDir, "index.html");
        } else {
          file = path.join(appDir, url.pathname);
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          file = path.join(appDir, "index.html");
        }
        res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        fs.createReadStream(file).pipe(res);
      });
      server.listen(0, "127.0.0.1", () => process.stdout.write("url: http://127.0.0.1:" + server.address().port + "/\\n"));
      `,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capture server printed no URL within 20s")), 20_000);
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => {
      const match = chunk.match(/url: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    spawned.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`capture server exited (${code})`));
    });
  });

  return { url, child: spawned };
}

test.beforeAll(async () => {
  const started = await startServer();
  child = started.child;
  baseUrl = started.url;
});

test.afterAll(() => {
  child?.kill("SIGTERM");
  // The fixture guard: these tests are meaningless without the model set the app fetches.
  expect(statSync(path.join(modelDir, "manifest.json")).isFile()).toBe(true);
  expect(readFileSync(path.join(modelDir, "manifest.json"), "utf8")).toContain("PP-OCRv6");
});

test.beforeEach(({}, testInfo) => {
  testInfo.setTimeout(180_000);
});

/** Draws the receipt on a canvas in the page and returns PNG bytes. `null` lines = word-free page. */
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

async function upload(page: Page, buffer: Buffer, name = "receipt.png"): Promise<void> {
  await page.getByTestId("file-input").setInputFiles({ name, mimeType: "image/png", buffer });
}

const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "TOTAL 100.00", "CASH 100.00"];

test("a selected file reaches a populated draft with provenance", async ({ page }) => {
  page.on("console", (m) => console.log("PAGE:", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  page.on("requestfailed", (r) => console.log("REQFAIL:", r.url(), r.failure()?.errorText));
  await page.goto(baseUrl);
  await upload(page, await receiptPng(page, RECEIPT_LINES));

  await expect(page.getByTestId("receipt-preview")).toBeVisible();
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 120_000 });

  const items = page.getByTestId("items-section");
  await expect(items).toContainText("COFFEE");
  await expect(page.getByTestId("provenance").first()).toContainText(/detected|assumed|unresolved/);
  await expect(page.getByTestId("zero-items-state")).toHaveCount(0);
});

test("denied camera still leaves file selection usable", async ({ page }) => {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    devices.enumerateDevices = async () =>
      [{ kind: "videoinput", deviceId: "fake", groupId: "g", label: "Fake" } as MediaDeviceInfo];
    devices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });

  await page.goto(baseUrl);
  await page.getByTestId("camera-btn").click();

  await expect(page.getByTestId("camera-denied")).toBeVisible();
  await upload(page, await receiptPng(page, RECEIPT_LINES));
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 120_000 });
});

test("a word-free image produces the critical zero-items state, not a blank review", async ({ page }) => {
  await page.goto(baseUrl);
  await upload(page, await receiptPng(page, []));

  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("zero-items-state")).toBeVisible();
  await expect(page.getByTestId("capture-notice")).toBeVisible();
});

test("recrop and rerun keep the previous parse until discarded or accepted", async ({ page }) => {
  await page.goto(baseUrl);
  await upload(page, await receiptPng(page, RECEIPT_LINES));
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 120_000 });

  const before = await page.getByTestId("items-section").innerText();

  // Recrop: drag a rectangle across the preview, which re-runs OCR and holds the old parse.
  const frame = page.getByTestId("preview-frame");
  const box = (await frame.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByTestId("crop-info")).toContainText("Crop");
  await expect(page.getByTestId("previous-parse-note")).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => !document.body.textContent?.includes("Running OCR"));

  // Discard restores the held parse without asking OCR again.
  await page.getByTestId("discard-btn").click();
  await expect(page.getByTestId("previous-parse-note")).toHaveCount(0);
  expect(await page.getByTestId("items-section").innerText()).toBe(before);

  // Accept hands the draft to /bill. Ticket 11 replaced ticket 10's placeholder note with the editor, so the
  // handoff is now proved by the working bill it built from the accepted parse — a draft line, and the print
  // it has to reconcile against — rather than by a sentence saying the draft arrived.
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill/);
  await expect(page.getByTestId("draft-count")).toContainText("draft line(s)");
  await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");
});

test("no receipt image bytes reach any store", async ({ page }) => {
  await page.goto(baseUrl);
  // Held in the driver and hashed there, so the census below can compare it against every cached response
  // body byte for byte — the same technique offline.spec.ts uses for request bodies (DECISIONS/0013 T5).
  const receipt = await receiptPng(page, RECEIPT_LINES);
  const receiptSha = createHash("sha256").update(receipt).digest("hex");
  await upload(page, receipt);
  await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 120_000 });
  // Ticket 14 kept the opt-in box off, and this is the case that proves "off" means off.
  await expect(page.getByTestId("keep-photo")).not.toBeChecked();
  await page.getByTestId("accept-btn").click();
  await expect(page).toHaveURL(/\/bill/);
  // The save has to have landed before the census: P7 writes the accepted import at revision 0, so a race
  // here would read a database that is genuinely not written yet and pass for the wrong reason.
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved");

  const census = await page.evaluate(async () => {
    const databases = (await indexedDB.databases()).map((database) => database.name).sort();
    const stores: { name: string; records: number }[] = [];
    if (databases.includes("receipt-lens")) {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("receipt-lens");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const name of [...database.objectStoreNames]) {
        const records = await new Promise<number>((resolve, reject) => {
          const transaction = database.transaction(name);
          const count = transaction.objectStore(name).count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        });
        stores.push({ name, records });
      }
      const names = [...database.objectStoreNames].sort();
      database.close();
      return { databases, stores, names };
    }
    return { databases, stores, names: [] as string[] };
  });

  // (a) receipt-lens is the only database.
  expect(census.databases).toEqual(["receipt-lens"]);
  // (b) the image-bearing store exists and holds nothing: ticket 10's claim, restated now that "no store
  // exists at all" is no longer the shape of the promise.
  expect(census.stores.find((store) => store.name === "retainedImages")).toEqual({ name: "retainedImages", records: 0 });
  // (c) and nothing else was created to hold one instead — the store list is exactly the pinned three.
  expect(census.names).toEqual(["bills", "creatorProfile", "retainedImages"]);
  // The other three storage surfaces are untouched, unchanged from ticket 10 — except the Cache API, which
  // ticket 17 put to use. `caches.keys()` used to be empty and now is not, so this assertion had to change
  // shape: the claim has never been "no cache exists", it is "no receipt image reached anything". The old form
  // proved the stronger statement only because nothing else was ever written. What is checked now is the
  // content: every cache is one of ticket 17's three kinds, and every entry is a deployment asset served by
  // URL — the uploaded receipt is a `File`, it is never a URL, and it cannot appear here by construction.
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);

  const cacheCensus = await page.evaluate(async () => {
    const names = (await caches.keys()).sort();
    const urls: Record<string, string[]> = {};
    for (const name of names) {
      const entries = await (await caches.open(name)).keys();
      urls[name] = entries.map((request) => request.url);
    }
    return { names, urls };
  });
  const SHELL = /^receipt-lens-shell-v[0-9a-f]{12}$/;
  const MODELS = /^receipt-lens-models:[^:]+:[0-9a-f]{64}$/;
  expect(cacheCensus.names.every((name) => SHELL.test(name) || MODELS.test(name) || name === "receipt-lens-active-model-cache")).toBe(true);
  const allUrls = Object.values(cacheCensus.urls).flat();
  /**
   * Deployment assets, plus the one synthetic key ticket 17 owns: the pointer cache stores the active model
   * cache name under `/active` (DECISIONS/0027 W3), which is a record rather than a file. Everything else is a
   * hashed build output, a model byte, an icon, the manifest or the worker script.
   */
  const CACHEABLE = new Set(["/index.html", "/manifest.webmanifest", "/sw.js", "/active"]);
  const deployAsset = (url: string): boolean => {
    const path = new URL(url).pathname;
    return /^\/(assets|icons)\//.test(path) || CACHEABLE.has(path);
  };
  expect(
    allUrls.every((url) => url.startsWith(baseUrl) && deployAsset(url)),
    `unexpected cache entries: ${allUrls.filter((url) => !deployAsset(url)).join(", ") || "(none)"}`,
  ).toBe(true);
  // No blob or data URL ever entered a cache — the only way an in-memory image could be stored by reference.
  expect(allUrls.some((url) => url.startsWith("blob:") || url.startsWith("data:"))).toBe(false);

  /**
   * And the claim itself, by content rather than by name. Checking only which *URLs* are cached would be
   * weaker than the `caches.keys()` assertion it replaced: the old form failed on any cache content at all,
   * so it would also have caught image bytes filed under a plausible deployment path. Every cached response
   * body is therefore hashed and compared with the uploaded receipt — the way `offline.spec.ts` proves an
   * image never left the device, applied to the cache instead of to the wire.
   */
  const imageInCache = await page.evaluate(async (needle) => {
    const matches: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const digest = await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer());
        const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (hex === needle) matches.push(`${name} ${request.url}`);
      }
    }
    return matches;
  }, receiptSha);
  expect(imageInCache, `the receipt image was found cached at: ${imageInCache.join(", ")}`).toEqual([]);
  // The bill itself is on disk (asserted for its own sake in persistence.spec.ts), so an empty
  // `retainedImages` is a real emptiness rather than a database that never got written.
  expect(census.stores.find((store) => store.name === "bills")?.records).toBe(1);
});

