/**
 * Ticket 17 — the origin that `playwright/offline-reload.spec.ts` and the footprint re-measurement run
 * against (DECISIONS/0027 W14, W17).
 *
 * It is `scripts/serve-app.mjs` plus the three things a *test* of a service worker needs and a shipping
 * server must not have:
 *
 *   - a writable model manifest. W5's update protocol cannot be exercised without a second model set, and the
 *     committed `assets/models/manifest.json` must never be edited to make a test pass. The override is a file
 *     in `overridesDir`; the real assets stay where they are, so the bytes a smoke run loads are the real
 *     weights and only the declared version and hashes move.
 *   - a writable `/sw.js`, for the same reason: W13's controller race needs a *second* worker, and the build
 *     cannot emit two.
 *   - a request log. `DECISIONS/0012` F5 counts bytes at the origin that served them, and the offline tests
 *     assert that nothing reached this origin after the block — which needs the origin's own record rather
 *     than a page's view of it.
 *
 * Everything else is the shipping server's behaviour: same MIME table, same app-route fallback, and the same
 * `cache-control: no-store`, because W8 measured that no-store does not obstruct a Cache API precache.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

const APP_ROUTES = ["/", "/capture", "/bill", "/bills", "/share"];

/**
 * @typedef {{ id: number, path: string, status: number, bodyBytes: number, completed: boolean, etag: string | null }} OriginEntry
 *
 * @param {{ overridesDir?: string | null, appDir?: string }} [options]
 *   `overridesDir` is consulted before the real tree for `/assets/models/*` and `/sw.js`, and its `offline`
 *   file is the offline switch. `appDir` defaults to `packages/pwa/dist/app`.
 */
export function startMeasureServer({ overridesDir = null, appDir = path.join(repoRoot, "packages/pwa", "dist/app") } = {}) {
  if (!existsSync(path.join(appDir, "index.html"))) {
    throw new Error("missing packages/pwa/dist/app/index.html — run `pnpm build` first");
  }

  const policyFile = path.join(repoRoot, "benchmarks", "dist", "footprint", "etag-policy.js");
  if (!existsSync(policyFile)) {
    throw new Error("missing benchmarks/dist/footprint/etag-policy.js — run `pnpm build`. The measurement origin and the shipping origin must answer conditional requests identically or the published warm number describes neither (DECISIONS/0029 P2).");
  }

  const child = spawn(
    process.execPath,
    [
      "-e",
      `
      const http = require("node:http");
      const fs = require("node:fs");
      const path = require("node:path");
      const appDir = ${JSON.stringify(appDir)};
      const modelDir = ${JSON.stringify(path.join(repoRoot, "assets", "models"))};
      const overrides = ${JSON.stringify(overridesDir)};
      const routes = ${JSON.stringify(APP_ROUTES)};
      const mime = ${JSON.stringify(MIME)};
      const policy = require(${JSON.stringify(policyFile)});
      const requests = [];
  /** Every request the origin refused while offline, including ones a worker forwarded. */
  const attempted = [];
  /** Monotonic id so a *finished* response can be marked complete in the parent's log (DECISIONS/0012 F9.7). */
  let nextId = 0;
      const pick = (dir, name) => {
        if (!dir) return null;
        const file = path.join(dir, name);
        return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
      };
      const http404 = (res, name) => {
        const id = log(name, 404, 0);
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("not found: " + name, () => finish(id));
      };
      const offlineMarker = overrides ? path.join(overrides, "offline") : null;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        const name = decodeURIComponent(url.pathname);
        // The offline switch is the origin destroying the socket, not a test-side route abort. Playwright's
        // context.route does not reliably observe a fetch a service worker initiated (DECISIONS/0027 W8
        // measured it firing zero times on a cache-served reload), and PROJECT(1).md §9 M3.4 says that
        // coverage is browser-dependent. A refused connection is not version-dependent: it is what offline is.
        if (offlineMarker && fs.existsSync(offlineMarker)) {
          process.stdout.write("hit " + JSON.stringify({ path: name, outcome: "refused" }) + "\\n");
          return res.destroy();
        }
        let file = null;
        if (name.startsWith("/assets/models/")) {
          const leaf = name.slice("/assets/models/".length);
          file = pick(overrides, leaf) ?? pick(modelDir, leaf);
        } else if (name === "/sw.js" && overrides) {
          file = pick(overrides, "sw.js") ?? path.join(appDir, "sw.js");
        } else if (routes.includes(name)) {
          file = path.join(appDir, "index.html");
        } else {
          file = pick(appDir, name);
        }
        if (!file && /\\.(js|mjs|css|wasm|webmanifest|json|png)$/.test(name)) return http404(res, name);
        if (!file) file = path.join(appDir, "index.html");
        if (!fs.existsSync(file)) return http404(res, name);
        const body = fs.readFileSync(file);
        const type = mime[path.extname(file)] ?? "application/octet-stream";
        const mode = policy.cachePolicyFor(name).mode;
        // Same module, same answers as the shipping origin. The 304 below is logged with 0 body bytes and is
        // marked complete from the end callback like every other response: F9.7 must not read a working
        // conditional as an interrupted download (DECISIONS/0029 P3).
        if (mode === "revalidate") {
          const etag = policy.etagFor(file, new Uint8Array(body));
          if (policy.shouldNotModify(req.headers["if-none-match"], etag)) {
            const notId = log(name, 304, 0, etag);
            res.writeHead(304, policy.notModifiedHeaders(etag));
            return res.end(() => finish(notId));
          }
          const id = log(name, 200, body.byteLength, etag);
          res.writeHead(200, policy.revalidateHeaders(etag, body.byteLength, type));
          return res.end(body, () => finish(id));
        }
        const id = log(name, 200, body.byteLength);
        res.writeHead(200, policy.noStoreHeaders(body.byteLength, type));
        res.end(body, () => finish(id));
      });
      function log(name, status, bodyBytes, etag) {
        const id = nextId++;
        // The validator travels with the entry (DECISIONS/0029 P7): a published "revalidated" state is only
        // evidence if a reader can tie it to the response that earned it.
        const record = { id, path: name, status, bodyBytes, completed: false, etag: etag ?? null };
        requests.push(record);
        process.stdout.write("req " + JSON.stringify(record) + "\\n");
        return id;
      }
      function finish(id) {
        const record = requests.find((entry) => entry.id === id);
        if (record) record.completed = true;
        process.stdout.write("done " + JSON.stringify({ id }) + "\\n");
      }
      server.listen(0, "127.0.0.1", () => process.stdout.write("url: http://127.0.0.1:" + server.address().port + "/\\n"));
      `,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  /** Every response the origin served, in order — F5 counts bytes at the origin that served them. */
  const requests = [];
  /** Every request the origin refused while the offline marker existed, including worker-forwarded ones. */
  const attempted = [];

  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("measure server printed no URL within 20s")), 20_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        const address = line.match(/url: (http:\/\/127\.0\.0\.1:\d+\/)/);
        if (address) {
          clearTimeout(timer);
          resolve(address[1]);
          continue;
        }
        const request = line.match(/^req (.+)$/);
        if (request) requests.push(JSON.parse(request[1]));
        const done = line.match(/^done (.+)$/);
        if (done) {
          const { id } = JSON.parse(done[1]);
          const record = requests.find((entry) => entry.id === id);
          if (record) record.completed = true;
        }
        const hit = line.match(/^hit (.+)$/);
        if (hit) attempted.push(JSON.parse(hit[1]));
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`measure server exited (${code})`));
    });
  });

  return {
    url,
    requests,
    /** Requests the origin answered since the last reset — the offline assertion's source of truth. */
    since: () => requests.slice(),
    refused: () => attempted.slice(),
    reset: () => {
      requests.splice(0, requests.length);
      attempted.splice(0, attempted.length);
    },
    totalBytes: () => requests.reduce((sum, entry) => sum + entry.bodyBytes, 0),
    close: () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
}
