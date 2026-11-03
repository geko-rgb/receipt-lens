/**
 * Minimal static server for the OCR harness.
 *
 * Serves the page, its bundle, the self-hosted model assets and the
 * onnxruntime-web WASM artifacts from the app's own origin — never a third-party CDN
 * (PROJECT(1).md §9). COOP/COEP are set so the shared-memory WASM build can use more
 * than one thread; without them ORT silently falls back to a single thread.
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

export async function startServer(port = 0) {
  const server = createServer(async (request, response) => {
    const file = resolveFile(request.url);
    if (!file) {
      response.writeHead(404).end("not found");
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      response.writeHead(404).end("not found");
      return;
    }
    if (!info.isFile()) {
      response.writeHead(404).end("not found");
      return;
    }

    response.writeHead(200, {
      "content-type": MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
      // Enables SharedArrayBuffer for the multi-threaded WASM build.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}/`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = await startServer(Number(process.env.PORT ?? 5178));
  process.stdout.write(`harness: ${server.url}\n`);
}
