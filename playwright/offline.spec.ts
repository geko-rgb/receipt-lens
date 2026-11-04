/***
 * Ticket 09a — offline inference, proven in a real browser.
 *
 * The protocol is DECISIONS/0013; this file is its only implementation. The shape that matters:
 *
 *   Phase A (precache): load with the network on, run one full inference, require a NON-EMPTY
 *            result. That result is the readiness signal — the harness has no `sessionsReady`
 *            flag, and a flag would be weaker than a completed run (main.ts:37 loads lazily).
 *   Phase B (block):   context-level routes abort EVERY request and close every WebSocket.
 *   Phase C (offline): the same page, no reload, a second inference. Zero requests may occur.
 *
 * Why no reload: ticket 08 measured that the 14,848,852 B ORT WASM exceeds Chromium's HTTP-cache
 * per-entity limit (~6-8 MiB), so a reload after blocking would fail for a cache reason that has
 * nothing to do with privacy (DECISIONS/0012 F10/F12). Ticket 17's Cache API owns offline reload.
 *
 * The server runs with CACHE_MODE=no-store so nothing in Phase C can be served from the HTTP cache:
 * success can only come from sessions already in memory.
 */
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* --------------------------------------------------------------- declarations */

interface HarnessRun {
  result: { lines: Array<{ words: Array<{ text: string }> }> };
  timings: { loadMs: number };
}

declare global {
  interface Window {
    __receiptLensHarness?: {
      run?: (file: File) => Promise<unknown>;
      last?: HarnessRun;
      error?: { name: string; message: string; code?: string };
    };
    __offlineMarker?: unknown;
  }
}

interface SyntheticFixture {
  canvas: { width: number; height: number };
  font: string;
  layout: { leftPx: number; firstBaselinePx: number; lineHeightPx: number };
  lines: string[];
  reference: { lines: number; words: number; text: string[]; note: string };
}

/**
 * Phase A may request only these exact paths (DECISIONS/0013 T4). Exact, not prefix: a prefix rule
 * would let `/assets/evil` pass because `/assets/models/...` is allowed — the negative control
 * asserts this exactness.
 */
const ASSET_ALLOWLIST = new Set([
  "/",
  "/index.html",
  "/dist/main.js",
  "/dist/main.js.map",
  "/assets/models/manifest.json",
  "/assets/models/PP-OCRv6_tiny_det.onnx",
  "/assets/models/PP-OCRv6_tiny_rec.onnx",
  "/assets/models/PP-OCRv6_tiny_rec.txt",
  "/ort/ort-wasm-simd-threaded.mjs",
  "/ort/ort-wasm-simd-threaded.wasm",
]);

type Phase = "precache" | "offline";

interface EgressRecord {
  phase: Phase;
  method: string;
  path: string;
  search: string;
  origin: string;
  sameOrigin: boolean;
  resourceType: string;
  bodySha256: string | null;
}

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/* ------------------------------------------------------------------- server */

async function startHarness(): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [path.join(repoRoot, "harness/serve.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0", CACHE_MODE: "no-store" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness server printed no URL within 20s:\n${output}`)), 20_000);
    const read = (chunk: string) => {
      output += chunk;
      const match = output.match(/harness: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", read);
    child.stderr?.on("data", (chunk: string) => (output += chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness server exited (${code}):\n${output}`));
    });
  });
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/* ------------------------------------------------------------------ monitor */

interface EgressMonitor {
  records: EgressRecord[];
  phase: () => Phase;
  setPhase: (phase: Phase) => void;
  block: () => void;
  reset: () => void;
  report: () => string;
}

/**
 * Records every request the context observes and enforces the allowlist at the route layer.
 * Bodies are never recorded — only their SHA-256 — so a CI log cannot become a second copy of user
 * data. Headers are never recorded either (cookies/referrers would leak without proving anything).
 */
async function createEgressMonitor(context: BrowserContext, appUrl: string): Promise<EgressMonitor> {
  const appOrigin = new URL(appUrl).origin;
  const records: EgressRecord[] = [];
  let phase: Phase = "precache";
  let blocked = false;

  context.on("request", (request: Request) => {
    const url = new URL(request.url());
    const body = request.postDataBuffer();
    records.push({
      phase,
      method: request.method(),
      path: url.pathname,
      search: url.search,
      origin: url.origin,
      sameOrigin: url.origin === appOrigin,
      resourceType: request.resourceType(),
      bodySha256: body ? sha256Of(body) : null,
    });
  });

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const allowed = !blocked && url.origin === appOrigin && url.search === "" && ASSET_ALLOWLIST.has(url.pathname);
    if (allowed) return route.continue();
    await route.abort("blockedbyclient");
  });

  // `context.route` does not see WebSocket upgrades; without this a socket could open and close
  // invisibly. A WebSocket attempt is a failure by definition on this page.
  await context.routeWebSocket("**/*", async (socket) => {
    const url = new URL(socket.url());
    records.push({
      phase,
      method: "WS",
      path: url.pathname,
      search: url.search,
      origin: url.origin,
      sameOrigin: url.origin === appOrigin,
      resourceType: "websocket",
      bodySha256: null,
    });
    await socket.close();
  });

  return {
    records,
    phase: () => phase,
    setPhase: (next) => (phase = next),
    block: () => (blocked = true),
    reset: () => records.splice(0, records.length),
    report: () => {
      const header = `egress requests (${records.length}):`;
      const lines = records.map(
        (record) =>
          `  [${record.phase}] ${record.method} ${record.path}${record.search} type=${record.resourceType} origin=${record.origin} body=${record.bodySha256 ? record.bodySha256.slice(0, 16) : "-"}`,
      );
      return [header, ...lines].join("\n");
    },
  };
}

function egressViolations(records: EgressRecord[], imageSha256: string | null): string[] {
  const problems: string[] = [];
  for (const record of records) {
    if (imageSha256 !== null && record.bodySha256 === imageSha256) {
      problems.push(`receipt image body left the device: ${record.method} ${record.origin}${record.path}`);
    }
    if (record.phase === "precache") {
      if (!record.sameOrigin) {
        problems.push(`cross-origin request: ${record.method} ${record.origin}${record.path}`);
      } else if (record.search !== "" || !ASSET_ALLOWLIST.has(record.path)) {
        problems.push(`unlisted same-origin request: ${record.method} ${record.path}${record.search}`);
      }
    } else if (record.phase === "offline") {
      problems.push(`request after the network block: ${record.method} ${record.origin}${record.path}`);
    }
  }
  return problems;
}

function assertNoUnexpectedEgress(records: EgressRecord[], imageSha256: string | null): void {
  const problems = egressViolations(records, imageSha256);
  if (problems.length > 0) {
    throw new Error(`unexpected egress:\n- ${problems.join("\n- ")}`);
  }
}

function thrownBy(run: () => void): string {
  try {
    run();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

/* ------------------------------------------------------------------- phases */

/** Draw the committed synthetic receipt (playwright/fixtures/synthetic-receipt.json) and return PNG bytes. */
async function renderSyntheticReceipt(page: Page, fixture: SyntheticFixture): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ canvas, font, layout, lines }) => {
      const element = document.createElement("canvas");
      element.width = canvas.width;
      element.height = canvas.height;
      const context = element.getContext("2d");
      if (!context) throw new Error("2d canvas unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, element.width, element.height);
      context.fillStyle = "#000000";
      context.font = font;
      lines.forEach((line, index) => {
        context.fillText(line, layout.leftPx, layout.firstBaselinePx + index * layout.lineHeightPx);
      });
      return element.toDataURL("image/png").split(",")[1] ?? "";
    },
    fixture,
  );
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) throw new Error("synthetic receipt rendered to zero bytes");
  return bytes;
}

interface HarnessOutcome {
  error: { name: string; message: string; code?: string } | null;
  lines: number;
  words: number;
  loadMs: number;
}

/**
 * Hand the image to the page and wait for a NEW result object. `harness.last` from an earlier phase
 * is a live object that cannot cross the Playwright boundary, so the marker is stashed in the page
 * and compared by identity there (the technique ticket 08's measurement uses).
 */
async function runHarness(page: Page, image: Buffer): Promise<HarnessOutcome> {
  await page.evaluate(() => {
    window.__offlineMarker = window.__receiptLensHarness?.last;
  });
  await page.setInputFiles("#file", { name: "synthetic-receipt.png", mimeType: "image/png", buffer: image });
  await page.waitForFunction(
    () => {
      const harness = window.__receiptLensHarness;
      return Boolean(harness && (harness.error || (harness.last && harness.last !== window.__offlineMarker)));
    },
    undefined,
    { timeout: 120_000, polling: "raf" },
  );
  return page.evaluate(() => {
    const harness = window.__receiptLensHarness;
    if (!harness) throw new Error("window.__receiptLensHarness is missing");
    if (harness.error) return { error: harness.error, lines: 0, words: 0, loadMs: 0 };
    const last = harness.last;
    if (!last) throw new Error("harness reported neither a result nor an error");
    return {
      error: null,
      lines: last.result.lines.length,
      words: last.result.lines.reduce((count, line) => count + line.words.length, 0),
      loadMs: last.timings.loadMs,
    };
  });
}

const fixture = JSON.parse(
  readFileSync(path.join(repoRoot, "playwright/fixtures/synthetic-receipt.json"), "utf8"),
) as SyntheticFixture & { reference: { note: string } };

/* --------------------------------------------------------------------- tests */

test.describe("@offline inference without outbound network", () => {
  test.setTimeout(240_000);

  test("@offline runs to completion with every outbound request blocked, and sends no image bytes", async ({ browser }) => {
    const harness = await startHarness();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const monitor = await createEgressMonitor(context, harness.url);
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") pageErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(String(error)));

      // ---- Phase A: precache. Network on, allowlisted, one full inference.
      monitor.setPhase("precache");
      await page.goto(harness.url, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__receiptLensHarness), undefined, { timeout: 30_000 });
      const image = await renderSyntheticReceipt(page, fixture);
      const imageSha = sha256Of(image);
      const phaseA = await runHarness(page, image);

      expect(phaseA.error, `Phase A harness error: ${JSON.stringify(phaseA.error)}`).toBeNull();
      // Non-empty readiness: an empty result is a pipeline failure, not permission to continue.
      expect(phaseA.lines, "Phase A must read at least one line").toBeGreaterThanOrEqual(1);
      expect(phaseA.words, "Phase A must read at least one word").toBeGreaterThanOrEqual(1);

      // ---- Phase B: block. Every request aborted; every WebSocket closed.
      monitor.block();
      monitor.setPhase("offline");

      // ---- Phase C: second inference, same page, no reload.
      await page.setInputFiles("#file", []);
      const phaseC = await runHarness(page, image);

      expect(phaseC.error, `Phase C harness error: ${JSON.stringify(phaseC.error)}`).toBeNull();
      expect(phaseC.lines, "inference must succeed with the network blocked").toBeGreaterThanOrEqual(1);
      expect(phaseC.words, "inference must read words with the network blocked").toBeGreaterThanOrEqual(1);
      expect(pageErrors, `console errors during the run:\n${pageErrors.join("\n")}`).toEqual([]);

      // The protocols own record of what left (or tried to): printed before the assertion so a
      // failure shows the full log, and after it so a pass leaves the same evidence behind.
      console.log(monitor.report());
      assertNoUnexpectedEgress(monitor.records, imageSha);

      const offlineRequests = monitor.records.filter((record) => record.phase === "offline");
      expect(offlineRequests, "Phase C must make no request at all").toEqual([]);
      const precacheOrigins = new Set(monitor.records.filter((r) => r.phase === "precache").map((r) => r.origin));
      expect([...precacheOrigins], "Phase A must see exactly one origin").toEqual([new URL(harness.url).origin]);

      await context.close();
    } finally {
      await harness.stop();
    }
  });

  test("@offline negative control catches cross-origin, unlisted same-origin, and post-block egress", async ({ browser }) => {
    const harness = await startHarness();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const monitor = await createEgressMonitor(context, harness.url);
      const page = await context.newPage();
      await page.goto(harness.url, { waitUntil: "load" });

      // 1. cross-origin -> aborted, and the assertion names it
      await page.evaluate(() => fetch("https://example.com/").catch(() => undefined));
      const crossOrigin = thrownBy(() => assertNoUnexpectedEgress(monitor.records, null));
      expect(crossOrigin, "a deliberate cross-origin fetch must be caught").toContain("cross-origin");

      // 2. same-origin but unlisted -> proves the allowlist is exact-path, not prefix
      monitor.reset();
      await page.evaluate(() => fetch("/assets/evil").catch(() => undefined));
      const unlisted = thrownBy(() => assertNoUnexpectedEgress(monitor.records, null));
      expect(unlisted, "an unlisted same-origin path must be caught").toContain("unlisted same-origin");

      // 3. after the block -> any request at all is a failure
      monitor.reset();
      monitor.block();
      monitor.setPhase("offline");
      await page.evaluate(() => fetch("/dist/main.js").catch(() => undefined));
      const blocked = thrownBy(() => assertNoUnexpectedEgress(monitor.records, null));
      expect(blocked, "a request after the block must be caught").toContain("after the network block");

      await context.close();
    } finally {
      await harness.stop();
    }
  });
});
