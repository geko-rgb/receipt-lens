/**
 * Ticket 14 — the committed migration fixtures (DECISIONS/0023 P9).
 *
 * What this produces is not a test input someone wrote: it is **the raw contents of `receipt-lens` after the
 * app's own save path wrote to it in Chromium** — capture, accept, edit, finalize, opt into retention — dumped
 * store by store. That is the whole of P9's realism rule: a migration test's "before" state has to be
 * evidence of what the code wrote, not a sketch of what someone thought it would write.
 *
 * Determinism comes from a frozen clock injected before the app loads. The stamps that would otherwise differ
 * on every run (`bill:${createdAt}`, `savedAt`) are derived from `Date`, and `lib/bill/*` already takes them
 * as parameters rather than reading a clock inside a rule (`Bill.svelte:46`, DECISIONS/0011) — so pinning the
 * browser's clock is the same discipline the unit tests get from a constant, not a special case in the format.
 * Nothing is normalized after the fact: if the save path changes what it serializes, these bytes change and
 * `pnpm verify:storage-fixtures` (`git diff --exit-code`) says so.
 *
 * Each scenario runs in its own browser context, which is its own IndexedDB, and each is frozen one second
 * apart: same clock *within* a scenario, distinct `billId`s *across* them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { startServer } from "./serve-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "packages/pwa/tests/persistence/fixtures");

/** The clock the first scenario is frozen to; each later scenario is one second on. Change it and every fixture byte moves — deliberately. */
const FROZEN_AT = new Date("2026-11-05T00:00:00.000Z");
const RECEIPT_LINES = ["RECEIPT", "COFFEE 4.50", "NAAN 60.00", "TOTAL 100.00"];

/**
 * Everything a scenario *types*, as opposed to everything the parser read off the drawn receipt. Named
 * separately because `pnpm scan:pii` checks the fixtures against this list: any free-text value in a
 * committed storage fixture must be one of these, an app default the editor itself writes (`Receipt`,
 * `Creator`), or the scan fails. Widening the vocabulary is therefore a visible diff in this file rather
 * than a quiet change to what the corpus contains.
 */
const TYPED_VALUES = ["P1", "Albus", "albus@okhdfc"];
const SYNTHETIC_VOCABULARY = [
  ...new Set([...RECEIPT_LINES, ...RECEIPT_LINES.flatMap((line) => line.split(/\s+/)), ...TYPED_VALUES]),
].sort();

/**
 * Freezes `Date` before any app code runs, so `billId` and `savedAt` are reproducible. `Date.now()` and
 * `new Date()` both answer with the pinned instant; a constructor given arguments still honours them, because
 * `staleLinkCutoffAt` and the settlement paths take their stamps from callers, not from here.
 */
async function freezeClock(context, iso) {
  await context.addInitScript((value) => {
    const fixed = new Date(value).getTime();
    class FrozenDate extends Date {
      constructor(...args) {
        super(...(args.length === 0 ? [fixed] : args));
      }
      static now() {
        return fixed;
      }
    }
    globalThis.Date = FrozenDate;
  }, iso);
}

/** Draws the receipt on a canvas in the page and returns PNG bytes — the same device the capture specs use. */
async function receiptPng(page, lines) {
  const dataUrl = await page.evaluate(async (drawLines) => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "bold 56px monospace";
    drawLines.forEach((line, index) => context.fillText(line, 60, 220 + index * 160));
    return canvas.toDataURL("image/png");
  }, lines);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function waitFor(page, testId, timeout = 180_000) {
  await page.waitForSelector(`[data-testid="${testId}"]`, { timeout });
}

async function upload(page, { keepPhoto = false } = {}) {
  await page.getByTestId("file-input").setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: await receiptPng(page, RECEIPT_LINES),
  });
  await waitFor(page, "draft-review");
  // The box is on the capture screen and the byte dies with the page at accept, so retention has to be
  // chosen *before* accepting — ticking it afterwards could only ever store nothing.
  if (keepPhoto) await page.getByTestId("keep-photo").check();
  await page.getByTestId("accept-btn").click();
  await page.waitForURL(/\/bill$/);
  await waitFor(page, "totals");
}

/**
 * Reads every record out of the app's database through the browser's own serializer, normalizing the two
 * things a second machine cannot reproduce (see `encodeBinary`). The normalization happens **in the page**:
 * `page.evaluate` returns a structured clone, and an `ArrayBuffer` that arrives in Node as `{}` cannot be
 * inspected afterwards — a replacer on this side would silently write a 39 KB photo as nothing, which is
 * exactly what the first version of this script did.
 */
async function dumpStores(page) {
  return page.evaluate(async () => {
    /**
     * The two things in a real record that a runner cannot reproduce byte-for-byte. Both are replaced by a
     * marker rather than rounded, because the values themselves move, not just their last digits: font
     * hinting shifts an OCR box by a couple of pixels and libjpeg's encoder changes a photograph's size by a
     * hundred bytes — CI measured 56.65 → 58.61 px and 39,877 → 39,761 B between two machines running the
     * same build. The fixture's job is to be evidence of what the *save path* wrote, and the save path wrote
     * the same text, prices, provenance, ids and structure on both.
     */
    const GEOMETRY_KEYS = new Set(["box", "sourceBox", "wordBoxes"]);
    /**
     * OCR confidence is a measurement of a raster, not a value the save path chose: the same build read
     * 0.99544… here and 0.99397… on the CI runner, in the fourth decimal, because the glyphs were hinted a
     * pixel differently. It is rounded to two places rather than dropped — a number stays a number, so core's
     * confidence floors (`DECISIONS/0011` V5's 0.50/0.70) still see a value they can classify, and the
     * fixture's derived state remains the app's own answer rather than an artifact of the normalizer. The
     * residual limit is honest: a machine whose reading crossed one of those floors would still move a
     * finding, and that would be a real model-behaviour change rather than this gate being fussy.
     */
    const roundConfidence = (value) => Math.round(value * 100) / 100;
    const encodeBinary = (item, key) => {
      if (key === "confidence" && typeof item === "number") return roundConfidence(item);
      if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return { "__normalized": "image bytes" };
      if (Array.isArray(item)) return item.map((entry) => encodeBinary(entry, key));
      if (item && typeof item === "object") {
        if (GEOMETRY_KEYS.has(key)) return { "__normalized": "geometry" };
        const copy = {};
        for (const [childKey, value] of Object.entries(item)) copy[childKey] = encodeBinary(value, childKey);
        return copy;
      }
      return item;
    };

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("receipt-lens");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = {};
    for (const name of [...database.objectStoreNames]) {
      stores[name] = await new Promise((resolve, reject) => {
        const transaction = database.transaction(name);
        const all = transaction.objectStore(name).getAll();
        all.onsuccess = () => resolve(encodeBinary(all.result, name));
        all.onerror = () => reject(all.error);
      });
    }
    const version = database.version;
    const names = [...database.objectStoreNames];
    database.close();
    return { version, names, stores };
  });
}

const scenarios = [
  {
    file: "v1-draft-bill.json",
    purpose: "a draft-tier bill with one committed price edit — the ordinary mid-edit state a migration must carry",
    async drive(page) {
      await upload(page);
      await page.getByTestId("draft-price").first().fill("7.25");
      await page.getByTestId("draft-price").first().dispatchEvent("change");
      await waitFor(page, "save-status");
      await page.waitForSelector('[data-testid="save-status"][data-status="saved"]');
    },
  },
  {
    file: "v1-finalized-bill.json",
    purpose: "participants, a finalized line with units, and the assumed-quantity review — 0021's shapes on disk",
    async drive(page) {
      await upload(page);
      await page.getByTestId("participant-name").fill("P1");
      await page.getByTestId("add-participant").click();
      await page.getByTestId("finalize-all").click();
      const review = page.getByTestId("review-item").first();
      if (await review.count()) await review.click();
      await page.waitForSelector('[data-testid="save-status"][data-status="saved"]');
    },
  },
  {
    file: "v1-profile-and-image.json",
    purpose: "the one-row creator profile, and the retained-image row that only exists because it was opted into",
    async drive(page, base) {
      await page.goto(`${base}bills`);
      await waitFor(page, "profile-panel");
      await page.getByTestId("profile-name").fill("Albus");
      await page.getByTestId("profile-upi").fill("albus@okhdfc");
      await page.getByTestId("profile-save").click();
      await waitFor(page, "profile-saved");

      await page.goto(`${base}capture`);
      await upload(page, { keepPhoto: true });
      await page.getByTestId("draft-price").first().fill("9.99");
      await page.getByTestId("draft-price").first().dispatchEvent("change");
      await page.waitForSelector('[data-testid="save-status"][data-status="saved"]');
      await waitFor(page, "kept-photo");
    },
  },
];

const browser = await chromium.launch({ headless: true });
const server = startServer({});
const base = await server.url;
const meta = {
  generator: "scripts/storage-fixtures.mjs",
  dbVersion: 1,
  storeNames: ["bills", "creatorProfile", "retainedImages"],
  frozenAt: FROZEN_AT.toISOString(),
  syntheticVocabulary: SYNTHETIC_VOCABULARY,
  normalized: [
    { keys: ["box", "sourceBox", "wordBoxes"], becomes: "{\"__normalized\":\"geometry\"}", because: "OCR geometry depends on the runner's font rendering; pixels differ between machines" },
    { keys: ["bytes"], becomes: "{\"__normalized\":\"image bytes\"}", because: "JPEG output size and content vary with the browser's encoder; presence and byte length are asserted in playwright/persistence.spec.ts instead" },
    { keys: ["confidence"], becomes: "the same number rounded to 2 decimal places", because: "softmax confidence follows the raster's hinting; the floors it is compared against are 2-decimal values (0.50, 0.70), so that is the precision that carries meaning" },
  ],
  vocabularyRule: "pnpm scan:pii fails if a free-text value here is not in syntheticVocabulary or an app-written constant",

};

mkdirSync(fixturesDir, { recursive: true });
const written = [];

for (const [index, scenario] of scenarios.entries()) {
  const context = await browser.newContext();
  const frozen = new Date(FROZEN_AT.getTime() + index * 1000).toISOString();
  await freezeClock(context, frozen);
  const page = await context.newPage();
  await page.goto(`${base}capture`);
  await scenario.drive(page, base);

  const dump = await dumpStores(page);
  await context.close();

  const file = path.join(fixturesDir, scenario.file);
  writeFileSync(
    file,
    `${JSON.stringify({ _meta: { ...meta, frozenAt: frozen, purpose: scenario.purpose }, ...dump.stores }, null, 2)}\n`,
    "utf8",
  );
  written.push(file);
  if (dump.version !== 1) throw new Error(`${scenario.file}: expected schema version 1, found ${dump.version}`);
}

server.close();
await browser.close();

console.log(`wrote ${written.length} storage fixtures to ${path.relative(repoRoot, fixturesDir)}`);
for (const file of written) console.log(`  ${path.relative(repoRoot, file)}`);
