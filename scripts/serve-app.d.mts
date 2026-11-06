/**
 * Types for the local origin every e2e spec, `scripts/storage-fixtures.mjs` and the footprint measurement run
 * against. Declaration only — the implementation is `serve-app.mjs`, and this file exists so that
 * `benchmarks/tests/footprint/etag-pins.test.ts` can drive the *real* shipping server over real HTTP with
 * checked types rather than `any`. A pin that cannot see the shape of what it asserts is a pin that quietly
 * stops asserting.
 */

/** One response the origin served, in order. Bytes are counted here, at the origin that moved them (`DECISIONS/0012` F5). */
export interface ServedEntry {
  readonly id: number;
  readonly path: string;
  readonly status: number;
  readonly bodyBytes: number;
  readonly completed: boolean;
  readonly etag?: string | null;
}

export interface LocalOrigin {
  /** Resolves to `http://127.0.0.1:<port>/` with a trailing slash. */
  readonly url: Promise<string>;
  readonly requests: ServedEntry[];
  /** Total response body bytes the origin moved. F5's "whose byte count". */
  bytes: () => number;
  reset: () => void;
  close: () => unknown;
}

export function startServer(options?: { withRig?: boolean; recordRequests?: boolean }): LocalOrigin;
