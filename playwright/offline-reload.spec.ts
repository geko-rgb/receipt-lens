/***
 * Ticket 17 — offline across a reload, proven in a real browser.
 *
 * This is the file `playwright/offline.spec.ts` says it cannot be. Ticket 09a's proof runs "load with network,
 * block, infer without reload" because the 14,848,852 B ORT WASM exceeds Chromium's HTTP-cache per-entity
 * limit (`DECISIONS/0012` F10/F12) — a reload after the block would fail for a caching reason that has nothing
 * to do with privacy, so the earlier spec deliberately refused to reload. Ticket 17's Cache API is the remedy,
 * and the reload is the proof: test 2 below is the case that fails before this ticket and passes after it.
 *
 * Offline here is the origin destroying the socket, not only a Playwright route abort. `context.route` does
 * not reliably observe a fetch that a service worker initiated — measured in this session firing zero times on
 * a cache-served reload — and §9 M3.4 warns that the coverage is browser-dependent. A refused connection is
 * not version-dependent.
 *
 * Split rather than one continuous flow, per `HANDOFF`'s owner note for tickets 13+: each transition fails
 * with its own name.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMeasureServer } from "../scripts/serve-measure-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "packages/pwa", "dist/app");
const modelDir = path.join(repoRoot, "assets/models");

/* ------------------------------------------------------------------ types */

interface OriginEntry {
  path: string;
  status: number;
  bodyBytes: number;
}

interface MeasureServer {
  readonly url: Promise<string>;
  since(): OriginEntry[];
  refused(): { path: string; outcome: string }[];
  reset(): void;
  close(): Promise<void>;
}

interface CacheReport {
  names: string[];
  entries: Record<string, string[]>;
}

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

/* ---------------------------------------------------------- origin helpers */

let overridesDir = "";
let server: MeasureServer | undefined;
let baseUrl = "";

async function startOrigin(): Promise<void> {
  overridesDir = mkdtempSync(path.join(os.tmpdir(), "rl-sw-"));
  const started = startMeasureServer({ overridesDir }) as unknown as MeasureServer;
  server = started;
  baseUrl = await started.url;
}

/** The offline switch: the origin refuses everything, and records that it was asked. */
function setOffline(offline: boolean): void {
  const marker = path.join(overridesDir, "offline");
  if (offline) writeFileSync(marker, "");
  else rmSync(marker, { force: true });
}

/** Abort at the Playwright layer too, so an intercepted request fails fast rather than hanging. */
async function blockAtEdge(context: BrowserContext): Promise<void> {
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
}

/* ------------------------------------------------------------- app helpers */

function waitForController(page: Page): Promise<unknown> {
  return page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 60_000 });
}

const READ_POINTER = `
  (async () => {
    const hit = await (await caches.open("receipt-lens-active-model-cache")).match("/active");
    return hit ? await hit.text() : null;
  })()
`;

/**
 * Readiness for the model cache is the pointer naming one, not a flag the harness does not have.
 *
 * Polled from Node rather than `page.waitForFunction`: with an async predicate, `waitForFunction` hands back a
 * handle to the Promise itself and `jsonValue()` serializes that as `null`, so the wait "resolves instantly
 * with nothing" — which reads as the feature being broken. `expect.poll` awaits the value properly.
 */
async function waitForActiveModelSet(page: Page, expectName?: RegExp): Promise<string> {
  await expect
    .poll(() => page.evaluate(READ_POINTER) as Promise<string | null>, {
      timeout: 240_000,
      message: expectName ? `the pointer never became ${expectName}` : "no model set ever activated",
    })
    .toMatch(expectName ?? /^receipt-lens-models:[^:]+:[0-9a-f]{64}$/);
  return (await page.evaluate(READ_POINTER)) as string;
}

async function cacheReport(page: Page): Promise<CacheReport> {
  return await page.evaluate(async () => {
    const names = (await caches.keys()).sort();
    const entries: Record<string, string[]> = {};
    for (const name of names) {
      const requests = await (await caches.open(name)).keys();
      entries[name] = requests.map((request) => new URL(request.url).pathname).sort();
    }
    return { names, entries };
  });
}

/** The precache list the build actually injected into the worker artifact. */
function injectedPrecache(): PrecacheEntry[] {
  const code = readFileSync(path.join(appDir, "sw.js"), "utf8");
  const match = code.match(/\[\{"url":"\/.*?"revision":null\}\]/);
  if (!match) throw new Error("sw.js carries no injected precache list — the build plugin did not run");
  return JSON.parse(match[0]) as PrecacheEntry[];
}

/** Files in `dist/app`, as root-relative URLs, minus the named exclusions (W1.1). */
function shippedAssetUrls(): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const next = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === ".vite" ? [] : walk(path.join(dir, entry.name), next);
      return [next];
    });
  return walk(appDir, "").filter((p) => p !== "/sw.js" && !p.endsWith(".map"));
}

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

const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "TOTAL 100.00", "CASH 100.00"];

async function captureToDraft(page: Page, label: string): Promise<void> {
  const buffer = await receiptPng(page, RECEIPT_LINES);
  await page.getByTestId("file-input").setInputFiles({ name: `${label}.png`, mimeType: "image/png", buffer });
  await expect(page.getByTestId("draft-review"), `capture ${label} never produced a draft`).toBeVisible({ timeout: 180_000 });
}

/* ------------------------------------------------------- model-set control */

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

interface OverrideOptions {
  providerVersion?: string;
  /** Declare a wrong digest for one role, which is how a substituted or corrupt download is detected (W7). */
  breakHashFor?: "det" | "rec" | "dict";
}

/**
 * Write an override model manifest. The three asset *files* stay the repository's real weights — the server
 * falls through to `assets/models/` for anything the override directory does not carry — so a smoke run loads
 * real ONNX and the only thing that moves is what the manifest declares. Nothing under `assets/models/` is
 * ever edited to make a test pass.
 */
function writeModelManifest(options: OverrideOptions = {}): { providerVersion: string; manifestHash: string } {
  const base = JSON.parse(readFileSync(path.join(modelDir, "manifest.json"), "utf8")) as {
    providerVersion: string;
    assets: { role: string; file: string; url: string; bytes: number; sha256: string }[];
  };
  const providerVersion = options.providerVersion ?? base.providerVersion;
  const manifest = {
    ...base,
    providerVersion,
    assets: base.assets.map((asset) => ({
      ...asset,
      bytes: statSync(path.join(modelDir, asset.file)).size,
      sha256:
        options.breakHashFor === asset.role
          ? "f".repeat(64)
          : sha256File(path.join(modelDir, asset.file)),
    })),
  };
  const text = JSON.stringify(manifest);
  writeFileSync(path.join(overridesDir, "manifest.json"), text);
  return { providerVersion, manifestHash: createHash("sha256").update(text).digest("hex") };
}

function clearModelManifest(): void {
  rmSync(path.join(overridesDir, "manifest.json"), { force: true });
}

/* ---------------------------------------------------------- worker scripts */

/**
 * A minimal second worker for W13 item 3's controller race. It follows the shipped worker's activate contract
 * (delete superseded shells, never the pointer, never a model set) so the assertion is about the real rule
 * under a real hand-off rather than about a fixture.
 */
function raceWorker(cacheName: string): string {
  return `
    const CACHE = ${JSON.stringify(cacheName)};
    self.addEventListener("install", (event) => {
      event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        const response = await fetch("/index.html", { cache: "reload" });
        await cache.put("/index.html", response);
        await self.skipWaiting();
      })());
    });
    self.addEventListener("activate", (event) => {
      event.waitUntil((async () => {
        for (const name of await caches.keys()) {
          if (name.startsWith("receipt-lens-shell-v") && name !== CACHE) await caches.delete(name);
        }
        await self.clients.claim();
      })());
    });
    self.addEventListener("fetch", (event) => {
      if (event.request.mode === "navigate") {
        event.respondWith(caches.match("/index.html").then((hit) => hit ?? fetch(event.request)));
      }
    });
  `;
}

/* ------------------------------------------------------------------ tests */

test.describe("@offline service worker: install, reload, and self-update", () => {
  test.use({ serviceWorkers: "allow" });

  /**
   * Serial, against one origin and one override directory. `fullyParallel` is the suite default, and this file
   * mutates shared state on purpose — the model manifest and the worker script the origin serves — so two
   * workers running it would clear each other's override mid-flight and report a state that never happened.
   * The alternative is a fresh origin and profile per test, which costs a 15 MB precache each time and buys
   * nothing: none of these tests is about concurrency.
   */
  test.describe.configure({ mode: "serial" });

  /** Real OCR runs in the reload, flow, bump and mismatch cases; the config's 30 s default is not enough (W9.2). */
  test.beforeEach(() => {
    test.setTimeout(240_000);
  });

  test.beforeAll(async () => {
    await startOrigin();
    expect(statSync(path.join(appDir, "sw.js")).isFile()).toBe(true);
    expect(shippedAssetUrls().some((url) => url.endsWith(".wasm")), "the build emitted no runtime WASM").toBe(true);
  });

  test.afterAll(async () => {
    await server?.close();
    rmSync(overridesDir, { recursive: true, force: true });
  });

  test.beforeEach(() => {
    clearModelManifest();
    rmSync(path.join(overridesDir, "sw.js"), { force: true });
    setOffline(false);
    server?.reset();
  });

  test("@offline installs on first visit and precaches the shell, the WASM included, and no model byte", async ({ page }) => {
    const manifest = injectedPrecache();
    expect(manifest.length).toBeGreaterThan(0);

    await page.goto(baseUrl, { waitUntil: "load" });
    await waitForController(page);

    const report = await cacheReport(page);
    const shells = report.names.filter((name) => /^receipt-lens-shell-v[0-9a-f]{12}$/.test(name));
    expect(shells, `expected exactly one shell cache, saw ${report.names.join(", ")}`).toHaveLength(1);

    const cached = [...report.entries[shells[0]!]].sort();
    const declared = manifest.map((entry) => entry.url).sort();
    expect(cached).toEqual(declared);

    // F12's remedy, as an artifact fact: the 14.85 MB runtime binary is in the list.
    const wasm = declared.filter((url) => url.endsWith(".wasm"));
    expect(wasm).toHaveLength(1);
    const bytes = statSync(path.join(appDir, wasm[0]!.replace(/^\//, ""))).size;
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);

    // W2.1: model bytes are prepared through §9's gate, never precached.
    expect(declared.some((url) => url.startsWith("/assets/models/"))).toBe(false);
    // Every shipped asset except the named exclusions is in there — W1.1's rule, read off the artifact.
    expect(declared.sort()).toEqual(shippedAssetUrls().sort());
  });

  test("@offline reloads with the origin refusing every request and still runs an inference", async ({ page, context }) => {
    await page.goto(baseUrl, { waitUntil: "load" });
    await waitForController(page);
    const active = await waitForActiveModelSet(page);
    expect(active).toMatch(/^receipt-lens-models:1\.0\.0:[0-9a-f]{64}$/);

    // Warm the pipeline the way a real first visit does, then go hard offline and reload.
    await captureToDraft(page, "before-block");

    setOffline(true);
    await blockAtEdge(context);
    server?.reset();

    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#shell-wordmark")).toHaveText("receipt-lens", { timeout: 30_000 });
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "the reload must still be controlled").toBe(true);

    await captureToDraft(page, "after-reload");

    // The claim: while offline the origin answered nothing and refused nothing, because nothing arrived.
    expect(server?.since() ?? [], `requests reached the origin while offline: ${JSON.stringify(server?.since())}`).toEqual([]);
    expect(server?.refused() ?? [], `requests reached the origin while offline: ${JSON.stringify(server?.refused())}`).toEqual([]);
  });

  test("@offline completes the whole capture-to-draft-to-bill flow after an offline reload", async ({ page, context }) => {
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await waitForController(page);
    await waitForActiveModelSet(page);
    await page.waitForFunction(() => !/preparing/.test(document.getElementById("model-status")?.dataset.modelStatus ?? "idle"), undefined, { timeout: 180_000 });

    setOffline(true);
    await blockAtEdge(context);
    server?.reset();
    await page.reload({ waitUntil: "load" });

    const buffer = await receiptPng(page, RECEIPT_LINES);
    await page.getByTestId("file-input").setInputFiles({ name: "offline.png", mimeType: "image/png", buffer });
    await expect(page.getByTestId("draft-review")).toBeVisible({ timeout: 180_000 });
    await page.getByTestId("accept-btn").click();
    await expect(page).toHaveURL(/\/bill/);
    // The bill view's own fields, in the order `bill-editor.spec.ts` reaches them: the draft line first, then
    // the printed total the parser read off the page. Both with no network at all.
    await expect(page.getByTestId("draft-count")).toContainText("draft line(s)");
    await expect(page.getByTestId("printed-grand-total")).toContainText("₹100.00");

    expect(server?.since() ?? [], "the offline flow reached the origin").toEqual([]);
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "the flow must still be worker-controlled").toBe(true);
  });

  test("@offline reports installability and drives the banner the app owns, for seven days", async ({ page }) => {
    const manifestResponse = await page.request.get(`${baseUrl}manifest.webmanifest`);
    expect(manifestResponse.ok()).toBe(true);
    expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");
    const manifest = await manifestResponse.json() as Record<string, unknown>;
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect((manifest.icons as { sizes: string; purpose: string }[]).map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(manifest.description).toBe("In-browser receipt parsing and bill splitting. Receipts never leave your device.");

    await page.goto(baseUrl, { waitUntil: "load" });
    await waitForController(page);

    const workerResponse = await page.request.get(`${baseUrl}sw.js`);
    expect(workerResponse.headers()["content-type"]).toContain("text/javascript");

    // The browser half cannot be driven here: headless Chromium fires no beforeinstallprompt (W12), so the
    // event is fabricated and what is asserted is this app's behaviour given it, not Chromium's offering.
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt(): Promise<void> };
      event.prompt = async () => undefined;
      window.dispatchEvent(event);
    });
    const banner = page.getByTestId("install-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Install receipt-lens for offline use");

    await page.getByTestId("install-dismiss").click();
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("receipt-lens:install-banner-dismissed-at"))).not.toBeNull();

    // Still inside the window after a reload: suppressed.
    await page.reload({ waitUntil: "load" });
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt(): Promise<void> };
      event.prompt = async () => undefined;
      window.dispatchEvent(event);
    });
    await expect(page.getByTestId("install-banner")).toHaveCount(0);

    // One day past seven: offered again. The clock is moved, not the code.
    await page.evaluate(() => {
      const key = "receipt-lens:install-banner-dismissed-at";
      localStorage.setItem(key, String(Date.now() - 8 * 24 * 60 * 60 * 1000));
      const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt(): Promise<void> };
      event.prompt = async () => undefined;
      window.dispatchEvent(event);
    });
    await expect(page.getByTestId("install-banner")).toBeVisible();
  });

  test("@offline a model version bump activates a new set and only then removes the superseded one", async ({ page }) => {
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await waitForController(page);
    const first = await waitForActiveModelSet(page);

    const bumped = writeModelManifest({ providerVersion: "1.0.1" });
    await page.reload({ waitUntil: "load" });
    await waitForController(page);
    // Wait for the new name specifically: the old pointer satisfies a bare "is there a model set" check the
    // instant the reloaded document runs, so without this the poll returns the set it is meant to replace.
    const second = await waitForActiveModelSet(page, new RegExp(`^receipt-lens-models:1\\.0\\.1:${bumped.manifestHash}$`));

    expect(second).toBe(`receipt-lens-models:1.0.1:${bumped.manifestHash}`);
    expect(second).not.toBe(first);

    const report = await cacheReport(page);
    expect(report.names.filter((name) => name.startsWith("receipt-lens-models:")), "the superseded set survived cleanup").toEqual([second]);
    // The pointer is never a cleanup target (W3.1).
    expect(report.names).toContain("receipt-lens-active-model-cache");

    // And the newly active set is the one that reads a receipt.
    await captureToDraft(page, "after-bump");
  });

  test("@offline a hash mismatch on an update keeps the working set active and shows the pending state", async ({ page }) => {
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await waitForController(page);
    const first = await waitForActiveModelSet(page);

    writeModelManifest({ providerVersion: "1.0.1", breakHashFor: "rec" });
    await page.reload({ waitUntil: "load" });
    await waitForController(page);

    await expect(page.getByTestId("model-status")).toHaveAttribute("data-model-status", "pending", { timeout: 180_000 });
    await expect(page.getByTestId("model-status")).toContainText("A model update is pending. Receipts still read with the previous model set.");

    const pointer = await waitForActiveModelSet(page);
    expect(pointer, "a failed update must not move the pointer").toBe(first);

    const report = await cacheReport(page);
    expect(report.names.filter((name) => name.startsWith("receipt-lens-models:"))).toEqual([first]);

    // The retained set is not just present, it works.
    await captureToDraft(page, "after-failed-update");
  });

  test("@offline with no model set on the device, the capture view says so instead of throwing", async ({ page, context }) => {
    await context.route("**/assets/models/**", (route) => route.abort("internetdisconnected"));

    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await waitForController(page);

    await expect(page.getByTestId("model-status")).toHaveAttribute("data-model-status", "unavailable", { timeout: 60_000 });
    await expect(page.getByTestId("model-status")).toContainText("Models are not on this device yet. Receipt reading needs them.");

    // Picking a file must produce an ordinary error state, not an uncaught rejection.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const buffer = await receiptPng(page, RECEIPT_LINES);
    await page.getByTestId("file-input").setInputFiles({ name: "no-models.png", mimeType: "image/png", buffer });
    await page.waitForTimeout(3_000);
    expect(pageErrors, `uncaught errors while OCR was unavailable:\n${pageErrors.join("\n")}`).toEqual([]);
    await expect(page.getByTestId("draft-review")).toHaveCount(0);
  });

  test("@offline only the capture route prepares a model set; share, bills and bill never do", async ({ page, context }) => {
    // Direct landings, so each route is a fresh document: the trigger is navigation, not a click.
    for (const route of ["bill", "bills", "share"]) {
      const fresh = await context.newPage();
      server?.reset();
      await fresh.goto(`${baseUrl}${route}`, { waitUntil: "load" });
      await waitForController(fresh).catch(() => undefined);
      await fresh.waitForTimeout(4_000);
      const modelRequests = (server?.since() ?? []).filter((entry) => entry.path.startsWith("/assets/models/"));
      expect(modelRequests, `/${route} requested model assets: ${JSON.stringify(modelRequests)}`).toEqual([]);
      await fresh.close();
    }

    server?.reset();
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await waitForController(page);
    await waitForActiveModelSet(page);
    const probes = (server?.since() ?? []).filter((entry) => entry.path === "/assets/models/manifest.json");
    expect(probes.length, "capture did not probe the model manifest").toBeGreaterThanOrEqual(1);
    expect((server?.since() ?? []).filter((entry) => entry.path.startsWith("/assets/models/")).length).toBeGreaterThan(probes.length);
  });

  test("@offline survives a controller hand-off from an old worker to a new one on a slow network", async ({ page, context }) => {
    // W13 item 3: the two-worker race is pinned in Chromium under throttling, not against mocks — a mocked
    // test of a race is a test of the mock (owner Condition 1).
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 256 * 1024,
      uploadThroughput: 256 * 1024,
    });

    writeManifestlessShell("receipt-lens-shell-vrace0000000a");
    await page.goto(baseUrl, { waitUntil: "load" });
    await waitForController(page);
    const firstController = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "");
    expect(firstController).toContain("/sw.js");
    // Under 256 KB/s the model download is tens of seconds, so the set has to be verified and active *before*
    // the hand-off, or "the model set survived the shell update" just measured a preparation still in flight.
    const modelBeforeHandoff = await waitForActiveModelSet(page);

    // A different worker, a different shell cache, while the tab is still controlled by the first.
    writeManifestlessShell("receipt-lens-shell-vrace0000000b");
    // `update()` is the check the browser does on navigation; called directly so the test drives the same
    // byte-compare path a reload would, without depending on a reload's timing.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("no registration to update");
      await registration.update();
    });
    // Wait for the *sweep*, not for the new cache to appear: the precache is created during install, so a
    // predicate that only looks for `...b` resolves before `activate` has run and the test then blames the
    // worker for its own timing. The hand-off is complete when the superseded shell is gone.
    await expect
      .poll(() => cacheReport(page).then((report) => report.names.filter((name) => name.startsWith("receipt-lens-shell-v"))), {
        timeout: 120_000,
        message: "the new worker never swept the superseded shell cache",
      })
      .toEqual(["receipt-lens-shell-vrace0000000b"]);

    const shells = (await cacheReport(page)).names.filter((name) => name.startsWith("receipt-lens-shell-v"));
    expect(shells, `the hand-off left ${shells.join(", ")} behind`).toEqual(["receipt-lens-shell-vrace0000000b"]);
    // The pointer cache and the verified model set survive a shell hand-off: a shell update must never orphan
    // a model set (W3, W7.2).
    const afterHandoff = (await cacheReport(page)).names;
    expect(afterHandoff).toContain("receipt-lens-active-model-cache");
    expect(afterHandoff).toContain(modelBeforeHandoff);
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "the new worker must control the tab").toBe(true);

    // Still functional after the hand-off, on the throttled connection.
    await captureToDraft(page, "after-handoff");
  });
});

/** Install a synthetic worker for the race test. Named separately so its intent is unmistakable. */
function writeManifestlessShell(cacheName: string): void {
  writeFileSync(path.join(overridesDir, "sw.js"), raceWorker(cacheName));
}
