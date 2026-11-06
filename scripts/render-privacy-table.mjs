#!/usr/bin/env node
/**
 * Ticket 18 — the privacy block generator.
 *
 *   node scripts/render-privacy-table.mjs [--write | --check] [--readme path]
 *
 * The README's local-processing paragraph is the §9 M3 claim, and `DECISIONS/0030` P11 says every published
 * sentence must trace to an artifact or a job that runs in CI. So the claim is emitted here, and `--check`
 * verifies the things it asserts instead of restating them:
 *
 *   - `playwright/privacy.spec.ts` declares exactly six privacy tests, all tagged `@offline` (the tag is what
 *     keeps `ci.yml`'s `--grep-invert @offline` from paying for the same browser OCR twice), and each of the
 *     three witnesses the paragraph names is still in the file;
 *   - `.github/workflows/privacy.yml` still runs that file under the job the paragraph calls "every PR";
 *   - `DECISIONS/0030` still carries the pins the limits are drawn from (P4.1, P6.1, P12).
 *
 * A block that describes an audit which has since been deleted fails here rather than sitting in the README as
 * a claim nothing backs. This is the same discipline ticket 08 and 09b applied to the footprint and accuracy
 * tables: the typeable path is gone.
 *
 * Note the kind of check this is. It proves the *shape* of the audit and the validity of the wiring; it cannot
 * prove that the audit passes. Only the job can, and that is why the paragraph points at the job for the result
 * and at `DECISIONS/0030` for the limits.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const BEGIN = "<!-- privacy:begin -->";
const END = "<!-- privacy:end -->";

/** A backtick, spelled as an escape so nothing below can accidentally open a template literal with it. */
const CB = "\u0060";
const code = (text) => CB + text + CB;

const argv = process.argv.slice(2);
const mode = argv.includes("--write") ? "write" : argv.includes("--check") ? "check" : null;
if (!mode) {
  console.error("usage: node scripts/render-privacy-table.mjs [--write | --check] [--readme path]");
  process.exit(2);
}
const readmeIndex = argv.indexOf("--readme");
const readmePath =
  readmeIndex === -1 ? path.join(repoRoot, "packages/core/README.md") : path.resolve(repoRoot, argv[readmeIndex + 1]);

const problems = [];
const note = (message) => problems.push(message);

/* ------------------------------------------------------------------- the spec */

const specPath = path.join(repoRoot, "playwright", "privacy.spec.ts");
const spec = await readFile(specPath, "utf8").catch(() => null);
if (spec === null) {
  note("playwright/privacy.spec.ts is missing — this block would describe an audit that does not exist");
} else {
  const cases = spec.match(/^ {2}test\("privacy: .*$/gm) ?? [];
  if (cases.length !== 6) {
    note("playwright/privacy.spec.ts declares " + cases.length + " privacy test(s), and this block publishes six");
  }
  for (const line of cases) {
    if (!line.endsWith('@offline", async () => {') && !line.includes("@offline")) {
      note("a privacy test is not tagged @offline, so ci.yml will run it a second time: " + line.trim());
    }
  }
  for (const witness of ['context.on("request"', 'context.route("**/*"', "recordRequests"]) {
    if (!spec.includes(witness)) {
      note("playwright/privacy.spec.ts no longer contains " + witness + " — one of the three witnesses the paragraph names is gone");
    }
  }
  if (!spec.includes("routeWebSocket")) {
    note("playwright/privacy.spec.ts no longer closes WebSocket upgrades — DECISIONS/0030 P4's witness 2 is incomplete");
  }
}

/* --------------------------------------------------------------- the workflow */

const workflowPath = path.join(repoRoot, ".github", "workflows", "privacy.yml");
const workflow = await readFile(workflowPath, "utf8").catch(() => null);
if (workflow === null) {
  note(".github/workflows/privacy.yml is missing — the claim says the audit runs on every PR");
} else {
  if (!workflow.includes("privacy.spec.ts")) {
    note(".github/workflows/privacy.yml no longer runs privacy.spec.ts");
  }
  if (!workflow.includes("Full-workflow PWA privacy audit")) {
    note(".github/workflows/privacy.yml lost the M3 step's name, so the audit's result is no longer findable on a PR");
  }
}

/* ------------------------------------------------------------------- the pins */

const recordPath = path.join(repoRoot, "DECISIONS", "0030-privacy-audit-pins.md");
const record = await readFile(recordPath, "utf8").catch(() => null);
if (record === null) {
  note("DECISIONS/0030-privacy-audit-pins.md is missing — the limits paragraph cites it");
} else {
  for (const pin of ["## P4.1", "## P6.1", "## P12"]) {
    if (!record.includes(pin)) note("DECISIONS/0030 no longer carries " + pin + ", which this block's limits are drawn from");
  }
}

/* ------------------------------------------------------------------ the block */

const lines = [];
const emit = (line = "") => lines.push(line);

emit(BEGIN);
emit("<!-- generated by scripts/render-privacy-table.mjs from playwright/privacy.spec.ts,");
emit("     .github/workflows/privacy.yml and DECISIONS/0030. Do not edit this block by hand.");
emit("     Regenerate with: pnpm render:privacy -->");
emit();
emit("## Privacy, audited");
emit();
emit(
  "**What the app does with your receipt.** Receipt OCR, parsing, and bill calculations run locally in the browser. " +
    "After required app/model assets are available, the tested inference workflow works without outbound network " +
    "access — a full-workflow privacy audit passes in CI, intercepting every request across capture, edit, lock, and " +
    "share. The audit runs on every PR and fails the job on unexpected egress; on the current private-repository plan, " +
    "GitHub does not permit branch protection rules that make this failure merge-blocking, so the audit's result is " +
    "visible on every PR but a human must not merge a red PR. Merge-blocking enforcement activates when the repository " +
    "becomes public, which is planned at v1's npm publish. Deliberate bill sharing is a separate user-initiated action: " +
    "the URL fragment carries selected parsed bill data, never the receipt image or raw OCR text. Full audit results " +
    "and limitations in " + code("DECISIONS/0030") + ".",
);
emit();
emit(
  "**How that is measured.** " + code("playwright/privacy.spec.ts") + " drives one workflow through the shipped UI — " +
    "capture, OCR, parse, review, edit, roster, assign, exclude, lock, mint share links, a participant opens one, " +
    "settle — with three witnesses: the context request log (which asserts), the routing layer (which enforces), and " +
    "the origin's own request log (which checks that the browser-side log is not blind). Six split tests read that one " +
    "log. Requests are classified by scheme: " + code("http:") + "/" + code("https:") + " are network requests subject to " +
    "every assertion, while " + code("blob:") + "/" + code("data:") + " are local object URLs, recorded but never counted " +
    "as egress — and the image assertion still proves the receipt bytes appear in no " + code("http(s)") + " body, URL, " +
    "query or header. Deliberate share actions are aborted in CI and printed as excluded, not exempt, and each minted " +
    "fragment and WhatsApp message body is content-scanned as an artifact. No request body or header value is written " +
    "to the log.",
);
emit();
emit("### Limits — read these as part of the claim");
emit();
emit(
  "- **An empirical demonstration, not a proof.** The audit shows that this flow, on this browser, on this deployment " +
    "produced no unexpected egress. It cannot show that an untested code path would not.",
);
emit(
  "- **One browser, and one measured blind spot.** Playwright's interception of service-worker traffic is " +
    "browser-dependent; this is measured on Desktop Chrome only. Measured: a cross-origin GET issued from a page the " +
    "service worker controls was not observed by the audit's request log, while a cross-origin POST from the same page " +
    "was — so a worker-mediated GET leak would not be caught by this audit, and the claim above is about the egress it " +
    "observes rather than every request a browser could make (`DECISIONS/0030` P3, P12).",
);
emit(
  "- **The install path is half-tested.** The app's install-offering half is automated — a fabricated " +
    code("beforeinstallprompt") + " event drives the banner. The browser's install-prompt half does not fire in headless " +
    "Chromium; manual install verification is documented as a not-yet-run check.",
);
emit(
  "- **Merge-blocking is a repository setting, not a code property.** The job fails red on every PR; what the current " +
    "plan permits in branch protection is stated in the paragraph above.",
);
emit(
  "- **The static scan is a supplement, never proof.** " + code("pnpm scan:egress") + " catches a code path this flow " +
    "never reaches; the runtime audit is what measures egress.",
);
emit();
emit(
  "Re-derive it: " + code("pnpm exec playwright test --config playwright/playwright.config.ts privacy.spec.ts") + ", then " +
    code("pnpm verify:privacy-table") + " to re-render this block from the spec, the workflow and " + code("DECISIONS/0030") + ".",
);
emit(END);

const block = lines.join("\n");

const readmeRaw = await readFile(readmePath, "utf8").catch(() => null);
if (readmeRaw === null) {
  console.error("missing " + path.relative(repoRoot, readmePath) + " — the block has nowhere to live");
  process.exit(1);
}
const begin = readmeRaw.indexOf(BEGIN);
const end = readmeRaw.indexOf(END);
if (begin === -1 || end === -1 || end < begin) {
  console.error(
    path.relative(repoRoot, readmePath) + " has no " + BEGIN + " / " + END + " markers — add them where the block belongs",
  );
  process.exit(1);
}
const rendered = readmeRaw.slice(0, begin) + block + readmeRaw.slice(end + END.length);

if (problems.length > 0) {
  console.error("the privacy block no longer re-derives from this tree:");
  for (const problem of problems) console.error("- " + problem);
  process.exit(1);
}

const rel = path.relative(repoRoot, readmePath);
if (mode === "check") {
  if (readmeRaw !== rendered) {
    console.error(rel + " does not match a fresh render of the spec, the workflow and DECISIONS/0030");
    console.error("this is the drift the check exists for — run: node scripts/render-privacy-table.mjs --write");
    process.exit(1);
  }
  console.log(rel + " matches the six @offline tests, the M3 workflow step and DECISIONS/0030's P4.1/P6.1/P12");
} else {
  await writeFile(readmePath, rendered, "utf8");
  console.log("wrote the privacy block into " + rel);
}
