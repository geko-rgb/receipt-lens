/**
 * Ticket 17 — the service worker (DECISIONS/0027 W1, W4, W13.1).
 *
 * Deliberately thin, and that thinness is the ruling's argument: every decision is made elsewhere by a
 * function a test can call — the precache list and its build-time completeness guard in `src/precache.ts`, the
 * cache names in `src/lib/models/cache-names.ts`, the three lifecycle transitions in `src/lib/sw/lifecycle.ts`,
 * and "how do I answer this request" in `src/lib/sw/handling.ts`. What remains here is event plumbing, and
 * plumbing is what genuinely needs a browser, so it is checked in `offline-reload.spec.ts`.
 *
 * The worker never writes a cache (W2.2). Model bytes are written by the page's update protocol, after §9's
 * verification and smoke gate, into a cache whose name carries the provider version and the manifest hash.
 */

import { shellCacheName, type CacheStorageLike } from "./lib/models/cache-names.js";
import { decideServing } from "./lib/sw/handling.js";
import { activateWorker, installShellCache, readPointer } from "./lib/sw/lifecycle.js";
import type { PrecacheEntry } from "./precache.js";

/** The path prefix the model cache serves (W3). Kept literal here rather than derived, so a typo is visible. */
const MODEL_PATH_PREFIX = "/assets/models/";

/**
 * The token the build plugin replaces with the generated precache list, in `generateBundle`, once every other
 * asset is known. It is a declared global rather than a comment because a bundler drops comments and does not
 * drop an undeclared identifier: the emitted `sw.js` still contains this exact name, and a search that cannot
 * find it fails the build (W1.1) rather than shipping a worker with no manifest in it.
 */
declare const __RL_PRECACHE_MANIFEST__: readonly PrecacheEntry[];

const PRECACHE_MANIFEST: readonly PrecacheEntry[] = __RL_PRECACHE_MANIFEST__;

/**
 * The shell cache name is derived, not remembered. A worker is stopped and restarted between requests, so a
 * module-level `let` assigned during install would be empty on wake — and an empty cache name is a miss on
 * every precached file, which reads as "the offline reload stopped working" hours after anything changed.
 */
const shellCache: Promise<string> = shellCacheName(PRECACHE_MANIFEST);

interface SwLifecycleEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

const scope = globalThis as unknown as {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorageLike;
  addEventListener(type: "install" | "activate", listener: (event: SwLifecycleEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: SwFetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
};

scope.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await installShellCache({
        caches: scope.caches,
        cacheName: await shellCache,
        manifest: PRECACHE_MANIFEST,
        // `reload` so a precache is never served from the very HTTP cache whose per-entity limit made this
        // ticket necessary (DECISIONS/0012 F12).
        fetch: (input) => fetch(input, { cache: "reload" }),
      });
      // W13: take over as soon as the new shell is whole. The race that creates is pinned in Chromium, not
      // here — a mocked test of a race is a test of the mock (W13 item 3).
      await scope.skipWaiting();
    })(),
  );
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await activateWorker({ caches: scope.caches, shellCache: await shellCache });
      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(serve(event.request));
});

/** Resolve the pointer and the cache contents, ask `decideServing`, perform exactly what it says. */
async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name = await shellCache;
  const action = await decideServing(
    { url: request.url, method: request.method, mode: request.mode, cache: request.cache },
    {
      sameOrigin: url.origin === scope.location.origin,
      shellCache: name,
      activeModelCache: await readPointer(scope.caches),
      shellHas: async (path) => Boolean(await (await scope.caches.open(name)).match(path)),
      modelHas: async (cacheName, path) => Boolean(await (await scope.caches.open(cacheName)).match(path)),
      isModelAsset: (path) => path.startsWith(MODEL_PATH_PREFIX),
    },
  );

  switch (action.kind) {
    case "serve-shell":
    case "serve-shell-navigation-fallback": {
      const hit = await (await scope.caches.open(name)).match(action.url);
      // A miss here, after the predicate said the entry existed, means the cache changed underneath the
      // request. Ask the origin rather than invent a response, and never answer a subresource with HTML.
      return hit ?? (await fetch(request));
    }
    case "serve-model": {
      const hit = await (await scope.caches.open(action.cacheName)).match(action.url);
      return hit ?? (await fetch(request));
    }
    case "network":
      return await fetch(request);
  }
}
