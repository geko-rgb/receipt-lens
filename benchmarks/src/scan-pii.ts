import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { redactWords, type HeaderEntities } from "./fixtures/redact.js";

/**
 * `pnpm scan:pii` — audits the committed fixtures before they are published.
 *
 * Two independent questions, deliberately answered by different means:
 *
 * 1. IDEMPOTENCE (hard): re-applying the redaction rules to the committed text must
 *    change nothing. If it does change something, the redactor saw the token and did
 *    not remove it — a bug, and a build failure.
 * 2. UNKNOWN CLASSES (advisory): broader heuristics for identifier shapes the agreed
 *    rule list does not cover. These are reported, never auto-redacted, because
 *    extending the rule list is an owner decision (DECISIONS/0005).
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");
// Ticket 14's storage fixtures (DECISIONS/0023 P9) are committed data too, so the standing rule that
// fixtures are PII-clean reaches them as well.
const storageFixturesRoot = path.join(repoRoot, "packages", "pwa", "tests", "persistence", "fixtures");

interface Heuristic {
  readonly name: string;
  readonly pattern: RegExp;
}

const heuristics: Heuristic[] = [
  { name: "email-shaped", pattern: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/ },
  // whole token only, handle at the end: `Rice @P` inside a line is not a VPA
  { name: "vpa-shaped", pattern: /^[A-Za-z0-9._-]+@[A-Za-z]{2,25}$/ },
  { name: "long-digit-run", pattern: /^\d[\d\s-]{8,}\d$/ },
  { name: "international-phone", pattern: /^\+\d{1,3}[\s-]?\d[\d\s()-]{5,}\d$/ },
  { name: "masked-card-tail", pattern: /^[xX*]{6,}\d{4}$/ },
];

async function fixtureFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await fixtureFiles(full)));
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".provenance.json")) found.push(full);
  }
  return found.sort();
}

interface FixtureReceipt {
  readonly ocr: { readonly lines: readonly { text: string; readonly words: readonly { text: string }[] }[] };
  readonly gold: { readonly items?: readonly { name: string }[] };
  readonly survivors?: readonly { class: string; reason: string; line: number; word: number; tokenLength: number }[];
}

function linesOf(receipt: FixtureReceipt): string[][] {
  return receipt.ocr.lines.map((line) => line.words.map((word) => word.text));
}

function maskShape(text: string): string {
  return text.replace(/\d/g, "#").replace(/[A-Za-z]{4,}/g, (word) => `${word[0] ?? ""}${"\u00b7".repeat(Math.min(word.length - 1, 8))}`);
}

const problems: string[] = [];
const advisories = new Map<string, { count: number; shapes: string[] }>();
let receiptsScanned = 0;
let tokensScanned = 0;
let survivorHits = 0;

for (const split of ["dev", "eval"]) {
  for (const file of await fixtureFiles(path.join(fixturesRoot, split))) {
    const receipt = JSON.parse(await readFile(file, "utf8")) as FixtureReceipt;
    receiptsScanned += 1;
    const entities: HeaderEntities = {};

    // 1. Idempotence: a complete redaction re-applies as a no-op — except at positions
    // the generator deliberately spared and recorded, which are reported as survivors.
    const again = redactWords(linesOf(receipt), entities);
    const spared = new Set((receipt.survivors ?? []).map((survivor) => `${survivor.line}:${survivor.word}`));
    for (const redaction of again.redactions) {
      if (spared.has(`${redaction.line}:${redaction.word}`)) {
        survivorHits += 1;
        continue;
      }
      problems.push(
        `${path.relative(repoRoot, file)} line ${redaction.line} word ${redaction.word}: ${redaction.class} would fire again on "${maskShape(redaction.before)}"`
      );
    }

    // 2. Heuristics over every committed token. Word tokens only, never joined line
    // text: a line like `000000111 1 193.00` reads as a ten-digit run across the
    // spaces and would bury the real findings under arithmetic.
    const texts = [
      ...receipt.ocr.lines.flatMap((line) => line.words.map((word) => word.text)),
      ...(receipt.gold.items ?? []).map((item) => item.name),
    ];
    for (const text of texts) {
      tokensScanned += 1;
      for (const heuristic of heuristics) {
        if (!heuristic.pattern.test(text)) continue;
        const entry = advisories.get(heuristic.name) ?? { count: 0, shapes: [] };
        entry.count += 1;
        if (entry.shapes.length < 5 && !entry.shapes.includes(maskShape(text))) entry.shapes.push(maskShape(text));
        advisories.set(heuristic.name, entry);
      }
    }
  }
}

// ── ticket 14: the storage fixtures, checked by a different mechanism ───────────────────────────────
//
// Idempotence means nothing here: these files are not redacted dataset output, they are a dump of what the
// app's save path wrote from a receipt *this repository draws on a canvas*. The meaningful guarantee is
// narrower and stronger: every free-text value in them must be one the generator declared, or one the
// editor itself writes. Anything else appeared out of a real receipt, and that is a failure.
const STORAGE_TEXT_KEYS = new Set(["name", "text", "label", "title", "displayName", "upiId"]);
/** App-side constants, not receipt content: `mapping.ts:173`, `:147`, and the canvas blob's own type. */
const APP_WRITTEN_VALUES = new Set(["Receipt", "Creator", "image/jpeg"]);

function storageTextValues(node: unknown, key: string, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) storageTextValues(item, key, into);
    return;
  }
  if (node && typeof node === "object") {
    for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && STORAGE_TEXT_KEYS.has(childKey)) into.push(value);
      else storageTextValues(value, childKey, into);
    }
    return;
  }
}

let storageFilesScanned = 0;
let storageValuesScanned = 0;
const storageSeen = new Set<string>();

for (const entry of (await readdir(storageFixturesRoot)).sort()) {
  if (!entry.startsWith("v1-") || !entry.endsWith(".json")) continue;
  const file = path.join(storageFixturesRoot, entry);
  const fixture = JSON.parse(await readFile(file, "utf8")) as {
    _meta?: { syntheticVocabulary?: string[] };
  };
  const declared = new Set(fixture._meta?.syntheticVocabulary ?? []);
  if (declared.size === 0) {
    problems.push(`${entry}: no _meta.syntheticVocabulary — regenerate with \`pnpm generate:storage-fixtures\``);
    continue;
  }
  storageFilesScanned += 1;
  const values: string[] = [];
  storageTextValues(fixture, "", values);
  for (const value of values) {
    storageValuesScanned += 1;
    storageSeen.add(value);
    if (declared.has(value) || APP_WRITTEN_VALUES.has(value)) continue;
    problems.push(`${entry}: free-text value ${JSON.stringify(value)} is in no declared vocabulary`);
  }
  // The heuristics still run, because a synthetic handle can be shaped like a real one and the report should
  // say so rather than a whitelist quietly hiding it.
  for (const value of values) {
    for (const heuristic of heuristics) {
      if (!heuristic.pattern.test(value)) continue;
      const entry2 = advisories.get(heuristic.name) ?? { count: 0, shapes: [] };
      entry2.count += 1;
      if (entry2.shapes.length < 5 && !entry2.shapes.includes(maskShape(value))) entry2.shapes.push(maskShape(value));
      advisories.set(heuristic.name, entry2);
    }
  }
}

console.log(
  `scanned ${receiptsScanned} receipts, ${tokensScanned} tokens (dev + eval)` +
    ` · ${storageFilesScanned} storage fixtures, ${storageValuesScanned} free-text values ` +
    `(${storageSeen.size} distinct, all from the declared synthetic vocabulary or app constants)`,
);
console.log("\nadvisory heuristics (reported, not redacted — DECISIONS/0005):");
for (const [name, entry] of [...advisories.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`  ${name.padEnd(22)} ${String(entry.count).padStart(5)}  e.g. ${entry.shapes.join(" | ")}`);
}

if (problems.length > 0) {
  console.error(`\nPII scan FAILED: redaction is not idempotent over ${problems.length} committed token(s):`);
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `\nidempotence: re-applying the redaction rules changes nothing (${survivorHits} recorded spared position(s) excluded)`
);
