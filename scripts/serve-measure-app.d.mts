/**
 * Types for the measurement and offline-test origin: `serve-app.mjs` plus the three test affordances documented
 * in that file's header (a writable model manifest, a writable `/sw.js`, and an always-on request log). Declared
 * so `benchmarks/tests/footprint/etag-pins.test.ts` can assert against the real server's real responses — the
 * conditional-request pins in particular have to see `status`, `etag` and `completed` on a typed entry, because
 * the whole point of ticket 17c is what a `304` does to a byte count.
 */
import type { ServedEntry } from "./serve-app.mjs";

export interface MeasureOrigin {
  /** Resolves to `http://127.0.0.1:<port>/` with a trailing slash. */
  readonly url: Promise<string>;
  readonly requests: ServedEntry[];
  /** Every response served since the last `reset()` — the offline assertion's source of truth. */
  since: () => ServedEntry[];
  /** Every request the origin refused while the offline marker existed. */
  refused: () => { path: string; outcome: string }[];
  reset: () => void;
  totalBytes: () => number;
  close: () => unknown;
}

export function startMeasureServer(options?: { overridesDir?: string | null; appDir?: string }): MeasureOrigin;
