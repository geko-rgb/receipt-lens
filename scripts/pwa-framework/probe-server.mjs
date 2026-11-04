/**
 * Static server for the 10a framework probe, modelled on harness/serve.mjs.
 *
 * Differences from the harness server, both of them the point of the exercise:
 *   - it serves a built app directory (--root) rather than the harness page, and
 *   - it can either answer unknown paths with index.html (--fallback) or 404 them,
 *     which is what separates history routing from hash routing on a static host.
 *
 * COOP/COEP are set so the threaded WASM build gets SharedArrayBuffer, exactly as the
 * harness does; without them ORT silently falls back to one thread.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const probeDir = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(probeDir, "../..");
const coreRequire = createRequire(path.join(repoRoot, "packages/core/package.json"));
const ortDist = path.dirname(coreRequire.resolve("onnxruntime-web/wasm"));

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".jsx", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".wasm", "application/wasm"],
  [".onnx", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
]);

export function startProbeServer(options) {
  const root = path.resolve(options.root);
  const fallback = options.fallback === true;
  const sampleImage = options.sampleImage ?? path.join(repoRoot, "benchmarks/datasets/raw/sroie/assets/ex.jpg");

  const requests = [];
  const isolation = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  };

  function resolveFile(urlPath) {
    const decoded = decodeURIComponent((urlPath ?? "/").split("?")[0]);
    if (decoded === "/sample.jpg") return sampleImage;
    const mounts = [
      ["/assets/models/", repoRoot, decoded],
      ["/ort/", ortDist, decoded.slice("/ort/".length)],
    ];
    for (const [prefix, base, relative] of mounts) {
      if (!decoded.startsWith(prefix)) continue;
      const normalised = path.normalize(path.join(base, relative));
      if (!normalised.startsWith(path.normalize(base) + path.sep)) return null;
      return normalised;
    }
    const normalised = path.normalize(path.join(root, decoded));
    if (!normalised.startsWith(root)) return null;
    return { file: normalised, fallback };
  }

  const server = createServer(async (request, response) => {
    const entry = { method: request.method ?? "?", url: request.url ?? "/", status: 0, bodyBytes: 0, completed: false };
    requests.push(entry);
    response.on("finish", () => {
      entry.completed = response.writableFinished === true;
    });

    let target = resolveFile(request.url);
    let viaFallback = false;
    if (target && typeof target === "object" && target.file) {
      const info = await stat(target.file).catch(() => null);
      if ((!info || !info.isFile()) && target.fallback) {
        target = { file: path.join(root, "index.html") };
        viaFallback = true;
        entry.fallback = true;
      }
    } else if (typeof target === "string") {
      const info = await stat(target).catch(() => null);
      target = info && info.isFile() ? { file: target } : null;
    } else {
      target = null;
    }

    if (!target) {
      entry.status = 404;
      response.writeHead(404).end("not found");
      return;
    }

    const info = await stat(target.file).catch(() => null);
    if (!info || !info.isFile()) {
      entry.status = 404;
      response.writeHead(404).end("not found");
      return;
    }
    const type = MIME.get(path.extname(target.file).toLowerCase()) ?? "application/octet-stream";
    entry.status = 200;
    entry.bodyBytes = info.size;
    entry.contentType = type;
    if (viaFallback) entry.spaFallback = true;
    response.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": "no-store", ...isolation });
    createReadStream(target.file).pipe(response);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        requests,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1];
  };
  const server = await startProbeServer({ root: valueOf("--root") || "apps/svelte/dist/bare-hash", fallback: args.includes("--fallback") });
  process.stdout.write(`probe server: ${server.url}\n`);
}
