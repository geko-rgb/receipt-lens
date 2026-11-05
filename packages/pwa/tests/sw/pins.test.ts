import { describe, expect, it } from "vitest";

import {
  ACTIVE_MODEL_CACHE,
  ACTIVE_MODEL_POINTER_PATH,
  MODEL_CACHE_PREFIX,
  SHELL_CACHE_PREFIX,
  SHELL_NAVIGATION_FALLBACK,
  canonicalPrecacheDigest,
  canonicalPrecacheSerialisation,
  isModelCache,
  isShellCache,
  modelCacheName,
  shellCacheName,
  type CacheStorageLike,
  supersededModelCaches,
  supersededShellCaches,
} from "../../src/lib/models/cache-names.js";
import { SMOKE_MIN_LINES, SMOKE_MIN_WORDS, acceptsSmokeResult } from "../../src/lib/models/smoke.js";
import { shouldPrepareModelSet } from "../../src/lib/models/trigger.js";
import {
  modelPreparingCopy,
  modelUpdateCopy,
  prepareModelSet,
  type PrepareModelSetDeps,
} from "../../src/lib/models/update.js";
import { decideServing, type ServedRequest, type ServingAction, type ServingState } from "../../src/lib/sw/handling.js";
import {
  INSTALL_BANNER_MS,
  INSTALL_BANNER_STORAGE_KEY,
  INSTALL_BANNER_SUPPRESS_DAYS,
  consumeInstallPrompt,
  dismissInstallBanner,
  installBannerCopy,
  shouldShowInstallBanner,
  type BannerStorage,
} from "../../src/lib/sw/install-banner.js";
import { MANIFEST_ICON_PATHS, appManifest } from "../../src/lib/sw/manifest.js";
import { SW_SCOPE, SW_SCRIPT_URL, registerServiceWorker } from "../../src/lib/sw/registration.js";
import {
  PRECACHE_PLACEHOLDER,
  assertNoModelAssets,
  assertPrecacheComplete,
  buildPrecacheEntries,
  isPrecacheExcluded,
  precacheExclusions,
  type PrecacheEntry,
} from "../../src/precache.js";

/**
 * DECISIONS/0027 — the service worker, the model cache and installability, as assertions.
 *
 * Every rule-carrying function under test throws `not implemented: DECISIONS/0027 W…`, so this file is red on
 * the pins and on nothing else: no existing suite is edited, and the browser-side proof is separate
 * (`playwright/offline-reload.spec.ts`, W9.1). The protocol runs through injected `fetch` and `caches`, which
 * is exactly why W4 puts it in the page rather than in the worker.
 */

const PROVIDER_VERSION = "1.0.0";
const TOTAL_ASSET_BYTES = 64 + 96 + 32;

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await new Response(text).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Deterministic ASCII bodies: equal lengths are equal bytes, so a hash difference means a real substitution
 * rather than an encoding accident. ASCII keeps the manifest's declared `bytes` exactly the string length.
 */
const filler = (length: number, salt: number): string =>
  Array.from({ length }, (_, index) => String.fromCharCode(97 + ((index * 31 + salt * 7) % 26))).join("");

/** Same length, different content — the only route to `hash_mismatch` rather than `download_incomplete`. */
const corruptSameLength = (text: string): string =>
  text.endsWith("a") ? `${text.slice(0, -1)}b` : `${text.slice(0, -1)}a`;

interface FixtureAsset {
  role: "det" | "rec" | "dict";
  file: string;
  url: string;
  bytes: string;
}

const fixtureAssets = (): FixtureAsset[] =>
  [
    { role: "det", file: "PP-OCRv6_tiny_det.onnx", size: 64, salt: 1 },
    { role: "rec", file: "PP-OCRv6_tiny_rec.onnx", size: 96, salt: 2 },
    { role: "dict", file: "PP-OCRv6_tiny_rec.txt", size: 32, salt: 3 },
  ].map(({ role, file, size, salt }) => ({
    role: role as FixtureAsset["role"],
    file,
    url: `/assets/models/${file}`,
    bytes: filler(size, salt),
  }));

/** A manifest shaped like the committed one, so core's `fetchModelManifest` validation accepts it (W5 step 1). */
const buildManifest = async (assets: readonly FixtureAsset[], providerVersion = PROVIDER_VERSION): Promise<string> =>
  JSON.stringify({
    schemaVersion: 1,
    provider: "pp-ocrv6",
    providerVersion,
    preset: "tiny",
    license: "Apache-2.0",
    assets: await Promise.all(
      assets.map(async (asset) => ({
        role: asset.role,
        file: asset.file,
        url: asset.url,
        bytes: asset.bytes.length,
        sha256: await sha256Hex(asset.bytes),
      })),
    ),
    detection: {
      inputName: "x",
      outputName: "fetch_name_0",
      inputShape: ["N", 3, "H", "W"],
      outputShape: ["N", 1, "H", "W"],
      preprocessing: {
        colorOrder: "BGR",
        scale: 0.00392156862745098,
        mean: [0.485, 0.456, 0.406],
        std: [0.229, 0.224, 0.225],
        limitSideLen: 960,
        sizeMultiple: 32,
      },
      postprocessing: { name: "DBPostProcess", threshold: 0.2, boxThreshold: 0.45, unclipRatio: 1.4, minSize: 3, maxCandidates: 3000 },
    },
    recognition: {
      inputName: "x",
      outputName: "fetch_name_0",
      inputShape: ["N", 3, 48, "W"],
      preprocessing: { colorOrder: "BGR", scale: 0.00392156862745098, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], height: 48, baseWidth: 320, maxWidth: 960 },
      decoder: { name: "CTCLabelDecode", blankIndex: 0, dictionaryEntries: 12, outputActivation: "softmax" },
    },
    readingOrder: { toleranceRatio: 0.5 },
  });

/* ---------------------------------------------------------------------- fakes */

interface FakeCaches {
  readonly storage: CacheStorageLike;
  readonly journal: string[];
  readonly deletes: string[];
  readonly entries: Map<string, Map<string, Response>>;
  seed(cacheName: string, url: string, body: BodyInit): Promise<void>;
}

/**
 * A Cache API stand-in that records what happened *in order*. W5's "activate, then clean up" and the mistake
 * "clean up, then activate" are the same set of calls in an unordered mock and different journals here, and
 * the ordering is the whole of §9's contract.
 *
 * `match` hands out a clone: a `Response` body can be read once, and a test that reads the same entry after
 * the protocol did would fail on the fake rather than on the code.
 */
async function fakeCaches(journal: string[]): Promise<FakeCaches> {
  const entries = new Map<string, Map<string, Response>>();
  const deletes: string[] = [];
  const caches: CacheStorageLike = {
    open: async (name: string) => {
      journal.push(`open:${name}`);
      if (!entries.has(name)) entries.set(name, new Map());
      const store = entries.get(name)!;
      return {
        match: async (url: string) => store.get(url)?.clone(),
        put: async (url: string, response: Response) => {
          journal.push(`put:${name}:${url}`);
          store.set(url, response);
        },
      };
    },
    keys: async () => [...entries.keys()],
    delete: async (name: string) => {
      journal.push(`delete:${name}`);
      deletes.push(name);
      const had = entries.has(name);
      entries.delete(name);
      return had;
    },
  };
  return {
    storage: caches,
    journal,
    deletes,
    entries,
    seed: async (name, url, body) => {
      if (!entries.has(name)) entries.set(name, new Map());
      entries.get(name)!.set(url, new Response(body));
    },
  };
}

/** Writes the pointer the way W5 step 6 does, so a test can begin from "a verified set is active". */
async function activateSet(caches: FakeCaches, providerVersion: string, manifestHash: string): Promise<string> {
  const name = `${MODEL_CACHE_PREFIX}${providerVersion}:${manifestHash}`;
  await caches.seed(ACTIVE_MODEL_CACHE, ACTIVE_MODEL_POINTER_PATH, name);
  await caches.seed(name, "/assets/models/PP-OCRv6_tiny_rec.onnx", "superseded bytes");
  return name;
}

const readPointer = async (caches: FakeCaches): Promise<string | null> => {
  const response = await caches.storage.open(ACTIVE_MODEL_CACHE).then((cache) => cache.match(ACTIVE_MODEL_POINTER_PATH));
  return response ? await response.text() : null;
};

type BodyMutator = (url: string, body: string) => string | null;

interface Harness {
  readonly deps: PrepareModelSetDeps;
  readonly caches: FakeCaches;
  readonly journal: string[];
  readonly manifestHash: string;
  readonly candidateName: string;
  readonly assetUrls: string[];
  readonly manifestUrl: string;
  /** Replace the served body of one asset, proving out the two verification codes separately (W7). */
  mutate(match: (url: string) => boolean, transform: (body: string) => string): void;
  /** Serve something unparseable (`manifest_invalid`) or nothing at all (`probe_unreachable`). */
  breakManifest(text: string | null): void;
}

async function harness(journal: string[]): Promise<Harness> {
  const assets = fixtureAssets();
  const manifestText = await buildManifest(assets);
  const bodies = new Map(assets.map((asset) => [asset.url, asset.bytes]));
  const assetUrls = assets.map((asset) => asset.url);
  const manifestUrl = "/assets/models/manifest.json";
  let mutator: BodyMutator = () => null;
  let manifestOverride: string | null = null;

  const fetchImpl = async (input: string): Promise<Response> => {
    journal.push(`fetch:${input}`);
    if (input === manifestUrl) {
      if (manifestOverride === null) return new Response(manifestText, { status: 200 });
      if (manifestOverride === "") throw new TypeError("Failed to fetch");
      return new Response(manifestOverride, { status: 200 });
    }
    const original = bodies.get(input);
    if (!original) throw new TypeError("Failed to fetch");
    const mutated = mutator(input, original);
    return new Response(mutated ?? original, { status: 200 });
  };

  const caches = await fakeCaches(journal);
  const deps: PrepareModelSetDeps = {
    // W6: the bypass is not a parameter of core's one-argument FetchLike — this closure *is* the mechanism.
    fetchImpl: (input) => {
      journal.push("cache:reload");
      return fetchImpl(input);
    },
    caches: caches.storage,
    manifestUrl,
    runSmoke: async () => {
      journal.push("smoke");
      return { lines: 3, words: 7 };
    },
    requestPersistence: async () => {
      journal.push("persist");
      return true;
    },
    now: () => Date.parse("2026-11-05T12:00:00.000Z"),
  };

  const manifestHash = await sha256Hex(manifestText);
  return {
    deps,
    caches,
    journal,
    manifestHash,
    candidateName: `${MODEL_CACHE_PREFIX}${PROVIDER_VERSION}:${manifestHash}`,
    assetUrls,
    manifestUrl,
    mutate(match, transform) {
      mutator = (url, body) => (match(url) ? transform(body) : null);
    },
    breakManifest(text) {
      manifestOverride = text;
    },
  };
}

/** Narrow to a passthrough, so `write` is type-visible and a wrong `kind` names itself. */
const asNetwork = (action: ServingAction): { kind: "network"; write: false; reason: string } => {
  if (action.kind !== "network") throw new Error(`expected a network passthrough, got ${action.kind}`);
  return action;
};

/* ---------------------------------------------------------------- W3 naming */

describe("W3 — cache names and the canonical serialisation", () => {
  const entries: PrecacheEntry[] = [
    { url: "/index.html", revision: null },
    { url: "/assets/index-zhQWO2KN.js", revision: null },
  ];

  it("names the model cache exactly as §9 pins it", () => {
    expect(modelCacheName("1.0.0", "abc123")).toBe("receipt-lens-models:1.0.0:abc123");
  });

  it("serialises canonically: sorted by url, control-character separators, order-independent", () => {
    const forward = canonicalPrecacheSerialisation(entries);
    expect(canonicalPrecacheSerialisation([...entries].reverse())).toBe(forward);
    expect(forward).toContain("\u001F");
    expect(forward).toContain("\u001E");
  });

  it("renders a null revision as nothing, because a content-hashed filename is its own revision", () => {
    expect(canonicalPrecacheSerialisation(entries)).not.toContain("null");
  });

  it("digests the serialisation to 12 hex characters", async () => {
    const digest = await canonicalPrecacheDigest(entries);
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(await canonicalPrecacheDigest([...entries].reverse())).toBe(digest);
  });

  it("bumps the shell cache name when one file is added — the no-forgotten-bump property", async () => {
    const before = await shellCacheName(entries);
    const after = await shellCacheName([...entries, { url: "/assets/new-CHUNK.js", revision: null }]);
    expect(before).toMatch(/^receipt-lens-shell-v[0-9a-f]{12}$/);
    expect(after).not.toBe(before);
  });

  it("keeps the pointer cache outside both cleanup prefixes", () => {
    expect(isModelCache(ACTIVE_MODEL_CACHE)).toBe(false);
    expect(isShellCache(ACTIVE_MODEL_CACHE)).toBe(false);
    expect(isModelCache("receipt-lens-models:1.0.0:deadbeefdead")).toBe(true);
    expect(isShellCache("receipt-lens-shell-v0123456789ab")).toBe(true);
  });
});

/* ---------------------------------------------------------- W3.1 cleanup */

describe("W3.1 — each caller may only ask about the kind of cache it owns", () => {
  const shell = "receipt-lens-shell-v0123456789ab";
  const oldModel = "receipt-lens-models:1.0.0:aaaaaaaaaaaa";
  const newModel = "receipt-lens-models:1.0.0:bbbbbbbbbbbb";
  const names = [ACTIVE_MODEL_CACHE, shell, "receipt-lens-shell-vffffffffffff", oldModel, newModel];

  it("the worker's sweep returns superseded shells and never a model cache", () => {
    expect(supersededShellCaches(names, shell)).toEqual(["receipt-lens-shell-vffffffffffff"]);
    expect(supersededShellCaches(names, shell).some(isModelCache)).toBe(false);
  });

  it("the page's sweep returns the superseded model set and never a shell cache", () => {
    expect(supersededModelCaches(names, newModel)).toEqual([oldModel]);
    expect(supersededModelCaches(names, newModel).some(isShellCache)).toBe(false);
  });

  it("neither selector can ever return the pointer cache", () => {
    expect(supersededShellCaches(names, "receipt-lens-shell-vffffffffffff")).not.toContain(ACTIVE_MODEL_CACHE);
    expect(supersededModelCaches(names, oldModel)).not.toContain(ACTIVE_MODEL_CACHE);
  });

  it("deletes nothing on a first install, where there is no superseded set at all", () => {
    expect(supersededShellCaches([ACTIVE_MODEL_CACHE, shell], shell)).toEqual([]);
    expect(supersededModelCaches([ACTIVE_MODEL_CACHE, shell], null)).toEqual([]);
  });

  it("a shell sweep with no previous shell is empty — W13.1: an ordinary activate performs zero deletions", () => {
    expect(supersededShellCaches([ACTIVE_MODEL_CACHE, shell], shell)).toHaveLength(0);
  });
});

/* -------------------------------------------------- W1.1 / W2.1 precache */

describe("W1.1 — the generated precache manifest", () => {
  const dist = [
    "index.html",
    "assets/index-zhQWO2KN.js",
    "assets/index-DSs-D2Tf.css",
    "assets/rolldown-runtime-CEoa-xHZ.js",
    "assets/ort.wasm.bundle.min-DEokbyO3.js",
    "assets/ort-wasm-simd-threaded-qh98TCA_.wasm",
    "manifest.webmanifest",
    "icons/receipt-lens-192.png",
    "sw.js",
    ".vite/manifest.json",
  ];

  it("excludes exactly the named set: the worker, the vite manifest, source maps", () => {
    expect(isPrecacheExcluded("sw.js")).toBe(true);
    expect(isPrecacheExcluded(".vite/manifest.json")).toBe(true);
    expect(isPrecacheExcluded("assets/index-zhQWO2KN.js.map")).toBe(true);
    expect(isPrecacheExcluded("index.html")).toBe(false);
    expect(PRECACHE_PLACEHOLDER).toBe("__RL_PRECACHE_MANIFEST__");
    expect([...precacheExclusions()].sort()).toEqual([".vite/manifest.json", "sw.js"]);
  });

  it("precaches every emitted file, root-relative and sorted, with no revision", () => {
    const entries = buildPrecacheEntries(dist);
    expect(entries.every((entry) => entry.revision === null)).toBe(true);
    expect(entries.map((entry) => entry.url)).toEqual([...entries.map((entry) => entry.url)].sort());
    expect(entries[0]!.url.startsWith("/")).toBe(true);
  });

  it("carries the F12 remedy: the 14.85 MB runtime WASM is in the list", () => {
    expect(buildPrecacheEntries(dist).filter((entry) => entry.url.endsWith(".wasm"))).toEqual([
      { url: "/assets/ort-wasm-simd-threaded-qh98TCA_.wasm", revision: null },
    ]);
  });

  it("never puts model bytes in the precache — those go through verification", () => {
    const entries = buildPrecacheEntries([...dist, "assets/models/PP-OCRv6_tiny_rec.onnx"]);
    expect(entries.some((entry) => entry.url.startsWith("/assets/models/"))).toBe(false);
    expect(() => assertNoModelAssets(entries)).not.toThrow();
    expect(() => assertNoModelAssets([{ url: "/assets/models/manifest.json", revision: null }])).toThrow(/DECISIONS\/0027 W2\.1/);
  });

  it("fails the build naming anything that reached dist/app and is neither precached nor excluded", () => {
    const entries = buildPrecacheEntries(dist);
    expect(() => assertPrecacheComplete(dist, entries)).not.toThrow();
    expect(() => assertPrecacheComplete([...dist, "assets/secret-chunk.js"], entries)).toThrow(/secret-chunk/);
  });
});

/* ------------------------------------------------------------ W5 protocol */

describe("W5 — the eight steps, in order, on a first preparation", () => {
  it("probes, downloads, verifies, writes the candidate, smokes, activates, then cleans up", async () => {
    const journal: string[] = [];
    const h = await harness(journal);

    const state = await prepareModelSet(h.deps);

    expect(state.status).toBe("up-to-date");
    if (state.status !== "up-to-date") throw new Error("unreachable");
    expect(state.providerVersion).toBe(PROVIDER_VERSION);
    expect(state.manifestHash).toBe(h.manifestHash);

    const ordered = journal.filter(
      (line) => line.startsWith("fetch:") || line.startsWith("put:") || line === "smoke",
    );
    const at = (needle: string) => ordered.indexOf(needle);
    const manifest = `fetch:${h.manifestUrl}`;
    expect(ordered[0]).toBe(manifest);

    for (const url of h.assetUrls) expect(at(`fetch:${url}`)).toBeGreaterThan(at(manifest));

    const candidatePuts = ordered.filter((line) => line.startsWith(`put:${h.candidateName}:`));
    expect(candidatePuts).toHaveLength(4);
    expect(at(candidatePuts[0]!)).toBeGreaterThan(at(`fetch:${h.assetUrls[2]}`));

    const pointer = `put:${ACTIVE_MODEL_CACHE}:${ACTIVE_MODEL_POINTER_PATH}`;
    expect(ordered).toContain(pointer);
    expect(at("smoke")).toBeGreaterThan(at(candidatePuts[0]!));
    expect(at(pointer)).toBeGreaterThan(at("smoke"));
  });

  it("writes no unverified byte: nothing reaches the candidate cache when a hash fails", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    h.mutate((url) => url.endsWith("rec.onnx"), corruptSameLength);

    const state = await prepareModelSet(h.deps);

    expect(state.status).toBe("unavailable");
    expect(h.caches.entries.has(h.candidateName)).toBe(false);
    expect(journal.filter((line) => line.startsWith(`put:${h.candidateName}:`))).toEqual([]);
  });

  it("exits at step 1 when the pointer already names this set: no download, no smoke, no write, no persist", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    await activateSet(h.caches, PROVIDER_VERSION, h.manifestHash);
    journal.length = 0;

    const state = await prepareModelSet(h.deps);

    expect(state.status).toBe("up-to-date");
    expect(journal.filter((line) => line.startsWith("fetch:"))).toEqual([`fetch:${h.manifestUrl}`]);
    expect(journal.filter((line) => line.startsWith("put:"))).toEqual([]);
    expect(journal).not.toContain("smoke");
    expect(journal).not.toContain("persist");
  });

  it("requests the manifest and every asset in reload cache mode, and never a query string — W6", async () => {
    const journal: string[] = [];
    const h = await harness(journal);

    await prepareModelSet(h.deps);

    const requested = journal.filter((line) => line.startsWith("fetch:")).map((line) => line.slice(6));
    expect(requested).toEqual([h.manifestUrl, ...h.assetUrls]);
    expect(requested.some((url) => url.includes("?"))).toBe(false);
    expect(journal.filter((line) => line === "cache:reload")).toHaveLength(requested.length);
  });

  it("reports progress in the manifest's own declared byte totals — W2.1's progressive UI", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    const seen: [number, number][] = [];

    await prepareModelSet({ ...h.deps, onProgress: (downloaded, total) => seen.push([downloaded, total]) });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual([TOTAL_ASSET_BYTES, TOTAL_ASSET_BYTES]);
  });

  it("asks for persistence once, after activation, and records a denial without failing — W18", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    let calls = 0;

    const state = await prepareModelSet({
      ...h.deps,
      requestPersistence: async () => {
        calls += 1;
        journal.push("persist");
        return false;
      },
    });

    expect(calls).toBe(1);
    const pointer = `put:${ACTIVE_MODEL_CACHE}:${ACTIVE_MODEL_POINTER_PATH}`;
    expect(journal.indexOf("persist")).toBeGreaterThan(journal.indexOf(pointer));
    if (state.status !== "up-to-date") throw new Error(`expected up-to-date, got ${state.status}`);
    expect(state.persisted).toBe(false);
  });

  it("does not re-request persistence on the warm path — the once-per-version property", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    await prepareModelSet(h.deps);
    const before = journal.filter((line) => line === "persist").length;
    await prepareModelSet(h.deps);
    expect(journal.filter((line) => line === "persist")).toHaveLength(before);
  });
});

/* -------------------------------------------------------------- W7 failure */

describe("W7 — a failed update keeps the old set and names the reason", () => {
  /**
   * W7's failure table, per step. A candidate is only collectable once the probe has produced a manifest, so
   * the two step-1 failures expect no deletion at all — there is no name to delete, and inventing one would
   * mean guessing a hash the probe never returned (W7.1).
   */
  const failures = [
    ["an unreachable probe", (h: Harness) => h.breakManifest(""), "probe_unreachable", []] as const,
    ["a manifest that is not JSON", (h: Harness) => h.breakManifest("<!doctype html><title>receipt-lens</title>"), "manifest_invalid", []] as const,
    ["a truncated asset", (h: Harness) => h.mutate((url) => url.endsWith("rec.onnx"), (body) => body.slice(0, 8)), "download_incomplete", ["candidate"]] as const,
    ["an asset substituted at the same length", (h: Harness) => h.mutate((url) => url.endsWith("det.onnx"), corruptSameLength), "hash_mismatch", ["candidate"]] as const,
    ["a smoke run that reads nothing", () => undefined, "smoke_failed", ["candidate"]] as const,
  ];

  for (const [label, apply, reason, expectedDeletes] of failures) {
    it(`${label}: pending on the retained set, pointer untouched, only the candidate deleted`, async () => {
      const journal: string[] = [];
      const h = await harness(journal);
      const retained = await activateSet(h.caches, "0.9.0", "a".repeat(64));
      apply(h);
      const deps = reason === "smoke_failed" ? { ...h.deps, runSmoke: async () => ({ lines: 0, words: 0 }) } : h.deps;

      const state = await prepareModelSet(deps);

      expect(state.status).toBe("pending");
      if (state.status !== "pending") throw new Error(`expected pending, got ${state.status}`);
      expect(state.reason).toBe(reason);
      expect(state.retainedVersion).toBe("0.9.0");

      expect(await readPointer(h.caches)).toBe(retained);
      expect(h.caches.deletes).not.toContain(retained);
      const expected = expectedDeletes.map(() => h.candidateName);
      expect(h.caches.deletes.filter((name) => name.startsWith(MODEL_CACHE_PREFIX))).toEqual(expected);
      expect(journal).not.toContain(`put:${ACTIVE_MODEL_CACHE}:${ACTIVE_MODEL_POINTER_PATH}`);
      expect(journal).not.toContain("persist");
      expect(h.caches.entries.has(retained)).toBe(true);
    });
  }

  it("reports `unavailable` rather than `pending` when there is no retained set — W13", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    h.breakManifest("");

    const state = await prepareModelSet(h.deps);

    expect(state.status).toBe("unavailable");
    if (state.status !== "unavailable") throw new Error("unreachable");
    expect(state.reason).toBe("probe_unreachable");
  });

  it("does not accumulate candidate caches across retries — the orphan is gone before the next attempt", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    await activateSet(h.caches, "0.9.0", "a".repeat(64));
    h.mutate((url) => url.endsWith("rec.onnx"), corruptSameLength);

    await prepareModelSet(h.deps);
    await prepareModelSet(h.deps);

    expect(h.caches.entries.has(h.candidateName)).toBe(false);
    expect(h.caches.deletes.filter((name) => name === h.candidateName).length).toBeGreaterThanOrEqual(1);
  });
});

describe("W5 step 7 — superseded cleanup happens only after verified activation", () => {
  it("deletes the superseded set after the pointer moves, never before", async () => {
    const journal: string[] = [];
    const h = await harness(journal);
    const retained = await activateSet(h.caches, "0.9.0", "a".repeat(64));

    const state = await prepareModelSet(h.deps);

    expect(state.status).toBe("up-to-date");
    expect(h.caches.deletes).toContain(retained);
    const from = journal.indexOf(`put:${ACTIVE_MODEL_CACHE}:${ACTIVE_MODEL_POINTER_PATH}`);
    const deleted = journal.indexOf(`delete:${retained}`);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(from);
    expect(await readPointer(h.caches)).toBe(h.candidateName);
  });
});

/* ------------------------------------------------------------- W13 smoke */

describe("W5 step 5 / W13 — the smoke acceptance bar", () => {
  it("accepts a run that yields at least one line and one word", () => {
    expect(SMOKE_MIN_LINES).toBe(1);
    expect(SMOKE_MIN_WORDS).toBe(1);
    expect(acceptsSmokeResult({ lines: 1, words: 1 })).toBe(true);
  });

  it("rejects zero lines, zero words, and an error — each is a broken model, not a hard receipt", () => {
    expect(acceptsSmokeResult({ lines: 0, words: 12 })).toBe(false);
    expect(acceptsSmokeResult({ lines: 12, words: 0 })).toBe(false);
    expect(acceptsSmokeResult({ error: "session creation failed" })).toBe(false);
  });
});

/* --------------------------------------------------------- W2.1 the trigger */

describe("W2.1 — the model download triggers on navigation to /capture and nowhere else", () => {
  it("starts on capture and never on share, the ledger, the bill or an unknown route", () => {
    expect(shouldPrepareModelSet({ route: "capture", phase: "idle" })).toBe(true);
    for (const route of ["share", "bills", "bill", "notFound"] as const) {
      expect(shouldPrepareModelSet({ route, phase: "idle" })).toBe(false);
    }
  });

  it("starts no second download while one is in flight", () => {
    expect(shouldPrepareModelSet({ route: "capture", phase: "in-flight" })).toBe(false);
  });

  it("does not re-run after success, and does allow a retry after a failure", () => {
    expect(shouldPrepareModelSet({ route: "capture", phase: "succeeded" })).toBe(false);
    expect(shouldPrepareModelSet({ route: "capture", phase: "failed" })).toBe(true);
  });
});

/* ------------------------------------------------------ W4 / W4.1 / W6 reads */

describe("W4 — the worker's serving decisions", () => {
  const shell = "receipt-lens-shell-v0123456789ab";
  const model = "receipt-lens-models:1.0.0:bbbbbbbbbbbb";
  const origin = "http://127.0.0.1:8000";

  const stateOf = (over: Partial<ServingState> = {}): ServingState => ({
    sameOrigin: true,
    shellCache: shell,
    activeModelCache: model,
    shellHas: async (url) => url !== "/assets/missing.js",
    modelHas: async (_name, url) => url !== "/assets/models/unknown.bin",
    isModelAsset: (url) => url.startsWith("/assets/models/"),
    ...over,
  });

  const requestOf = (path: string, over: Partial<ServedRequest> = {}): ServedRequest => ({
    url: `${origin}${path}`,
    method: "GET",
    mode: "cors",
    cache: "default",
    ...over,
  });

  it("passes a cross-origin request through and writes nothing", async () => {
    const action = await decideServing(requestOf("/", { url: "https://example.com/x" }), stateOf({ sameOrigin: false }));
    expect(asNetwork(action)).toEqual({ kind: "network", write: false, reason: "cross-origin" });
  });

  it("passes a non-GET through", async () => {
    const action = await decideServing(requestOf("/api", { method: "POST", mode: "same-origin" }), stateOf());
    expect(asNetwork(action).reason).toBe("non-get");
  });

  it("sends a reload-mode model request to the network and stores nothing — W6's probe bypass", async () => {
    const action = await decideServing(requestOf("/assets/models/manifest.json", { cache: "reload" }), stateOf());
    expect(asNetwork(action)).toEqual({ kind: "network", write: false, reason: "probe-bypass" });
  });

  it("serves a model asset from the active set, never from the shell", async () => {
    const action = await decideServing(requestOf("/assets/models/PP-OCRv6_tiny_rec.onnx"), stateOf());
    expect(action).toEqual({ kind: "serve-model", cacheName: model, url: "/assets/models/PP-OCRv6_tiny_rec.onnx" });
  });

  it("passes an uncached model asset through rather than answering it with HTML — W4.1", async () => {
    const action = await decideServing(requestOf("/assets/models/unknown.bin"), stateOf());
    expect(asNetwork(action).kind).toBe("network");
  });

  it("passes every model request through when no set has ever activated", async () => {
    const action = await decideServing(requestOf("/assets/models/manifest.json"), stateOf({ activeModelCache: null }));
    expect(asNetwork(action)).toEqual({ kind: "network", write: false, reason: "no-active-model-set" });
  });

  it("serves a navigation from the shell cache when the exact URL is there", async () => {
    const action = await decideServing(requestOf("/", { mode: "navigate" }), stateOf());
    expect(action).toEqual({ kind: "serve-shell", url: "/" });
  });

  it("answers an unknown deep link with the cached document, because it is a navigation", async () => {
    const action = await decideServing(requestOf("/bill", { mode: "navigate" }), stateOf({ shellHas: async () => false }));
    expect(action).toEqual({ kind: "serve-shell-navigation-fallback", url: SHELL_NAVIGATION_FALLBACK });
  });

  it("refuses the HTML fallback to a subresource, so a missing manifest reads as a miss and not as corrupt JSON", async () => {
    const action = await decideServing(requestOf("/manifest.webmanifest", { mode: "no-cors" }), stateOf({ shellHas: async () => false }));
    expect(action.kind).toBe("network");
  });

  it("serves the precached WASM from the shell — the read half of the F12 remedy", async () => {
    const action = await decideServing(requestOf("/assets/ort-wasm-simd-threaded-qh98TCA_.wasm"), stateOf());
    expect(action).toEqual({ kind: "serve-shell", url: "/assets/ort-wasm-simd-threaded-qh98TCA_.wasm" });
  });

  it("passes a shell miss through rather than inventing a response", async () => {
    const action = await decideServing(requestOf("/assets/missing.js"), stateOf());
    expect(asNetwork(action)).toEqual({ kind: "network", write: false, reason: "no-cache-entry" });
  });

  it("every passthrough is write:false — the worker never populates a cache (W2.2)", async () => {
    const empty = stateOf({ shellHas: async () => false, modelHas: async () => false, activeModelCache: null });
    for (const path of ["/assets/missing.js", "/assets/models/unknown.bin", "/deeply/unshipped.css"]) {
      const action = await decideServing(requestOf(path, { mode: "same-origin" }), empty);
      expect(asNetwork(action).write).toBe(false);
    }
  });
});

/* ---------------------------------------------------------- W10 registration */

describe("W10 — registration, and a worker that never arrives", () => {
  it("registers /sw.js with scope /", async () => {
    const calls: [string, string][] = [];
    const outcome = await registerServiceWorker({
      register: async (url, options) => {
        calls.push([url, options.scope]);
        return { scope: options.scope };
      },
    });
    expect(calls).toEqual([[SW_SCRIPT_URL, SW_SCOPE]]);
    expect(outcome).toEqual({ registered: true, scope: "/", error: null });
  });

  it("records a rejection and never throws: a blocked or disabled worker is an ordinary start", async () => {
    const outcome = await registerServiceWorker({
      register: async () => {
        throw new DOMException("Registration failed", "SecurityError");
      },
    });
    expect(outcome.registered).toBe(false);
    expect(outcome.scope).toBeNull();
    expect(outcome.error).toContain("Registration failed");
  });
});

/* --------------------------------------------------------------- W11 manifest */

describe("W11 — the web app manifest", () => {
  it("anchors start_url and scope at the worker scope, so the two cannot drift", () => {
    const manifest = appManifest();
    expect(manifest.start_url).toBe(SW_SCOPE);
    expect(manifest.scope).toBe(SW_SCOPE);
    expect(manifest.id).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBe("receipt-lens");
    expect(manifest.short_name).toBe("receipt-lens");
  });

  it("carries a 192, a 512 and a maskable 512, and states §1's claim without exceeding it", () => {
    const manifest = appManifest();
    expect(manifest.icons.map((icon) => icon.sizes).sort()).toEqual(["192x192", "512x512", "512x512"]);
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    expect(manifest.icons.every((icon) => icon.type === "image/png")).toBe(true);
    expect(manifest.icons.every((icon) => MANIFEST_ICON_PATHS.includes(icon.src))).toBe(true);
    expect(manifest.description).toContain("Receipts never leave your device");
  });

  it("uses the palette the stylesheet already has rather than inventing a brand colour", () => {
    const manifest = appManifest();
    expect(manifest.background_color).toBe("#fbfaf7");
    expect(manifest.theme_color).toBe("#efe9dc");
  });

  it("round-trips through JSON, because the build writes the file from this object", () => {
    expect(JSON.parse(JSON.stringify(appManifest()))).toEqual(appManifest());
  });
});

/* ----------------------------------------------------------------- W12 banner */

describe("W12.1 — the install banner and its seven days", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const offered = { eventSeen: true, dismissedAt: null, now, displayMode: "browser" as const };

  it("suppresses a dismissal for exactly seven days and no longer", () => {
    expect(INSTALL_BANNER_SUPPRESS_DAYS).toBe(7);
    expect(shouldShowInstallBanner({ ...offered, dismissedAt: now - INSTALL_BANNER_MS * 3 })).toBe(false);
    expect(shouldShowInstallBanner({ ...offered, dismissedAt: now - INSTALL_BANNER_MS * 7 })).toBe(false);
    expect(shouldShowInstallBanner({ ...offered, dismissedAt: now - INSTALL_BANNER_MS * 7 - 1 })).toBe(true);
  });

  it("shows nothing when no event was seen, and nothing once running as an app", () => {
    expect(shouldShowInstallBanner({ ...offered, eventSeen: false })).toBe(false);
    expect(shouldShowInstallBanner({ ...offered, displayMode: "standalone" })).toBe(false);
  });

  it("writes the dismissal under the app's one and only localStorage key", () => {
    const written: [string, string][] = [];
    const storage: BannerStorage = { get: () => null, set: (key, value) => written.push([key, value]), remove: () => undefined };
    dismissInstallBanner(storage, now);
    expect(written).toEqual([[INSTALL_BANNER_STORAGE_KEY, String(now)]]);
  });

  it("clears the suppression once the offer is spent", () => {
    const removed: string[] = [];
    const storage: BannerStorage = { get: () => String(now), set: () => undefined, remove: (key) => removed.push(key) };
    consumeInstallPrompt(storage);
    expect(removed).toEqual([INSTALL_BANNER_STORAGE_KEY]);
  });

  it("shows the headline pinned by the record", () => {
    expect(installBannerCopy().headline).toBe("Install receipt-lens for offline use");
  });
});

/* -------------------------------------------------------------------- W7.3 copy */

describe("W7.3 — pinned user-facing copy", () => {
  it("pending says the retained set is still in use, and never calls it current", () => {
    expect(modelUpdateCopy("pending")).toBe("A model update is pending. Receipts still read with the previous model set.");
  });

  it("unavailable says reading needs the models, without promising a download", () => {
    expect(modelUpdateCopy("unavailable")).toBe("Models are not on this device yet. Receipt reading needs them.");
  });

  it("formats the progress line from the manifest's own byte totals, one decimal, MB = 10^6", () => {
    expect(modelPreparingCopy(3_145_728, 6_277_292)).toBe("Preparing OCR — 3.1 MB of 6.3 MB.");
    expect(modelPreparingCopy(0, 6_277_292)).toBe("Preparing OCR — 0.0 MB of 6.3 MB.");
  });
});
