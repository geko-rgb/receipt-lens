import { startServer } from "../scripts/serve-app.mjs";

/**
 * The built shell plus this repository's model assets, served same-origin on a loopback port (§9: no third
 * party, no CDN). Existing specs grew their own copy of this; `bill-editor.spec.ts` uses this module so the
 * server is defined once, and the older specs can move onto it without ticket 11 editing them.
 *
 * Ticket 14 moved the implementation to `scripts/serve-app.mjs`, because `scripts/storage-fixtures.mjs` —
 * which produces the committed migration fixtures by driving this same built app — runs under plain Node and
 * cannot import a `.ts` file. Two copies of a server is what this module was written to prevent, so the
 * second consumer joins it instead of forking it. This file is now the typed facade the specs import.
 *
 * Ticket 18 extends it instead of bypassing it (`DECISIONS/0030` P1). The privacy audit's third witness is the
 * origin's own request log — the only witness Playwright's interception cannot influence — and this facade used
 * to discard exactly the fields that witness needs (`requests`, `bytes()`, `reset()`). Extending the facade keeps
 * "one server, one definition" true for a spec whose whole point is that a monitor must be compared against
 * something that is not itself.
 */

/** One response the origin served, in order. Bytes are counted here, at the origin that moved them (F5). */
export interface ServedRequest {
  /** Request pathname, decoded, as the origin logged it. Never carries a query (there is nothing to query). */
  readonly path: string;
  readonly status: number;
  readonly bodyBytes: number;
}

export interface AppServer {
  readonly url: string;
  /**
   * Every response the origin served, live. Empty unless `recordRequests` was asked for — an always-on log is a
   * cost no other spec agreed to pay.
   */
  readonly requests: readonly ServedRequest[];
  /** Total response body bytes the origin moved. */
  bytes(): number;
  /** Drop the log, so a spec can attribute what follows to its own flow. */
  reset(): void;
  close(): void;
}

export interface AppServerOptions {
  /**
   * Serve the migration rig at `/rig/*`. Off by default: the shipped-app tests must not be able to reach a
   * test-only bundle by accident, and `smoke.spec.ts` asserts it is not in the app build either.
   */
  readonly withRig?: boolean;
  /**
   * Log what the origin served (`DECISIONS/0030` P1, witness 3). Off by default so every existing caller sees
   * byte-identical behaviour.
   */
  readonly recordRequests?: boolean;
}

export async function startAppServer(options: AppServerOptions = {}): Promise<AppServer> {
  const server = startServer({
    withRig: options.withRig === true,
    recordRequests: options.recordRequests === true,
  });
  return {
    url: await server.url,
    requests: server.requests,
    bytes: server.bytes,
    reset: server.reset,
    close: server.close,
  };
}
