/**
 * DECISIONS/0029 P1–P3 — the conditional-request policy, in one place.
 *
 * This module is imported by **both** servers' request handlers (`scripts/serve-app.mjs` and
 * `scripts/serve-measure-app.mjs`) and by the pins in `benchmarks/tests/footprint/etag-pins.test.ts`. That is
 * deliberate and it is the whole reason the file exists: P2's split is a published claim about the deployment,
 * so a second definition of it would let the shipping origin and the measured origin drift while a parity test
 * dutifully compared two implementations of different policies and passed.
 *
 * The layering looks backwards — a repo-root dev server importing a workspace build output — and the
 * alternative is worse. `packages/pwa/dist/app` is already produced by `pnpm build`, every e2e spec already
 * requires that, and the servers refuse to start without it.
 *
 * Two rules the pins hold:
 * - **the validator value never comes from filesystem metadata.** size and mtime may key a memo; they may not
 *   be the digest. `harness/serve.mjs` uses `"size-mtime"` and is *correct*, but not deterministic across a
 *   rebuild that touched nothing, and `verify:footprint`'s job is re-derivation from committed inputs.
 * - **a `no-store` response advertises no validator.** Emitting an `ETag` the client is forbidden to use would
 *   be a header that lies about the contract.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

export type CacheMode = "revalidate" | "no-store";

export interface CachePolicy {
  readonly mode: CacheMode;
  readonly group: string;
  readonly reason: string;
}

/**
 * Bulk binaries: already resident in the worker's Cache API, so an HTTP-cache copy would be a second copy the
 * worker never consults — and a stale-weights path that bypasses DECISIONS/0027 W5's verified-before-activate
 * protocol. Ruled at checkpoint 1, 2026-11-06 (0029 P2).
 */
const BULK: readonly { readonly pattern: RegExp; readonly group: string }[] = [
  { pattern: /^\/assets\/models\/[^/]+\.onnx$/, group: "model weights" },
  { pattern: /^\/assets\/models\/[^/]+\.txt$/, group: "recognition dictionary" },
  { pattern: /^\/assets\/ort-wasm-simd-threaded-[\w-]+\.wasm$/, group: "inference runtime WASM" },
];

/**
 * The SPA shell and its route fallbacks. Excluded because on a warm visit the document is answered by the
 * worker's navigation fallback (`SHELL_NAVIGATION_FALLBACK`, DECISIONS/0027 W4.1), so it costs no origin
 * request to revalidate, and because "always revalidate the shell" is what the update-prompt story assumes.
 */
const DOCUMENT: readonly RegExp[] = [/^\/index\.html$/, /^\/(capture|bill|bills|share|)$/];

/** Everything else the origin serves is code or app metadata, and revalidates. */
export function cachePolicyFor(pathname: string): CachePolicy {
  const bulk = BULK.find((entry) => entry.pattern.test(pathname));
  if (bulk !== undefined) {
    return {
      mode: "no-store",
      group: bulk.group,
      reason: "held by the worker's Cache API; an HTTP-cache copy would be a second copy and a staleness path",
    };
  }
  if (DOCUMENT.some((pattern) => pattern.test(pathname))) {
    return {
      mode: "no-store",
      group: "app shell and route fallbacks",
      reason: "answered by the worker's navigation fallback on a warm visit, and the update story assumes a fresh shell",
    };
  }
  return {
    mode: "revalidate",
    group: "code and app metadata",
    reason: "small, static, and worth 0 bytes on a warm visit if the browser already holds a copy to revalidate",
  };
}

/**
 * The digest, memoised by `(absolute path, size, mtimeMs)`.
 *
 * Hashing the 242 KB entry chunk on every request is cheap; hashing anything larger is unnecessary, because the
 * only paths that reach this function are the ones P2 put in the `revalidate` group — and the WASM and model
 * weights are excluded above it. The memo key may use metadata; the returned value never does, and two files
 * with identical bytes always agree, which is what the determinism pin checks.
 *
 * `mtimeMs` belongs in the key for correctness, not tidiness: a rebuild can emit a different file of the same
 * size at the same path, and a key of `(path, size)` would then serve last build's validator — which is a `304`
 * for bytes the client no longer has.
 */
const memo = new Map<string, string>();

export function etagFor(absolutePath: string, body: Uint8Array): string {
  let key = `${absolutePath}|body`;
  try {
    const info = statSync(absolutePath);
    key = `${absolutePath}|${info.size}|${Math.round(info.mtimeMs)}`;
  } catch {
    // No file to key against (a synthetic body in a test, say): skip the memo rather than guess.
    return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  }
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const digest = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  memo.set(key, digest);
  return digest;
}

/** Response headers for a `revalidate` asset's `200`. */
export function revalidateHeaders(etag: string, contentLength: number, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-cache",
    etag,
    "content-length": String(contentLength),
  };
}

/** Response headers for an asset P2 keeps out of the HTTP cache entirely. */
export function noStoreHeaders(contentLength: number, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": String(contentLength),
  };
}

/** `If-None-Match` is a strong comparison here: no weak validators, no list parsing, no `Last-Modified`. */
export function shouldNotModify(ifNoneMatch: string | undefined, etag: string): boolean {
  return ifNoneMatch === etag;
}

/** Headers on a `304`: the validator, the policy, and nothing that implies a body. */
export function notModifiedHeaders(etag: string): Record<string, string> {
  return { "cache-control": "no-cache", etag };
}
