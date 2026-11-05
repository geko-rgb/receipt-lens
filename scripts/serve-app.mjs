/**
 * Ticket 14 — the one app server.
 *
 * `playwright/app-server.ts` has carried this since ticket 11 ("existing specs grew their own copy of this;
 * this module so the server is defined once"), and ticket 14 adds a second consumer: `scripts/storage-fixtures.mjs`,
 * which drives the built app in Chromium to produce the committed migration fixtures and cannot import a `.ts`
 * file from plain Node. So the implementation moves here and the TypeScript module becomes a typed facade.
 *
 * Served, all same-origin on a loopback port (§9: no third party, no CDN):
 *   - the built app (`packages/pwa/dist/app`), with every app route falling back to `index.html` so a deep
 *     link works without a server rewrite;
 *   - the repository's model assets at `/assets/models/*`;
 *   - the migration rig at `/rig/*` (`playwright/rig/dist`), which is *not* inside the app bundle — that
 *     separation is what `smoke.spec.ts` asserts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "packages/pwa", "dist/app");
const rigDir = path.join(repoRoot, "packages/pwa", "rig", "dist");
const modelDir = path.join(repoRoot, "assets", "models");

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

/** Every app route falls back to `index.html`, so a deep link works without a server rewrite. */
const APP_ROUTES = ["/", "/capture", "/bill", "/bills", "/share"];

/**
 * Ticket 17 additions, both opt-in so every existing caller sees byte-identical behaviour:
 *
 * - `recordRequests` collects `{ path, status, bodyBytes }` per response and exposes them on the handle.
 *   `DECISIONS/0012` F5 requires bytes to be counted by the origin that served them, not by page resource
 *   timings, and the footprint measurement now points at *this* deployment — so this server needs the log
 *   `harness/serve.mjs` already had (W17 item 1).
 * - an unknown path ending in a code-ish extension answers `404` instead of falling back to `index.html`.
 *   A missing `/sw.js` served as HTML fails worker registration with a message naming nothing useful, and the
 *   catch-all made that failure silent (W17 item 2). `cache-control: no-store` stays exactly as it was: W8
 *   measured that it does not obstruct a Cache-API precache, and changing a shipping server's headers to make
 *   a measurement look better is the kind of fix `DECISIONS/0012` F12 warns against.
 */
export function startServer({ withRig = false, recordRequests = false } = {}) {
  if (!existsSync(path.join(appDir, "index.html"))) {
    throw new Error("missing packages/pwa/dist/app/index.html — run `pnpm build` first");
  }
  if (withRig && !existsSync(path.join(rigDir, "rig.html"))) {
    throw new Error("missing packages/pwa/rig/dist/rig.html — run `pnpm build:rig` first");
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
      const modelDir = ${JSON.stringify(modelDir)};
      const rigDir = ${JSON.stringify(withRig ? rigDir : null)};
      const routes = ${JSON.stringify(APP_ROUTES)};
      const mime = ${JSON.stringify(MIME)};
      const record = ${JSON.stringify(recordRequests)};
      const CODE_LIKE = /\\.(js|mjs|css|wasm|webmanifest|json|png)$/;
      const pick = (dir, name) => {
        const file = path.join(dir, name);
        return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
      };
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        const name = decodeURIComponent(url.pathname);
        let file = null;
        if (name.startsWith("/assets/models/")) {
          file = pick(modelDir, name.slice("/assets/models/".length));
        } else if (rigDir && (name === "/rig" || name.startsWith("/rig/"))) {
          file = pick(rigDir, name.slice("/rig/".length) || "rig.html");
          if (!file) file = path.join(rigDir, "rig.html");
        } else if (routes.includes(name)) {
          file = path.join(appDir, "index.html");
        } else {
          file = pick(appDir, name);
        }
        if (!file && CODE_LIKE.test(name)) {
          log(name, 404, 0);
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          return res.end("not found: " + name);
        }
        if (!file) file = path.join(appDir, "index.html");
        const body = fs.readFileSync(file);
        log(name, 200, body.byteLength);
        res.writeHead(200, {
          "content-type": mime[path.extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "content-length": body.byteLength,
        });
        res.end(body);
      });
      function log(name, status, bodyBytes) {
        if (record) process.stdout.write("req " + JSON.stringify({ path: name, status, bodyBytes }) + "\\n");
      }
      server.listen(0, "127.0.0.1", () => process.stdout.write("url: http://127.0.0.1:" + server.address().port + "/\\n"));
      `,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  /** Every response the origin served, in order. Only populated with `recordRequests`, hence always present. */
  const requests = [];

  const url = new Promise((resolve, reject) => {
    // NO_COLOR: vite-style banners colourise the port and the digits arrive wrapped in escape codes
    // (DECISIONS/0017, ticket 10a's note 4). This server does not print one, but the reason the guard
    // exists is the failure it prevents, and it costs nothing to keep.
    const timer = setTimeout(() => reject(new Error("app server printed no URL within 20s")), 20_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        const match = line.match(/url: (http:\/\/127\.0\.0\.1:\d+\/)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
          continue;
        }
        const request = line.match(/^req (.+)$/);
        if (request) requests.push(JSON.parse(request[1]));
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app server exited (${code})`));
    });
  });

  return {
    url,
    requests,
    close: () => child.kill("SIGTERM"),
    /** Total response body bytes the origin moved. F5's "whose byte count", for the footprint measurement. */
    bytes: () => requests.reduce((sum, entry) => sum + entry.bodyBytes, 0),
    reset: () => requests.splice(0, requests.length),
  };
}
