import type { PrecacheEntry } from "../../precache.js";
import { readActiveModelCache, supersededShellCaches, type CacheStorageLike } from "../models/cache-names.js";

/**
 * Ticket 17 — the worker's three lifecycle transitions, as functions (DECISIONS/0027 W13.1, owner Condition 1).
 *
 * `src/sw.ts` wires these to real events and does nothing else. That split exists because hand-written worker
 * bugs live in the transitions, and a transition you cannot call cannot be pinned: each function below takes
 * an injected `caches` and `fetch`, so `tests/sw/lifecycle.test.ts` asserts install-populates-exactly,
 * activate-deletes-nothing-of-the-model-kind, and fetch-hits-or-falls-through without booting a browser. The
 * one transition that genuinely needs Chromium — the two-worker controller hand-off — is pinned there instead,
 * in `offline-reload.spec.ts`, because a mocked test of a race is a test of the mock (W13 item 3).
 */

export interface InstallDeps {
  readonly caches: CacheStorageLike;
  readonly cacheName: string;
  readonly manifest: readonly PrecacheEntry[];
  readonly fetch: (url: string) => Promise<Response>;
}

/**
 * Populate the shell cache with **exactly** the precache manifest, nothing more (W13.1).
 *
 * Any single failure rejects, so `install` fails and the browser keeps the previous worker rather than
 * activating a half-populated one: an install that swallows a 404 is how a deployment ends up "installed" with
 * no runtime WASM in it, which is precisely the silent drop the W1.1 completeness guard exists to prevent.
 */
export async function installShellCache(deps: InstallDeps): Promise<readonly string[]> {
  const cache = await deps.caches.open(deps.cacheName);
  const cached: string[] = [];
  for (const entry of deps.manifest) {
    const response = await deps.fetch(entry.url);
    if (!response.ok) {
      throw new Error(`DECISIONS/0027 W13.1: precache of ${entry.url} answered ${response.status}, so install fails`);
    }
    await cache.put(entry.url, response);
    cached.push(entry.url);
  }
  if (cached.length !== deps.manifest.length) {
    throw new Error(`DECISIONS/0027 W13.1: installed ${cached.length} of ${deps.manifest.length} precache entries`);
  }
  return cached;
}

export interface ActivateDeps {
  readonly caches: CacheStorageLike;
  readonly shellCache: string;
}

/**
 * The activate sweep: superseded **shell** caches only, and zero deletions when there is no previous shell
 * (W7.2, W13.1). Model caches are never a target here — only the page's step 7 knows whether a candidate is
 * still being verified, and an activate that swept them would delete a working set out from under a running
 * preparation. The pointer cache is never returned by `supersededShellCaches` either.
 */
export async function activateWorker(deps: ActivateDeps): Promise<readonly string[]> {
  const names = await deps.caches.keys();
  const targets = supersededShellCaches(names, deps.shellCache);
  for (const name of targets) await deps.caches.delete(name);
  return targets;
}

/** The pointer at read time, so a request is answered from the set that was active when it arrived (W4). */
export const readPointer = (caches: CacheStorageLike): Promise<string | null> => readActiveModelCache(caches);
