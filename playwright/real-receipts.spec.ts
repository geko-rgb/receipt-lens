import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `next.md` Part 3 — the image-level acceptance gate, run on the two real photographs.
 *
 * This is the only test that runs `PP-OCRv6 Small` itself, in the built shell, in Chromium, with no network: the
 * same code path a user takes. Everything else asserts against the provider output this produces (replayed in
 * `packages/core/src/parse/real-ocr-fixtures.ts`), so the fixtures cannot drift from the model unnoticed.
 *
 * The photographs themselves are the owner's, not the repository's (Amendment H), so each test skips cleanly when
 * an image is absent rather than pretending to have run. When it is present, this is the gate.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(repoRoot, "packages/pwa/dist/app");
const modelDir = path.join(repoRoot, "assets/models");
const IMAGES = {
  saravana: "WhatsApp Image 2026-11-06 at 22.48.34.jpeg",
  pineapple: "WhatsApp Image 2026-11-06 at 22.48.35(1).jpeg",
};
let child: ChildProcess | undefined;
let baseUrl = "";

test.beforeAll(async () => {
  const spawned = spawn(process.execPath, ["-e", `
      const http = require("node:http"); const fs = require("node:fs"); const path = require("node:path");
      const appDir = ${JSON.stringify(appDir)}; const modelDir = ${JSON.stringify(modelDir)};
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8" };
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        let file;
        if (url.pathname.startsWith("/assets/models/")) file = path.join(modelDir, url.pathname.slice("/assets/models/".length));
        else if (["/", "/capture", "/bill", "/share"].includes(url.pathname)) file = path.join(appDir, "index.html");
        else file = path.join(appDir, url.pathname);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(appDir, "index.html");
        res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        fs.createReadStream(file).pipe(res);
      });
      server.listen(0, "127.0.0.1", () => process.stdout.write("url: http://127.0.0.1:" + server.address().port + "/\\n"));
    `], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  child = spawned;
  baseUrl = await new Promise<string>((resolve) => {
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (c: string) => {
      const m = c.match(/url: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) resolve(m[1]!);
    });
  });
});
test.afterAll(() => child?.kill("SIGTERM"));

const photo = (name: string) => path.join(repoRoot, "images", name);

test("the Saravana Bhavan photograph reads as four products totalling ₹474.00", async ({ page }) => {
  test.skip(!existsSync(photo(IMAGES.saravana)), `supply images/${IMAGES.saravana} to run the image-level gate`);
  test.setTimeout(300_000);
  await page.goto(baseUrl);
  await page.getByTestId("file-input").setInputFiles({
    name: IMAGES.saravana,
    mimeType: "image/jpeg",
    buffer: readFileSync(path.join(repoRoot, "images", IMAGES.saravana)),
  });
  await page.getByTestId("draft-review").waitFor({ state: "visible", timeout: 240_000 });

  const rows = page.getByTestId("item-row");
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("item-line-total")).toHaveText(["₹70.00", "₹50.00", "₹48.00", "₹306.00"]);
  await expect(page.getByTestId("provenance")).toHaveText(["detected · explicit", "detected · explicit", "detected · explicit", "detected · explicit"]);

  await page.getByTestId("accept-btn").click();
  await expect(page.getByTestId("printed-grand-total")).toContainText("474.00", { timeout: 30_000 });
  // The four lines reach the bill with their own names, a read quantity and a read price — not unresolved drafts.
  await expect(page.getByTestId("draft-row")).toHaveCount(4);
  const fieldValues = (testId: string) =>
    page.locator(`[data-testid='${testId}']`).evaluateAll((elements) =>
      elements.map((element) => (element as HTMLInputElement).value)
    );
  expect(await fieldValues("draft-name")).toEqual(["offee", "vada", "Chappathi Empty", "combo 2 chapati/,Po8 Masala"]);
  expect(await fieldValues("draft-qty")).toEqual(["2", "2", "2", "2"]);
  expect(await fieldValues("draft-price")).toEqual(["₹35.00", "₹25.00", "₹24.00", "₹153.00"]);
  await expect(page.locator("[data-testid='draft-provenance']")).toHaveText([
    "detected · explicit",
    "detected · explicit",
    "detected · explicit",
    "detected · explicit",
  ]);
  // DECISIONS/0035's disposition audit changed this figure and the spec says so rather than hiding it. Pairing
  // removed the twelve unread rows and the unamounted `gst` charge this page used to publish. Before the audit every
  // trailing row was discarded as "header noise" by accident (the item-region counter never advanced on a page whose
  // priced rows were all reconstructed), which is why this gate used to assert zero. Five rows are preserved now —
  // the ones no rule can justify as a header, a charge, metadata or an understood tax row, so §5 rule 7 keeps them.
  // The extraction itself is unmoved: four products, ₹474.00, names verbatim.
  const unclassified = page.getByTestId("unclassified-row");
  await expect(unclassified).toHaveCount(5);
  // The live model reads the photograph, so these are its own (illegible) strings, not the redacted replay.
  // `Sman :-3` and `Sales Type ： DINING` left this list on 2026-11-10: DECISIONS/0034's amendment reads them as
  // staff and sales-type metadata, so they no longer need a human's dismissal.
  for (const [index, needle] of ["ocrec re", "Wtnin 2gis", "sarrna", "saraerana"].entries()) {
    await expect(unclassified.nth(index === 0 ? 0 : index + 1)).toContainText(needle);
  }
  for (const row of await unclassified.all()) await expect(row).not.toContainText("Sales Type");
  // So the lock reports them: the four products are ready and the review list is the creator's to dismiss.
  await expect(page.getByTestId("no-blockers")).toHaveCount(0);
  await expect(page.getByTestId("blockers-list")).toBeVisible();
});

test("the KOT counter photograph reads one line at ₹75.00 and preserves three trailing marks", async ({ page }) => {
  test.skip(!existsSync(photo(IMAGES.pineapple)), `supply images/${IMAGES.pineapple} to run the image-level gate`);
  test.setTimeout(300_000);
  await page.goto(baseUrl);
  await page.getByTestId("file-input").setInputFiles({
    name: IMAGES.pineapple,
    mimeType: "image/jpeg",
    buffer: readFileSync(path.join(repoRoot, "images", IMAGES.pineapple)),
  });
  await page.getByTestId("draft-review").waitFor({ state: "visible", timeout: 240_000 });

  const rows = page.getByTestId("item-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("75.00");
  // Same disposition audit as the Saravana page: the invoice's trailing `1` and the two illegible marks below it are
  // preserved on the bill, not discarded — no price, nothing to extract, and no justification for calling them
  // headers. (The count is pinned deterministically in `headerless.test.ts`; this page-level assertion is the gate.)
  await page.getByTestId("accept-btn").click();
  const unclassified = page.getByTestId("unclassified-row");
  await expect(unclassified.first()).toBeVisible({ timeout: 30_000 });
  await expect(unclassified).toHaveCount(3);
});
