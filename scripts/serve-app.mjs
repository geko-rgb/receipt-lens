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
 * Starts the server on an ephemeral port. `withRig` is false by default: the shipped-app tests must not be
 * able to reach the rig accidentally, and the ones that need it ask for it.
 */
export function startServer({ withRig = false } = {}) {
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
        if (!file) file = path.join(appDir, "index.html");
        res.writeHead(200, {
          "content-type": mime[path.extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        fs.createReadStream(file).pipe(res);
      });
      server.listen(0, "127.0.0.1", () => process.stdout.write("url: http://127.0.0.1:" + server.address().port + "/\\n"));
      `,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = new Promise((resolve, reject) => {
    // NO_COLOR: vite-style banners colourise the port and the digits arrive wrapped in escape codes
    // (DECISIONS/0017, ticket 10a's note 4). This server does not print one, but the reason the guard
    // exists is the failure it prevents, and it costs nothing to keep.
    const timer = setTimeout(() => reject(new Error("app server printed no URL within 20s")), 20_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      const match = chunk.match(/url: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app server exited (${code})`));
    });
  });

  return { url, close: () => child.kill("SIGTERM") };
}
