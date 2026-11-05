#!/usr/bin/env node
/**
 * Ticket 17 — the single-`localStorage`-key rule of DECISIONS/0027 W12.1, as a check.
 *
 * §10's IndexedDB stores are the versioned bill ledger. `localStorage` is not versioned, not exported by
 * ticket 14's backup, and not covered by any migration — so the one key this app may hold is the install
 * banner's dismissal timestamp, and it holds no bill data, no name, no amount, no fragment and no image.
 *
 * The check is structural rather than semantic, which is what makes it worth running: a preference surface
 * that grows quietly is how a bearer secret ends up in `localStorage`, and `docs/pwa-design.md` §3 is
 * explicitly about the fragment never being copied somewhere that outlives the page. Scanning for the call
 * sites catches the second key the moment it is written, in the same style as `scan:egress`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const target = path.join(repoRoot, "packages/pwa/src");

/** The one module allowed to touch `localStorage`, and the one key it may touch. */
const ALLOWED_FILE = path.join(target, "lib/sw/install-banner.ts");
const ALLOWED_KEYS = ["receipt-lens:install-banner-dismissed-at"];

/** Declared before use: the loop below references it, and a `const` after the loop is a temporal-dead-zone crash that only appears once a violation exists to reach it. */
const INSTALL_BANNER_KEY_LITERAL = ALLOWED_KEYS[0];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "dist" ? [] : walk(full);
    return /\.(ts|svelte)$/.test(entry.name) ? [full] : [];
  });

const violations = [];
for (const file of walk(target)) {
  const source = readFileSync(file, "utf8");
  if (!/(localStorage|sessionStorage)/.test(source)) continue;
  const relative = path.relative(repoRoot, file);
  if (file !== ALLOWED_FILE && !relative.endsWith("components/InstallBanner.svelte")) {
    violations.push(`${relative}: touches Web Storage; only the install banner may (DECISIONS/0027 W12.1)`);
    continue;
  }
  for (const match of source.matchAll(/(?:localStorage|sessionStorage)\s*[.[]\s*(?:getItem|setItem|removeItem)?\s*\(?\s*["'`]([^"'`]+)["'`]/g)) {
    const key = match[1];
    if (!ALLOWED_KEYS.includes(key) && key !== INSTALL_BANNER_KEY_LITERAL) {
      violations.push(`${relative}: new Web Storage key "${key}" (DECISIONS/0027 W12.1 allows exactly one)`);
    }
  }
  if (source.includes("sessionStorage")) {
    violations.push(`${relative}: sessionStorage is not used by this app at all`);
  }
}

if (violations.length > 0) {
  process.stdout.write(`Web Storage scan (DECISIONS/0027 W12.1)\n- ${violations.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Web Storage scan: exactly one key, one owner (DECISIONS/0027 W12.1) — ok\n`);
