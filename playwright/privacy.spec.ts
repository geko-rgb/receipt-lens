/***
 * Ticket 18 — the §9 M3 full-workflow privacy audit.
 *
 * The protocol is DECISIONS/0030; this file is its only implementation. What it claims:
 *
 *   Receipt images and OCR text are processed locally, and the tested inference workflow succeeds after the
 *   app/model assets are available without an inference service. Six split tests read one accumulated request
 *   log from one full workflow run — capture, parse, review, edit, assign, lock, mint share links, open one as
 *   a participant, mark paid — rather than each driving their own OCR pass (P6).
 *
 * Three witnesses, because one alone is not enough (P4). The context event log is what asserts. The context
 * routes enforce. The origin's own request log confirms the event log is not blind — a path the server served
 * that never appeared in the browser-side log fails the audit, and it is the only witness Playwright's
 * interception cannot influence.
 *
 * LIMITS, STATED HERE BECAUSE THEY ARE PART OF THE CLAIM (P3, P12):
 *   - Service workers run with `serviceWorkers: "allow"`, so the worker's own egress is in scope. Playwright's
 *     interception of service-worker traffic is browser-dependent and Chromium-specific; everything here is
 *     measured on Desktop Chrome and nothing else.
 *   - This is an empirical demonstration, not a mathematical proof. It shows the tested flow, on this browser,
 *     on this deployment, produced no unexpected egress. It cannot show that an untested code path would not —
 *     which is why the static scan (P8) exists and why it is labelled a supplement, never a proof.
 *   - Deliberate share actions are excluded from the local-processing claim (P7) and the exclusions are printed,
 *     so the carve-out is auditable rather than a `continue()` in a loop. Excluded from the *cross-origin*
 *     assertion only: a deliberate payload is still content-scanned as an artifact, not merely aborted.
 *   - No body, header value, or query string is written to the CI log. Hashes, counts and method/origin/path
 *     only (P4): proving user data did not leave must not copy it into a build log to do it.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startServer, type LocalOrigin } from "../scripts/serve-app.mjs";

/* --------------------------------------------------------------- the receipt */

/** P2. `COFFEE 4.50` becomes an item; `NAAN 60.00` stays an excluded ambiguous row. */
const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "NAAN 60.00", "TOTAL 100.00"];

/** The OCR line strings that must never appear in any request, in the clear or percent-decoded (P5). */
const OCR_STRINGS = RECEIPT_LINES.map((line) => line.toLowerCase());

/** Deliberate destinations, pinned rather than heuristically detected (P7). */
const DELIBERATE_ORIGINS = new Set(["https://wa.me", "https://api.whatsapp.com"]);

/* ------------------------------------------------------------------- records */

type Phase =
  | "profile"
  | "capture"
  | "parse"
  | "review"
  | "edit"
  | "assign"
  | "lock"
  | "share"
  | "participant"
  | "settle"
  | "deliberate";

interface RecordedRequest {
  phase: Phase;
  method: string;
  url: string;
  origin: string;
  path: string;
  search: string;
  sameOrigin: boolean;
  resourceType: string;
  /** SHA-256 of `postDataBuffer()`, or null when there is no body. Never the body itself (P4). */
  bodySha256: string | null;
  /** Header *names* whose value matched a receipt signature. Values are never recorded (P5). */
  headerMatches: string[];
  /** Set only for a request the audit classified as deliberate (P7). */
  deliberate?: "whatsapp-intent" | "upi-intent" | "share-link-minted";
}

interface AuditLog {
  /** Witness 1 — the context event log. The assertion surface. */
  requests: RecordedRequest[];
  /** Witness 2 — what the routing layer was handed and enforced against. */
  enforced: string[];
  /** Witness 3 — the origin's own request log, independent of Playwright. */
  served: { path: string; status: number; bodyBytes: number }[];
  /** The SHA-256 of the exact PNG bytes handed to the file input (P2). */
  imageSha256: string;
  /** Deliberate actions seen, printed as excluded-not-exempt (P7). */
  exclusions: { tag: string; destination: string }[];
}

/* ---------------------------------------------------------------- the server */

let origin: LocalOrigin;
let baseUrl = "";

test.beforeAll(async () => {
  origin = startServer({ recordRequests: true });
  baseUrl = await origin.url;
});

test.afterAll(() => {
  origin?.close();
});

/* ------------------------------------------------------------------ stubs */

/**
 * Every assertion below is pinned in DECISIONS/0030 before it is implemented, so a red run says *which* pin is
 * still unimplemented rather than failing an assertion that was never written. Commit 3 replaces each of these
 * bodies; a stub that returns instead of throwing would be the false-green pattern ticket 17 and 17b both had
 * to avoid.
 */
function notImplemented(pin: string): never {
  throw new Error(`not implemented: DECISIONS/0030 ${pin}`);
}

/** P6 — drives the whole workflow once and returns the accumulated log. */
async function runFullWorkflow(context: BrowserContext): Promise<AuditLog> {
  void context;
  return notImplemented("P6");
}

/** P4/P6 — no unexpected cross-origin request anywhere in the flow, first load included. */
async function assertNoCrossOriginEgress(log: AuditLog): Promise<void> {
  void log;
  return notImplemented("P4/P6");
}

/** P5 — the receipt image, byte-for-byte by hash and by 4 KB window, in no request body. */
async function assertNoImageBytes(log: AuditLog): Promise<void> {
  void log;
  return notImplemented("P5");
}

/** P5 — no OCR line string in any URL, query, header value or body, decoded where a decoder is defined. */
async function assertNoOcrText(log: AuditLog): Promise<void> {
  void log;
  return notImplemented("P5");
}

/** P7 — deliberate share actions tagged and printed, and each minted fragment content-scanned as an artifact. */
async function assertDeliberateShareIsScopedAndScanned(log: AuditLog, page: Page): Promise<void> {
  void log;
  void page;
  return notImplemented("P7");
}

/** P8 — runs the existing first-party scanner and asserts its exit code; supplement, not proof. */
async function assertStaticScanClean(): Promise<void> {
  return notImplemented("P8");
}

/** P9 — two injected canaries must make the helpers above throw, and the real log must not. */
async function assertCanariesAreCaught(): Promise<void> {
  return notImplemented("P9");
}

/* ------------------------------------------------------------------- tests */

test.describe("privacy: the §9 M3 full-workflow audit", () => {
  test.use({ serviceWorkers: "allow" });

  test("privacy: no cross-origin request during the full workflow @offline", async ({ context }) => {
    const log = await runFullWorkflow(context);
    await assertNoCrossOriginEgress(log);
  });

  test("privacy: no receipt-image bytes appear in any request @offline", async ({ context }) => {
    const log = await runFullWorkflow(context);
    await assertNoImageBytes(log);
  });

  test("privacy: no OCR text appears in any request @offline", async ({ context }) => {
    const log = await runFullWorkflow(context);
    await assertNoOcrText(log);
  });

  test("privacy: deliberate share actions are identified, excluded and scanned @offline", async ({
    page,
    context,
  }) => {
    const log = await runFullWorkflow(context);
    await assertDeliberateShareIsScopedAndScanned(log, page);
  });

  test("privacy: static scan finds no banned egress primitives (supplement, not proof) @offline", async () => {
    await assertStaticScanClean();
  });

  test("privacy: an injected canary egress fails the audit @offline", async () => {
    await assertCanariesAreCaught();
  });
});
