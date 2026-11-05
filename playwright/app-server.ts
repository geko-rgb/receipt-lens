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
 */

export interface AppServer {
  readonly url: string;
  close(): void;
}

export interface AppServerOptions {
  /**
   * Serve the migration rig at `/rig/*`. Off by default: the shipped-app tests must not be able to reach a
   * test-only bundle by accident, and `smoke.spec.ts` asserts it is not in the app build either.
   */
  readonly withRig?: boolean;
}

export async function startAppServer(options: AppServerOptions = {}): Promise<AppServer> {
  const server = startServer({ withRig: options.withRig === true });
  return { url: await server.url, close: server.close };
}
