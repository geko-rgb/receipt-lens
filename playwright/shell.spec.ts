/***
 * Ticket 10a — the shell, and the three router conditions DECISIONS/0017 D3a pins, proved in a real
 * browser against the BUILT bundle (`pnpm build` first; CI already builds before it tests).
 *
 * Why a browser at all: `packages/pwa/src/lib/router.test.ts` checks the pure functions, but conditions
 * 1 and 3 are about a live history object — a `hashchange` that re-renders without a navigation, and a
 * fragment surviving a chain of route changes. Only Chromium can show that.
 *
 * The server is `vite preview` on an ephemeral port: the same static file server the shell ships behind,
 * with its SPA fallback doing the job the service worker will take over in ticket 17.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwaDir = path.join(repoRoot, "packages/pwa");
const shellIndex = path.join(pwaDir, "dist/app/index.html");

declare global {
  interface Window {
    __noReloadToken?: string;
  }
}

let server: ChildProcess | undefined;
let baseUrl = "";

/** Resolves once `vite preview` has reported the port it bound. */
async function startShellServer(): Promise<{ child: ChildProcess; url: string }> {
  if (!existsSync(shellIndex)) {
    throw new Error(`missing ${path.relative(repoRoot, shellIndex)} — run \`pnpm build\` before Playwright`);
  }
  const child = spawn(process.execPath, [path.join(pwaDir, "node_modules/vite/bin/vite.js"), "preview", "--port", "0"], {
    cwd: pwaDir,
    // NO_COLOR matters: under a Playwright worker vite colourises the banner, and the port digits end up
    // wrapped in escape codes so the URL below never matches. Stripping is the defensive half.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    // stdout AND stderr are watched: the promise must reject with the server's own complaint rather
    // than the generic timeout, because a silent spawn failure looks exactly like a slow start.
    const noise: string[] = [];
    const timer = setTimeout(
      () => reject(new Error(`vite preview did not report a URL within 30s. output: ${noise.join("") || "(none)"}`)),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      const match = /http:\/\/localhost:\d+/.exec(chunk.toString().replace(/\u001b\[[0-9;]*m/g, ""));
      if (match) {
        clearTimeout(timer);
        resolve(`${match[0]}/`);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      noise.push(chunk.toString());
      const match = /http:\/\/localhost:\d+/.exec(chunk.toString().replace(/\u001b\[[0-9;]*m/g, ""));
      if (match) {
        clearTimeout(timer);
        resolve(`${match[0]}/`);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`vite preview exited ${code}. output: ${noise.join("")}`));
      }
    });
  });
  return { child, url };
}

test.beforeAll(async () => {
  const started = await startShellServer();
  server = started.child;
  baseUrl = started.url;
});

test.afterAll(async () => {
  server?.kill();
});

function watchRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => seen.push(request.url()));
  return seen;
}

/** The shell's own state element: which view rendered, how many renders, how long the fragment is. */
async function shellState(page: Page): Promise<{ route: string; renders: number; fragmentLength: number; heading: string }> {
  return await page.evaluate(() => {
    const view = document.getElementById("shell-view");
    return {
      route: view?.getAttribute("data-route") ?? "",
      renders: Number(view?.getAttribute("data-renders") ?? "0"),
      fragmentLength: Number(view?.getAttribute("data-fragment-length") ?? "-1"),
      heading: view?.querySelector("h1")?.textContent?.trim() ?? "",
    };
  });
}

async function currentHash(page: Page): Promise<string> {
  return await page.evaluate(() => window.location.hash);
}

test.describe("shell navigation", () => {
  test("direct navigation to /capture renders the view before ONNX loads", async ({ page }) => {
    const requests = watchRequests(page);
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });

    const state = await shellState(page);
    expect(state.route).toBe("capture");
    expect(state.heading).toBe("Capture");
    // Ticket 10 replaced the placeholder: capture is a real view now, so the note no longer says
    // "navigation and layout only" — it must still be present, and must describe intake.
    expect(await page.getByTestId("capture-note").textContent()).toContain("Capture a receipt");

    // DECISIONS/0017 D4: the shell must not force-load the OCR runtime on first paint.
    expect(requests.filter((url) => /\.wasm$|onnx|ort[-/.]/i.test(url))).toEqual([]);
    expect(requests.every((url) => url.startsWith(baseUrl))).toBe(true);
  });

  test("the three placeholder views are reachable by nav without a page reload", async ({ page }) => {
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await page.evaluate(() => {
      window.__noReloadToken = "kept";
    });

    await page.getByRole("link", { name: "Bill" }).click();
    expect((await shellState(page)).heading).toBe("Bill");
    await page.getByRole("link", { name: "Share" }).click();
    expect((await shellState(page)).heading).toBe("Share");
    expect((await shellState(page)).route).toBe("share");
    await page.getByRole("link", { name: "Capture" }).click();
    expect((await shellState(page)).heading).toBe("Capture");

    expect(await page.evaluate(() => window.__noReloadToken)).toBe("kept");
  });
});

test.describe("D3a condition 1 — hashchange re-renders, and the fragment stays opaque", () => {
  test("a hash change re-renders the route without a navigation", async ({ page }) => {
    await page.goto(`${baseUrl}bill#v1.test`, { waitUntil: "load" });
    await page.evaluate(() => {
      window.__noReloadToken = "kept";
    });
    const before = await shellState(page);
    expect(before.route).toBe("bill");

    await page.evaluate(() => {
      window.location.hash = "v1.other";
    });
    await page.waitForFunction(
      (renders) => Number(document.getElementById("shell-view")?.getAttribute("data-renders") ?? "0") > renders,
      before.renders,
    );

    const after = await shellState(page);
    expect(after.route).toBe("bill");
    expect(after.renders).toBeGreaterThan(before.renders);
    expect(after.fragmentLength).toBe("v1.other".length);
    expect(await currentHash(page)).toBe("#v1.other");
    // Same document: the hash change re-rendered, it did not navigate.
    expect(await page.evaluate(() => window.__noReloadToken)).toBe("kept");
  });

  test("a back navigation re-renders through popstate", async ({ page }) => {
    await page.goto(`${baseUrl}capture`, { waitUntil: "load" });
    await page.getByRole("link", { name: "Bill" }).click();
    await page.evaluate(() => {
      window.location.hash = "v1.fromback";
    });
    await page.getByRole("link", { name: "Share" }).click();
    expect((await shellState(page)).route).toBe("share");

    await page.goBack();
    const state = await shellState(page);
    expect(state.route).toBe("bill");
    expect(state.fragmentLength).toBe("v1.fromback".length);
    expect(await currentHash(page)).toBe("#v1.fromback");
  });

  test("the raw fragment is never URL-decoded and never split on a later #", async ({ page }) => {
    const raw = "v1.T3st%2FT0ken+plus~tilde#second-hash";
    await page.goto(`${baseUrl}share#${raw}`, { waitUntil: "load" });

    expect((await shellState(page)).route).toBe("share");
    expect(await currentHash(page)).toBe(`#${raw}`);
    expect(await page.getByTestId("share-fragment").getAttribute("data-raw")).toBe(raw);
  });
});

test.describe("D3a condition 3 — the fragment survives every route change", () => {
  test("/capture#v1.x -> /bill#v1.x -> /share#v1.x keeps the fragment byte-for-byte", async ({ page }) => {
    const fragment = "v1.t0keN.n0ncE.c2h0dE4tA==";
    await page.goto(`${baseUrl}capture#${fragment}`, { waitUntil: "load" });
    expect(await currentHash(page)).toBe(`#${fragment}`);
    expect((await shellState(page)).route).toBe("capture");

    await page.getByRole("link", { name: "Bill" }).click();
    await expect.poll(() => currentHash(page)).toBe(`#${fragment}`);
    expect((await shellState(page)).route).toBe("bill");
    expect((await shellState(page)).fragmentLength).toBe(fragment.length);

    await page.getByRole("link", { name: "Share" }).click();
    await expect.poll(() => currentHash(page)).toBe(`#${fragment}`);
    expect((await shellState(page)).route).toBe("share");
    expect(await page.getByTestId("share-fragment").getAttribute("data-raw")).toBe(fragment);
  });
});

test.describe("D3a condition 2 — unknown routes and fragment-bearing landings", () => {
  test("a fragment-bearing landing page is the share-link entry point", async ({ page }) => {
    const fragment = "v1.fr4gmenT0nly.n0nce.ciphertext";
    await page.goto(`${baseUrl}#${fragment}`, { waitUntil: "load" });

    const state = await shellState(page);
    expect(state.route).toBe("share");
    expect(state.heading).toBe("Share");
    expect(await page.getByTestId("share-fragment").getAttribute("data-raw")).toBe(fragment);
  });

  test("an unknown path shows not-found and keeps its fragment", async ({ page }) => {
    const requests = watchRequests(page);

    await page.goto(`${baseUrl}nonexistent#v1.keepme`, { waitUntil: "load" });
    expect((await shellState(page)).heading).toBe("Not found");
    expect(await currentHash(page)).toBe("#v1.keepme");
    expect(await page.getByTestId("notfound-fragment").textContent()).toContain("preserved");

    await page.goto(`${baseUrl}nonexistent`, { waitUntil: "load" });
    expect((await shellState(page)).heading).toBe("Not found");
    expect((await shellState(page)).fragmentLength).toBe(0);
    expect(requests.every((url) => url.startsWith(baseUrl))).toBe(true);
  });
});

test.describe("Q3 — /share with no fragment", () => {
  test("renders the placeholder, not an error, and does not crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(`${baseUrl}share`, { waitUntil: "load" });
    const state = await shellState(page);
    expect(state.route).toBe("share");
    expect(state.heading).toBe("Share");
    expect(await page.getByTestId("share-state").textContent()).toContain("No share link");
    expect(await page.getByTestId("share-placeholder").textContent()).toContain("ticket 16");
    expect(await page.getByTestId("share-fragment").count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe("shell identity", () => {
  test("the shell carries the receipt-lens title and wordmark on every route", async ({ page }) => {
    await page.goto(`${baseUrl}bill`, { waitUntil: "load" });
    await expect(page.title()).resolves.toBe("receipt-lens");
    await expect(page.locator("#shell-wordmark")).toHaveText("receipt-lens");
  });
});
