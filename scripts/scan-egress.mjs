#!/usr/bin/env node
/**
 * Ticket 09a — static first-party egress scan. A SUPPLEMENT to the runtime test, never a proof
 * (PROJECT(1).md §9 M1/M3.5, DECISIONS/0013 T7).
 *
 * The runtime test (playwright/offline.spec.ts) proves the shipped path makes no unexpected request.
 * This scan catches a different class: code that exists but did not run in that one flow. It scans
 * source only (never build output), prints every indirect `fetch(...)` it tolerated, and fails on any
 * literal remote endpoint or exfiltration primitive.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const TARGETS = ["packages/core/src", "packages/pwa/src", "harness/src"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"]);

const BANNED = [
  { pattern: /navigator\.sendBeacon\s*\(/, label: "navigator.sendBeacon" },
  { pattern: /new\s+WebSocket\s*\(/, label: "new WebSocket" },
  { pattern: /new\s+EventSource\s*\(/, label: "new EventSource" },
  { pattern: /new\s+Image\s*\(/, label: "new Image" },
  { pattern: /new\s+XMLHttpRequest\s*\(/, label: "new XMLHttpRequest" },
  { pattern: /\.action\s*=/, label: "form.action assignment" },
  { pattern: /import\s*\(\s*["'`]https?:\/\//, label: "dynamic import of a remote URL" },
  { pattern: /fetch\s*\(\s*["'`]https?:\/\//, label: "fetch of a remote URL literal" },
];

/**
 * Deliberate external actions, pinned by a `// egress-allowed: <id>` marker on the line above the literal.
 * §15 rule 6: opening WhatsApp or sharing a bill is a user action, not inference egress — but the scan still
 * has to name it, so an unmarked remote URL remains a violation.
 */
const DELIBERATE_EXTERNAL_ACTIONS = [
  {
    id: "whatsapp-intent",
    justification:
      "settlement-links.ts — a wa.me click-to-chat link the user must press. Deliberate external action (§15 rule 6, DECISIONS/0024 S5); never fetched by the app.",
  },
];

/** The one expected egress site, pinned with its justification (DECISIONS/0013 T7). */
const PINNED_PROVIDER_FETCH = {
  marker: "this.options.fetch ??" ,
  justification:
    "pp-ocrv6.ts:155 — provider fetch(input) where input is a manifest URL; runtime interception verifies same-origin. Re-review when manifest schema changes.",
};

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...walk(full));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

const files = TARGETS.flatMap((target) => walk(path.join(repoRoot, target)));
const violations = [];
const allowed = [];
let pinnedSeen = false;

for (const file of files) {
  const relative = path.relative(repoRoot, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    for (const rule of BANNED) {
      if (rule.pattern.test(line)) {
        violations.push({ file: relative, line: index + 1, label: rule.label, text: trimmed });
      }
    }
    if (/["'`]https?:\/\/[^"'`]+["'`]/.test(line)) {
      const markerText = `${lines[index - 1] ?? ""} ${line}`;
      const marker = /egress-allowed:\s*([a-z-]+)/.exec(markerText)?.[1];
      const pinnedAction = DELIBERATE_EXTERNAL_ACTIONS.find((action) => action.id === marker);
      if (pinnedAction) {
        allowed.push({
          file: relative,
          line: index + 1,
          text: pinnedAction.justification.replace("settlement-links.ts", `${path.basename(relative)}:${index + 1}`),
        });
      } else {
        violations.push({ file: relative, line: index + 1, label: "absolute URL literal", text: trimmed });
      }
    }
    if (/\bfetch\s*\(/.test(line) && !/fetch\s*\(\s*["'`]/.test(line)) {
      if (line.includes(PINNED_PROVIDER_FETCH.marker)) {
        pinnedSeen = true;
        allowed.push({
          file: relative,
          line: index + 1,
          text: PINNED_PROVIDER_FETCH.justification.replace("pp-ocrv6.ts:155", `${path.basename(relative)}:${index + 1}`),
        });
      } else {
        allowed.push({
          file: relative,
          line: index + 1,
          text: `${path.basename(relative)}:${index + 1} — indirect fetch(input); the runtime test verifies same-origin behaviour. Re-review if this call site changes.`,
        });
      }
    }
  });
}

if (!pinnedSeen) {
  violations.push({
    file: "packages/core/src/ocr/pp-ocrv6.ts",
    line: 0,
    label: "pinned provider fetch site not found",
    text: "the allowlisted provider fetch is gone or rewritten — update DECISIONS/0013 T7 before merging",
  });
}

console.log("egress static scan — supplement to the runtime test, not a proof (DECISIONS/0013 T7)");
console.log(`scanned ${files.length} first-party source files in ${TARGETS.join(", ")}`);
for (const entry of allowed) console.log(`ALLOWED ${entry.file}:${entry.line}\n        ${entry.text}`);
if (violations.length > 0) {
  console.error(`\n${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.label}] ${violation.text}`);
  }
  process.exit(1);
}
console.log(`\n0 violations. ${allowed.length} indirect fetch site(s) tolerated and listed above.`);
