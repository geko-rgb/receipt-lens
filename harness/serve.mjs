/**
 * Minimal static server for the OCR harness.
 *
 * Serves the page, its bundle, the self-hosted model assets and the
 * onnxruntime-web WASM artifacts from the app's own origin — never a third-party CDN
 * (PROJECT(1).md §9). COOP/COEP are set so the shared-memory WASM build can use more
 * than one thread; without them ORT silently falls back to a single thread.
 *
 * `cacheMode` selects the caching contract, and nothing else changes:
 *   "no-store"  (default) `cache-control: no-store`, every request re-downloads.
 *   "validate"  ETag + `cache-control: no-cache`, so a warm browser revalidates and
 *               gets a 304 with no body. Ticket 08 needs a cache that can get warm;
 *               revalidation is the only correct policy for asset names that are not
 *               yet content-hashed (content-hashed names + the service-worker model
 *               cache are §9/ticket 17 work, and are not what is measured here).
 * Every request is appended to `server.requests` so measured download bytes come from
 * the origin that served them, not from what one page was able to observe — WebAssembly
 * and worker loads are requested outside the page's own resource timings.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
// onnxruntime-web is a dependency of packages/core, so resolve it from there.
const coreRequire = createRequire(path.join(repoRoot, "packages/core/package.json"));
const ortDist = path.dirname(coreRequire.resolve("onnxruntime-web/wasm"));

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".onnx", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

function resolveFile(urlPath) {
  const decoded = decodeURIComponent((urlPath ?? "/").split("?")[0]);
  if (decoded === "/" || decoded === "/index.html") return path.join(repoRoot, "harness/index.html");

  // `/dist/` and `/assets/models/` mirror real repo paths, so the URL path is kept.
  // `/ort/` maps onto onnxruntime-web's dist directory, so the mount prefix is stripped.
  const routes = [
    ["/dist/", path.join(repoRoot, "harness"), decoded],
    ["/assets/models/", repoRoot, decoded],
    ["/ort/", ortDist, decoded.slice("/ort/".length)],
  ];
  for (const [prefix, root, relative] of routes) {
    if (!decoded.startsWith(prefix)) continue;
    const normalised = path.normalize(path.join(root, relative));
    if (!normalised.startsWith(path.normalize(root) + path.sep)) return null;
    return normalised;
  }
  return null;
}

export async function startServer(port = 0, options = {}) {
  const cacheMode = options.cacheMode ?? "no-store";
  if (cacheMode !== "no-store" && cacheMode !== "validate") {
    throw new Error(`unknown cacheMode ${cacheMode}`);
  }
  /** @type {{method: string, url: string, status: number, bodyBytes: number, fromCache: boolean, completed: boolean}[]} */
  const requests = [];
  const isolation = {
    // Enables SharedArrayBuffer for the multi-threaded WASM build.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  };

  const server = createServer(async (request, response) => {
    const entry = {
      method: request.method ?? "?",
      url: request.url ?? "/",
      status: 0,
      bodyBytes: 0,
      fromCache: false,
      completed: false,
    };
    requests.push(entry);
    if (request.headers.range) entry.range = request.headers.range;
    // writableFinished is only true once the whole body reached the socket, so an
    // interrupted download cannot be mistaken for a completed one in the byte totals.
    response.on("finish", () => {
      entry.completed = response.writableFinished === true;
    });

    const file = resolveFile(request.url);
    let info = null;
    if (file) {
      info = await stat(file).catch(() => null);
    }
    if (!info || !info.isFile()) {
      entry.status = 404;
      response.writeHead(404).end("not found");
      return;
    }

    const headers = {
      "content-type": MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
      ...isolation,
    };
    if (cacheMode === "no-store") {
      entry.status = 200;
      entry.bodyBytes = info.size;
      response.writeHead(200, { ...headers, "content-length": info.size, "cache-control": "no-store" });
      createReadStream(file).pipe(response);
      return;
    }

    const etag = `"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
    if (request.headers["if-none-match"] === etag) {
      entry.status = 304;
      entry.fromCache = true;
      response.writeHead(304, { etag, "cache-control": "no-cache", ...isolation });
      response.end();
      return;
    }
    entry.status = 200;
    entry.bodyBytes = info.size;
    response.writeHead(200, { ...headers, "content-length": info.size, "cache-control": "no-cache", etag });
    createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}/`,
    cacheMode,
    /** Live request log; the same array the handler above appends to. */
    requests,
    async close() {
      // Chromium's network service keeps HTTP/1.1 connections alive past context teardown,
      // and server.close() only resolves once every socket is gone — without this, a driver
      // that starts one server per measurement sample hangs on the first shutdown.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = await startServer(Number(process.env.PORT ?? 5178), {
    cacheMode: process.env.CACHE_MODE ?? "no-store",
  });
  process.stdout.write(`harness: ${server.url} (cache ${server.cacheMode})\n`);
}
