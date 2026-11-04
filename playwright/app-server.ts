import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built shell plus this repository's model assets, served same-origin on a loopback port (§9: no third
 * party, no CDN). Existing specs grew their own copy of this; `bill-editor.spec.ts` uses this module so the
 * server is defined once, and the older specs can move onto it without ticket 11 editing them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "packages/pwa", "dist/app");
const modelDir = path.join(repoRoot, "assets", "models");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Every app route falls back to `index.html`, so a deep link works without a server rewrite. */
const APP_ROUTES = ["/", "/capture", "/bill", "/share"];

export interface AppServer {
  readonly url: string;
  close(): void;
}

export async function startAppServer(): Promise<AppServer> {
  if (!existsSync(path.join(appDir, "index.html"))) {
    throw new Error("missing packages/pwa/dist/app/index.html — run `pnpm build` before Playwright");
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
      const routes = ${JSON.stringify(APP_ROUTES)};
      const mime = ${JSON.stringify(MIME)};
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        let file;
        if (url.pathname.startsWith("/assets/models/")) {
          file = path.join(modelDir, url.pathname.slice("/assets/models/".length));
        } else if (routes.includes(url.pathname)) {
          file = path.join(appDir, "index.html");
        } else {
          file = path.join(appDir, url.pathname);
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(appDir, "index.html");
        res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        fs.createReadStream(file).pipe(res);
      });
      server.listen(0, "127.0.0.1", () => process.stdout.write("url: http://127.0.0.1:" + server.address().port + "/\\n"));
      `,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("app server printed no URL within 20s")), 20_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const match = chunk.match(/url: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app server exited (${code})`));
    });
  });

  return { url, close: () => child.kill("SIGTERM") };
}
