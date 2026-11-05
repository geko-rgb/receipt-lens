import { adoptProvider, loadOcr } from "../ocr.js";
import { drawSmokeImage } from "./smoke-image.js";
import { prepareModelSet, type PrepareModelSetDeps, type SmokeOutcome, type VerifiedModelSet } from "./update.js";

/**
 * Ticket 17 — the browser half of DECISIONS/0027 W4/W5: build the real dependencies and run the protocol.
 *
 * Nothing here decides anything. `update.ts` holds the rules and takes them as parameters; this module is the
 * adapter that hands it `fetch`, `caches`, the clock and a smoke runner, so that the rules stay testable
 * without a browser and this file stays testable only with one (`playwright/offline-reload.spec.ts`).
 */

/** Where the app's own model assets are served from — the same path the manifest declares (§9, same-origin). */
export const MODEL_MANIFEST_URL = "/assets/models/manifest.json";

/**
 * W6: every protocol request must bypass the caches so a probe can learn what the origin is actually serving.
 * A query string would be an alternative, and it is forbidden — `playwright/offline.spec.ts`'s allowlist is
 * exact-path with an empty search, and the negative control that proves it is exact depends on that.
 */
const reloadFetch = (input: string): Promise<Response> => fetch(input, { cache: "reload" });

/**
 * Run one real inference against the bytes the protocol just verified (W5 step 5).
 *
 * The provider is handed those bytes through its own `fetch` option rather than reading them back by URL, so
 * the smoke test cannot accidentally pass on the *previous* set the worker is still serving — which would make
 * the gate prove nothing at all.
 */
export async function runSmokeInference(set: VerifiedModelSet): Promise<SmokeOutcome> {
  try {
    const core = await loadOcr();
    const declared = (JSON.parse(set.manifestText) as { assets: { role: string; url: string }[] }).assets;
    const bodies = new Map<string, string | ArrayBuffer>();
    bodies.set(MODEL_MANIFEST_URL, set.manifestText);
    for (const asset of declared) {
      const bytes = set.assets[asset.role as keyof VerifiedModelSet["assets"]];
      if (!bytes) throw new Error(`manifest declares ${asset.role}, the verified set does not carry it`);
      bodies.set(asset.url, bytes);
    }
    const provider = core.createPPOCRv6Provider({
      fetch: async (input) => {
        const body = bodies.get(input);
        if (body === undefined) throw new Error(`smoke run asked for an asset the manifest did not declare: ${input}`);
        return new Response(body);
      },
    });
    const image = await drawSmokeImage();
    if (!image) return { error: "no 2d canvas to draw the smoke image on" };
    const result = await provider.recognize(image);
    // W5 hand-off: this provider has loaded the verified bytes and run them, so it is the one the user's
    // first capture should use. Only adopted on a passing run — a failed smoke must not become the provider.
    adoptProvider(provider);
    return { lines: result.lines.length, words: result.lines.reduce((count, line) => count + line.words.length, 0) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** W18: durability is requested, never assumed. A denied promise is normal and changes nothing else. */
const requestPersistence = async (): Promise<boolean> => {
  const storage = navigator.storage;
  return storage && typeof storage.persist === "function" ? storage.persist() : false;
};

/** The browser-side dependencies, with the injected seams W4's protocol expects. */
export function browserPrepareDeps(onProgress?: (downloaded: number, total: number) => void): PrepareModelSetDeps {
  return {
    fetchImpl: reloadFetch,
    caches: caches as unknown as PrepareModelDepsCaches,
    manifestUrl: MODEL_MANIFEST_URL,
    runSmoke: runSmokeInference,
    requestPersistence,
    now: () => Date.now(),
    ...(onProgress ? { onProgress } : {}),
  };
}

type PrepareModelDepsCaches = PrepareModelSetDeps["caches"];

/** Run W5's eight steps against this deployment. Never throws: every failure is a state, per W7. */
export async function prepareModelsForBrowser(onProgress?: (downloaded: number, total: number) => void) {
  return await prepareModelSet(browserPrepareDeps(onProgress));
}
