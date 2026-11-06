import { describe, expect, it } from "vitest";

import {
  ACTIVE_MODEL_CACHE,
  ACTIVE_MODEL_POINTER_PATH,
  MODEL_CACHE_PREFIX,
  readActiveModelCache,
} from "../../src/lib/models/cache-names.js";
import { activateWorker, installShellCache, readPointer } from "../../src/lib/sw/lifecycle.js";
import type { PrecacheEntry } from "../../src/precache.js";
import type { CacheStorageLike } from "../../src/lib/models/cache-names.js";

/**
 * DECISIONS/0027 W13.1 — owner Condition 1, the three lifecycle transitions.
 *
 * These are the hand-written-worker bugs: install populating something it did not declare, activate sweeping a
 * cache the lifecycle has no business touching, a pointer read that guesses. Each is asserted against an
 * injected `caches`, which is why the transitions are functions in `src/lib/sw/lifecycle.ts` rather than
 * inline event handlers. The transition that genuinely needs a browser — the two-worker controller hand-off —
 * is pinned in `playwright/offline-reload.spec.ts`, because a mocked test of a race is a test of the mock.
 */

interface Fake {
  readonly caches: CacheStorageLike;
  readonly puts: [string, string][];
  readonly deletes: string[];
  readonly fetches: string[];
  seed(cache: string, url: string, body: string): void;
}

async function fakeCaches(seed: Record<string, string> = {}): Promise<Fake> {
  const entries = new Map<string, Map<string, Response>>();
  const puts: [string, string][] = [];
  const deletes: string[] = [];
  const fetches: string[] = [];
  const ensure = (name: string) => {
    if (!entries.has(name)) entries.set(name, new Map());
    return entries.get(name)!;
  };
  for (const [key, body] of Object.entries(seed)) {
    const [, cache, url] = key.split("|");
    ensure(cache!).set(url!, new Response(body));
  }
  return {
    puts,
    deletes,
    fetches,
    seed: (cache, url, body) => void ensure(cache).set(url, new Response(body)),
    caches: {
      open: async (name: string) => {
        const store = ensure(name);
        return {
          match: async (url: string) => store.get(url)?.clone(),
          put: async (url: string, response: Response) => {
            puts.push([name, url]);
            store.set(url, response);
          },
        };
      },
      keys: async () => [...entries.keys()],
      delete: async (name: string) => {
        deletes.push(name);
        const had = entries.has(name);
        entries.delete(name);
        return had;
      },
    },
  };
}

const manifest: PrecacheEntry[] = [
  { url: "/index.html", revision: null },
  { url: "/assets/index-abc.js", revision: null },
  { url: "/assets/ort-wasm-simd-threaded-xyz.wasm", revision: null },
];

describe("W13.1 — install populates the shell cache with exactly the manifest", () => {
  it("fetches and stores every declared entry, in the shell cache named by the worker", async () => {
    const fetched: string[] = [];
    const fake = await fakeCaches();
    const spyFetch = async (url: string): Promise<Response> => {
      fetched.push(url);
      return new Response("bytes", { status: 200 });
    };

    const cached = await installShellCache({
      caches: fake.caches,
      cacheName: "receipt-lens-shell-v0123456789ab",
      manifest,
      fetch: spyFetch,
    });

    expect(fetched).toEqual(manifest.map((entry) => entry.url));
    expect(cached).toEqual(manifest.map((entry) => entry.url));
    expect(fake.puts).toEqual([
      ["receipt-lens-shell-v0123456789ab", "/index.html"],
      ["receipt-lens-shell-v0123456789ab", "/assets/index-abc.js"],
      ["receipt-lens-shell-v0123456789ab", "/assets/ort-wasm-simd-threaded-xyz.wasm"],
    ]);
  });

  it("fetches nothing the manifest did not declare", async () => {
    const fetched: string[] = [];
    const fake = await fakeCaches();
    await installShellCache({
      caches: fake.caches,
      cacheName: "receipt-lens-shell-v0123456789ab",
      manifest,
      fetch: async (url) => {
        fetched.push(url);
        return new Response("bytes", { status: 200 });
      },
    });
    expect(fetched.filter((url) => !manifest.some((entry) => entry.url === url))).toEqual([]);
  });

  it("a single failed entry rejects the install, so the browser keeps the previous worker", async () => {
    const fake = await fakeCaches();
    await expect(
      installShellCache({
        caches: fake.caches,
        cacheName: "receipt-lens-shell-v0123456789ab",
        manifest,
        fetch: async (url) => new Response("nope", { status: url.endsWith(".wasm") ? 404 : 200 }),
      }),
    ).rejects.toThrow(/DECISIONS\/0027 W13\.1/);
  });
});

describe("W13.1 / W7.2 — activate sweeps superseded shells and nothing else", () => {
  const current = "receipt-lens-shell-v0123456789ab";
  const previous = "receipt-lens-shell-vffffffffffff";
  const activeModel = `${MODEL_CACHE_PREFIX}1.0.0:bbbbbbbbbbbb`;

  it("deletes the previous shell cache", async () => {
    const fake = await fakeCaches();
    fake.seed(previous, "/index.html", "old shell");
    fake.seed(current, "/index.html", "new shell");

    const deleted = await activateWorker({ caches: fake.caches, shellCache: current });

    expect(deleted).toEqual([previous]);
    expect(fake.deletes).toEqual([previous]);
  });

  it("never deletes a model cache or the pointer cache, whatever it finds", async () => {
    const fake = await fakeCaches();
    fake.seed(previous, "/index.html", "old shell");
    fake.seed(activeModel, "/assets/models/PP-OCRv6_tiny_rec.onnx", "verified weights");
    fake.seed(`${MODEL_CACHE_PREFIX}0.9.0:aaaaaaaaaaaa`, "/assets/models/manifest.json", "older weights");
    fake.seed(ACTIVE_MODEL_CACHE, ACTIVE_MODEL_POINTER_PATH, activeModel);

    const deleted = await activateWorker({ caches: fake.caches, shellCache: current });

    expect(deleted).toEqual([previous]);
    expect(deleted.some((name) => name.startsWith(MODEL_CACHE_PREFIX))).toBe(false);
    expect(deleted).not.toContain(ACTIVE_MODEL_CACHE);
    expect(fake.deletes).not.toContain(ACTIVE_MODEL_CACHE);
  });

  it("performs zero deletions when there is no previous shell — an ordinary activate touches nothing", async () => {
    const fake = await fakeCaches();
    fake.seed(current, "/index.html", "new shell");
    fake.seed(activeModel, "/assets/models/manifest.json", "weights");

    const deleted = await activateWorker({ caches: fake.caches, shellCache: current });

    expect(deleted).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });
});

describe("W4 — the pointer the fetch handler resolves", () => {
  it("is null before anything has activated", async () => {
    const fake = await fakeCaches();
    expect(await readActiveModelCache(fake.caches)).toBeNull();
    expect(await readPointer(fake.caches)).toBeNull();
  });

  it("names the active model cache once one has been promoted", async () => {
    const fake = await fakeCaches();
    const name = `${MODEL_CACHE_PREFIX}1.0.0:cccccccccccc`;
    fake.seed(ACTIVE_MODEL_CACHE, ACTIVE_MODEL_POINTER_PATH, name);
    expect(await readPointer(fake.caches)).toBe(name);
    // Reading it twice is safe: a consumed body cannot make the second reader see nothing.
    expect(await readPointer(fake.caches)).toBe(name);
  });
});
